/**
 * `prompt.minimal-context` — marker behavior for models whose context
 * window is too small to hold gezel's standing system prompt at all.
 *
 * The prompt stack (guardrail + about + project context + conduct core +
 * tools block) routinely runs 2–3K tokens before the user's first word —
 * fine on a 32K+ model, fatal on a 2K one. talkie-1930 (a 2048-token
 * period-writing model) can't even answer "hi there": the standing prompt
 * needed ~2,681 tokens against a 2,048 window, so the engine rejected the
 * turn before generating a single token.
 *
 * When this behavior is on the resolved profile (or auto-applied because
 * the model's catalog `contextWindow` is at/below
 * `MINIMAL_CONTEXT_MAX_WINDOW`), `buildInstructions` returns a stripped
 * prompt — header + the gezel's (length-capped) about.md + one short
 * "you have no tools, just converse" conduct line — and drops every other
 * layer (routing guardrail, project context, workspace/documents listings,
 * task blocks, recall, the full conduct core, and the tools block). The
 * goal is a usable chat floor (~350 tok), accepting that such a model
 * won't do tool-driven or project work — it's for conversation and short
 * writing.
 *
 * No hooks — the logic lives in `buildInstructions` ([chat/manager.ts]),
 * gated by a `minimalContext` flag resolved at the call site from
 * `profileHasBehavior(profile, 'prompt.minimal-context')` OR the catalog
 * context-window check. OFF by default; forceable per-run via
 * `GEZEL_FORCE_BEHAVIORS` for A/B.
 */

import type { Behavior } from '../types.js';

/**
 * Models whose advertised context window is at or below this get the
 * minimal prompt automatically, even without the behavior on their
 * manifest. 4096 covers the genuinely tiny local models (2K/4K); anything
 * larger holds the standard stack with room to spare.
 */
export const MINIMAL_CONTEXT_MAX_WINDOW = 4096;

export const PromptMinimalContext: Behavior = {
  id: 'prompt.minimal-context',
  description:
    "Strips the system prompt to header + capped about.md + a short 'no tools, just converse' line for models whose context window can't hold the standing stack (auto-applied at contextWindow <= 4096). Accepts that such a model does conversation/short writing, not tool or project work. No hooks; gates buildInstructions via a minimalContext flag. OFF by default; A/B via GEZEL_FORCE_BEHAVIORS.",
};
