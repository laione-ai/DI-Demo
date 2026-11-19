// ============================================================
// Driving School — Lesson Reminder Service.
//
// Manages reminder scheduling, cancellation, and processing
// for driving lessons.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  Lesson,
  DrivingSchoolConfig,
  LessonReminder,
  ReminderType,
} from './types';
import { createWhatsAppService } from './whatsapp-service';

/**
 * Schedule standard reminders for a new or rescheduled lesson:
 *   1. Initial reminder: 12 hours before (or immediate if < 12h away)
 *   2. Final reminder: 1 hour before
 */
export async function scheduleRemindersForLesson(
  db: SupabaseClient,
  lesson: Lesson,
  config: DrivingSchoolConfig,
): Promise<void> {
  const lessonStart = new Date(lesson.starts_at).getTime();
  const now = Date.now();

  const initialMs = config.reminder_initial_minutes * 60 * 1000; // 12h
  const finalMs = config.reminder_final_minutes * 60 * 1000;     // 1h

  const remindersToInsert: Array<{
    lesson_id: string;
    account_id: string;
    reminder_type: ReminderType;
    status: 'pending';
    scheduled_at: string;
    sequence_number: number;
  }> = [];

  // Initial reminder (12h)
  const initialScheduledAt = lessonStart - initialMs;
  if (initialScheduledAt > now) {
    remindersToInsert.push({
      lesson_id: lesson.id,
      account_id: lesson.account_id,
      reminder_type: 'initial_12h',
      status: 'pending',
      scheduled_at: new Date(initialScheduledAt).toISOString(),
      sequence_number: 1,
    });
  } else if (lessonStart - now > finalMs) {
    // If within 12h but more than 1h away, schedule an immediate initial reminder
    remindersToInsert.push({
      lesson_id: lesson.id,
      account_id: lesson.account_id,
      reminder_type: 'initial_12h',
      status: 'pending',
      scheduled_at: new Date(now + 60_000).toISOString(), // 1 min from now
      sequence_number: 1,
    });
  }

  // Final reminder (1h)
  const finalScheduledAt = lessonStart - finalMs;
  if (finalScheduledAt > now) {
    remindersToInsert.push({
      lesson_id: lesson.id,
      account_id: lesson.account_id,
      reminder_type: 'final_1h',
      status: 'pending',
      scheduled_at: new Date(finalScheduledAt).toISOString(),
      sequence_number: 2,
    });
  }

  if (remindersToInsert.length > 0) {
    const { error } = await db
      .from('lesson_reminders')
      .insert(remindersToInsert);

    if (error) {
      console.error('[driving] failed to schedule lesson reminders:', error);
    }
  }
}

/**
 * Cancel all pending reminders for a lesson.
 */
export async function cancelRemindersForLesson(
  db: SupabaseClient,
  lessonId: string,
): Promise<void> {
  const { error } = await db
    .from('lesson_reminders')
    .update({ status: 'cancelled' })
    .eq('lesson_id', lessonId)
    .eq('status', 'pending');

  if (error) {
    console.error('[driving] failed to cancel lesson reminders:', error);
  }
}

/**
 * Process due reminders (called by cron).
 */
export async function processDueReminders(
  db: SupabaseClient,
  config: DrivingSchoolConfig,
): Promise<{ processed: number; sent: number; failed: number }> {
  const now = new Date().toISOString();

  // Find pending reminders due for sending
  const { data: dueReminders, error } = await db
    .from('lesson_reminders')
    .select('*, lesson:lessons(*, learner:learners(*), instructor:instructors(*))')
    .eq('account_id', config.account_id)
    .eq('status', 'pending')
    .lte('scheduled_at', now)
    .order('scheduled_at', { ascending: true })
    .limit(50);

  if (error || !dueReminders) {
    console.error('[driving] failed to fetch due reminders:', error);
    return { processed: 0, sent: 0, failed: 0 };
  }

  const waService = createWhatsAppService(db, config.demo_mode);
  let sent = 0;
  let failed = 0;

  for (const reminder of dueReminders) {
    const lesson = reminder.lesson as (Lesson & { learner: any; instructor: any });
    if (!lesson || !lesson.learner) continue;

    // Skip if lesson is cancelled or completed
    if (['cancelled', 'rescheduled', 'completed', 'no_show'].includes(lesson.status)) {
      await db
        .from('lesson_reminders')
        .update({ status: 'cancelled' })
        .eq('id', reminder.id);
      continue;
    }

    try {
      const { sendLessonReminder } = await import('./whatsapp-service');
      const res = await sendLessonReminder(db, waService, lesson, reminder, config);

      if (res.success) {
        await db
          .from('lesson_reminders')
          .update({
            status: 'sent',
            sent_at: new Date().toISOString(),
            whatsapp_message_id: res.messageId ?? null,
          })
          .eq('id', reminder.id);

        await db
          .from('lessons')
          .update({
            status: lesson.status === 'scheduled' ? 'reminder_sent' : lesson.status,
            last_reminder_sent_at: new Date().toISOString(),
            reminder_count: (lesson.reminder_count || 0) + 1,
          })
          .eq('id', lesson.id);

        sent++;
      } else {
        await db
          .from('lesson_reminders')
          .update({
            status: 'failed',
            error_message: res.error ?? 'Send failed',
          })
          .eq('id', reminder.id);
        failed++;
      }
    } catch (err) {
      console.error('[driving] reminder send error:', err);
      failed++;
    }
  }

  return { processed: dueReminders.length, sent, failed };
}
