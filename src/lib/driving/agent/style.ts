// ============================================================
// Driving Agent — Reply style guard.
//
// The prompt asks the model to text like a person: short, plain,
// one question at a time. Models drift, so this runs on every reply
// before it is sent and enforces the parts that can be enforced
// deterministically:
//
//   - at most ONE question per message (anything after the first
//     question is dropped — it gets asked on a later turn)
//   - no markdown that WhatsApp would show literally (**bold**, # headings)
//   - no walls of blank lines
// ============================================================

const URL_RE = /https?:\/\/\S+/g;

/** Count question marks outside URLs. */
export function countQuestions(text: string): number {
  return (text.replace(URL_RE, '').match(/\?/g) ?? []).length;
}

/**
 * Keep everything up to and including the first question; drop the rest.
 * Question marks inside URLs are ignored. Text with 0–1 questions is unchanged.
 */
export function limitToOneQuestion(text: string): string {
  if (countQuestions(text) <= 1) return text;

  // Mask URLs (same length, no '?') so indexes line up with the original.
  const masked = text.replace(URL_RE, (url) => 'x'.repeat(url.length));
  const first = masked.indexOf('?');
  if (first === -1) return text;

  // Keep closing quotes/brackets and emoji that belong to the question ("…time? 😊").
  const hug = /^(?:["')\]]|[ \t]?(?:\p{Extended_Pictographic}️?)+)*/u.exec(text.slice(first + 1));
  const end = first + 1 + (hug ? hug[0].length : 0);
  return text.slice(0, end).trimEnd();
}

/** Remove markdown WhatsApp would display literally, and tidy whitespace. */
export function stripMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Apply every style rule to a model-written reply. */
export function humanizeReply(text: string): string {
  if (!text) return text;
  return limitToOneQuestion(stripMarkdown(text));
}
