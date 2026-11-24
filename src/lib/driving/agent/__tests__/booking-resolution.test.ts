import { describe, it, expect } from 'vitest';
import { executeTool, resolveInstructor, resolveStart, type ToolExecutionContext } from '../tools';
import { checkSlotBookable } from '../../availability-service';
import { rememberAvailability, formatLookedUpSection } from '../availability-memory';
import { buildDrivingAgentPrompt } from '../prompt';
import type { DrivingSchoolConfig, Instructor } from '../../types';

// ---------------------------------------------------------------------------
// A tiny fake Supabase client: tracks .eq() filters per query and answers
// from in-memory tables. A non-UUID id on instructors.single() errors, like
// Postgres does ("invalid input syntax for type uuid").
// ---------------------------------------------------------------------------

const KEVIN_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const SAM_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const UUID = /^[0-9a-f-]{36}$/i;

const allDays = { start: '09:00', end: '17:00' };
const hours = { mon: allDays, tue: allDays, wed: allDays, thu: allDays, fri: allDays, sat: allDays, sun: allDays };

type Row = Record<string, unknown>;

function makeDb(opts: {
  instructors?: Row[];
  overrides?: Row[];
  lessons?: Row[];
}) {
  const tables: Record<string, Row[]> = {
    instructors: opts.instructors ?? [
      { id: KEVIN_ID, full_name: 'Kevin', is_active: true, account_id: 'acc', default_hours: hours, min_notice_hours: 2 },
    ],
    instructor_availability: opts.overrides ?? [],
    lessons: opts.lessons ?? [],
  };

  return {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const rows = () =>
        (tables[table] ?? []).filter((r) =>
          Object.entries(filters).every(([k, v]) => k === 'instructor_id' || r[k] === undefined || r[k] === v),
        );
      const q: Record<string, unknown> = {
        select: () => q,
        gte: () => q,
        lte: () => q,
        not: () => q,
        order: () => q,
        eq: (k: string, v: unknown) => {
          filters[k] = v;
          return q;
        },
        single: async () => {
          if (table === 'instructors' && typeof filters.id === 'string' && !UUID.test(filters.id)) {
            return { data: null, error: { message: 'invalid input syntax for type uuid' } };
          }
          const r = rows()[0];
          return r ? { data: r, error: null } : { data: null, error: { message: 'not found' } };
        },
        then: (resolve: (v: unknown) => void) => resolve({ data: rows(), error: null }),
      };
      return q;
    },
  } as unknown as ToolExecutionContext['db'];
}

/** A date N days from today (UTC calendar), as YYYY-MM-DD. */
function daysFromNow(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const config = {
  id: 'cfg',
  account_id: 'acc',
  user_id: 'usr',
  school_name: 'LessonDesk Driving School',
  school_timezone: 'Europe/London',
  default_lesson_minutes: 60,
  demo_mode: true,
  agent_enabled: true,
} as DrivingSchoolConfig;

function ctx(db: ToolExecutionContext['db']): ToolExecutionContext {
  return {
    db,
    accountId: 'acc',
    userId: 'usr',
    phone: '+447700900201',
    learnerId: 'lrn',
    config,
    conversationId: 'conv',
    waMessageId: 'wam',
    waService: {} as ToolExecutionContext['waService'],
  };
}

// ---------------------------------------------------------------------------

describe('resolveInstructor — the bug from the logs', () => {
  it('accepts the real id', async () => {
    const r = await resolveInstructor(makeDb({}), 'acc', KEVIN_ID);
    expect(r.ok && r.instructor.id).toBe(KEVIN_ID);
  });

  it('accepts a name ("Kevin", "kevin", first name of a full name)', async () => {
    const db = makeDb({
      instructors: [
        { id: KEVIN_ID, full_name: 'Kevin Walsh', is_active: true, account_id: 'acc' },
        { id: SAM_ID, full_name: 'Sam Patel', is_active: true, account_id: 'acc' },
      ],
    });
    for (const ref of ['Kevin', 'kevin', 'Kevin Walsh', ' KEVIN ']) {
      const r = await resolveInstructor(db, 'acc', ref);
      expect(r.ok && r.instructor.id, ref).toBe(KEVIN_ID);
    }
  });

  it('with only one instructor, a missing ref means them', async () => {
    const r = await resolveInstructor(makeDb({}), 'acc', undefined);
    expect(r.ok && r.instructor.full_name).toBe('Kevin');
  });

  it('an unknown ref returns the valid ids so the model can fix itself', async () => {
    const r = await resolveInstructor(makeDb({}), 'acc', 'inst_1');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toContain(`Kevin (id ${KEVIN_ID})`);
  });
});

describe('resolveStart — date + time in UK time', () => {
  it('converts winter (GMT) and summer (BST) correctly', () => {
    expect(resolveStart('2026-11-26', '10:00', undefined, 'Europe/London')).toBe('2026-11-26T10:00:00.000Z');
    expect(resolveStart('2026-06-18', '10:00', undefined, 'Europe/London')).toBe('2026-06-18T09:00:00.000Z');
    expect(resolveStart('2026-06-18', '9:30', undefined, 'Europe/London')).toBe('2026-06-18T08:30:00.000Z');
  });

  it('falls back to an ISO datetime, and rejects garbage', () => {
    expect(resolveStart(undefined, undefined, '2026-11-26T10:00:00Z', 'Europe/London')).toBe('2026-11-26T10:00:00.000Z');
    expect(resolveStart('Thursday', '10am', undefined, 'Europe/London')).toBeNull();
    expect(resolveStart(undefined, undefined, 'next week', 'Europe/London')).toBeNull();
  });
});

describe('checkSlotBookable — server-side guard', () => {
  const day = daysFromNow(5);
  const at = (t: string) => resolveStart(day, t, undefined, 'Europe/London')!;

  it('accepts a real open slot', async () => {
    const r = await checkSlotBookable(makeDb({}), 'acc', KEVIN_ID, at('10:00'));
    expect(r.ok).toBe(true);
  });

  it('rejects off-grid times, breaks, out-of-hours and booked slots — and lists the open ones', async () => {
    const db = makeDb({
      overrides: [{ available_date: day, start_time: '09:00', end_time: '13:00', breaks: [{ start: '11:00', end: '12:00' }] }],
      lessons: [{ starts_at: at('09:00'), ends_at: at('10:00'), status: 'confirmed' }],
    });
    for (const t of ['10:30', '11:00', '15:00', '09:00', '03:00']) {
      const r = await checkSlotBookable(db, 'acc', KEVIN_ID, at(t));
      expect(r.ok, t).toBe(false);
      if (!r.ok) expect(r.openTimes).toEqual(['10:00', '12:00']);
    }
  });

  it('respects minimum notice', async () => {
    const soon = new Date(Date.now() + 30 * 60 * 1000);
    soon.setUTCMinutes(0, 0, 0);
    const r = await checkSlotBookable(makeDb({}), 'acc', KEVIN_ID, soon.toISOString());
    expect(r.ok).toBe(false);
  });

  it('a 2-hour lesson needs two free slots in a row', async () => {
    const db = makeDb({ lessons: [{ starts_at: at('11:00'), ends_at: at('12:00'), status: 'confirmed' }] });
    expect((await checkSlotBookable(db, 'acc', KEVIN_ID, at('09:00'), 'Europe/London', 60, 120)).ok).toBe(true);
    expect((await checkSlotBookable(db, 'acc', KEVIN_ID, at('10:00'), 'Europe/London', 60, 120)).ok).toBe(false);
  });
});

describe('tools end-to-end with the name instead of the id', () => {
  it('get_instructor_availability("Kevin") works instead of "Instructor not found"', async () => {
    const r = await executeTool(
      { id: 't1', name: 'get_instructor_availability', arguments: { instructor_id: 'Kevin' } },
      ctx(makeDb({})),
    );
    const parsed = JSON.parse(r.result.content);
    expect(parsed.error).toBeUndefined();
    expect(parsed.instructor_id).toBe(KEVIN_ID);
    expect(parsed.instructor_name).toBe('Kevin');
    expect(parsed.available_days.length).toBeGreaterThan(5);
  });

  it('create_booking refuses a time that is not open and says which times are', async () => {
    const day = daysFromNow(5);
    const r = await executeTool(
      { id: 't2', name: 'create_booking', arguments: { instructor_id: 'Kevin', date: day, time: '03:00' } },
      ctx(makeDb({})),
    );
    const err = JSON.parse(r.result.content).error as string;
    expect(err).toContain('Not booked');
    expect(err).toContain('09:00, 10:00');
    expect(r.lesson).toBeUndefined();
  });
});

describe('availability memory across turns', () => {
  const toolContent = JSON.stringify({
    instructor_id: KEVIN_ID,
    instructor_name: 'Kevin',
    available_days: [
      { date: '2099-01-01', day_name: 'Thursday', available_slots: [{ time: '10:00' }, { time: '11:00' }] },
      { date: '2099-01-02', day_name: 'Friday', available_slots: [] },
    ],
  });

  it('remembers a successful lookup and ignores errors', () => {
    const m = rememberAvailability(toolContent);
    expect(m?.instructor_id).toBe(KEVIN_ID);
    expect(m?.days[0].times).toEqual(['10:00', '11:00']);
    expect(rememberAvailability(JSON.stringify({ error: 'nope' }))).toBeNull();
    expect(rememberAvailability('not json')).toBeNull();
  });

  it('shows the remembered slots, with the id, in the next turn\'s prompt', () => {
    const m = rememberAvailability(toolContent)!;
    const section = formatLookedUpSection([m], 'Europe/London')!;
    expect(section).toContain(`Kevin (id ${KEVIN_ID})`);
    expect(section).toContain('(date 2099-01-01): 10:00, 11:00');
    expect(section).not.toContain('2099-01-02'); // no empty days

    const prompt = buildDrivingAgentPrompt({
      config,
      learnerLessons: [],
      instructors: [{ id: KEVIN_ID, full_name: 'Kevin', transmission_type: 'both' } as Instructor],
      lookedUpAvailability: [m],
    });
    expect(prompt).toContain(`Kevin (id ${KEVIN_ID}`);
    expect(prompt).toContain('AVAILABILITY YOU ALREADY CHECKED');
    expect(prompt).toContain('Never ask the learner for permission to retry');
  });

  it('drops days that are already in the past', () => {
    const old = { ...rememberAvailability(toolContent)!, days: [{ date: '2000-01-01', day_name: 'Saturday', times: ['10:00'] }] };
    expect(formatLookedUpSection([old], 'Europe/London')).toBeNull();
  });
});
