// ============================================================
// Driving Agent — Deterministic guards.
//
// Rules that must hold regardless of what the LLM decides to do.
// ============================================================

/** Minimum completed driving LESSONS before a driving test / mock test can be booked. */
export const REQUIRED_LESSONS_FOR_TEST = 5;

/** A "driving test" in free text: driving/practical/mock test (theory tests are a separate thing). */
const TEST_PHRASE = /\b(driving|practical|mock)\s+test\b/i;

/**
 * Does this learner message talk about booking a driving test / mock test
 * (as opposed to booking ordinary driving lessons)?
 */
export function mentionsDrivingTest(text: string): boolean {
  if (!text) return false;
  return (
    TEST_PHRASE.test(text) ||
    /\b(book|booking|schedule|arrange|take|sit|put me in for)\b.{0,25}\b(my|a|the)\s+test\b/i.test(text) ||
    /\btest\s+(date|slot|booking)\b/i.test(text)
  );
}

/**
 * Is this booking a test (as opposed to a driving lesson)? A booking counts as a
 * test when it is typed `mock_test`, OR when the notes say it is for a driving/mock
 * test — so the 5-lesson gate cannot be bypassed by the model picking a different
 * `lesson_type`.
 */
export function isTestBooking(
  lessonType: string | null | undefined,
  notes?: string | null,
): boolean {
  if (lessonType === 'mock_test') return true;
  return !!notes && TEST_PHRASE.test(notes);
}

/**
 * Has the learner explicitly asked for a person, raised a complaint, or reported
 * something safety-related? Only then may the agent hand the chat to a human.
 */
export function wantsHuman(text: string): boolean {
  if (!text) return false;
  const t = text.toLowerCase();
  return (
    /\b(speak|talk|chat|connect|transfer|put me through|pass me|get me)\b.{0,30}\b(human|person|someone|somebody|instructor|manager|staff|team|owner|agent|receptionist)\b/.test(t) ||
    /\b(human|real person|live agent|real human|call me|ring me|phone me|give me a call)\b/.test(t) ||
    /\b(complain|complaint|refund|solicitor|lawyer|legal action|ombudsman|unacceptable)\b/.test(t) ||
    /\b(accident|injur(y|ed)|emergency|unsafe)\b/.test(t)
  );
}
