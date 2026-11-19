// ============================================================
// Driving School — Shared Reschedule Logic.
//
// Shared by both the interactive WhatsApp button handler and
// the AI agent tool executor.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Lesson, DrivingSchoolConfig } from './types';
import { loadSchoolConfig } from './config';
import { scheduleRemindersForLesson, cancelRemindersForLesson } from './reminder-service';

export interface CommitRescheduleArgs {
  db: SupabaseClient;
  accountId: string;
  oldLesson: Lesson;
  newStartsAt: Date;
  config?: DrivingSchoolConfig;
  newInstructorId?: string;
  actor: string;
  bookedVia?: string;
}

export interface CommitRescheduleResult {
  newLesson: Lesson;
}

/**
 * Execute a reschedule:
 *   1. Calculate ends_at based on duration
 *   2. Insert the new lesson row
 *   3. Mark the old lesson as 'rescheduled'
 *   4. Cancel old reminders, schedule new ones
 *   5. Write audit entries
 */
export async function commitReschedule(
  args: CommitRescheduleArgs,
): Promise<CommitRescheduleResult> {
  const {
    db,
    accountId,
    oldLesson,
    newStartsAt,
    newInstructorId,
    actor,
    bookedVia = 'agent',
  } = args;

  const durationMinutes = oldLesson.duration_minutes || 60;
  const newEndsAt = new Date(newStartsAt.getTime() + durationMinutes * 60 * 1000);
  const instructorId = newInstructorId || oldLesson.instructor_id;

  const config =
    args.config ?? (await loadSchoolConfig(db, accountId, oldLesson.user_id));

  // 1. Insert new lesson
  const { data: newLesson, error: insertErr } = await db
    .from('lessons')
    .insert({
      account_id: accountId,
      user_id: oldLesson.user_id,
      learner_id: oldLesson.learner_id,
      instructor_id: instructorId,
      starts_at: newStartsAt.toISOString(),
      ends_at: newEndsAt.toISOString(),
      duration_minutes: durationMinutes,
      status: 'confirmed',
      lesson_type: oldLesson.lesson_type,
      notes: oldLesson.notes,
      rescheduled_from_id: oldLesson.id,
      booked_via: bookedVia,
      calendar_uid: oldLesson.calendar_uid, // preserve stable calendar UID across reschedules
      confirmed_at: new Date().toISOString(),
    })
    .select('*, learner:learners(*), instructor:instructors(*)')
    .single();

  if (insertErr || !newLesson) {
    throw insertErr || new Error('Failed to create rescheduled lesson');
  }

  // 2. Mark old lesson as rescheduled
  const { error: updateErr } = await db
    .from('lessons')
    .update({
      status: 'rescheduled',
      rescheduled_to_id: newLesson.id,
      updated_at: new Date().toISOString(),
    })
    .eq('id', oldLesson.id)
    .eq('account_id', accountId);

  if (updateErr) {
    console.warn('[driving] failed to update old lesson status on reschedule:', updateErr);
  }

  // 3. Cancel reminders for old lesson, schedule for new lesson
  await cancelRemindersForLesson(db, oldLesson.id);
  await scheduleRemindersForLesson(db, newLesson as Lesson, config);

  // 4. Audit entries
  await db.from('lesson_audit').insert([
    {
      lesson_id: oldLesson.id,
      account_id: accountId,
      action: 'rescheduled',
      old_status: oldLesson.status,
      new_status: 'rescheduled',
      actor,
      details: { rescheduled_to_id: newLesson.id },
    },
    {
      lesson_id: newLesson.id,
      account_id: accountId,
      action: 'created_via_reschedule',
      old_status: null,
      new_status: 'confirmed',
      actor,
      details: { rescheduled_from_id: oldLesson.id },
    },
  ]);

  return { newLesson: newLesson as Lesson };
}
