/**
 * Walk a live chat session's resolved model profile: the behavior hooks that
 * set its continuation budget and turn timeout, judge a finished turn, and
 * prepend a prelude to the next user message. Behaviors read the
 * {@link ModelCtx} / {@link TurnCtx} built here, never the session itself.
 */
import {
  type ChatMessageToolCall,
  type ChatSession,
  type TurnMessageOrigin,
  createLogger,
} from '@bendyline/gezel';
import type { Store } from '../fs/store.js';
import type {
  ModelCtx,
  NudgeVerdict,
  ResolvedModelProfile,
  TurnCtx,
} from '../model-profile/types.js';
import type { LLMSession } from '../providers/types.js';

const log = createLogger('chat');

/** The slice of a live session the behavior hooks read. */
export interface ProfileHookState {
  record: ChatSession;
  session: LLMSession | null;
  profile?: ResolvedModelProfile;
}

/** Include provider-qualified and unqualified spellings in capability checks. */
export function liveTurnToolNames(session: LLMSession | null | undefined): string[] {
  const names = new Set<string>();
  for (const name of session?.getRegisteredToolNames?.() ?? []) {
    names.add(name);
    const qualified = name.match(/^mcp__.+?__(.+)$/)?.[1];
    if (qualified && qualified !== '*') names.add(qualified);
  }
  return [...names];
}

/**
 * Default cap on how many times we'll silently nudge a stalled turn
 * before giving up — used when no behavior on the resolved profile
 * fires a `continuationBudget` value. The runaway-hallucination case
 * ("I will now…" repeated indefinitely) is the dominant failure
 * mode this bounds; legitimate multi-step rituals override via the
 * `turn.continuation-budget` behavior (tier:tiny opts in with
 * `count: 4` to absorb a voorman setup chain). See
 * `manager.test.ts`'s `tier-aware MAX_CONTINUATIONS` coverage.
 */
const DEFAULT_CONTINUATION_BUDGET = 2;

/**
 * Continuation budget for one user-initiated send. Walks the
 * resolved profile's `continuationBudget` hooks; first non-null
 * wins — the registered behavior is `turn.continuation-budget` with
 * config `{ count }`. Falls through to
 * {@link DEFAULT_CONTINUATION_BUDGET} when no behavior fires.
 */
export function resolveContinuationBudget(state: ProfileHookState): number {
  const profile = state.profile;
  if (profile) {
    for (const entry of profile.behaviors) {
      const hook = entry.behavior.continuationBudget;
      if (!hook) continue;
      const ctx = modelCtxFromProfile(profile, state);
      const value = hook(ctx, entry.config);
      if (typeof value === 'number') return value;
    }
  }
  return DEFAULT_CONTINUATION_BUDGET;
}

/**
 * Walk the `turnTimeoutMs` hooks on the resolved profile. Used to
 * let a behavior raise/lower the per-turn output-budget ceiling
 * without code changes (no shipped behavior uses this today; the
 * consumer exists so future per-model overrides land cleanly).
 * Returns `null` to signal "no behavior fired" — caller keeps its
 * provider-keyed default.
 */
export function resolveProfileTurnTimeoutMs(state: ProfileHookState): number | null {
  const profile = state.profile;
  if (!profile) return null;
  for (const entry of profile.behaviors) {
    const hook = entry.behavior.turnTimeoutMs;
    if (!hook) continue;
    const ctx = modelCtxFromProfile(profile, state);
    const value = hook(ctx, entry.config);
    if (typeof value === 'number') return value;
  }
  return null;
}

/**
 * Build the {@link ModelCtx} every behavior hook expects from the
 * resolved profile + the live session state. Centralizing the
 * mapping here keeps every hook call site reading the same shape;
 * behaviors should never reach back into `state` directly.
 */
function modelCtxFromProfile(profile: ResolvedModelProfile, state: ProfileHookState): ModelCtx {
  return {
    catalogId: profile.catalogId,
    tier: profile.tier,
    family: profile.style.family,
    modelId: state.record.model,
    providerName: state.record.providerName,
  };
}

/**
 * Walk the `postTurnDetector` hooks on the resolved profile and
 * return the first non-null verdict. Mirrors today's hand-rolled
 * detection chain in `runSend` (`detectHallucinatedToolUse` →
 * `detectFabricatedToolClaim`) but driven by the registry — new
 * detectors land via the model-profile package, not by editing
 * manager.ts.
 *
 * The verdict `kind` distinguishes warn-only (attach reason to the
 * message's `warnings`) from re-prompt (queue a continuation with
 * `promptForNextTurn` as the next user-prompt). A behavior may set
 * both flags; both effects are applied independently.
 */
export function runPostTurnDetectors(
  state: ProfileHookState,
  args: {
    sessionId: string;
    isMeester: boolean;
    messageOrigin: TurnMessageOrigin;
    userText: string;
    drained: ChatMessageToolCall[];
    verifiedPriorArtifactRead: boolean;
    assistantContent: string;
    continuationCount: number;
  },
): NudgeVerdict | null {
  const profile = state.profile;
  if (!profile) return null;
  const turnCtx: TurnCtx = {
    ...modelCtxFromProfile(profile, state),
    sessionId: args.sessionId,
    isMeester: args.isMeester,
    projectId: state.record.projectId,
    messageOrigin: args.messageOrigin,
    availableToolNames: liveTurnToolNames(state.session),
    userText: args.userText,
    drained: args.drained,
    verifiedPriorArtifactRead: args.verifiedPriorArtifactRead,
    assistantContent: args.assistantContent,
    continuationCount: args.continuationCount,
  };
  for (const entry of profile.behaviors) {
    const hook = entry.behavior.postTurnDetector;
    if (!hook) continue;
    const verdict = hook(turnCtx, entry.config);
    if (verdict) {
      // Stable marker — ab-prompt-conduct greps daemon logs for
      // "post-turn detector fired id=" to count caught-after-the-fact
      // failures per arm. Keep the phrasing if you touch this line.
      const action =
        verdict.warnUser && verdict.promptForNextTurn
          ? 'warn+reprompt'
          : verdict.warnUser
            ? 'warn'
            : 'reprompt';
      log.info(
        `session ${args.sessionId}: post-turn detector fired id=${entry.id} action=${action}`,
      );
      return verdict;
    }
  }
  return null;
}

/**
 * Walk the resolved profile's `userPromptPrelude` hooks and return
 * the first non-null result. Carries the {@link TurnCtx} the hooks
 * expect: per-turn user text, the active gezel's `isMeester`
 * status (resolved via the on-disk config's `meesterGezelId`),
 * model context. Returns the prelude text + the firing behavior id
 * for the diagnostic log line. `null` when no behavior applies.
 *
 * Today's only hook is `prompt.meester-build-prelude`; the
 * Step-6 Gemma behaviors that re-prompt (single-tool-per-turn,
 * etc.) ride this same path without further manager.ts changes.
 */
export async function resolveUserPromptPrelude(
  store: Store,
  state: ProfileHookState,
  userText: string,
  messageOrigin: TurnMessageOrigin,
  libraryRecall: ReadonlyArray<{ path: string; snippet: string; score: number }> = [],
): Promise<{ behaviorId: string; text: string } | null> {
  const profile = state.profile;
  if (!profile) return null;
  const cfg = await store.readConfig().catch(() => null);
  const isMeester = cfg?.meesterGezelId === state.record.gezelId;
  const turnCtx: TurnCtx = {
    ...modelCtxFromProfile(profile, state),
    sessionId: state.record.id,
    isMeester,
    projectId: state.record.projectId,
    messageOrigin,
    availableToolNames: liveTurnToolNames(state.session),
    userText,
    drained: [],
    assistantContent: '',
    continuationCount: 0,
    ...(libraryRecall.length > 0 ? { libraryRecall } : {}),
  };
  for (const entry of profile.behaviors) {
    const hook = entry.behavior.userPromptPrelude;
    if (!hook) continue;
    const text = hook(turnCtx, entry.config);
    if (text) return { behaviorId: entry.id, text };
  }
  return null;
}
