/**
 * Does this message ask a question or for an opinion, rather than for work?
 *
 * `suggest_work` puts "answer it yourself" first when this holds, so a
 * coordinator is not handed a menu of projects for "what can you do?". The
 * turn-intent check (`looksLikeWorkRequest`) is not enough on its own: it is
 * anchored to the start of the message and reads any "can you" as a request,
 * so it called both "What can you do?" and "Quick question, no need to start
 * anything: … SQLite or Postgres" work.
 *
 * "Explain …", "is it possible to …" and "I was wondering if you could …"
 * are deliberately not cues: each is as often a polite request for work
 * (explaining a code folder is a craftbook) as a question.
 */

const ADVICE_CUE_RE =
  /\b(?:should\s+(?:i|we)|would\s+you\s+(?:lean|recommend|suggest|pick|choose|go\s+with)|which\s+(?:is|one|would|should|do\s+you)|is\s+it\s+(?:better|worth)|what(?:'s|\s+is)\s+the\s+difference|pros\s+and\s+cons|what\s+do\s+you\s+(?:think|recommend|suggest)|what\s+can\s+you\s+do|who\s+are\s+you|how\s+do\s+(?:i|you|we)|how\s+does|why\s+(?:is|does|do|did))\b/i;

/**
 * Said outright, this settles it whatever else the sentence asks for. The
 * no-action notes ("Heads up: Theo is debugging accept.mjs … You don't need
 * to do anything — just confirm you've seen this note") read as work on their
 * verbs, so the work-options prelude handed the coordinator a list of
 * debugging and migration recipes to start (2026-10-22). A bare "heads up" or
 * "FYI" is not a cue: "FYI the build is failing, can you fix it?" is work.
 */
const NO_WORK_CUE_RE =
  /\b(?:quick\s+question|no\s+need\s+to\s+(?:start|create|make|build|set\s+up)|just\s+curious|(?:(?:you\s+)?(?:don['’]?t|do\s+not)|no)\s+need\s+to\s+do\s+anything|no\s+action\s+(?:is\s+)?(?:needed|required)|just\s+confirm\s+(?:that\s+)?(?:you(?:['’]ve|\s+have)\s+)?(?:seen|read|received|got)\b|just\s+(?:fyi|so\s+you\s+know|letting\s+you\s+know))\b/i;

/**
 * Words that make a question-shaped sentence a request for work. "What should
 * we eat this week? Two of us, no meat, cheap dinners please." asks for a meal
 * plan, and "should we" alone read it as advice, so Meal Planner was never
 * offered (S1, 2026-10-17). "Help me understand …" stays a question.
 */
const REQUEST_MARKER_RE =
  /\b(?:please|help\s+(?:me|us)\s+(?:get|learn|practi[cs]e|plan|improve|build|make|organi[sz]e|track|prepare|write|start|run|keep)|i(?:'d|\s+would)\s+like\s+you\s+to)\b/i;

const ARITHMETIC_RE = /^\s*(?:what(?:'s|\s+is)\s+)?[\d\s.,+\-*/×x÷()^%=]+\??\s*$/i;

const INTERROGATIVE_OPEN_RE =
  /^\s*(?:how|what|why|when|where|who|which|is|are|was|were|can|could|did|do|does|will|would|should|has|have)\b/i;

/**
 * Verbs that turn a question-shaped sentence into a request for something
 * made: "Can you create a PowerPoint?" is work, "Can you hear me?" is not.
 */
const PRODUCTION_VERB_RE =
  /\b(?:build|convert|create|design|draft|edit|export|generate|make|plan|prepare|produce|render|revise|summari[sz]e|translate|turn|update|write|organi[sz]e|clean|tidy|review|fix|analy[sz]e|find|research|compare|set\s+up|start)\b/i;

export function looksLikeQuestionOrAdvice(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) return false;
  if (ARITHMETIC_RE.test(normalized) && /\d/.test(normalized)) return true;
  if (NO_WORK_CUE_RE.test(normalized)) return true;
  if (REQUEST_MARKER_RE.test(normalized)) return false;
  if (ADVICE_CUE_RE.test(normalized)) return true;
  return (
    INTERROGATIVE_OPEN_RE.test(normalized) &&
    /\?\s*$/.test(normalized) &&
    !PRODUCTION_VERB_RE.test(normalized)
  );
}
