// ============================================================
// Driving School — Demo & Seed Data.
//
// Populates an account with demo instructors, learners, and
// driving lessons to test the agent immediately.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import { loadSchoolConfig } from './config';

export async function seedDrivingSchoolData(
  db: SupabaseClient,
  accountId: string,
  userId: string,
): Promise<{ instructors: number; learners: number; lessons: number }> {
  // 1. Ensure driving school config exists
  await loadSchoolConfig(db, accountId, userId);

  // 2. Insert Instructors
  const instructorsData = [
    {
      account_id: accountId,
      user_id: userId,
      full_name: 'James Wilson',
      transmission_type: 'manual',
      phone: '+447700900101',
      email: 'james.wilson@lessondesk.example',
      badge_reference: 'ADI/123456',
      badge_verified: true,
      service_areas: ['W5', 'W13', 'W3', 'UB1', 'UB2'],
      booking_mode: 'auto',
      is_active: true,
      lesson_duration_minutes: 60,
      default_hours: {
        mon: { start: '09:00', end: '18:00' },
        tue: { start: '09:00', end: '18:00' },
        wed: { start: '09:00', end: '18:00' },
        thu: { start: '09:00', end: '18:00' },
        fri: { start: '09:00', end: '18:00' },
        sat: { start: '10:00', end: '16:00' },
        sun: null,
      },
    },
    {
      account_id: accountId,
      user_id: userId,
      full_name: 'Sarah Ahmed',
      transmission_type: 'both',
      phone: '+447700900102',
      email: 'sarah.ahmed@lessondesk.example',
      badge_reference: 'ADI/789012',
      badge_verified: true,
      service_areas: ['E1', 'E2', 'E3', 'E14', 'EC'],
      booking_mode: 'auto',
      is_active: true,
      lesson_duration_minutes: 60,
      default_hours: {
        mon: { start: '08:30', end: '17:30' },
        tue: { start: '08:30', end: '17:30' },
        wed: { start: '08:30', end: '17:30' },
        thu: { start: '08:30', end: '17:30' },
        fri: { start: '08:30', end: '17:30' },
        sat: { start: '09:00', end: '15:00' },
        sun: null,
      },
    },
  ];

  const insertedInstructors: any[] = [];
  for (const inst of instructorsData) {
    const { data } = await db
      .from('instructors')
      .upsert(inst, { onConflict: 'account_id,phone' })
      .select()
      .single();
    if (data) insertedInstructors.push(data);
  }

  // 3. Insert Learners (UK numbers & profiles)
  // Include one learner with < 5 lessons (Ahmed) and one with >= 5 lessons (Chloe) to test eligibility
  const learnersData = [
    {
      account_id: accountId,
      user_id: userId,
      full_name: 'Ahmed Khan',
      phone: '+447700900201',
      name_confirmed: true,
      age: 24,
      postcode: 'W5 2AA',
      licence_type: 'provisional',
      transmission_preference: 'manual',
      experience_level: 'Had around 5 lessons previously, hasn’t driven for 6 months',
      lessons_completed: 3, // < 5 lessons -> NOT eligible for mock test yet
      goal: 'Pass driving test',
      preferred_days: ['fri', 'sat'],
      preferred_times: ['evening'],
      lessons_per_week: 2,
    },
    {
      account_id: accountId,
      user_id: userId,
      full_name: 'Chloe Taylor',
      phone: '+447700900202',
      name_confirmed: true,
      age: 19,
      postcode: 'E1 6AN',
      licence_type: 'provisional',
      transmission_preference: 'automatic',
      experience_level: 'Advanced learner',
      lessons_completed: 8, // >= 5 lessons -> ELIGIBLE for mock test!
      goal: 'Prepare for driving test next month',
      preferred_days: ['mon', 'wed'],
      preferred_times: ['morning'],
      lessons_per_week: 1,
    },
    {
      account_id: accountId,
      user_id: userId,
      full_name: 'Liam Davies',
      phone: '+447700900203',
      name_confirmed: true,
      age: 28,
      postcode: 'W13 0PL',
      licence_type: 'full',
      transmission_preference: 'manual',
      experience_level: 'Passed test 5 years ago, needs refresher',
      lessons_completed: 0,
      goal: 'Confidence building on motorways',
    },
  ];

  const insertedLearners: any[] = [];
  for (const lrn of learnersData) {
    const { data } = await db
      .from('learners')
      .upsert(lrn, { onConflict: 'account_id,phone' })
      .select()
      .single();
    if (data) insertedLearners.push(data);
  }

  // 4. Insert Lessons
  let lessonCount = 0;
  if (insertedInstructors.length > 0 && insertedLearners.length > 0) {
    const now = new Date();
    const inst1 = insertedInstructors[0];
    const inst2 = insertedInstructors[1] || inst1;

    // Upcoming lessons
    const tomorrow10am = new Date(now);
    tomorrow10am.setDate(tomorrow10am.getDate() + 1);
    tomorrow10am.setHours(10, 0, 0, 0);

    const tomorrow11am = new Date(tomorrow10am);
    tomorrow11am.setHours(11, 0, 0, 0);

    const fridayEvening = new Date(now);
    fridayEvening.setDate(fridayEvening.getDate() + ((5 + 7 - fridayEvening.getDay()) % 7 || 7));
    fridayEvening.setHours(17, 0, 0, 0);
    const fridayEveningEnd = new Date(fridayEvening);
    fridayEveningEnd.setHours(18, 0, 0, 0);

    const sampleLessons = [
      {
        account_id: accountId,
        user_id: userId,
        instructor_id: inst1.id,
        learner_id: insertedLearners[0].id,
        starts_at: tomorrow10am.toISOString(),
        ends_at: tomorrow11am.toISOString(),
        duration_minutes: 60,
        lesson_type: 'standard',
        status: 'confirmed',
        booked_via: 'agent',
      },
      {
        account_id: accountId,
        user_id: userId,
        instructor_id: inst2.id,
        learner_id: insertedLearners[1].id,
        starts_at: fridayEvening.toISOString(),
        ends_at: fridayEveningEnd.toISOString(),
        duration_minutes: 60,
        lesson_type: 'mock_test',
        status: 'confirmed',
        booked_via: 'agent',
      },
    ];

    for (const lsn of sampleLessons) {
      const { error } = await db.from('lessons').insert(lsn);
      if (!error) lessonCount++;
    }
  }

  return {
    instructors: insertedInstructors.length,
    learners: insertedLearners.length,
    lessons: lessonCount,
  };
}
