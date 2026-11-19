// ============================================================
// Driving School — WhatsApp Button Webhook Handler.
//
// Handles interactive button clicks (confirm, cancel, reschedule)
// from learners on WhatsApp.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  DRIVING_BUTTON_PREFIX,
  DRIVING_BUTTON_IDS,
  type Lesson,
  type DrivingSchoolConfig,
} from './types';
import {
  findActiveLessonForLearner,
  transitionLesson,
} from './lesson-service';
import { getNextAvailableDates, getAvailableSlots } from './availability-service';
import { loadSchoolConfig, formatInSchoolTimezone } from './config';
import { createWhatsAppService } from './whatsapp-service';
import { commitReschedule } from './reschedule';

export function isDrivingButtonReply(buttonId: string): boolean {
  return buttonId.startsWith(DRIVING_BUTTON_PREFIX);
}

/**
 * Handle a driving button click from WhatsApp.
 */
export async function handleDrivingButtonReply(
  db: SupabaseClient,
  accountId: string,
  contactPhone: string,
  buttonId: string,
): Promise<boolean> {
  const config = await loadSchoolConfig(db, accountId);
  const waService = createWhatsAppService(db, config.demo_mode);

  try {
    // 1. Confirm
    if (buttonId === DRIVING_BUTTON_IDS.CONFIRM) {
      const activeLesson = await findActiveLessonForLearner(db, accountId, contactPhone);
      if (!activeLesson) {
        await waService.sendTextMessage({
          accountId,
          phone: contactPhone,
          text: "We couldn't find an upcoming driving lesson to confirm. Please contact your instructor.",
        });
        return true;
      }

      await transitionLesson(
        db,
        accountId,
        activeLesson.id,
        'confirmed',
        'learner_button',
        { button_id: buttonId },
      );

      const dateStr = formatInSchoolTimezone(
        activeLesson.starts_at,
        config.school_timezone,
        { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' },
      );

      await waService.sendTextMessage({
        accountId,
        phone: contactPhone,
        text: `✅ Thank you! Your driving lesson on ${dateStr} is confirmed. See you then! 🚗`,
      });
      return true;
    }

    // 2. Cancel
    if (buttonId === DRIVING_BUTTON_IDS.CANCEL) {
      const activeLesson = await findActiveLessonForLearner(db, accountId, contactPhone);
      if (!activeLesson) {
        await waService.sendTextMessage({
          accountId,
          phone: contactPhone,
          text: "We couldn't find an upcoming driving lesson to cancel.",
        });
        return true;
      }

      await transitionLesson(
        db,
        accountId,
        activeLesson.id,
        'cancelled',
        'learner_button',
        { reason: 'Cancelled via WhatsApp button' },
      );

      await waService.sendTextMessage({
        accountId,
        phone: contactPhone,
        text: `❌ Your driving lesson has been cancelled. If you would like to book a new lesson, simply message here anytime! 🚗`,
      });
      return true;
    }

    // 3. Reschedule - Step 1: Offer Dates
    if (buttonId === DRIVING_BUTTON_IDS.RESCHEDULE) {
      const activeLesson = await findActiveLessonForLearner(db, accountId, contactPhone);
      if (!activeLesson) {
        await waService.sendTextMessage({
          accountId,
          phone: contactPhone,
          text: "We couldn't find an active driving lesson to reschedule.",
        });
        return true;
      }

      // Transition to reschedule_requested
      if (activeLesson.status !== 'reschedule_requested') {
        await transitionLesson(
          db,
          accountId,
          activeLesson.id,
          'reschedule_requested',
          'learner_button',
        );
      }

      const nextDates = await getNextAvailableDates(
        db,
        accountId,
        activeLesson.instructor_id,
        config.school_timezone,
        3,
      );

      if (nextDates.length === 0) {
        await waService.sendTextMessage({
          accountId,
          phone: contactPhone,
          text: "Sorry, your instructor currently has no open slots in the next 30 days. Please message us with your preferred dates or speak to a member of staff.",
        });
        return true;
      }

      // Create reschedule session
      const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
      await db.from('reschedule_sessions').insert({
        lesson_id: activeLesson.id,
        account_id: accountId,
        learner_id: activeLesson.learner_id,
        step: 'date_selection',
        offered_dates: nextDates,
        expires_at: expiresAt,
      });

      const buttons = nextDates.map((d, i) => {
        const formatted = new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', {
          weekday: 'short',
          day: 'numeric',
          month: 'short',
        });
        return {
          id: `${DRIVING_BUTTON_IDS.DATE_PREFIX}${i}`,
          title: formatted,
        };
      });

      await waService.sendInteractiveButtons({
        accountId,
        phone: contactPhone,
        bodyText: "📅 Please choose a new date for your driving lesson:",
        buttons,
        headerText: "🚗 Reschedule Lesson",
      });
      return true;
    }

    // 4. Date selection -> Offer Slots
    if (buttonId.startsWith(DRIVING_BUTTON_IDS.DATE_PREFIX)) {
      const index = parseInt(buttonId.replace(DRIVING_BUTTON_IDS.DATE_PREFIX, ''), 10);

      const { data: session } = await db
        .from('reschedule_sessions')
        .select('*, lesson:lessons(*)')
        .eq('account_id', accountId)
        .is('completed_at', null)
        .gt('expires_at', new Date().toISOString())
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (!session || !session.offered_dates?.[index]) {
        await waService.sendTextMessage({
          accountId,
          phone: contactPhone,
          text: "Your reschedule session has expired. Please tap 'Reschedule' again to restart.",
        });
        return true;
      }

      const selectedDate = session.offered_dates[index];
      const lesson = session.lesson as Lesson;

      const dayAvail = await getAvailableSlots(
        db,
        accountId,
        lesson.instructor_id,
        selectedDate,
        selectedDate,
        config.school_timezone,
        lesson.duration_minutes || 60,
      );

      const openSlots = dayAvail[0]?.slots.filter((s) => s.available).slice(0, 3) ?? [];

      if (openSlots.length === 0) {
        await waService.sendTextMessage({
          accountId,
          phone: contactPhone,
          text: `Sorry, there are no open slots on ${selectedDate}. Please select another date or message us directly.`,
        });
        return true;
      }

      await db
        .from('reschedule_sessions')
        .update({
          selected_date: selectedDate,
          offered_slots: openSlots.map((s) => s.time),
          step: 'time_selection',
        })
        .eq('id', session.id);

      const buttons = openSlots.map((s, i) => ({
        id: `${DRIVING_BUTTON_IDS.SLOT_PREFIX}${i}`,
        title: s.time,
      }));

      await waService.sendInteractiveButtons({
        accountId,
        phone: contactPhone,
        bodyText: `Available times on ${selectedDate}:\nPlease choose a slot:`,
        buttons,
        headerText: "🚗 Choose Lesson Time",
      });
      return true;
    }

    // 5. Slot selection -> Commit Reschedule
    if (buttonId.startsWith(DRIVING_BUTTON_IDS.SLOT_PREFIX)) {
      const index = parseInt(buttonId.replace(DRIVING_BUTTON_IDS.SLOT_PREFIX, ''), 10);

      const { data: session } = await db
        .from('reschedule_sessions')
        .select('*, lesson:lessons(*, learner:learners(*), instructor:instructors(*))')
        .eq('account_id', accountId)
        .is('completed_at', null)
        .gt('expires_at', new Date().toISOString())
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (!session || !session.selected_date || !session.offered_slots?.[index]) {
        await waService.sendTextMessage({
          accountId,
          phone: contactPhone,
          text: "Your reschedule session has expired. Please tap 'Reschedule' to start again.",
        });
        return true;
      }

      const selectedTime = session.offered_slots[index];
      const lesson = session.lesson as Lesson;
      const { schoolLocalToUtc } = await import('./config');
      const newStartsAt = new Date(
        schoolLocalToUtc(session.selected_date, selectedTime, config.school_timezone),
      );

      const { newLesson } = await commitReschedule({
        db,
        accountId,
        oldLesson: lesson,
        newStartsAt,
        config,
        actor: 'learner_button',
        bookedVia: 'button',
      });

      await db
        .from('reschedule_sessions')
        .update({
          completed_at: new Date().toISOString(),
          selected_slot: selectedTime,
          new_starts_at: newStartsAt.toISOString(),
          step: 'completed',
        })
        .eq('id', session.id);

      const dateStr = formatInSchoolTimezone(newLesson.starts_at, config.school_timezone, {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
      });
      const timeStr = formatInSchoolTimezone(newLesson.starts_at, config.school_timezone, {
        hour: '2-digit',
        minute: '2-digit',
      });

      await waService.sendTextMessage({
        accountId,
        phone: contactPhone,
        text: `✅ Your driving lesson has been successfully rescheduled!\n\n📅 Date: ${dateStr}\n🕐 Time: ${timeStr}\n👤 Instructor: ${lesson.instructor?.full_name ?? 'Your instructor'}\n\nSee you then! 🚗`,
      });
      return true;
    }

    return false;
  } catch (err) {
    console.error('[driving] handleDrivingButtonReply error:', err);
    await waService.sendTextMessage({
      accountId,
      phone: contactPhone,
      text: "Sorry, something went wrong updating your lesson. A staff member has been notified.",
    });
    return true;
  }
}
