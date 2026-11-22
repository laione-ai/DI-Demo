import { describe, it, expect } from 'vitest';
import { getIntakeProgress, formatIntakeSection, isPlaceholderName } from '../intake-flow';

const blank = { full_name: '+447700900301', name_confirmed: false };

const core = {
  full_name: 'Ahmed',
  name_confirmed: true,
  age: 24,
  postcode: 'EALING',
  licence_type: 'provisional' as const,
  experience_level: 'around 5 lessons',
};

const prefs = {
  transmission_preference: 'manual' as const,
  goal: 'pass test',
  lessons_per_week: 2,
};

describe('getIntakeProgress — the 6-step enquiry script', () => {
  it('step 1: brand new learner, no replies sent yet', () => {
    expect(getIntakeProgress(blank, 0).step).toBe(1);
  });

  it('step 2 (language) after the first reply, step 3 (details) after the second', () => {
    expect(getIntakeProgress(blank, 1).step).toBe(2);
    expect(getIntakeProgress(blank, 2).step).toBe(3);
    expect(getIntakeProgress(blank, 5).step).toBe(3);
  });

  it('step 3 lists exactly what is still missing', () => {
    const p = getIntakeProgress({ ...blank, age: 24 }, 2);
    expect(p.step).toBe(3);
    expect(p.missingCore).toContain('full name');
    expect(p.missingCore).toContain('postcode or area');
    expect(p.missingCore).not.toContain('age');
  });

  it('step 4 once core details are saved', () => {
    const p = getIntakeProgress({ ...core }, 3);
    expect(p.step).toBe(4);
    expect(p.missingPrefs).toHaveLength(3);
  });

  it('step 5 once preferences are saved but days/times are not', () => {
    expect(getIntakeProgress({ ...core, ...prefs }, 4).step).toBe(5);
  });

  it('step 6 once days/times are known — and stays there', () => {
    const l = { ...core, ...prefs, preferred_days: ['friday'], preferred_times: ['evening'] };
    expect(getIntakeProgress(l, 5).step).toBe(6);
    expect(getIntakeProgress(l, 30).step).toBe(6);
  });

  it('skips ahead when the learner volunteers details early (never re-asks)', () => {
    expect(getIntakeProgress({ ...core }, 0).step).toBe(4);
  });

  it('treats an unconfirmed or phone-number name as missing', () => {
    expect(getIntakeProgress({ ...core, name_confirmed: false }, 3).missingCore).toContain('full name');
    expect(getIntakeProgress({ ...core, full_name: '+447700900301' }, 3).missingCore).toContain('full name');
  });

  it('handles a missing learner row', () => {
    expect(getIntakeProgress(null, 0).step).toBe(1);
  });
});

describe('formatIntakeSection', () => {
  it('names the current step and forbids skipping or hand-offs', () => {
    const text = formatIntakeSection(getIntakeProgress({ ...core }, 3));
    expect(text).toContain('CURRENT STEP: Step 4');
    expect(text).toContain('SCRIPT DISCIPLINE');
    expect(text).toContain('Never end the conversation or hand it off');
  });

  it('step 6 tells the model to check real availability and not re-ask intake', () => {
    const l = { ...core, ...prefs, preferred_days: ['friday'] };
    const text = formatIntakeSection(getIntakeProgress(l, 5));
    expect(text).toContain('CURRENT STEP: Step 6');
    expect(text).toContain('get_instructor_availability');
    expect(text).toContain('Do NOT re-ask any intake question');
  });
});

describe('isPlaceholderName', () => {
  it('detects phone-number names', () => {
    expect(isPlaceholderName('+44 7700 900301')).toBe(true);
    expect(isPlaceholderName('Ahmed')).toBe(false);
    expect(isPlaceholderName(null)).toBe(true);
  });
});
