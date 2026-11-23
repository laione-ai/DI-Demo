// ============================================================
// Driving Agent — Intake script progress (one question at a time).
//
// The new-client enquiry is a queue of single questions. Each reply
// from the agent asks exactly ONE of them — the first one whose
// answer is not yet on file — the way a person texting would.
//
// Progress is worked out deterministically from the learner row in
// the database, so the model never has to guess where it is:
//
//    1  experience     "Had lessons before, or first time?"  (+ greeting)
//    2  language       "Happy chatting in English?"
//    3  full_name
//    4  age
//    5  postcode
//    6  licence        provisional / full
//    7  transmission   manual / automatic
//    8  goal           test-ready / confidence
//    9  frequency      lessons per week
//   10  schedule       preferred days / times
//   →  complete       check real availability and offer slots
//
// Safety valve: if the same question has already been asked
// MAX_ASKS times in this session and still isn't on file (the
// learner dodged it, or the model forgot to save it), it is skipped
// so the conversation can never loop on one question.
// ============================================================

import type { Learner } from '../types';

export type IntakeQuestionKey =
  | 'experience'
  | 'language'
  | 'full_name'
  | 'age'
  | 'postcode'
  | 'licence'
  | 'transmission'
  | 'goal'
  | 'frequency'
  | 'schedule';

export interface IntakeQuestion {
  key: IntakeQuestionKey;
  /** 1-based position in the script. */
  number: number;
  /** What we are trying to find out (for the model). */
  topic: string;
  /** One natural way to ask it. The model should vary the wording. */
  example: string;
  /** Which `update_learner_profile` field(s) the answer goes in. */
  saveAs: string;
}

/** How many times one question may be asked in a session before we move on. */
export const MAX_ASKS = 2;

export const INTAKE_QUESTIONS: readonly IntakeQuestion[] = [
  {
    key: 'experience',
    number: 1,
    topic: 'whether they have had driving lessons before',
    example: 'Have you had any driving lessons before, or would this be your first time behind the wheel?',
    saveAs: 'experience_level (e.g. "first time", "about 5 lessons, not driven for 6 months")',
  },
  {
    key: 'language',
    number: 2,
    topic: 'which language they would like to chat in',
    example: 'Are you happy chatting in English, or would another language be easier for you?',
    saveAs: 'preferred_language (e.g. "English", "Polish")',
  },
  {
    key: 'full_name',
    number: 3,
    topic: 'their full name',
    example: "What's your full name?",
    saveAs: 'full_name',
  },
  {
    key: 'age',
    number: 4,
    topic: 'their age',
    example: 'And how old are you?',
    saveAs: 'age',
  },
  {
    key: 'postcode',
    number: 5,
    topic: 'where they live (postcode or area)',
    example: 'Whereabouts are you based? Your postcode or just the area is fine.',
    saveAs: 'postcode',
  },
  {
    key: 'licence',
    number: 6,
    topic: 'whether they hold a provisional or full licence',
    example: 'Have you got your provisional licence yet?',
    saveAs: 'licence_type ("provisional" or "full")',
  },
  {
    key: 'transmission',
    number: 7,
    topic: 'manual or automatic lessons',
    example: 'Are you after manual or automatic lessons?',
    saveAs: 'transmission_preference ("manual" or "automatic")',
  },
  {
    key: 'goal',
    number: 8,
    topic: 'their goal (getting test-ready, or building confidence)',
    example: "What's the main goal: getting ready for your test, or more about building your confidence?",
    saveAs: 'goal',
  },
  {
    key: 'frequency',
    number: 9,
    topic: 'how many lessons a week they would like',
    example: 'Roughly how many lessons a week were you thinking?',
    saveAs: 'lessons_per_week',
  },
  {
    key: 'schedule',
    number: 10,
    topic: 'which days and times usually suit them',
    example: 'What days and times usually work best for you?',
    saveAs: 'preferred_days and/or preferred_times',
  },
];

export interface IntakeProgress {
  /** The single question to ask next, or null when intake is complete. */
  next: IntakeQuestion | null;
  /** Every question still unanswered, in script order (excluding skipped ones). */
  remaining: IntakeQuestionKey[];
  /** Questions given up on after MAX_ASKS attempts. */
  skipped: IntakeQuestionKey[];
  /** True once everything needed to offer slots is on file. */
  complete: boolean;
  /** True on the very first reply of a conversation (greet before asking). */
  firstContact: boolean;
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
    | 'language_confirmed'
  >
>;

export type IntakeAskCounts = Partial<Record<IntakeQuestionKey, number>>;

/** A name that is really just the learner's phone number. */
export function isPlaceholderName(name: string | null | undefined): boolean {
  if (!name) return true;
  return /^\+?[\d\s\-()]+$/.test(name.trim());
}

/** Is the answer to this question already on file? */
function isAnswered(key: IntakeQuestionKey, l: LearnerLike): boolean {
  switch (key) {
    case 'experience':
      return !!l.experience_level;
    case 'language':
      return !!l.language_confirmed;
    case 'full_name':
      return !isPlaceholderName(l.full_name) && !!l.name_confirmed;
    case 'age':
      return !!l.age;
    case 'postcode':
      return !!l.postcode;
    case 'licence':
      return !!l.licence_type;
    case 'transmission':
      return !!l.transmission_preference;
    case 'goal':
      return !!l.goal;
    case 'frequency':
      return !!l.lessons_per_week;
    case 'schedule':
      return (l.preferred_days?.length ?? 0) > 0 || (l.preferred_times?.length ?? 0) > 0;
  }
}

/**
 * Work out the next single question to ask.
 *
 * @param learner    The learner row (null when none exists yet).
 * @param turnCount  Number of agent replies already sent in this session.
 * @param asked      How many times each question has been asked in this session.
 */
export function getIntakeProgress(
  learner: LearnerLike | null | undefined,
  turnCount: number,
  asked: IntakeAskCounts = {},
): IntakeProgress {
  const l = learner ?? {};
  const remaining: IntakeQuestionKey[] = [];
  const skipped: IntakeQuestionKey[] = [];

  for (const q of INTAKE_QUESTIONS) {
    if (isAnswered(q.key, l)) continue;
    if ((asked[q.key] ?? 0) >= MAX_ASKS) {
      skipped.push(q.key);
      continue;
    }
    remaining.push(q.key);
  }

  const next = remaining.length
    ? INTAKE_QUESTIONS.find((q) => q.key === remaining[0]) ?? null
    : null;

  return {
    next,
    remaining,
    skipped,
    complete: next === null,
    firstContact: turnCount <= 0,
  };
}

/**
 * Render the "what to ask next" block for the system prompt.
 */
export function formatIntakeSection(p: IntakeProgress): string {
  const lines: string[] = [];

  lines.push('INTAKE PROGRESS (worked out from the database — trust it over your own guess):');

  if (p.next) {
    const later = p.remaining.slice(1);
    lines.push(`CURRENT QUESTION: Q${p.next.number} of ${INTAKE_QUESTIONS.length} — ${p.next.topic}`);
    lines.push(`Example wording (vary it, don't copy it every time): "${p.next.example}"`);
    lines.push(`When they answer, save it with \`update_learner_profile\` → ${p.next.saveAs}.`);
    if (later.length) {
      lines.push(`Still to come LATER, one per message (do NOT ask these now): ${later.join(', ')}.`);
    }
    lines.push('');
    lines.push('WHAT TO DO THIS TURN:');
    if (p.firstContact) {
      lines.push(
        '- This is the first reply. Open with a short, warm hello (one line), then ask the current question.',
      );
    } else {
      lines.push(
        '- React briefly and naturally to what they just said (a few words, not a formula), then ask the current question.',
      );
    }
    lines.push(
      '- If their message already answers the current question or any later ones, call `update_learner_profile` FIRST ' +
        'with everything they gave you. The system will then move you on to whatever is still missing — ask only that.',
    );
    lines.push(
      '- If they asked you something (prices, areas, how it works…), answer it in a sentence first, then ask the current question.',
    );
  } else {
    lines.push('All intake details are on file ✅ — do NOT re-ask any intake question.');
    lines.push(
      'Save any new day/time preferences with `update_learner_profile`, then call `list_instructors` and ' +
        '`get_instructor_availability` (matching their transmission, area and preferred days/times) and suggest ' +
        'two or three REAL open slots in one natural sentence, ending with one question (e.g. "Would any of those work?"). ' +
        'Book only after they clearly pick one. If they are asking about something else (reschedule, cancel, test, FAQ), handle that instead.',
    );
  }

  if (p.skipped.length) {
    lines.push(`(Skipped after asking twice — don't ask again unless they bring it up: ${p.skipped.join(', ')}.)`);
  }

  lines.push('');
  lines.push(
    'ONE QUESTION PER MESSAGE: every message you send contains at most one question mark. ' +
      'Never bundle questions, never send a list of things to fill in. ' +
      'Never end the conversation or hand it off part-way through intake.',
  );

  return lines.join('\n');
}
