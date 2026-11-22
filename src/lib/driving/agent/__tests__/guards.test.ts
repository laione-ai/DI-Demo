import { describe, it, expect } from 'vitest';
import { mentionsDrivingTest, isTestBooking, wantsHuman, REQUIRED_LESSONS_FOR_TEST } from '../guards';

describe('mentionsDrivingTest — a test is not a lesson', () => {
  it.each([
    'I want to book my driving test',
    'Can I book a mock test for next week?',
    'can you arrange my practical test',
    'I need a test date',
    'put me in for the test',
  ])('detects: %s', (text) => {
    expect(mentionsDrivingTest(text)).toBe(true);
  });

  it.each([
    "Hi, I'm looking for driving lessons",
    'I want to pass my test and probably two lessons a week',
    'Manual. Two lessons a week please',
    'I live near the test centre',
    'I need to do my theory test first',
  ])('does NOT trigger for: %s', (text) => {
    expect(mentionsDrivingTest(text)).toBe(false);
  });
});

describe('isTestBooking', () => {
  it('flags mock_test lessons', () => {
    expect(isTestBooking('mock_test')).toBe(true);
  });

  it('flags a "standard" booking whose notes say it is a driving test (gate cannot be bypassed)', () => {
    expect(isTestBooking('standard', 'for my driving test')).toBe(true);
  });

  it('does not flag ordinary lessons', () => {
    expect(isTestBooking('standard')).toBe(false);
    expect(isTestBooking('intensive', 'pick up from Ealing Broadway')).toBe(false);
    expect(isTestBooking(null, null)).toBe(false);
  });
});

describe('wantsHuman — the only time the bot may hand off', () => {
  it.each([
    'Can I speak to a real person?',
    'I want to talk to my instructor',
    'please call me',
    'I would like to make a complaint',
    'I need a refund',
    'there was an accident',
  ])('true: %s', (text) => {
    expect(wantsHuman(text)).toBe(true);
  });

  it.each([
    'Weekday evenings, preferably Friday',
    'English is fine.',
    'My name is Ahmed. I\'m 24, live in Ealing, and I have a provisional licence.',
    'I want to book my driving test',
    '',
  ])('false: %s', (text) => {
    expect(wantsHuman(text)).toBe(false);
  });
});

describe('constants', () => {
  it('requires 5 lessons', () => {
    expect(REQUIRED_LESSONS_FOR_TEST).toBe(5);
  });
});
