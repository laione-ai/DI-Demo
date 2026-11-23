// ============================================================
// Driving School — Availability Service.
//
// Calculates available lesson slots for an instructor on a
// given date, considering:
//   1. Default weekly hours (from instructors.default_hours)
//   2. Per-day overrides (instructor_availability)
//   3. Breaks (lunch, travel, etc.)
//   4. Existing booked lessons
//   5. Lesson duration (default 60 mins)
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Instructor, DayAvailability, AvailableSlot } from './types';
import { getDayKey, schoolLocalToUtc, getDateInTimezone } from './config';

/**
 * Get available slots for an instructor on a range of dates.
 */
export async function getAvailableSlots(
  db: SupabaseClient,
  accountId: string,
  instructorId: string,
  fromDate: string,  // "2026-03-20"
  toDate: string,    // "2026-03-27"
  timezone: string = 'Europe/London',
  durationMinutes: number = 60,
): Promise<DayAvailability[]> {
  // Load instructor
  const { data: instructor, error: instErr } = await db
    .from('instructors')
    .select('*')
    .eq('id', instructorId)
    .eq('account_id', accountId)
    .single();

  if (instErr || !instructor) {
    throw new Error('Instructor not found');
  }

  // Load overrides for the date range
  const { data: overrides } = await db
    .from('instructor_availability')
    .select('*')
    .eq('instructor_id', instructorId)
    .gte('available_date', fromDate)
    .lte('available_date', toDate);

  const overrideMap = new Map(
    (overrides ?? []).map((o) => [o.available_date, o]),
  );

  // Load existing lessons for the date range
  const fromUtc = schoolLocalToUtc(fromDate, '00:00', timezone);
  const toUtc = schoolLocalToUtc(toDate, '23:59', timezone);

  const { data: bookedLessons } = await db
    .from('lessons')
    .select('starts_at, ends_at, status')
    .eq('instructor_id', instructorId)
    .eq('account_id', accountId)
    .gte('starts_at', fromUtc)
    .lte('starts_at', toUtc)
    .not('status', 'in', '("cancelled","rescheduled")');

  const bookedSlots = (bookedLessons ?? []).map((a) => ({
    start: new Date(a.starts_at).getTime(),
    end: new Date(a.ends_at).getTime(),
  }));

  // Generate days
  const days: DayAvailability[] = [];
  const current = new Date(fromDate + 'T00:00:00Z');
  const end = new Date(toDate + 'T00:00:00Z');

  while (current <= end) {
    const dateStr = current.toISOString().split('T')[0];
    const dayName = current.toLocaleDateString('en-GB', {
      weekday: 'long',
      timeZone: 'UTC',
    });

    const dayKey = getDayKey(current, 'UTC');
    const override = overrideMap.get(dateStr);

    let dayStart: string | null = null;
    let dayEnd: string | null = null;
    let breaks: Array<{ start: string; end: string }> = [];

    if (override) {
      dayStart = override.start_time;
      dayEnd = override.end_time;
      breaks = override.breaks ?? [];
    } else {
      const defaultDay = (instructor as Instructor).default_hours?.[dayKey];
      if (defaultDay) {
        dayStart = defaultDay.start;
        dayEnd = defaultDay.end;
      }
    }

    if (!dayStart || !dayEnd) {
      // Day off
      days.push({ date: dateStr, day_name: dayName, slots: [] });
      current.setUTCDate(current.getUTCDate() + 1);
      continue;
    }

    // Generate time slots
    const slots = generateSlots(
      dateStr,
      dayStart,
      dayEnd,
      breaks,
      durationMinutes,
      timezone,
      bookedSlots,
    );

    days.push({ date: dateStr, day_name: dayName, slots });
    current.setUTCDate(current.getUTCDate() + 1);
  }

  return days;
}

/**
 * Generate time slots for a single day.
 */
function generateSlots(
  dateStr: string,
  dayStart: string,
  dayEnd: string,
  breaks: Array<{ start: string; end: string }>,
  durationMinutes: number,
  timezone: string,
  bookedSlots: Array<{ start: number; end: number }>,
): AvailableSlot[] {
  const slots: AvailableSlot[] = [];

  const startMinutes = timeToMinutes(dayStart);
  const endMinutes = timeToMinutes(dayEnd);
  const now = Date.now();

  for (let m = startMinutes; m + durationMinutes <= endMinutes; m += durationMinutes) {
    const timeStr = minutesToTime(m);
    const slotEndStr = minutesToTime(m + durationMinutes);

    // Check if slot overlaps with a break
    const inBreak = breaks.some((b) => {
      const breakStart = timeToMinutes(b.start);
      const breakEnd = timeToMinutes(b.end);
      return m < breakEnd && m + durationMinutes > breakStart;
    });

    if (inBreak) continue;

    // Convert to UTC for comparison
    const slotUtcStart = schoolLocalToUtc(dateStr, timeStr, timezone);
    const slotUtcEnd = schoolLocalToUtc(dateStr, slotEndStr, timezone);
    const slotStartMs = new Date(slotUtcStart).getTime();
    const slotEndMs = new Date(slotUtcEnd).getTime();

    // Skip past slots
    if (slotStartMs < now) {
      continue;
    }

    // Check if overlaps with any booked lesson
    const isBooked = bookedSlots.some(
      (b) => slotStartMs < b.end && slotEndMs > b.start,
    );

    slots.push({
      time: timeStr,
      datetime: slotUtcStart,
      available: !isBooked,
    });
  }

  return slots;
}

function timeToMinutes(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

function minutesToTime(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
}

/**
 * Get the next N available dates with at least one open slot.
 */
export async function getNextAvailableDates(
  db: SupabaseClient,
  accountId: string,
  instructorId: string,
  timezone: string = 'Europe/London',
  count: number = 3,
  durationMinutes: number = 60,
): Promise<string[]> {
  const dates: string[] = [];
  const today = new Date();
  const maxDaysAhead = 30;

  // Start from today (i = 0): slots already in the past are skipped by generateSlots.
  for (let i = 0; i <= maxDaysAhead && dates.length < count; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() + i);
    const dateStr = getDateInTimezone(d, timezone);

    const availability = await getAvailableSlots(
      db,
      accountId,
      instructorId,
      dateStr,
      dateStr,
      timezone,
      durationMinutes,
    );

    if (availability[0]?.slots.some((s) => s.available)) {
      dates.push(dateStr);
    }
  }

  return dates;
}
