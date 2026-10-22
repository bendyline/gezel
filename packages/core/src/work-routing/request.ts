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

const SOURCE_FILE_RE =
  /(?:^|[\s`'"(])(?:[\w.-]+\/)*[a-z_][\w.-]*\.(?:[cm]?[jt]sx?|py|rb|go|rs|java|kt|swift|c|cc|cpp|h|hpp|cs|php|scala|sh|sql|vue|svelte)\b/;
const REPO_URL_RE =
  /\bhttps?:\/\/(?:www\.)?(?:github\.com|gitlab\.com|bitbucket\.org|codeberg\.org)\/[\w.-]+\/[\w.-]+/i;
const FAILING_TEST_RE =
  /\b(?:failing\s+(?:tests?|specs?|builds?|checks?)|tests?\s+(?:fail|are\s+failing|keep\s+failing|is\s+failing))\b/i;
const CODE_CHANGE_RE =
  /\b(?:bug(?:gy|s)?|fix(?:e[sd]|ing)?|broken|break(?:s|ing)?|crash(?:es|ed|ing)?|debug(?:s|ged|ging)?|refactor(?:s|ed|ing)?|review(?:s|ed|ing)?|fail(?:s|ed|ing)?|errors?|exceptions?|regressions?)\b/i;

/**
 * Work on code that already exists: the request points at it and asks for a
 * fix or a review. `files` when it names source files or failing tests, which
 * live in some project; `repository` when it names a hosted repository, which
 * has to be fetched before anyone can work on it. Nothing new is being built,
 * so neither a new project nor a recipe matched on the code's subject fits: a
 * cart-total bug read to the embedder as billing and was offered Invoice
 * Generator, and a review of src/pricing.js was offered Pricing Page first
 * (2026-10-22).
 *
 * The file pattern wants a lowercase or path-qualified name, so product names
 * ("Node.js", "D3.js") do not count as code being pointed at.
 */
export function existingCodeTarget(text: string): 'files' | 'repository' | undefined {
  if (!CODE_CHANGE_RE.test(text)) return undefined;
  if (REPO_URL_RE.test(text)) return 'repository';
  if (SOURCE_FILE_RE.test(text) || FAILING_TEST_RE.test(text)) return 'files';
  return undefined;
}

export function looksLikeExistingCodeRequest(text: string): boolean {
  return existingCodeTarget(text) !== undefined;
}
