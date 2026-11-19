// ============================================================
// Driving School — Lesson Service.
//
// Core CRUD and state machine management for driving lessons.
// All operations are scoped by account_id for multi-tenancy.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  Lesson,
  LessonStatus,
  CreateLessonRequest,
  DrivingSchoolConfig,
} from './types';
import { VALID_STATUS_TRANSITIONS } from './types';
import { loadSchoolConfig } from './config';
import { scheduleRemindersForLesson, cancelRemindersForLesson } from './reminder-service';

/**
 * Create a new driving lesson:
 *   1. Validate starts_at is in the future
 *   2. Compute ends_at from duration
 *   3. Insert row (EXCLUDE constraint guards against double-booking)
 *   4. Schedule reminders
 *   5. Write audit entry
 */
export async function createLesson(
  db: SupabaseClient,
  accountId: string,
  userId: string,
  input: CreateLessonRequest,
): Promise<Lesson> {
  const config = await loadSchoolConfig(db, accountId, userId);
  const durationMinutes = input.duration_minutes || config.default_lesson_minutes || 60;

  const startsAt = new Date(input.starts_at);
  if (startsAt.getTime() <= Date.now()) {
    throw new Error('Lesson start time must be in the future');
  }

  const endsAt = new Date(startsAt.getTime() + durationMinutes * 60 * 1000);

  const { data: lesson, error } = await db
    .from('lessons')
    .insert({
      account_id: accountId,
      user_id: userId,
      learner_id: input.learner_id,
      instructor_id: input.instructor_id,
      starts_at: startsAt.toISOString(),
      ends_at: endsAt.toISOString(),
      duration_minutes: durationMinutes,
      lesson_type: input.lesson_type || 'standard',
      notes: input.notes || null,
      status: 'scheduled',
      booked_via: 'staff',
    })
    .select('*, learner:learners(*), instructor:instructors(*)')
    .single();

  if (error) {
    if (error.code === '23P01') {
      throw new Error('This time slot conflicts with an existing lesson for this instructor');
    }
    throw error;
  }

  // Schedule reminders
  await scheduleRemindersForLesson(db, lesson as Lesson, config);

  // Write audit trail
  await db.from('lesson_audit').insert({
    lesson_id: lesson.id,
    account_id: accountId,
    action: 'created',
    old_status: null,
    new_status: 'scheduled',
    actor: userId,
    details: { booked_via: 'staff' },
  });

  return lesson as Lesson;
}

/**
 * Get a lesson by ID with joined learner and instructor.
 */
export async function getLesson(
  db: SupabaseClient,
  accountId: string,
  lessonId: string,
): Promise<Lesson | null> {
  const { data, error } = await db
    .from('lessons')
    .select('*, learner:learners(*), instructor:instructors(*), reminders:lesson_reminders(*)')
    .eq('id', lessonId)
    .eq('account_id', accountId)
    .maybeSingle();

  if (error) {
    console.error('[driving] getLesson error:', error);
    return null;
  }

  return data as Lesson | null;
}

/**
 * List lessons with flexible filtering.
 */
export async function listLessons(
  db: SupabaseClient,
  accountId: string,
  filter: {
    instructor_id?: string;
    learner_id?: string;
    status?: LessonStatus | LessonStatus[];
    from_date?: string;
    to_date?: string;
    limit?: number;
    offset?: number;
  } = {},
): Promise<{ data: Lesson[]; count: number }> {
  let query = db
    .from('lessons')
    .select('*, learner:learners(*), instructor:instructors(*)', { count: 'exact' })
    .eq('account_id', accountId);

  if (filter.instructor_id) query = query.eq('instructor_id', filter.instructor_id);
  if (filter.learner_id) query = query.eq('learner_id', filter.learner_id);

  if (filter.status) {
    if (Array.isArray(filter.status)) {
      query = query.in('status', filter.status);
    } else {
      query = query.eq('status', filter.status);
    }
  }

  if (filter.from_date) query = query.gte('starts_at', filter.from_date);
  if (filter.to_date) query = query.lte('starts_at', filter.to_date);

  query = query.order('starts_at', { ascending: true });

  if (filter.limit !== undefined) {
    const offset = filter.offset || 0;
    query = query.range(offset, offset + filter.limit - 1);
  }

  const { data, count, error } = await query;

  if (error) {
    console.error('[driving] listLessons error:', error);
    return { data: [], count: 0 };
  }

  return { data: (data ?? []) as Lesson[], count: count ?? 0 };
}

/**
 * Count the number of completed lessons for a learner.
 * Used to verify the 5-lesson minimum prerequisite before booking a test.
 */
export async function countCompletedLessons(
  db: SupabaseClient,
  accountId: string,
  learnerId: string,
): Promise<{ completedInDb: number; baseCompleted: number; totalCompleted: number }> {
  // 1. Query learner's recorded lessons_completed base count
  const { data: learner } = await db
    .from('learners')
    .select('lessons_completed')
    .eq('id', learnerId)
    .eq('account_id', accountId)
    .maybeSingle();

  const baseCompleted = learner?.lessons_completed || 0;

  // 2. Query completed lessons in the database
  const { count: completedInDb } = await db
    .from('lessons')
    .select('*', { count: 'exact', head: true })
    .eq('learner_id', learnerId)
    .eq('account_id', accountId)
    .eq('status', 'completed');

  const inDb = completedInDb || 0;
  const totalCompleted = Math.max(baseCompleted, inDb);

  return {
    completedInDb: inDb,
    baseCompleted,
    totalCompleted,
  };
}

/**
 * Transition a lesson to a new status enforcing state machine rules.
 */
export async function transitionLesson(
  db: SupabaseClient,
  accountId: string,
  lessonId: string,
  newStatus: LessonStatus,
  actor: string,
  details: Record<string, unknown> = {},
): Promise<Lesson> {
  const current = await getLesson(db, accountId, lessonId);
  if (!current) throw new Error('Lesson not found');

  const allowed = VALID_STATUS_TRANSITIONS[current.status];
  if (!allowed.includes(newStatus)) {
    throw new Error(`Cannot transition lesson from ${current.status} to ${newStatus}`);
  }

  const updates: Record<string, unknown> = {
    status: newStatus,
    updated_at: new Date().toISOString(),
  };

  if (newStatus === 'confirmed') {
    updates.confirmed_at = new Date().toISOString();
  } else if (newStatus === 'cancelled') {
    updates.cancelled_at = new Date().toISOString();
    if (details.reason) updates.cancellation_reason = details.reason;
  } else if (newStatus === 'completed') {
    updates.completed_at = new Date().toISOString();
  }

  const { data: updated, error } = await db
    .from('lessons')
    .update(updates)
    .eq('id', lessonId)
    .eq('account_id', accountId)
    .select('*, learner:learners(*), instructor:instructors(*)')
    .single();

  if (error || !updated) throw error || new Error('Failed to update lesson');

  // Cancel pending reminders if moved to terminal state
  if (['cancelled', 'completed', 'no_show'].includes(newStatus)) {
    await cancelRemindersForLesson(db, lessonId);
  }

  // Write audit entry
  await db.from('lesson_audit').insert({
    lesson_id: lessonId,
    account_id: accountId,
    action: `transition_to_${newStatus}`,
    old_status: current.status,
    new_status: newStatus,
    actor,
    details,
  });

  return updated as Lesson;
}

/**
 * Find the most relevant upcoming lesson for a learner by phone.
 */
export async function findActiveLessonForLearner(
  db: SupabaseClient,
  accountId: string,
  learnerPhone: string,
): Promise<Lesson | null> {
  const { data: learner } = await db
    .from('learners')
    .select('id')
    .eq('account_id', accountId)
    .eq('phone', learnerPhone)
    .maybeSingle();

  if (!learner) return null;

  const now = new Date().toISOString();
  const { data: lesson } = await db
    .from('lessons')
    .select('*, learner:learners(*), instructor:instructors(*)')
    .eq('account_id', accountId)
    .eq('learner_id', learner.id)
    .in('status', ['scheduled', 'reminder_sent', 'confirmed', 'pending_approval'])
    .gte('starts_at', now)
    .order('starts_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  return (lesson as Lesson) ?? null;
}

/**
 * Auto-complete past lessons (cron job).
 */
export async function autoCompleteLessons(db: SupabaseClient): Promise<number> {
  const now = new Date().toISOString();

  // 1. Confirmed lessons that have ended -> 'completed'
  const { data: pastConfirmed } = await db
    .from('lessons')
    .select('id, learner_id, account_id')
    .in('status', ['confirmed'])
    .lt('ends_at', now);

  let updatedCount = 0;
  for (const lesson of pastConfirmed ?? []) {
    await db
      .from('lessons')
      .update({ status: 'completed', completed_at: now })
      .eq('id', lesson.id);

    // Increment learner's lessons_completed counter
    await db.rpc('increment_learner_lessons', { learner_id: lesson.learner_id }).catch(() => {
      // Fallback to manual update
      db.from('learners')
        .update({ lessons_completed: (lesson as any).lessons_completed + 1 })
        .eq('id', lesson.learner_id);
    });

    updatedCount++;
  }

  // 2. Unconfirmed scheduled/reminder_sent past lessons -> 'no_show'
  const { data: pastUnconfirmed } = await db
    .from('lessons')
    .select('id')
    .in('status', ['scheduled', 'reminder_sent'])
    .lt('ends_at', now);

  for (const lesson of pastUnconfirmed ?? []) {
    await db
      .from('lessons')
      .update({ status: 'no_show' })
      .eq('id', lesson.id);
    updatedCount++;
  }

  return updatedCount;
}
