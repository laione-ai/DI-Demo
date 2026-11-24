// ============================================================
// Driving Agent — Memory of availability already looked up.
//
// The session only keeps the TEXT of past turns, not tool results.
// Without this, when a learner says "Thursday at 10 please" on the
// next turn, the model no longer has the instructor's id or the exact
// slot. It guesses, and the booking tools fail ("Instructor not
// found"). The spec called for this: persist the options actually shown
// so a later "the second one" resolves unambiguously.
//
// After every successful get_instructor_availability call, the engine
// stores a compact copy in the session (`slots.looked_up`) and the
// prompt shows it back to the model on every later turn.
// ============================================================

import type { LookedUpAvailability } from '../types';

const MAX_DAYS = 14;
const MAX_TIMES_PER_DAY = 12;

/** Parse a get_instructor_availability tool result into a compact memory entry. */
export function rememberAvailability(
  toolContent: string,
  checkedAt: Date = new Date(),
): LookedUpAvailability | null {
  let parsed: {
    error?: string;
    instructor_id?: string;
    instructor_name?: string;
    available_days?: Array<{
      date: string;
      day_name: string;
      available_slots: Array<{ time: string }>;
    }>;
  };
  try {
    parsed = JSON.parse(toolContent);
  } catch {
    return null;
  }
  if (!parsed || parsed.error || !parsed.instructor_id || !Array.isArray(parsed.available_days)) {
    return null;
  }

  return {
    instructor_id: parsed.instructor_id,
    instructor_name: parsed.instructor_name ?? 'Instructor',
    checked_at: checkedAt.toISOString(),
    days: parsed.available_days.slice(0, MAX_DAYS).map((d) => ({
      date: d.date,
      day_name: d.day_name,
      times: (d.available_slots ?? []).slice(0, MAX_TIMES_PER_DAY).map((s) => s.time.slice(0, 5)),
    })),
  };
}

/** Render remembered availability for the system prompt. */
export function formatLookedUpSection(
  entries: LookedUpAvailability[],
  timezone: string,
  now: Date = new Date(),
): string | null {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);

  const blocks = entries
    .map((e) => {
      const days = e.days.filter((d) => d.date >= today && d.times.length > 0);
      if (!days.length) return null;
      const lines = days.map((d) => {
        const label = new Date(d.date + 'T12:00:00Z').toLocaleDateString('en-GB', {
          weekday: 'short',
          day: 'numeric',
          month: 'short',
          timeZone: 'UTC',
        });
        return `  - ${label} (date ${d.date}): ${d.times.join(', ')}`;
      });
      return `${e.instructor_name} (id ${e.instructor_id}):\n${lines.join('\n')}`;
    })
    .filter((b): b is string => !!b);

  if (!blocks.length) return null;

  return (
    `AVAILABILITY YOU ALREADY CHECKED (real open start times, UK time):\n` +
    `${blocks.join('\n')}\n` +
    `When the learner picks one of these, book it straight away with \`create_booking\` using that instructor id, ` +
    `the date and the time exactly as written above. No need to check again unless they want different days. ` +
    `If the booking tool says a time isn't open (it may have just been taken), offer one of the open times it lists.`
  );
}
