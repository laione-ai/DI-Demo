import { describe, it, expect } from 'vitest';
import {
  getIntakeProgress,
  formatIntakeSection,
  isPlaceholderName,
  INTAKE_QUESTIONS,
  MAX_ASKS,
} from '../intake-flow';

const blank = { full_name: '+447700900301', name_confirmed: false };

const everything = {
  full_name: 'Ahmed',
  name_confirmed: true,
  language_confirmed: true,
  age: 24,
  postcode: 'EALING',
  licence_type: 'provisional' as const,
  experience_level: 'around 5 lessons',
  transmission_preference: 'manual' as const,
  goal: 'pass test',
  lessons_per_week: 2,
  preferred_days: ['friday'],
  preferred_times: ['evening'],
};

describe('getIntakeProgress — one question at a time', () => {
  it('asks about previous lessons first, and flags the first contact', () => {
    const p = getIntakeProgress(blank, 0);
    expect(p.next?.key).toBe('experience');
    expect(p.firstContact).toBe(true);
    expect(p.complete).toBe(false);
  });

  it('walks the questions in script order as each answer is saved', () => {
    const order = INTAKE_QUESTIONS.map((q) => q.key);
    const learner: Record<string, unknown> = { ...blank };
    const seen: string[] = [];
    const answers: Record<string, Record<string, unknown>> = {
      experience: { experience_level: 'first time' },
      language: { language_confirmed: true },
      full_name: { full_name: 'Ahmed Khan', name_confirmed: true },
      age: { age: 24 },
      postcode: { postcode: 'SW17' },
      licence: { licence_type: 'provisional' },
      transmission: { transmission_preference: 'manual' },
      goal: { goal: 'pass test' },
      frequency: { lessons_per_week: 2 },
      schedule: { preferred_days: ['friday'] },
    };
    for (let turn = 0; turn < 20; turn++) {
      const p = getIntakeProgress(learner, turn);
      if (!p.next) break;
      seen.push(p.next.key);
      Object.assign(learner, answers[p.next.key]);
    }
    expect(seen).toEqual(order);
    expect(getIntakeProgress(learner, 10).complete).toBe(true);
  });

  it('skips questions the learner already answered up front (never re-asks)', () => {
    const p = getIntakeProgress(
      { ...blank, experience_level: '5 lessons', full_name: 'Ahmed', name_confirmed: true, age: 24 },
      1,
    );
    expect(p.next?.key).toBe('language');
    expect(p.remaining).not.toContain('age');
    expect(p.remaining).not.toContain('full_name');
  });

  it('treats an unconfirmed or phone-number name as unanswered', () => {
    const base = { ...everything };
    expect(getIntakeProgress({ ...base, name_confirmed: false }, 3).next?.key).toBe('full_name');
    expect(getIntakeProgress({ ...base, full_name: '+447700900301' }, 3).next?.key).toBe('full_name');
  });

  it('is complete once everything is on file', () => {
    const p = getIntakeProgress(everything, 30);
    expect(p.complete).toBe(true);
    expect(p.next).toBeNull();
  });

  it(`gives up on a question after it has been asked ${MAX_ASKS} times (no loops)`, () => {
    const p = getIntakeProgress({ ...everything, age: null }, 8, { age: MAX_ASKS });
    expect(p.skipped).toContain('age');
    expect(p.complete).toBe(true);
    // one ask is not enough to skip
    expect(getIntakeProgress({ ...everything, age: null }, 8, { age: 1 }).next?.key).toBe('age');
  });

  it('handles a missing learner row', () => {
    expect(getIntakeProgress(null, 0).next?.key).toBe('experience');
  });
});

describe('formatIntakeSection', () => {
  it('names exactly one current question and defers the rest', () => {
    const text = formatIntakeSection(getIntakeProgress({ ...blank, experience_level: 'x' }, 1));
    expect(text).toContain('CURRENT QUESTION: Q2');
    expect(text).toContain('do NOT ask these now');
    expect(text).toContain('ONE QUESTION PER MESSAGE');
    expect(text).toContain('Never end the conversation or hand it off');
  });

  it('greets only on the first reply', () => {
    expect(formatIntakeSection(getIntakeProgress(blank, 0))).toContain('first reply');
    expect(formatIntakeSection(getIntakeProgress(blank, 2))).not.toContain('first reply');
  });

  it('once complete, tells the model to check real availability and not re-ask', () => {
    const text = formatIntakeSection(getIntakeProgress(everything, 9));
    expect(text).toContain('get_instructor_availability');
    expect(text).toContain('do NOT re-ask any intake question');
    expect(text).not.toContain('CURRENT QUESTION');
  });
});

describe('isPlaceholderName', () => {
  it('detects phone-number names', () => {
    expect(isPlaceholderName('+44 7700 900301')).toBe(true);
    expect(isPlaceholderName('Ahmed')).toBe(false);
    expect(isPlaceholderName(null)).toBe(true);
  });
});
