// ============================================================
// Driving School — WhatsApp Service.
//
// Dual-mode service (real Meta API vs mock console log) for
// driving lesson notifications and reminders.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Lesson, DrivingSchoolConfig, LessonReminder } from './types';
import { DRIVING_BUTTON_IDS } from './types';
import { formatInSchoolTimezone } from './config';

export interface DrivingWhatsAppService {
  sendInteractiveButtons(params: {
    accountId: string;
    phone: string;
    bodyText: string;
    buttons: Array<{ id: string; title: string }>;
    headerText?: string;
    footerText?: string;
  }): Promise<{ success: boolean; messageId?: string; error?: string }>;

  sendTextMessage(params: {
    accountId: string;
    phone: string;
    text: string;
  }): Promise<{ success: boolean; messageId?: string; error?: string }>;

  sendReaction(params: {
    accountId: string;
    phone: string;
    targetMessageId: string;
    emoji: string;
  }): Promise<{ success: boolean; error?: string }>;
}

export class MockWhatsAppService implements DrivingWhatsAppService {
  constructor(private db: SupabaseClient) {}

  async sendInteractiveButtons(params: {
    accountId: string;
    phone: string;
    bodyText: string;
    buttons: Array<{ id: string; title: string }>;
    headerText?: string;
    footerText?: string;
  }) {
    console.log(`[driving][mock] Interactive to ${params.phone}:`, params.bodyText, params.buttons);
    return { success: true, messageId: `mock_btn_${Date.now()}` };
  }

  async sendTextMessage(params: { accountId: string; phone: string; text: string }) {
    console.log(`[driving][mock] Text to ${params.phone}:`, params.text);
    return { success: true, messageId: `mock_txt_${Date.now()}` };
  }

  async sendReaction(params: { accountId: string; phone: string; targetMessageId: string; emoji: string }) {
    console.log(`[driving][mock] Reaction ${params.emoji} to ${params.targetMessageId}`);
    return { success: true };
  }
}

export class RealWhatsAppService implements DrivingWhatsAppService {
  constructor(private db: SupabaseClient) {}

  async sendInteractiveButtons(params: {
    accountId: string;
    phone: string;
    bodyText: string;
    buttons: Array<{ id: string; title: string }>;
    headerText?: string;
    footerText?: string;
  }) {
    try {
      const { resolveConversationByPhone } = await import('@/lib/whatsapp/resolve-conversation');
      const { sendMessageToConversation } = await import('@/lib/whatsapp/send-message');

      // Throws SendMessageError on a bad phone / missing WhatsApp config.
      const resolved = await resolveConversationByPhone(this.db, params.accountId, params.phone);

      const result = await sendMessageToConversation(this.db, params.accountId, {
        conversationId: resolved.conversationId,
        messageType: 'interactive',
        contentText: params.bodyText,
        interactivePayload: {
          kind: 'buttons',
          body: params.bodyText,
          header: params.headerText,
          footer: params.footerText,
          buttons: params.buttons.map((b) => ({ id: b.id, title: b.title })),
        },
      });

      return { success: true, messageId: result.whatsappMessageId };
    } catch (err: any) {
      console.error('[driving] sendInteractiveButtons error:', err);
      return { success: false, error: err.message || 'Send error' };
    }
  }

  async sendTextMessage(params: { accountId: string; phone: string; text: string }) {
    try {
      const { resolveConversationByPhone } = await import('@/lib/whatsapp/resolve-conversation');
      const { sendMessageToConversation } = await import('@/lib/whatsapp/send-message');

      const resolved = await resolveConversationByPhone(this.db, params.accountId, params.phone);

      const result = await sendMessageToConversation(this.db, params.accountId, {
        conversationId: resolved.conversationId,
        messageType: 'text',
        contentText: params.text,
      });

      return { success: true, messageId: result.whatsappMessageId };
    } catch (err: any) {
      console.error('[driving] sendTextMessage error:', err);
      return { success: false, error: err.message || 'Send error' };
    }
  }

  async sendReaction(params: { accountId: string; phone: string; targetMessageId: string; emoji: string }) {
    try {
      const { sendReactionMessage } = await import('@/lib/whatsapp/meta-api');
      const { decrypt } = await import('@/lib/whatsapp/encryption');
      const { sanitizePhoneForMeta } = await import('@/lib/whatsapp/phone-utils');

      const { data: config } = await this.db
        .from('whatsapp_config')
        .select('phone_number_id, access_token')
        .eq('account_id', params.accountId)
        .maybeSingle();

      if (!config) return { success: false, error: 'No WhatsApp config' };

      await sendReactionMessage({
        phoneNumberId: config.phone_number_id,
        accessToken: decrypt(config.access_token),
        to: sanitizePhoneForMeta(params.phone),
        targetMessageId: params.targetMessageId,
        emoji: params.emoji,
      });

      return { success: true };
    } catch (err: any) {
      console.error('[driving] sendReaction error:', err);
      return { success: false, error: err.message || 'Reaction error' };
    }
  }
}

export function createWhatsAppService(
  db: SupabaseClient,
  demoMode: boolean = true,
): DrivingWhatsAppService {
  return demoMode ? new MockWhatsAppService(db) : new RealWhatsAppService(db);
}

/**
 * Send a lesson reminder message via WhatsApp.
 */
export async function sendLessonReminder(
  db: SupabaseClient,
  waService: DrivingWhatsAppService,
  lesson: Lesson & { learner: any; instructor: any },
  reminder: LessonReminder,
  config: DrivingSchoolConfig,
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  const learner = lesson.learner;
  const instructor = lesson.instructor;
  const tz = config.school_timezone || 'Europe/London';

  const dateStr = formatInSchoolTimezone(lesson.starts_at, tz, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });
  const timeStr = formatInSchoolTimezone(lesson.starts_at, tz, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  const instructorName = instructor?.full_name ?? 'your instructor';
  const learnerName = learner?.full_name?.split(' ')[0] ?? 'there';
  const lessonType = lesson.lesson_type === 'mock_test' ? 'Driving Mock Test' : 'driving lesson';

  let bodyText = '';
  if (reminder.reminder_type === 'initial_12h') {
    bodyText =
      `Hi ${learnerName}! 🚗 Just a reminder that you have a ${lessonType} scheduled for tomorrow:\n\n` +
      `📅 ${dateStr}\n` +
      `🕐 ${timeStr}\n` +
      `👤 Instructor: ${instructorName}\n\n` +
      `Please confirm if you'll be attending, or reschedule/cancel below.`;
  } else {
    bodyText =
      `Hi ${learnerName}! 🚗 Your ${lessonType} with ${instructorName} starts in 1 hour!\n\n` +
      `🕐 Start time: ${timeStr}\n` +
      `Get ready for your drive!`;
  }

  const buttons = [
    { id: DRIVING_BUTTON_IDS.CONFIRM, title: 'Confirm ✅' },
    { id: DRIVING_BUTTON_IDS.RESCHEDULE, title: 'Reschedule 📅' },
    { id: DRIVING_BUTTON_IDS.CANCEL, title: 'Cancel ❌' },
  ];

  return waService.sendInteractiveButtons({
    accountId: config.account_id,
    phone: learner.phone,
    bodyText,
    buttons,
    headerText: '🚗 Driving Lesson Reminder',
    footerText: config.school_name,
  });
}
