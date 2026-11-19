// ============================================================
// Driving Agent — Core engine.
//
// The main tool-calling loop for the driving instructor WhatsApp agent:
//   1. Loads/creates an active session
//   2. Builds LLM context (system prompt + history + tools)
//   3. Calls LLM with DRIVING_TOOLS
//   4. Executes tool calls server-side (enforces 5-lesson test rule)
//   5. Composes deterministic confirmation from DB rows
//   6. Updates session state
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Lesson, DrivingSchoolConfig } from '../types';
import type {
  AgentContext,
  AgentTurnResult,
  ToolCallingMessage,
} from './types';
import { loadAiConfig } from '@/lib/ai/config';
import { aiRequestTimeoutMs } from '@/lib/ai/defaults';
import { generateWithTools } from './providers';
import { DRIVING_TOOLS, executeTool, type ToolExecutionContext } from './tools';
import { buildDrivingAgentPrompt } from './prompt';
import {
  loadActiveSession,
  createSession,
  updateSession,
  completeSession,
  isSessionExpired,
  isMessageAlreadyProcessed,
} from './session';
import { loadSchoolConfig, formatInSchoolTimezone } from '../config';
import { formatCalendarLinksForWhatsApp } from '../calendar';
import { createWhatsAppService } from '../whatsapp-service';
import { countCompletedLessons } from '../lesson-service';

const MAX_ROUNDS = 6;

/**
 * Run one agent turn for an inbound WhatsApp message.
 */
export async function runAgentTurn(
  db: SupabaseClient,
  ctx: AgentContext,
  inboundText: string,
  waMessageId: string,
): Promise<AgentTurnResult> {
  const { accountId, conversationId, contactId, phone, configOwnerUserId } = ctx;

  // 1. Load AI config
  const aiConfig = await loadAiConfig(db, accountId);
  if (!aiConfig) {
    console.warn('[driving agent] No AI config for account', accountId);
    return { consumed: false };
  }

  // 2. Load school config + instructors + learner
  const config = await loadSchoolConfig(db, accountId, configOwnerUserId);
  const { data: instructors } = await db
    .from('instructors')
    .select('*')
    .eq('account_id', accountId)
    .eq('is_active', true)
    .order('full_name');

  let isNewlyAutoRegistered = false;

  const learner = await (async () => {
    const { data: existing } = await db
      .from('learners')
      .select('*')
      .eq('account_id', accountId)
      .eq('phone', phone)
      .maybeSingle();

    if (existing) return existing;

    // Auto-create learner from contact
    const { data: contact } = await db
      .from('contacts')
      .select('id, name, phone')
      .eq('id', contactId)
      .maybeSingle();

    const learnerName = contact?.name?.trim() || phone;

    const { data: created, error: createErr } = await db
      .from('learners')
      .insert({
        account_id: accountId,
        user_id: configOwnerUserId,
        contact_id: contactId,
        full_name: learnerName,
        phone,
      })
      .select('*')
      .single();

    if (createErr) {
      console.error('[driving agent] failed to auto-register learner:', createErr);
      return null;
    }

    isNewlyAutoRegistered = true;
    return created;
  })();

  const learnerId = learner?.id ?? null;
  const learnerName = learner?.full_name ?? undefined;

  const nameIsPlaceholder = learnerName
    ? /^\+?[\d\s\-()]+$/.test(learnerName.trim())
    : false;

  const nameIsUnconfirmed =
    !nameIsPlaceholder &&
    learnerName &&
    (isNewlyAutoRegistered || (learner && !learner.name_confirmed));

  // Count completed lessons for 5-lesson test eligibility
  let completedLessonsCount = 0;
  if (learnerId) {
    const counts = await countCompletedLessons(db, accountId, learnerId);
    completedLessonsCount = counts.totalCompleted;
  }

  // Load upcoming lessons
  let learnerLessons: Lesson[] = [];
  if (learnerId) {
    const { data: lessons } = await db
      .from('lessons')
      .select('*, learner:learners(*), instructor:instructors(*)')
      .eq('account_id', accountId)
      .eq('learner_id', learnerId)
      .in('status', ['scheduled', 'reminder_sent', 'confirmed', 'pending_approval'])
      .gte('starts_at', new Date().toISOString())
      .order('starts_at', { ascending: true })
      .limit(5);
    learnerLessons = (lessons ?? []) as Lesson[];
  }

  // 3. Load or create session
  let session = await loadActiveSession(db, accountId, phone);

  if (session && isSessionExpired(session)) {
    await completeSession(db, session.id, 'expired');
    session = null;
  }

  if (session && isMessageAlreadyProcessed(session, waMessageId)) {
    console.log('[driving agent] duplicate message detected, skipping:', waMessageId);
    return { consumed: true };
  }

  if (!session) {
    session = await createSession(db, accountId, phone, conversationId, learnerId);
  }

  if (learnerId && !session.learner_id) {
    await updateSession(db, session.id, { learner_id: learnerId });
    session.learner_id = learnerId;
  }

  // 4. Build prompt
  const systemPrompt = buildDrivingAgentPrompt({
    config,
    learnerLessons,
    instructors: instructors ?? [],
    learner,
    learnerName,
    nameIsPlaceholder,
    nameIsUnconfirmed: !!nameIsUnconfirmed,
    completedLessonsCount,
  });

  const llmMessages: ToolCallingMessage[] = [
    { role: 'system', content: systemPrompt },
  ];

  for (const msg of session.messages) {
    llmMessages.push({ role: msg.role, content: msg.content });
  }

  llmMessages.push({ role: 'user', content: inboundText });

  const updatedMessages = [
    ...session.messages,
    { role: 'user' as const, content: inboundText },
  ];

  // 5. Tool-calling loop
  const timeoutMs = aiRequestTimeoutMs();
  let rounds = 0;
  let finalText = '';
  let handedOff = false;
  let handoffReason: string | undefined;
  let lastMutationLesson: Lesson | undefined;

  const waService = createWhatsAppService(db, config.demo_mode);

  const toolCtx: ToolExecutionContext = {
    db,
    accountId,
    userId: configOwnerUserId,
    phone,
    learnerId,
    config,
    conversationId,
    waMessageId,
    waService,
  };

  try {
    while (rounds < MAX_ROUNDS) {
      rounds++;

      const result = await generateWithTools(aiConfig.provider, {
        apiKey: aiConfig.apiKey,
        model: aiConfig.model,
        messages: llmMessages,
        tools: DRIVING_TOOLS,
        timeoutMs,
      });

      if (process.env.DRIVING_AGENT_DEBUG === 'true') {
        console.log(`[driving agent][debug] round ${rounds}`, result);
      }

      if (result.done || result.toolCalls.length === 0) {
        finalText = result.text;
        break;
      }

      llmMessages.push({
        role: 'assistant',
        content: result.text || undefined,
        tool_calls: result.toolCalls,
      });

      for (const toolCall of result.toolCalls) {
        const { result: toolResult, handoff, handoffReason: reason, lesson } =
          await executeTool(toolCall, toolCtx);

        if (handoff) {
          handedOff = true;
          handoffReason = reason;
        }

        if (lesson) {
          lastMutationLesson = lesson;
        }

        llmMessages.push({
          role: 'tool',
          tool_call_id: toolResult.tool_call_id,
          name: toolResult.name,
          content: toolResult.content,
        });
      }

      if (handedOff) {
        finalText = result.text || '';
        break;
      }
    }

    if (rounds >= MAX_ROUNDS && !finalText) {
      handedOff = true;
      finalText =
        "I'm having a little trouble completing your request. Let me connect you directly with your instructor or our team to help.";
    }
  } catch (err) {
    console.error('[driving agent] LLM error:', err);
    handedOff = true;
    finalText =
      "I'm experiencing a quick technical hitch. Let me connect you with your instructor who will be in touch shortly.";
  }

  // 6. Handle handoff
  if (handedOff) {
    await performHandoff(
      db,
      conversationId,
      accountId,
      aiConfig.handoffAgentId,
      session.messages,
      session.turn_count,
      handoffReason,
    );
    await completeSession(db, session.id, 'handed_off');
  }

  // 7. Compose deterministic confirmation if mutation occurred
  let replyText = finalText;

  if (lastMutationLesson && !handedOff) {
    const confirmation = composeDeterministicConfirmation(lastMutationLesson, config);
    if (confirmation) {
      replyText = finalText ? `${finalText}\n\n${confirmation}` : confirmation;
    }
  }

  // 8. Update session
  const assistantMessages = [
    ...updatedMessages,
    { role: 'assistant' as const, content: replyText },
  ];

  if (!handedOff) {
    await updateSession(db, session.id, {
      messages: assistantMessages,
      turn_count: session.turn_count + 1,
      last_message_id: waMessageId,
      state: lastMutationLesson
        ? 'completed'
        : session.state === 'awaiting_intent'
          ? 'collecting_info'
          : session.state,
    });

    if (lastMutationLesson) {
      await completeSession(db, session.id, 'completed');
    }
  }

  return {
    consumed: true,
    reply: replyText,
    handedOff,
  };
}

/**
 * Compose a deterministic confirmation from the database row.
 */
function composeDeterministicConfirmation(
  lesson: Lesson,
  config: DrivingSchoolConfig,
): string | null {
  const tz = config.school_timezone || 'Europe/London';
  const dateStr = formatInSchoolTimezone(lesson.starts_at, tz, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  const timeStr = formatInSchoolTimezone(lesson.starts_at, tz, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const instructorName = lesson.instructor?.full_name ?? 'your instructor';
  const lessonType = lesson.lesson_type === 'mock_test' ? 'Driving Mock Test' : 'Driving Lesson';

  switch (lesson.status) {
    case 'scheduled':
    case 'confirmed': {
      const calendarLinks = formatCalendarLinksForWhatsApp(lesson, config);
      return (
        `✅ ${lessonType} Confirmed!\n\n` +
        `📅 Date: ${dateStr}\n` +
        `🕐 Time: ${timeStr}\n` +
        `🚗 Instructor: ${instructorName}\n` +
        `⏱️ Duration: ${lesson.duration_minutes || 60} mins\n\n` +
        `${calendarLinks}`
      );
    }

    case 'cancelled':
      return `❌ Your driving lesson on ${dateStr} at ${timeStr} with ${instructorName} has been cancelled.`;

    default:
      return null;
  }
}

/**
 * Perform handoff to a human staff member or instructor.
 */
async function performHandoff(
  db: SupabaseClient,
  conversationId: string,
  accountId: string,
  handoffAgentId: string | null,
  messages: Array<{ role: string; content: string }>,
  replyCount: number,
  reason?: string,
): Promise<void> {
  const lastCustomer = [...messages]
    .reverse()
    .find((m) => m.role === 'user' && m.content.trim());

  let summary = `🚗 Driving AI booking agent handed off.`;
  if (reason) summary += ` Reason: ${reason}`;
  if (lastCustomer) {
    const quote =
      lastCustomer.content.trim().length > 160
        ? lastCustomer.content.trim().slice(0, 159) + '…'
        : lastCustomer.content.trim();
    summary += ` Last message: "${quote}"`;
  }

  const update: Record<string, unknown> = {
    ai_autoreply_disabled: true,
    ai_handoff_summary: summary,
  };

  if (handoffAgentId) {
    const { data: conv } = await db
      .from('conversations')
      .select('assigned_agent_id')
      .eq('id', conversationId)
      .maybeSingle();

    if (conv && !conv.assigned_agent_id) {
      update.assigned_agent_id = handoffAgentId;
    }
  }

  await db.from('conversations').update(update).eq('id', conversationId);
}
