/**
 * `reasoning.strip-think-tags` — captures `<think>...</think>` and
 * `<reasoning>...</reasoning>` blocks from the model's raw output and
 * promotes them onto `ChatMessage.reasoning` so the UI can render
 * them in a collapsible expander instead of the visible bubble.
 *
 * The `think` shape is the canonical Qwen / DeepSeek-R1 / QwQ chain-
 * of-thought wrapper. With `enable_thinking=True` the chat template
 * also injects a leading `<think>\n` into the prompt suffix, so the
 * model's output starts mid-reasoning and the close arrives before
 * the visible reply — that anchored leading-close case is handled
 * here too.
 *
 * Migrated from a subset of the universal `extractReasoning()` in
 * [providers/local-tool-call-salvage.ts](../../providers/local-tool-call-salvage.ts).
 * Pair with {@link McpRelaxRequiredFields}-style behaviors that need
 * reasoning hidden before fabrication detectors run.
 */

import type { Behavior } from '../types.js';

/**
 * Apply think-shape patterns to `text`, returning the cleaned visible
 * output and any captured reasoning prose. Idempotent — running on
 * already-clean input is a no-op.
 *
 * Patterns covered:
 *   1. Closed `<think>...</think>` pairs — strip and capture inner.
 *   2. Closed `<reasoning>...</reasoning>` pairs — same.
 *   3. Anchored leading `^...</think>` — Qwen 3.6 with
 *      `enable_thinking=True` injects `<think>\n` into the prompt
 *      suffix; the model's output starts mid-reasoning.
 *   4. Unclosed `<think>...` ending at `\n\n` — truncated reasoning
 *      shouldn't dump everything as visible text.
 *   5. Stray bare `<think>` / `</think>` / `<reasoning>` /
 *      `</reasoning>` markers left over from partial emissions.
 */
function captureThinkTags(text: string): { visible: string; reasoning: string } {
  if (!text) return { visible: text, reasoning: '' };
  const captured: string[] = [];
  let out = text;
  out = out.replace(/<think>([\s\S]*?)<\/think>/gi, (_m, inner: string) => {
    captured.push(inner);
    return '';
  });
  out = out.replace(/<reasoning>([\s\S]*?)<\/reasoning>/gi, (_m, inner: string) => {
    captured.push(inner);
    return '';
  });
  out = out.replace(/^([\s\S]*?)<\/think>\s*/i, (_m, inner: string) => {
    captured.push(inner);
    return '';
  });
  out = out.replace(/^([\s\S]*?)<\/reasoning>\s*/i, (_m, inner: string) => {
    captured.push(inner);
    return '';
  });
  out = out.replace(/<think>([\s\S]*?)(?:<\/think>|\n\n)/i, (_m, inner: string) => {
    captured.push(inner);
    return '';
  });
  out = out.replace(/<\/?think>/gi, '');
  out = out.replace(/<\/?reasoning>/gi, '');
  const visible = out.replace(/\n{3,}/g, '\n\n').trim();
  const reasoning = captured
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .join('\n\n');
  return { visible, reasoning };
}

export const ReasoningStripThinkTags: Behavior = {
  id: 'reasoning.strip-think-tags',
  description:
    'Captures `<think>` / `<reasoning>` blocks from the visible reply and promotes them to `ChatMessage.reasoning`. Opt-in for Qwen / DeepSeek-R1 / QwQ-family models.',
  captureReasoning: (text: string) => captureThinkTags(text),
};
