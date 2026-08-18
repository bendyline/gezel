/**
 * Behavior registry types — the runtime contract that every per-model
 * behavior implements. Lives in the service package because behaviors
 * carry runtime hooks (MCP wrappers, prompt builders, post-turn
 * detectors) that depend on service-internal types.
 *
 * Schema-side types (`BehaviorId`, `BehaviorEntry`, `ModelStyle`,
 * `ModelFamily`, etc.) live in `@bendyline/gezel/schemas/model-profile`
 * — they're pure data and need to be readable from UI code.
 *
 * The shape here mirrors how MCP wrappers are organized
 * ({@link packages/service/src/providers/mcp-wrappers/types.ts}): one
 * registry, one canonical context that every hook receives, and an
 * interface where every method is optional so a behavior only
 * implements what it needs.
 */

import type {
  BehaviorId,
  ChatMessageToolCall,
  ModelFamily,
  ModelStyle,
  ProviderName,
} from '@bendyline/gezel';
import type { z } from 'zod';
import type { ModelTier } from '../chat/local-model-tier.js';
import type { McpToolWrapper } from '../providers/mcp-wrappers/types.js';

// ─ Resolved profile (the runtime view) ────────────────────────────────

/**
 * One entry on a {@link ResolvedModelProfile}. The resolver walks each
 * `BehaviorEntry` from the manifest, looks up the registry, validates
 * `config` against the behavior's schema, and produces this triple.
 *
 * Consumers receive `behavior` + `config` and don't need to round-trip
 * through {@link lookupBehavior}.
 */
export interface ResolvedBehaviorEntry {
  id: BehaviorId;
  /**
   * Validated config — typed by the behavior's `configSchema`, or
   * `undefined` for behaviors that take no parameters. Hooks should
   * pass this through unchanged; the registry has already validated
   * + applied the behavior's `defaultConfig`.
   */
  config: unknown;
  /** Reference to the registry entry; saves consumers a lookup. */
  behavior: Behavior<unknown>;
}

/**
 * The runtime view of "what behaviors apply to this session?" —
 * resolved from the catalog manifest (or the tier-default fallback)
 * once at session-build time, then threaded through `LiveSessionState`,
 * `SessionOpts`, and `wrapperCtx` for the lifetime of the session.
 *
 * Mirrors the threading pattern of `modelTier` today
 * ({@link packages/service/src/chat/manager.ts}'s `buildSessionOpts`):
 * compute once, cache, hand to every consumer that needs to branch.
 */
export interface ResolvedModelProfile {
  /** Catalog ID the profile was resolved from, or `undefined` for unknown / third-party imports. */
  catalogId: string | undefined;
  tier: ModelTier;
  style: ModelStyle;
  behaviors: ResolvedBehaviorEntry[];
}

// ─ Hook contexts ──────────────────────────────────────────────────────

/**
 * Per-model context every hook receives. Carries the resolved profile
 * + the bare facts every hook tends to need (provider, tier, family,
 * model id). Hooks branch on these instead of recomputing from
 * substring matches.
 */
export interface ModelCtx {
  catalogId: string | undefined;
  tier: ModelTier;
  family: ModelFamily;
  modelId: string | undefined;
  providerName: ProviderName;
}

/**
 * Context for {@link Behavior.promptAppend} hooks — fired once during
 * `buildInstructions` to assemble the system-prompt content blocks
 * (cookbook, anti-fabrication rules, family hints).
 */
export interface PromptCtx extends ModelCtx {
  /** Whether `@playwright/mcp` is registered for this session. */
  hasPlaywright: boolean;
  /** True when the active gezel is the configured Meester. */
  isMeester: boolean;
  /** The gezel's about.md content (already loaded). */
  about: string;
  /**
   * Tool names actually wired for this session (post-allowlist).
   *
   * A behavior whose whole point is "reach for tool X instead of tool Y"
   * must gate on this and return null when X is absent. The rendered block
   * is also passed through `filterPromptToolDirectives`, but that pass is
   * lexical: it drops a line only when the line reads as a directive, and
   * "write a small Node script and execute it — `derive_file(...)`" does
   * not match, so the block survived intact on a roster with no execution
   * tool at all and prescribed a remedy the session could not perform.
   * Positive gating here is the reliable half; the lexical filter is the
   * backstop for phrasings a behavior author did not anticipate.
   */
  availableToolNames: ReadonlySet<string>;
}

/**
 * Context for per-turn hooks: {@link Behavior.userPromptPrelude} and
 * {@link Behavior.postTurnDetector}. Carries everything needed to
 * decide whether to inject a prelude before the model sees the user's
 * message, or to fire a corrective nudge after the model replies.
 */
export interface TurnCtx extends ModelCtx {
  sessionId: string;
  isMeester: boolean;
  /** Project receiving this turn. `default` is the unscoped front-door context. */
  projectId: string;
  /**
   * Provenance of the user-role message. Provider schemas use `user` for
   * human composer turns, question answers, gezel handoffs, and service
   * nudges alike; behaviors need this stronger signal before applying
   * user-intent routing such as the Meester new-project prelude.
   */
  messageOrigin: 'direct-user' | 'question-answer' | 'cross-gezel' | 'background-nudge' | 'system';
  /** Canonical/unqualified plus provider-advertised live tool names. */
  availableToolNames: ReadonlyArray<string>;
  /** Verbatim user-message text for this turn. */
  userText: string;
  /** Tool calls that drained from the per-turn accumulator. */
  drained: ChatMessageToolCall[];
  /** Final assistant content for the just-completed turn. */
  assistantContent: string;
  /** How many continuation nudges have already fired in this user-initiated send. */
  continuationCount: number;
  /**
   * Shared-library documents matching THIS turn's message, resolved before
   * the prelude hooks run (they are synchronous; the search is not).
   * Populated only for user-origin turns, and only with matches strong
   * enough to be worth the tokens — usually absent.
   */
  libraryRecall?: ReadonlyArray<{ path: string; snippet: string; score: number }>;
}

/**
 * Verdict returned by {@link Behavior.postTurnDetector} when a
 * behavior detects the model produced a fabricated / stalled /
 * wrong-shape reply.
 *
 * Two outcomes the chat manager handles, settable independently:
 *
 *   - `promptForNextTurn` set → fire a continuation with this string
 *     as the next turn's user-prompt. Used when the behavior wants
 *     the model to self-correct (e.g. claim-without-tool).
 *   - `warnUser` set → attach `reason` to the persisted assistant
 *     message's `warnings` array. The UI renders a yellow banner
 *     under the bubble. Used when the behavior wants to surface the
 *     fabrication to the user without re-prompting (e.g. plain
 *     past-tense-no-tools — re-running just produces more
 *     fabrication).
 *
 * A behavior can set both: warn the user AND re-prompt. A behavior
 * can also set neither (returning null instead is preferred — but a
 * verdict with neither is a no-op).
 */
export interface NudgeVerdict {
  /** Short label for logs + (when `warnUser`) the user-visible warning text. */
  reason: string;
  /** When set, fire a continuation with this as the next turn's user-prompt. */
  promptForNextTurn?: string;
  /** When true, append `reason` to the assistant message's `warnings` array. */
  warnUser?: boolean;
}

// ─ Behavior interface ─────────────────────────────────────────────────

/**
 * One registered runtime behavior. Most behaviors implement one or two
 * of the optional hooks; the rest are skipped. The `TConfig` type
 * parameter ties the hook signatures to whatever shape the behavior
 * declared via {@link Behavior.configSchema} — for switch-style
 * behaviors with no parameters, leave `TConfig` as the default `void`
 * and the runtime passes `undefined` through.
 *
 * The split between hooks reflects the runtime points where each kind
 * of decision lands today:
 *
 *   - `promptAppend` — system-prompt assembly (was `pickLocalHints`)
 *   - `userPromptPrelude` — per-turn prelude before user text (was inline `MEESTER_BUILD_PRELUDE`)
 *   - `postTurnDetector` — post-turn fabrication / stall detection (was `detectHallucinatedToolUse` etc.)
 *   - `mcpWrapper` — MCP-bridge call interception (was `GezelMcpSmallModelRelaxer`)
 *   - `stripVisibleContent` — display-side content scrubbing (was strip-tool-call-markup family branches)
 *   - `captureReasoning` — service-side reasoning extraction (was format-specific cases in `extractReasoning`)
 *   - `numPredict` / `turnTimeoutMs` / `continuationBudget` — turn-loop knobs (were `pickOllamaNumPredict`, `maxContinuationsForTier`)
 *
 * New hooks land here as future migrations uncover shapes that don't
 * fit the existing surface. Adding a hook is non-breaking — every
 * existing behavior leaves it undefined.
 */
export interface Behavior<TConfig = void> {
  /** Stable id used in manifests + logs. Convention: `category.kebab-name`. */
  id: BehaviorId;
  /** Short human description shown in the registry overview / logs. */
  description: string;
  /** Zod schema for this behavior's config. Omit for switch-style behaviors. */
  configSchema?: z.ZodType<TConfig>;
  /** Default config used when the manifest opts in without specifying one. */
  defaultConfig?: TConfig;

  /**
   * Append a block to the system prompt at `buildInstructions` time.
   * Multiple behaviors compose; the registry concatenates non-null
   * results in declaration order with a single newline separator.
   * Return `null` to skip — most behaviors that have a `promptAppend`
   * hook return non-null only when their gating condition is met
   * (e.g. `hasPlaywright` true).
   */
  promptAppend?(ctx: PromptCtx, config: TConfig): string | null;

  /**
   * Prepend a per-turn note to the user's message before it reaches
   * the model. Used for "system note for this turn" overrides like
   * the Meester build-prelude. The first non-null result from any
   * behavior wins — keep prelude wording short to avoid drowning out
   * the user's actual ask.
   */
  userPromptPrelude?(ctx: TurnCtx, config: TConfig): string | null;

  /**
   * Inspect the just-completed turn and decide whether to fire a
   * corrective re-prompt. Returns `null` to pass; returns
   * {@link NudgeVerdict} to have the chat manager queue a
   * continuation with `promptForNextTurn` as the next-turn user-prompt.
   * Multiple detectors can apply; the first one that returns
   * non-null wins.
   */
  postTurnDetector?(ctx: TurnCtx, config: TConfig): NudgeVerdict | null;

  /**
   * Static MCP wrapper for behaviors with no config; OR a factory
   * that takes the validated config and returns the wrapper. The
   * registry assembles per-session wrapper lists by calling the
   * factory once per resolved entry.
   */
  mcpWrapper?: McpToolWrapper | ((config: TConfig) => McpToolWrapper);

  /**
   * Display-side scrub of visible content. Composes left-to-right
   * across behaviors — each receives the previous behavior's output.
   * Used to strip family-specific reasoning markers
   * (`<|channel|>...`, `<think>...`, etc.) from the rendered bubble.
   */
  stripVisibleContent?(text: string, ctx: ModelCtx, config: TConfig): string;

  /**
   * Service-side reasoning extraction. Composes left-to-right across
   * behaviors: each receives the previous behavior's `visible` output,
   * strips its own format's markup, and contributes any captured
   * prose to the accumulated reasoning. The runtime joins captured
   * fragments with `\n\n`. Used by the verbose-family extraction
   * layer; one behavior per format (think, channel, pre-tool-prose).
   */
  captureReasoning?(
    text: string,
    ctx: ModelCtx,
    config: TConfig,
  ): { visible: string; reasoning: string };

  /** Override the default per-turn output budget. Returns `null` to defer. */
  numPredict?(ctx: ModelCtx, config: TConfig): number | null;
  /** Override the per-turn timeout (ms). Returns `null` to defer. */
  turnTimeoutMs?(ctx: ModelCtx, config: TConfig): number | null;
  /** Override the continuation-nudge budget. Returns `null` to defer. */
  continuationBudget?(ctx: ModelCtx, config: TConfig): number | null;
}
