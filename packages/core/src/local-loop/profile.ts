/**
 * The slice of a resolved model profile the local loop reads: the model's
 * style and its behavior entries (id, validated config, and the reasoning
 * hooks). The daemon's full `ResolvedModelProfile` is assignable to it.
 */

import type { ModelStyle } from '../schemas/model-profile.js';
import { extractReasoning } from '../transform/reasoning.js';

export interface LocalLoopBehaviorEntry {
  id: string;
  config: unknown;
  // Method syntax: each behavior types its own config.
  behavior: {
    captureReasoning?(
      visible: string,
      ctx: never,
      config: unknown,
    ): { visible: string; reasoning?: string | null | undefined };
    stripVisibleContent?(visible: string, ctx: never, config: unknown): string;
  };
}

export interface LocalLoopProfile {
  style: ModelStyle;
  behaviors: readonly LocalLoopBehaviorEntry[];
}

export type { TurnRambleDetectionConfig } from '../model-profile/behaviors/turn-ramble-detection.js';

/**
 * True when the resolved profile opts in to a behavior with the given
 * id. Marker behaviors (`turn.preamble-folding`,
 * `parse.gemma-special-token`) use this; the call site doesn't need
 * the entry's config.
 */
export function profileHasBehavior(
  profile: LocalLoopProfile | undefined,
  behaviorId: string,
): boolean {
  if (!profile) return false;
  return profile.behaviors.some((entry) => entry.id === behaviorId);
}

/**
 * Look up a parameterized behavior's validated config off a profile.
 * Returns `null` when the behavior is absent so the caller can branch
 * on opt-in. The runtime has already applied the behavior's
 * `defaultConfig` and Zod validation by the time this fires, so the
 * shape callers receive is exactly what their consumer expects.
 */
export function profileBehaviorConfig<T>(
  profile: LocalLoopProfile | undefined,
  behaviorId: string,
): T | null {
  if (!profile) return null;
  const entry = profile.behaviors.find((e) => e.id === behaviorId);
  if (!entry) return null;
  return entry.config as T;
}

/**
 * Universal `extractReasoning` (handles `<think>` / `<|channel|>` /
 * `<reasoning>` blocks) followed by a profile-driven composition of
 * every behavior with `captureReasoning` and `stripVisibleContent`
 * hooks. Each behavior sees the previous behavior's `visible` output,
 * strips its own format, and (for capture-reasoning) contributes any
 * captured prose to the reasoning channel.
 *
 * Order:
 *   1. Universal `extractReasoning` first — strips structured tag
 *      formats before per-behavior passes try to scrape bare-prose
 *      leaks. Avoids `reasoning.capture-pre-tool-prose` mistakenly
 *      grabbing a `thought\n` inside a `<|channel|>` block.
 *   2. Profile `captureReasoning` hooks — extract any remaining
 *      family-specific reasoning shapes (e.g.
 *      `reasoning.capture-pre-tool-prose` for Gemma's bare leaks).
 *   3. Profile `stripVisibleContent` hooks — final visible-content
 *      scrub for behaviors that need to remove markup that doesn't
 *      go to the reasoning channel (no shipped behavior uses this
 *      yet; the consumer exists so a future hook lands cleanly).
 */
export function extractReasoningWithProfile(
  text: string,
  profile: LocalLoopProfile | undefined,
): { visible: string; reasoning: string } {
  const base = extractReasoning(text);
  if (!profile) return base;
  let visible = base.visible;
  const reasoningParts: string[] = base.reasoning ? [base.reasoning] : [];
  for (const entry of profile.behaviors) {
    const hook = entry.behavior.captureReasoning;
    if (!hook) continue;
    // The hook's `ctx` arg is intentionally not constructed here:
    // every shipped capture-reasoning behavior is format-keyed and
    // doesn't read context. If a future behavior needs ctx, we'll
    // thread it then; today's call sites don't have profile-side
    // model context handy, and synthesizing one here would be
    // forwarding fields the hook ignores.
    const out = hook(visible, undefined as never, entry.config);
    visible = out.visible;
    if (out.reasoning) reasoningParts.push(out.reasoning);
  }
  for (const entry of profile.behaviors) {
    const hook = entry.behavior.stripVisibleContent;
    if (!hook) continue;
    visible = hook(visible, undefined as never, entry.config);
  }
  return {
    visible,
    reasoning: reasoningParts.filter((s) => s.length > 0).join('\n\n'),
  };
}
