/**
 * `reasoning.capture-pre-tool-prose` — Gemma-specific reasoning
 * capture. Catches the wild-caught "thought\nPlan: ...\nWait, ...\n
 * Step 1: ..." prose pattern Gemma 4 26B leaks into the visible
 * bubble even when the verbose-family channel hint is in play.
 *
 * The shape that motivated this: from the Cosima / Space Invaders
 * bundle, Gemma 26B emitted (after the channel-tags strip pass had
 * already run):
 *
 *   thought
 *   Plan: I need to create a new project for the user. Let me call
 *   create_project with the right shape.
 *   Wait, the user wants a Space Invaders game. I should...
 *   Step 1: ...
 *
 * The salvage layer correctly extracted the eventual tool call but
 * the prose remained as the visible bubble. {@link
 * ReasoningStripChannelTags} would have caught it if Gemma had
 * wrapped it; the wild-caught case is bare prose without the
 * `<|channel>` markers, often when the model "forgets" the format.
 *
 * This behavior captures any leading paragraph that starts with one
 * of the distinctive thinking-prefix tokens (`thought`, `Plan:`,
 * `Step 1:`, `Wait,`, `Let me think`, `First,`, `I need to`) and
 * extends to the first blank line. Gated by manifest opt-in
 * (Gemma-family only) so it can't over-fire on legitimate
 * "Step 1: <visible content>" responses from other families that
 * use numbered-list output.
 *
 * Composes with {@link ReasoningStripChannelTags} — that one strips
 * channel-wrapped reasoning; this one strips the bare-prose leak
 * that bypassed the wrapping.
 */

import type { Behavior } from '../types.js';

/**
 * Distinctive opening tokens for the Gemma reasoning leak. Matched
 * case-insensitive at the start of the visible content. The tokens
 * are deliberately specific — `thought\n` is unmistakable
 * thinking-mode output; `Plan:` / `Wait,` / `Let me think` are
 * Gemma's chain-of-thought prefixes that wouldn't appear at the
 * start of a substantive user-facing reply. `Step 1:` is included
 * because Gemma emits it as a planning header before any tool
 * action; if it were the start of a numbered list of advice, the
 * line would extend with substantive content the user wants — but
 * the leak case ALWAYS continues with `Step 2:` / `Step 3:` etc.
 * before any tool call, so we capture up to the first blank line
 * either way and rely on opt-in to avoid false positives.
 */
const LEADING_THINKING_PREFIXES =
  /^(?:thought\b|plan\s*:|step\s*\d+\s*:|wait\s*,|let\s+me\s+think\b|first\s*,?\s|i\s+need\s+to\s)/i;

function capturePreToolProse(text: string): { visible: string; reasoning: string } {
  if (!text) return { visible: text, reasoning: '' };
  const trimmed = text.trimStart();
  if (!LEADING_THINKING_PREFIXES.test(trimmed)) {
    return { visible: text, reasoning: '' };
  }
  const blankLine = trimmed.indexOf('\n\n');
  if (blankLine < 0) {
    return { visible: '', reasoning: trimmed };
  }
  const captured = trimmed.slice(0, blankLine);
  const remaining = trimmed.slice(blankLine + 2);
  return { visible: remaining.trim(), reasoning: captured.trim() };
}

export const ReasoningCapturePreToolProse: Behavior = {
  id: 'reasoning.capture-pre-tool-prose',
  description:
    'Captures bare-prose reasoning leaks that bypass the channel-tags wrap (Gemma 4 26B "thought\\nPlan:\\n..." pattern). Gemma-family opt-in only — the prefix tokens it matches would over-fire on numbered-list output from other families.',
  captureReasoning: (text: string) => capturePreToolProse(text),
};
