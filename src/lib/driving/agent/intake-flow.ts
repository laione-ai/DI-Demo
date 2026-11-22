// ============================================================
// Driving Agent — Intake script progress.
//
// The new-client enquiry follows a fixed 6-step script (see the
// prompt). Left to itself the model improvises, skips steps or
// re-asks things. This module works out — deterministically, from
// what is in the database plus how many replies have been sent —
// which step the conversation is on and what is still missing, so
// the prompt can tell the model exactly what to do next.
//
//   Step 1  Welcome + "first time or had lessons before?"
//   Step 2  Language preference
//   Step 3  Core details (name, age, postcode, licence, experience)
//   Step 4  Transmission, goal, lessons per week
//   Step 5  Preferred days / times
//   Step 6  Check real availability and propose slots
// ============================================================

import type { Learner } from '../types';

export type IntakeStep = 1 | 2 | 3 | 4 | 5 | 6;

export interface IntakeProgress {
  step: IntakeStep;
  /** Core details still missing (drives step 3). */
  missingCore: string[];
  /** Lesson preferences still missing (drives step 4). */
  missingPrefs: string[];
  /** True once days/times are known (step 5 done). */
  scheduleKnown: boolean;
}

type LearnerLike = Partial<
  Pick<
    Learner,
    | 'full_name'
    | 'name_confirmed'
    | 'age'
    | 'postcode'
    | 'licence_type'
    | 'experience_level'
    | 'transmission_preference'
    | 'goal'
    | 'lessons_per_week'
    | 'preferred_days'
    | 'preferred_times'
  >
>;

/** A name that is really just the learner's phone number. */
export function isPlaceholderName(name: string | null | undefined): boolean {
  if (!name) return true;
  return /^\+?[\d\s\-()]+$/.test(name.trim());
}

/**
 * Work out which script step the conversation is on.
 *
 * @param learner    The learner row (null when none exists yet).
 * @param turnCount  Number of assistant replies already sent in this session.
 */
export function getIntakeProgress(
  learner: LearnerLike | null | undefined,
  turnCount: number,
): IntakeProgress {
  const l = learner ?? {};

  const missingCore: string[] = [];
  if (isPlaceholderName(l.full_name) || !l.name_confirmed) missingCore.push('full name');
  if (!l.age) missingCore.push('age');
  if (!l.postcode) missingCore.push('postcode or area');
  if (!l.licence_type) missingCore.push('licence type (provisional or full)');
  if (!l.experience_level) missingCore.push('previous driving experience');

  const missingPrefs: string[] = [];
  if (!l.transmission_preference) missingPrefs.push('manual or automatic');
  if (!l.goal) missingPrefs.push('goal (e.g. passing their test or building confidence)');
  if (!l.lessons_per_week) missingPrefs.push('lessons per week');

  const scheduleKnown =
    (l.preferred_days?.length ?? 0) > 0 || (l.preferred_times?.length ?? 0) > 0;

  let step: IntakeStep;
  if (missingCore.length > 0) {
    // Steps 1-3 are driven by how far into the script we are, because the
    // first two questions (experience, language) leave no trace in the DB.
    step = turnCount <= 0 ? 1 : turnCount === 1 ? 2 : 3;
  } else if (missingPrefs.length > 0) {
    step = 4;
  } else if (!scheduleKnown) {
    step = 5;
  } else {
    step = 6;
  }

  return { step, missingCore, missingPrefs, scheduleKnown };
}

/**
 * Render the "where are we in the script" block for the system prompt.
 */
export function formatIntakeSection(p: IntakeProgress): string {
  const lines: string[] = [];

  lines.push('INTAKE PROGRESS (worked out from the database and this conversation — trust it over your own guess):');
  lines.push(
    `- Core details still missing: ${p.missingCore.length ? p.missingCore.join(', ') : 'none ✅'}`,
  );
  lines.push(
    `- Lesson preferences still missing: ${p.missingPrefs.length ? p.missingPrefs.join(', ') : 'none ✅'}`,
  );
  lines.push(`- Preferred days/times: ${p.scheduleKnown ? 'known ✅' : 'not yet asked / not yet given'}`);
  lines.push('');
  lines.push(`CURRENT STEP: Step ${p.step}`);

  switch (p.step) {
    case 1:
      lines.push('Send the Step 1 message (welcome + "first time or had lessons before?"). Nothing else.');
      break;
    case 2:
      lines.push(
        'Acknowledge their answer with empathy, then send the Step 2 message (language preference). Nothing else.',
      );
      break;
    case 3:
      lines.push(
        'Send the Step 3 message asking for the details above that are still missing. ' +
          'If their latest message already contains any of them, call `update_learner_profile` FIRST, ' +
          'then ask only for what is still missing. If they just told you their preferred language, save it too.',
      );
      break;
    case 4:
      lines.push(
        'Thank them by name, then send the Step 4 message (manual/automatic, goal, lessons per week) — ' +
          'asking only for the preferences listed as missing. If their latest message already contains ' +
          'any of them, call `update_learner_profile` first.',
      );
      break;
    case 5:
      lines.push(
        'Send the Step 5 message ("I\'ve got all your details… which days or times work best?"). ' +
          'If their latest message already gave days/times, call `update_learner_profile` ' +
          '(preferred_days, preferred_times) and move on to Step 6 instead.',
      );
      break;
    case 6:
      lines.push(
        'All intake details are on file. Do NOT re-ask any intake question. ' +
          'Save any newly-given days/times with `update_learner_profile`, call `list_instructors` and ' +
          '`get_instructor_availability` (match their transmission, area and preferred days/times), then offer ' +
          'the best REAL open slots. Book only after they explicitly confirm a slot. ' +
          'If they are asking about something else (reschedule, cancel, test, FAQ) handle that instead.',
      );
      break;
  }

  lines.push('');
  lines.push(
    'SCRIPT DISCIPLINE: send only the message for the current step (adapt names/acknowledgements naturally). ' +
      'Do not skip ahead, merge steps, or ask for anything already on file. ' +
      'Never end the conversation or hand it off part-way through intake — keep going step by step until ' +
      'the learner has been offered real slots and a booking is confirmed.',
  );

  return lines.join('\n');
}
