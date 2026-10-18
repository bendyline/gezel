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
  /\b(?:should\s+(?:i|we)|would\s+you\s+(?:lean|recommend|suggest|pick|choose|go\s+with)|which\s+(?:is|one|would|should|do\s+you)|is\s+it\s+(?:better|worth)|what(?:'s|\s+is)\s+the\s+difference|pros\s+and\s+cons|what\s+do\s+you\s+(?:think|recommend|suggest)|what\s+can\s+you\s+do|who\s+are\s+you|how\s+do\s+(?:i|you|we)|how\s+does|why\s+(?:is|does|do|did)|quick\s+question|no\s+need\s+to\s+(?:start|create|make|build|set\s+up)|just\s+curious)\b/i;

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
  if (ADVICE_CUE_RE.test(normalized)) return true;
  return (
    INTERROGATIVE_OPEN_RE.test(normalized) &&
    /\?\s*$/.test(normalized) &&
    !PRODUCTION_VERB_RE.test(normalized)
  );
}
