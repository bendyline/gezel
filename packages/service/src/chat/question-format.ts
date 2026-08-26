import type { Question } from '@bendyline/gezel';

/**
 * Render a `Question`'s answer into the synthetic user-message text we
 * inject back into the asking session. The shape stays consistent so
 * the model + every gezel see the same envelope:
 *
 *   [Answer to: "..."]
 *   Selected: choice1, choice2
 *   Notes: write-in body
 *
 * For "proceed with defaults" answers (`declined`):
 *
 *   [The user wants you to proceed without their input — use sensible
 *    defaults: "..."]
 *
 * Silent-skip answers don't go through this function — the answer
 * route returns before calling `deliverQuestionAnswer` when the user
 * dismissed without wanting a follow-up turn.
 *
 * Pure / synchronous so it's easy to unit-test and easy to reason
 * about — formatting drift between this and what the UI shows in the
 * answered card would confuse users, so this is the single source.
 */
export function formatAnswerSeed(question: Question): string {
  const promptHeadline = oneLine(question.prompt);
  const ans = question.answer;
  if (!ans || ans.declined) {
    return `[The user wants you to proceed without their input — use sensible defaults: "${promptHeadline}"]`;
  }
  const lines: string[] = [`[Answer to: "${promptHeadline}"]`];
  const selected =
    ans.selectedChoices && question.choices
      ? ans.selectedChoices
          .map((i) => question.choices?.[i])
          .filter((c): c is string => typeof c === 'string' && c.length > 0)
      : [];
  if (selected.length > 0) {
    lines.push(`Selected: ${selected.join(', ')}`);
  }
  const writeIn = ans.writeIn?.trim();
  if (writeIn) {
    lines.push(`Notes: ${writeIn}`);
  }
  // Defensive: if neither selection nor write-in landed, surface that
  // explicitly rather than leaving the gezel with a bare prompt header.
  if (selected.length === 0 && !writeIn) {
    lines.push('(no answer body provided)');
  }
  return lines.join('\n');
}

/** Collapse a multi-line markdown prompt into a single quoted line for the
 *  envelope header. Caps length so the seed stays readable. */
function oneLine(text: string, max = 200): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

/**
 * Pick the question that should BLOCK a fresh `ask_user_question` from
 * the same chat session — the session's oldest unanswered, intent-less
 * (plain user-facing) question, if any.
 *
 * Why this exists: small models (wild-caught: a Meester on gemma4-e4b
 * driving an "Ikari Warriors style shooter" request) re-ask a reworded
 * version of the same clarifying question every time they're re-invoked
 * before the user has answered. Each call mints a fresh `Question`
 * record, so the "Needs your input" panel fills with near-duplicate
 * cards ("Question 7 of 7"). The provider-level dedup only collapses
 * repeats WITHIN one turn; this is the turn-to-turn guard — one
 * outstanding question card per session at a time.
 *
 * Scope, and why each clause matters:
 *  - same `sessionId` — a session is one gezel's conversation; questions
 *    from other sessions are unrelated and must stay independent.
 *  - `!answer` — an already-answered question doesn't block; once the
 *    user has replied the gezel may legitimately ask a follow-up.
 *  - `intent === undefined` — approval cards (npm-install / command /
 *    tool-permission / image-generation) are distinct decisions written
 *    via other routes; they must never suppress, or be suppressed by, a
 *    plain question. Text is deliberately NOT compared: the failure mode
 *    is a *reworded* re-ask, so any text match would miss it.
 *
 * Returns the OLDEST match so the user keeps answering the first card
 * they saw rather than having the prompt swapped under them.
 */
export function outstandingSessionQuestion(
  questions: readonly Question[],
  sessionId: string,
): Question | undefined {
  return questions
    .filter((q) => q.sessionId === sessionId && !q.answer && q.intent === undefined)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
}
