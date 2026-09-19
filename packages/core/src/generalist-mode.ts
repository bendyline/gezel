/**
 * Generalist mode — the single switch that decides how much orchestration
 * wraps a piece of work.
 *
 * Two things hang off it:
 *
 *  - **Task execution mode** ({@link resolveTaskExecutionMode}): whether a
 *    craftbook task is worked by ONE gezel in ONE continuous session across
 *    every step (`generalist`), or by a specialist per step, each in its own
 *    session (`stepwise`). Steps, gates and fanout are identical in both
 *    modes; only who runs them and how much context carries over changes.
 *  - **Kickoff shape** ({@link resolveGeneralistKickoff}): whether the
 *    Meester's `start_project` routes a concrete ask to a single solo lead
 *    (the Builder template with every build-loop step pinned to them) or
 *    recruits a crew.
 *
 * `auto` deliberately differs between the two. Kickoff keeps the measured
 * rule — self-orchestrating providers plus local MEDIUM (paired N=3 core
 * A/B, 2026-07-17, llama.cpp: flat >= scaffold on every scenario, zero
 * regressions across 24 paired trials) — and adds the raw cloud SDKs so every
 * frontier provider gets the same shape. Task execution is generalist for
 * frontier providers only: the single-session + union-tool-surface semantics
 * are unmeasured on local engines, where tool schemas dominate prompt mass,
 * so local models stay stepwise until the generalist eval says otherwise.
 *
 * Kept dependency-free (string in, union out) so the runtime, the MCP child
 * and the eval harness resolve the mode the same way. See
 * `GezelConfig.generalistMode` and `docs/generalist-mode.md`.
 */

export type GeneralistMode = 'on' | 'off';
export type GeneralistModeSetting = 'auto' | GeneralistMode;

/**
 * How a task is executed. Stamped on the task at create (`Task.executionMode`)
 * so a later change to the setting never flips a running task. The tuple is
 * the source for the wire schema (`TaskExecutionModeSchema`).
 */
export const TASK_EXECUTION_MODES = ['generalist', 'stepwise'] as const;
export type TaskExecutionMode = (typeof TASK_EXECUTION_MODES)[number];

/**
 * Providers whose models run in generalist mode under `auto`: the hosted
 * frontier models (Claude, ChatGPT/Codex, Copilot), whether reached through
 * an SDK or a CLI. Bare strings on purpose — no coupling to the provider-name
 * union, so the MCP child and the eval harness can share this.
 */
export const FRONTIER_PROVIDER_NAMES: ReadonlyArray<string> = [
  'copilot',
  'anthropic',
  'anthropic-cli',
  'openai',
  'codex-cli',
];

export function isFrontierProvider(providerName: string | undefined): boolean {
  return providerName !== undefined && FRONTIER_PROVIDER_NAMES.includes(providerName);
}

/**
 * Providers that run their OWN internal agent loop (plan→act→observe)
 * inside a single CLI/SDK invocation — they self-orchestrate, so gezel's
 * outer crew + per-step loop is largely redundant overhead. A finer cut
 * than "is this a cloud provider": `copilot` is cloud-backed but DOES
 * self-orchestrate, whereas raw cloud APIs (`anthropic`, `openai`) and
 * local engines (`llama-cpp`, `mlx`, `ds4`) do not — gezel drives their loop
 * one turn per step. The eval harness widens its silence watchdog for these.
 *
 * Mirrors `evals/src/providers.ts` `isSelfOrchestratingProvider`.
 */
export function isSelfOrchestratingProvider(providerName: string | undefined): boolean {
  return (
    providerName === 'codex-cli' || providerName === 'anthropic-cli' || providerName === 'copilot'
  );
}

/**
 * Resolve how a task executes.
 *
 *  - explicit `on` / `off` → `generalist` / `stepwise`.
 *  - `auto` **and unset** → `generalist` for frontier providers, `stepwise`
 *    for everything else (local engines, `remote`, `ollama`, `mock`) at
 *    every tier. `tier` is accepted so callers and the eval matrix keep one
 *    signature when the local rule is revisited on evidence.
 */
export function resolveTaskExecutionMode(
  setting: GeneralistModeSetting | undefined,
  providerName: string | undefined,
  _tier?: string,
): TaskExecutionMode {
  if (setting === 'on') return 'generalist';
  if (setting === 'off') return 'stepwise';
  return isFrontierProvider(providerName) ? 'generalist' : 'stepwise';
}

/**
 * Resolve the kickoff shape the Meester's `start_project` uses.
 *
 *  - explicit `on` / `off` → that value (the escape hatch: `off` forces the
 *    full crew on a frontier provider).
 *  - `auto` **and unset** → `on` for frontier providers and for local MEDIUM
 *    (12–45B: Qwen 27B, Gemma 12/26/31B) per the measured A/B; `off` for
 *    local tiny/small/large (small was a statistical wash, tiny/large are
 *    unmeasured) and for anything without a tier hint.
 */
export function resolveGeneralistKickoff(
  setting: GeneralistModeSetting | undefined,
  providerName: string | undefined,
  tier?: string,
): GeneralistMode {
  if (setting === 'on' || setting === 'off') return setting;
  if (isFrontierProvider(providerName)) return 'on';
  if (tier === 'medium') return 'on';
  return 'off';
}

/**
 * Map the pre-v2 `executionDensity` config value onto the setting. `flat`
 * routed kickoff to a solo lead, `scaffold` forced the crew, `auto` picked
 * by provider — the same three intents, renamed. Anything else is unset.
 */
export function legacyDensityToGeneralistMode(
  value: string | undefined,
): GeneralistModeSetting | undefined {
  if (value === 'flat') return 'on';
  if (value === 'scaffold') return 'off';
  if (value === 'auto') return 'auto';
  return undefined;
}

/**
 * Pick the effective setting from a config that may still carry the legacy
 * key (the Store migrates it on boot, but a hand-edited file or an older
 * client patch can reintroduce it). The new key always wins.
 */
export function effectiveGeneralistModeSetting(config: {
  generalistMode?: GeneralistModeSetting;
  executionDensity?: string;
}): GeneralistModeSetting | undefined {
  return config.generalistMode ?? legacyDensityToGeneralistMode(config.executionDensity);
}

/** @deprecated Pre-v2 name; use {@link GeneralistMode} (`on` ≙ `flat`, `off` ≙ `scaffold`). */
export type ExecutionDensity = 'flat' | 'scaffold';
/** @deprecated Pre-v2 name; use {@link GeneralistModeSetting}. */
export type ExecutionDensitySetting = 'auto' | ExecutionDensity;

/**
 * @deprecated Pre-v2 kickoff resolver kept for published-API compatibility.
 * Use {@link resolveGeneralistKickoff}; this shim maps its answer back onto
 * the old vocabulary.
 */
export function resolveExecutionDensity(
  setting: ExecutionDensitySetting | undefined,
  providerName: string | undefined,
  tier?: string,
): ExecutionDensity {
  const kickoff = resolveGeneralistKickoff(
    legacyDensityToGeneralistMode(setting),
    providerName,
    tier,
  );
  return kickoff === 'on' ? 'flat' : 'scaffold';
}
