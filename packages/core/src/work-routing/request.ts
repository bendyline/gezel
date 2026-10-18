/**
 * What `suggest_work` ranks and what `start_work` binds: the person's own
 * words, not a coordinator's paraphrase of them. A paraphrase drops the
 * details that make the work theirs ("for the four of us", "a toddler"),
 * and a small model's paraphrase also adds words the routing detectors
 * read as intent ("Create a project…").
 */

const ANSWER_ENVELOPE_RE = /^\s*\[(?:Answer to:|The user wants you to proceed)/i;

/**
 * The request to route for this turn. An answer to a question the
 * coordinator asked ("[Answer to: …] Selected: A document") means nothing on
 * its own, so it is read together with the request it answers.
 */
export function routingRequestText(latest: string, previous?: string): string {
  const said = latest.trim();
  if (!ANSWER_ENVELOPE_RE.test(said) || !previous?.trim()) return said;
  return `${previous.trim()}\n\n${said}`;
}

export function isAnswerEnvelope(text: string): boolean {
  return ANSWER_ENVELOPE_RE.test(text);
}

const POLITE_LEAD_RE =
  /^\s*(?:(?:hi|hey|hello)[,!\s]+)?(?:(?:please|can\s+you|could\s+you|would\s+you|i\s+(?:want|need|would\s+like|'d\s+like)(?:\s+you)?\s+to|i\s+want|help\s+me(?:\s+to)?|let'?s)(?:[\s,]+|$))*/i;
const PROJECT_LEAD_RE =
  /^(?:start|create|make|set\s+up|spin\s+up|open)\s+(?:a\s+|an\s+|the\s+)?(?:new\s+)?project\s+(?:to|for|about|where)\s+/i;
const MAX_NAME_WORDS = 7;

/**
 * A project name from the person's sentence: its first clause, without the
 * polite lead-in or the "start a project to" frame, capped at seven words.
 * Deterministic, so a repeat of the same request finds the project it made.
 */
export function projectNameFromRequest(text: string, fallback = 'New project'): string {
  const unframed = text.replace(POLITE_LEAD_RE, '').replace(PROJECT_LEAD_RE, '');
  const clause = unframed.split(/[\n.!?;:,]/)[0] ?? '';
  const words = clause.trim().split(/\s+/).filter(Boolean).slice(0, MAX_NAME_WORDS);
  if (words.length === 0) return fallback;
  const name = words.join(' ');
  return name.charAt(0).toUpperCase() + name.slice(1);
}
