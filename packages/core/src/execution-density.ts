/**
 * Execution density — the single switch that scales how much orchestration
 * scaffolding wraps a task, from the full crew + granular craftbook
 * ("scaffold") down to a single generalist Builder running a collapsed
 * craftbook ("flat"). See `GezelConfig.executionDensity` and
 * `docs/frontier-adaptive-execution.md`.
 *
 * Kept dependency-free (string in, union out) so both the runtime and the
 * eval harness can resolve density the same way.
 */

export type ExecutionDensity = 'flat' | 'scaffold';
export type ExecutionDensitySetting = 'auto' | ExecutionDensity;

/**
 * Providers that run their OWN internal agent loop (plan→act→observe)
 * inside a single CLI/SDK invocation — they self-orchestrate, so gezel's
 * outer crew + per-step loop is largely redundant overhead. A finer cut
 * than "is this a cloud provider": `copilot` is cloud-backed but DOES
 * self-orchestrate, whereas raw cloud APIs (`anthropic`, `openai`) and
 * local engines (`llama-cpp`, `mlx`, `ds4`) do not — gezel drives their loop
 * one turn per step.
 *
 * Mirrors `evals/src/providers.ts` `isSelfOrchestratingProvider`. Takes a
 * bare string to avoid coupling to the provider-name union.
 */
export function isSelfOrchestratingProvider(providerName: string | undefined): boolean {
  return (
    providerName === 'codex-cli' || providerName === 'anthropic-cli' || providerName === 'copilot'
  );
}

/**
 * Resolve the effective execution density for a session.
 *
 *  - explicit `flat` / `scaffold` → that value (the config override / escape
 *    hatch — set `scaffold` to force the full crew on a frontier provider).
 *  - `auto` **and unset** → `flat` for self-orchestrating providers, else
 * `scaffold`. `auto` is the default: validated by the A/B
 *    (codex-cli, flat == scaffold pass rate at −36% to −61% tokens; the
 *    quality gates stay the universal floor that makes flat safe). Local
 *    MEDIUM-tier models also resolve to `flat` (paired N=3 core A/B, see the
 *    function body); local small/tiny/large and raw-cloud stay `scaffold`.
 */
export function resolveExecutionDensity(
  setting: ExecutionDensitySetting | undefined,
  providerName: string | undefined,
  tier?: string,
): ExecutionDensity {
  if (setting === 'flat' || setting === 'scaffold') return setting;
  // `auto` (explicit) and unset (default) pick by provider, then local tier.
  if (isSelfOrchestratingProvider(providerName)) return 'flat';
  // Local MEDIUM tier (12–45B: Qwen 27B, Gemma 26/31B): a paired N=3 core A/B
  // (2026-07-17, llama.cpp) landed flat ≥ scaffold on every scenario — 8
  // non-canary scenarios tied at 3/3, a schema-migration WIN (flat 1/1 vs
  // scaffold 0/1), and ZERO regressions across 24 paired trials. At this tier
  // the crew scaffold was pure coordination overhead. The SMALL tier was a
  // statistical wash (±1-trial churn both ways), so it stays on scaffold
  // pending a larger-N run; tiny/large are unmeasured and stay scaffold. The
  // explicit `flat`/`scaffold` config override (above) is the escape hatch.
  if (tier === 'medium') return 'flat';
  return 'scaffold';
}
