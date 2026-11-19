// ============================================================
// Driving School — Configuration loader & defaults.
//
// Loads the per-account driving_school_config row, falling back
// to sensible UK defaults when no row exists yet.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import type { DrivingSchoolConfig } from './types';

/** Sensible defaults used when no config row exists yet. */
export const DRIVING_DEFAULTS = {
  school_name: 'LessonDesk Driving School',
  school_timezone: 'Europe/London',
  reminder_initial_minutes: 720,    // 12 hours
  reminder_final_minutes: 60,       // 1 hour
  reminder_followup_interval: 180,  // 3 hours between follow-ups
  default_lesson_minutes: 60,       // 1 hour standard driving lesson
  demo_mode: true,
  agent_enabled: false,
} as const;

/**
 * Load the driving school config for an account, creating a default
 * row if none exists. Uses the service-role client so it can be
 * called from cron/webhook paths that bypass RLS.
 */
export async function loadSchoolConfig(
  db: SupabaseClient,
  accountId: string,
  userId?: string,
): Promise<DrivingSchoolConfig> {
  const { data, error } = await db
    .from('driving_school_config')
    .select('*')
    .eq('account_id', accountId)
    .maybeSingle();

  if (error) {
    console.error('[driving] failed to load school config:', error);
    // Return defaults as a fallback so callers never crash
    return {
      id: '',
      account_id: accountId,
      user_id: userId ?? '',
      school_name: DRIVING_DEFAULTS.school_name,
      school_phone: null,
      school_address: null,
      school_timezone: DRIVING_DEFAULTS.school_timezone,
      reminder_initial_minutes: DRIVING_DEFAULTS.reminder_initial_minutes,
      reminder_final_minutes: DRIVING_DEFAULTS.reminder_final_minutes,
      reminder_followup_interval: DRIVING_DEFAULTS.reminder_followup_interval,
      default_lesson_minutes: DRIVING_DEFAULTS.default_lesson_minutes,
      demo_mode: DRIVING_DEFAULTS.demo_mode,
      agent_enabled: DRIVING_DEFAULTS.agent_enabled,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
  }

  if (data) return data as DrivingSchoolConfig;

  // No config row yet — create one with defaults (needs userId)
  if (!userId) {
    return {
      id: '',
      account_id: accountId,
      user_id: '',
      ...DRIVING_DEFAULTS,
      school_phone: null,
      school_address: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
  }

  const { data: created, error: createErr } = await db
    .from('driving_school_config')
    .insert({
      account_id: accountId,
      user_id: userId,
      ...DRIVING_DEFAULTS,
    })
    .select()
    .single();

  if (createErr) {
    console.error('[driving] failed to create default config:', createErr);
    return {
      id: '',
      account_id: accountId,
      user_id: userId,
      ...DRIVING_DEFAULTS,
      school_phone: null,
      school_address: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
  }

  return created as DrivingSchoolConfig;
}

/**
 * Format a UTC date to school-local display string in Europe/London.
 */
export function formatInSchoolTimezone(
  utcDate: string | Date,
  timezone: string = 'Europe/London',
  options?: Intl.DateTimeFormatOptions,
): string {
  const date = typeof utcDate === 'string' ? new Date(utcDate) : utcDate;
  return date.toLocaleString('en-GB', {
    timeZone: timezone,
    ...options,
  });
}

/**
 * Get "now" in the school's timezone as a Date reference.
 */
export function schoolNow(timezone: string = 'Europe/London'): Date {
  return new Date();
}

/**
 * Convert a local UK time string ("10:30") on a specific date
 * to a UTC ISO string.
 */
export function schoolLocalToUtc(
  date: string,       // "2026-03-20"
  time: string,       // "10:30"
  timezone: string = 'Europe/London',
): string {
  const dtStr = `${date}T${time}:00`;

  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  const tempDate = new Date(dtStr + 'Z');
  const parts = formatter.formatToParts(tempDate);
  const getPart = (type: string) =>
    parts.find((p) => p.type === type)?.value ?? '00';

  const utcInTz = new Date(
    `${getPart('year')}-${getPart('month')}-${getPart('day')}T${getPart('hour')}:${getPart('minute')}:${getPart('second')}Z`,
  );

  const offsetMs = utcInTz.getTime() - tempDate.getTime();
  const actualUtc = new Date(tempDate.getTime() - offsetMs);
  return actualUtc.toISOString();
}

/**
 * Get the day-of-week key for a date in the school timezone.
 */
export function getDayKey(
  date: Date | string,
  timezone: string = 'Europe/London',
): 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun' {
  const d = typeof date === 'string' ? new Date(date) : date;
  const dayName = d.toLocaleDateString('en-GB', {
    timeZone: timezone,
    weekday: 'short',
  }).toLowerCase();

  const mapping: Record<string, 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun'> = {
    mon: 'mon', tue: 'tue', wed: 'wed', thu: 'thu',
    fri: 'fri', sat: 'sat', sun: 'sun',
  };
  return mapping[dayName] ?? 'mon';
}

/**
 * Get the date string (YYYY-MM-DD) for a Date in the school timezone.
 */
export function getDateInTimezone(date: Date, timezone: string = 'Europe/London'): string {
  return date.toLocaleDateString('en-CA', { timeZone: timezone });
}
