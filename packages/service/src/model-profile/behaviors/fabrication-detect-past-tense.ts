/**
 * `fabrication.detect-past-tense-no-tools` — when zero tool calls
 * fired this turn AND the assistant text contains a past-tense
 * action claim or ≥2 bracket placeholders, attach a user-visible
 * warning to the persisted assistant message.
 *
 * Two independent signals:
 *
 *   1. **Bracket placeholders** — ≥ 2 distinct `[CapitalizedThing]`
 *      patterns. Real bracketed citations like `[2024]` (numeric) or
 *      markdown links `[text](url)` don't count. Two separate
 *      placeholders is the unambiguous "I'm making this up" signal —
 *      single placeholders happen in legitimate prose.
 *   2. **Past-tense action verbs** — phrases like "I have navigated",
 *      "I have loaded", "I have retrieved" with no matching tool
 *      call this turn. These verbs imply tool invocation; using them
 *      without a tool fire is fabrication.
 *
 * Does NOT re-prompt — retrying just produces more fabrication. The
 * warning surfaces the broken trust to the user; they decide whether
 * to switch providers or start a fresh session.
 *
 * Migrated verbatim from `chat/hallucination-detector.ts`'s
 * `detectHallucinatedToolUse`.
 */

import type { Behavior, NudgeVerdict, TurnCtx } from '../types.js';

const PLACEHOLDER_RE = /\[([A-Z][A-Za-z0-9 _/]{1,40})\]/g;

const ACTION_VERBS = [
  'navigated',
  'loaded',
  'retrieved',
  'fetched',
  'pulled',
  'downloaded',
  'opened',
  'accessed',
  'read',
  'wrote',
  'created',
  'searched',
  'queried',
  'looked up',
  'clicked',
  'typed',
  'submitted',
  'sent',
  'snapshotted',
  'taken a snapshot',
  'taken the snapshot',
  'crawled',
  'scraped',
  'analyzed',
  'analysed',
  'compiled',
  'executed',
  'ran',
  'invoked',
  'called',
  // Meester / team-management lexicon. The Meester's about.md trains
  // the model on "kickoff task" / "kick off the project" / "spin up a
  // voorman" / "recruit a designer" / "wire them in" — so when the
  // model fabricates a `start_project` / `ensure_gezel` /
  // `update_project` call, these are the verbs it reaches for, NOT
  // "created". Wild-caught on a Meester (Kenji) MLX session where
  // "I've kicked off the project" produced no tool fire and slid
  // past the detector. Includes singular verbs where the prompt's
  // own vocabulary is the lead indicator of fabrication.
  'kicked off',
  'spun up',
  'recruited',
  'wired in',
  'set up',
  'assigned',
  'started',
  'spawned',
];

const ACTION_VERB_RE = new RegExp(
  // First-person past-tense framing ("I have", "I've", "I just",
  // "I successfully", "I already") optionally followed by an adverb
  // ("successfully", "already", "now", "just", "finally") then the
  // action verb. Accepts both "I have loaded" and "I have
  // successfully loaded" — the model often inserts the adverb to
  // sound competent about a thing it didn't actually do.
  String.raw`\bI(?:\s+have|'ve|\s+just|\s+successfully|\s+already)` +
    String.raw`(?:\s+(?:successfully|already|just|now|finally))?\s+(?:` +
    ACTION_VERBS.join('|') +
    String.raw`)\b`,
  'i',
);

// Third-person tool-result claim. Catches the shape where the model
// asserts a tool / specialist returned content WITHOUT calling first-
// person verbs the primary regex anchors on. Wild-caught on
// gemma4-26b/MLX Breno session: `ask_specialist` failed
// with `reason: 'self'`, model retried, both failed, then emitted
// "The specialist has weighed in with a breakdown of the top three
// options:" followed by a fully fabricated comparison table.
//
// Strict-subject + strict-verb matching keeps false-positive risk
// low: only fires when the subject is one of the result-shaped nouns
// AND the verb is a result-delivery verb. Phrases like "the tool
// returned an error" (legitimate acknowledgement of a failure) don't
// match this pattern — they use "an error" / "an issue" / etc.,
// while a fabrication tends to assert content delivered. The gate
// in `detectHallucinatedToolUse` (successfulToolCallCount === 0)
// remains the load-bearing guard.
const THIRD_PERSON_TOOL_RESULT_RE =
  /\bThe\s+(?:specialist|expert|consultant|advisor|tool|search|analysis|response|reply|result)\s+(?:has\s+|just\s+)?(?:weighed in|replied|answered|provided|recommended|suggested|responded|confirmed|indicated|reported|delivered)\b/i;

/**
 * Verdict shape exported for tests + any other code that wants to
 * use the same heuristic outside the runtime hook (e.g. the salvage
 * layer's own diagnostics). Mirrors what the legacy
 * `detectHallucinatedToolUse` returned.
 */
export interface HallucinationVerdict {
  hallucinated: boolean;
  placeholders: string[];
  actionVerbHit: string | null;
}

export function detectHallucinatedToolUse(args: {
  text: string;
  /**
   * Number of tool calls that fired AND returned a success result this
   * turn. Errored or rejected calls don't count — if the navigation
   * failed and the model still claims "I have navigated", that's
   * fabrication, not legitimate past-tense.
   */
  successfulToolCallCount: number;
}): HallucinationVerdict {
  if (args.successfulToolCallCount > 0) {
    return { hallucinated: false, placeholders: [], actionVerbHit: null };
  }

  const placeholderSet = new Set<string>();
  PLACEHOLDER_RE.lastIndex = 0;
  let m: RegExpExecArray | null = PLACEHOLDER_RE.exec(args.text);
  while (m !== null) {
    const inner = m[1]?.trim();
    if (inner) placeholderSet.add(inner);
    m = PLACEHOLDER_RE.exec(args.text);
  }
  const placeholders = Array.from(placeholderSet);

  const actionVerbMatch = ACTION_VERB_RE.exec(args.text);
  const thirdPersonMatch = THIRD_PERSON_TOOL_RESULT_RE.exec(args.text);
  // First-person hits take precedence in the verdict because the
  // existing reason text is keyed on `actionVerbHit`; a third-person
  // hit still surfaces as fabrication but is reported via the same
  // field so the warning reads naturally.
  const actionVerbHit = actionVerbMatch?.[0] ?? thirdPersonMatch?.[0] ?? null;

  const hallucinated = placeholders.length >= 2 || actionVerbHit !== null;
  return { hallucinated, placeholders, actionVerbHit };
}

export const FabricationDetectPastTense: Behavior = {
  id: 'fabrication.detect-past-tense-no-tools',
  description:
    'Catches fabricated past-tense claims ("I have navigated to X", "[Region X]" placeholders) when zero tools fired this turn. Attaches a user-visible warning to the assistant message; does NOT re-prompt.',

  postTurnDetector(ctx: TurnCtx): NudgeVerdict | null {
    const successfulToolCallCount = ctx.drained.filter((d) => d.success).length;
    const verdict = detectHallucinatedToolUse({
      text: ctx.assistantContent,
      successfulToolCallCount,
    });
    if (!verdict.hallucinated) return null;

    const reason = verdict.actionVerbHit
      ? `text claims "${verdict.actionVerbHit}" but no tool actually ran`
      : `${verdict.placeholders.length} placeholder(s) in the response (${verdict.placeholders.slice(0, 3).join(', ')}…)`;
    const warningMessage = `This local model appears to have fabricated tool results. Heuristic: ${reason}. For tool-heavy work (browsing, file ops, web research), switch to a cloud provider (Copilot or OpenAI) in Settings, or start a fresh session — once a few fabricated turns are in the history, the small model tends to keep going.`;

    return { reason: warningMessage, warnUser: true };
  },
};
