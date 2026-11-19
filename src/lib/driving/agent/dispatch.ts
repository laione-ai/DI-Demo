// ============================================================
// Driving Agent — Webhook dispatch entry point.
//
// Called from process-webhook.ts when:
//   1. The message is free text (not an interactive button reply)
//   2. No Flow consumed it
//   3. No driving button handler consumed it
//
// Does an indexed early-exit if driving_school_config.agent_enabled is false.
// When isDrivingAccount is true, the generic AI auto-reply is suppressed.
// ============================================================

import { supabaseAdmin } from '@/lib/ai/admin-client';
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit';
import { runAgentTurn } from './engine';
import type { AgentContext } from './types';

export interface DispatchArgs {
  accountId: string;
  conversationId: string;
  contactId: string;
  phone: string;
  text: string;
  configOwnerUserId: string;
  waMessageId?: string;
}

export interface DispatchResult {
  consumed: boolean;
  isDrivingAccount: boolean;
}

/**
 * Entry point for the driving instructor WhatsApp AI booking agent.
 */
export async function dispatchInboundToDrivingAgent(
  args: DispatchArgs,
): Promise<DispatchResult> {
  const {
    accountId,
    conversationId,
    contactId,
    phone,
    text,
    configOwnerUserId,
    waMessageId,
  } = args;

  if (!text.trim()) return { consumed: false, isDrivingAccount: false };

  const db = supabaseAdmin();

  // 1. Feature flag check
  const { data: config } = await db
    .from('driving_school_config')
    .select('agent_enabled')
    .eq('account_id', accountId)
    .maybeSingle();

  if (!config?.agent_enabled) return { consumed: false, isDrivingAccount: false };

  // 2. Rate limit check
  const rateCheck = checkRateLimit(
    `driving-agent:${accountId}`,
    RATE_LIMITS.aiAutoReplyAccount,
  );

  if (!rateCheck.success) {
    console.warn(`[driving agent] account ${accountId} hit rate limit`);
    return { consumed: false, isDrivingAccount: true };
  }

  // 3. Run turn
  try {
    const ctx: AgentContext = {
      accountId,
      conversationId,
      contactId,
      phone,
      configOwnerUserId,
    };

    const result = await runAgentTurn(
      db,
      ctx,
      text,
      waMessageId ?? `unknown_${Date.now()}`,
    );

    if (!result.consumed) return { consumed: false, isDrivingAccount: true };

    // 4. Send reply via WhatsApp
    if (result.reply) {
      const { loadSchoolConfig } = await import('../config');
      const { createWhatsAppService } = await import('../whatsapp-service');

      const schoolConfig = await loadSchoolConfig(db, accountId, configOwnerUserId);
      const waService = createWhatsAppService(db, schoolConfig.demo_mode);

      await waService.sendTextMessage({
        accountId,
        phone,
        text: result.reply,
      });

      // Log message
      const { data: learner } = await db
        .from('learners')
        .select('id')
        .eq('account_id', accountId)
        .eq('phone', phone)
        .maybeSingle();

      await db.from('driving_message_log').insert({
        account_id: accountId,
        learner_id: learner?.id ?? null,
        direction: 'outbound',
        message_type: 'text',
        content: result.reply,
        mock_mode: schoolConfig.demo_mode,
      });
    }

    return { consumed: true, isDrivingAccount: true };
  } catch (err) {
    console.error('[driving agent] dispatch failed:', err);
    return { consumed: false, isDrivingAccount: true };
  }
}
