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
import type { Lesson, Learner, AgentSession, DrivingSchoolConfig } from '../types';
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
import { getIntakeProgress, isPlaceholderName } from './intake-flow';
import { mentionsDrivingTest } from './guards';
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

/** Max LLM <-> tool rounds in one turn (parallel tool calls share a round). */
const MAX_ROUNDS = 10;

/** Hand off to a human only after this many failed turns IN A ROW (one blip is not a reason). */
const MAX_CONSECUTIVE_FAILURES = 3;

const SOFT_RETRY_TEXT =
  "Sorry, I had a little hiccup on my side 🙈 Could you send that again in a moment?";

const TECHNICAL_HANDOFF_TEXT =
  "I'm experiencing a technical issue, so I'm going to connect you with your instructor who will be in touch shortly 🚗";

const FORCE_TEXT_INSTRUCTION =
  '\n\nFINAL INSTRUCTION: Reply to the learner NOW with a short, friendly WhatsApp message in plain text, ' +
  'using only the information you already have. Do not call any tools. Stay on the conversation script.';

/** Call the LLM, retrying once on a transient failure (timeout, 429, 5xx). */
async function generateWithRetry(
  provider: 'openai' | 'anthropic',
  args: Parameters<typeof generateWithTools>[1],
) {
  try {
    return await generateWithTools(provider, args);
  } catch (err) {
    console.warn('[driving agent] LLM call failed, retrying once:', err);
    await new Promise((resolve) => setTimeout(resolve, 500));
    return generateWithTools(provider, args);
  }
}

/**
 * Clean stored history before sending it to the model. Empty messages make
 * Anthropic reject the whole request (400), and a conversation must start with
 * a user turn.
 */
function sanitizeHistory(
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
): Array<{ role: 'user' | 'assistant'; content: string }> {
  const cleaned = messages.filter((m) => m.content && m.content.trim());
  while (cleaned.length > 0 && cleaned[0].role !== 'user') cleaned.shift();
  return cleaned;
}

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

    return created;
  })();

  const learnerId = learner?.id ?? null;
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
  const activeSession: AgentSession = session;
  const testRequestDetected = mentionsDrivingTest(inboundText);

  // Built from a learner snapshot so it can be rebuilt mid-turn, right after the
  // model saves new details — that is what moves the script on to the next step.
  const promptFor = (current: Learner | null): string => {
    const currentName = current?.full_name ?? undefined;
    const placeholder = currentName ? isPlaceholderName(currentName) : false;
    return buildDrivingAgentPrompt({
      config,
      learnerLessons,
      instructors: instructors ?? [],
      learner: current,
      learnerName: currentName,
      nameIsPlaceholder: placeholder,
      nameIsUnconfirmed: !placeholder && !!currentName && !current?.name_confirmed,
      completedLessonsCount,
      intake: getIntakeProgress(current, activeSession.turn_count),
      testRequestDetected,
    });
  };

  const llmMessages: ToolCallingMessage[] = [
    { role: 'system', content: promptFor(learner as Learner | null) },
  ];

  for (const msg of sanitizeHistory(session.messages)) {
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
  let llmFailed = false;

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
    inboundText,
  };

  const callLlm = (messages: ToolCallingMessage[]) =>
    generateWithRetry(aiConfig.provider, {
      apiKey: aiConfig.apiKey,
      model: aiConfig.model,
      messages,
      tools: DRIVING_TOOLS,
      timeoutMs,
    });

  try {
    while (rounds < MAX_ROUNDS) {
      rounds++;

      const result = await callLlm(llmMessages);

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

      let profileChanged = false;

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

        if (toolCall.name === 'update_learner_profile') {
          profileChanged = true;
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

      // The learner's profile changed, so the script has moved on: rebuild the
      // prompt so the model sees the NEW current step on its next round.
      if (profileChanged && learnerId) {
        const { data: fresh } = await db
          .from('learners')
          .select('*')
          .eq('id', learnerId)
          .maybeSingle();
        if (fresh) {
          llmMessages[0] = { role: 'system', content: promptFor(fresh as Learner) };
        }
      }
    }

    // Out of rounds, or the model returned nothing: ask once more for a plain-text
    // reply rather than handing the conversation to a human.
    if (!handedOff && !finalText.trim()) {
      console.warn(`[driving agent] no reply after ${rounds} round(s); forcing a text reply`);
      const forcedMessages = [...llmMessages];
      forcedMessages[0] = {
        role: 'system',
        content: (forcedMessages[0].content ?? '') + FORCE_TEXT_INSTRUCTION,
      };
      const forced = await callLlm(forcedMessages);
      finalText = forced.text;
    }
  } catch (err) {
    console.error('[driving agent] LLM error:', err);
    llmFailed = true;
  }

  // A turn that produced no usable reply is a "failed turn". One blip must not
  // permanently switch the bot off for this chat: apologise, keep the session
  // exactly as it was so the learner can just retry, and only hand off after
  // several failures in a row.
  const priorFailures = activeSession.slots?.llm_failures ?? 0;
  const failedTurn = !handedOff && (llmFailed || !finalText.trim());

  if (failedTurn) {
    const failures = priorFailures + 1;
    if (failures >= MAX_CONSECUTIVE_FAILURES) {
      handedOff = true;
      handoffReason = `AI could not produce a reply ${failures} times in a row (technical issue)`;
      finalText = TECHNICAL_HANDOFF_TEXT;
    } else {
      finalText = SOFT_RETRY_TEXT;
    }
  }

  // 6. Handle handoff
  if (handedOff && !finalText.trim()) {
    finalText =
      "No problem at all — I'm passing you over to your instructor / our team now, and they'll be in touch shortly 😊";
  }

  if (handedOff) {
    console.warn('[driving agent] handing off to a human', {
      reason: handoffReason,
      turn: session.turn_count,
      rounds,
    });
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

  if (failedTurn && !handedOff) {
    await updateSession(db, activeSession.id, {
      slots: { ...activeSession.slots, llm_failures: priorFailures + 1 },
    });
    return { consumed: true, reply: finalText, handedOff: false };
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
      ...(priorFailures > 0
        ? { slots: { ...activeSession.slots, llm_failures: 0 } }
        : {}),
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
