import type { ToolCallCard } from '@bendyline/gezel';

type CardBearing = { readonly card?: ToolCallCard | undefined };

/**
 * One craftbook card per task per conversation.
 *
 * Every `invoke_craftbook` and `advance_task_step` call stamps its own
 * snapshot card, and a model that re-invokes a plan it already started gets
 * an idempotent "already running" receipt each time. A bakery owner's one
 * request read as three identical "Formatted Report is underway" cards in a
 * row. The earliest card for a task stays; later ones keep only their plain
 * row behind Details. Earliest, so a bubble the person already read never
 * shrinks above them.
 *
 * `messages` must arrive in the order they render. Returns the card objects
 * to hide and the tasks a persisted card already speaks for, which
 * {@link liveCardsToHide} needs for a turn still streaming.
 */
export function craftbookCardDedupe(
  messages: Iterable<{ readonly toolCalls?: ReadonlyArray<CardBearing> | undefined }>,
): { hidden: ReadonlySet<ToolCallCard>; owned: ReadonlySet<string> } {
  const hidden = new Set<ToolCallCard>();
  const owned = new Set<string>();
  for (const m of messages) {
    for (const call of m.toolCalls ?? []) {
      const card = call.card;
      if (!card) continue;
      if (owned.has(card.taskRef)) hidden.add(card);
      else owned.add(card.taskRef);
    }
  }
  return { hidden, owned };
}

/** The same rule for a live turn, against the tasks earlier cards own. */
export function liveCardsToHide(
  tools: ReadonlyArray<CardBearing>,
  owned: ReadonlySet<string>,
): ReadonlySet<ToolCallCard> {
  const hidden = new Set<ToolCallCard>();
  const seen = new Set(owned);
  for (const tool of tools) {
    const card = tool.card;
    if (!card) continue;
    if (seen.has(card.taskRef)) hidden.add(card);
    else seen.add(card.taskRef);
  }
  return hidden;
}
