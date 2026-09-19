import type { EvalScenario } from './types.ts';

export type RepairPolicy = 'harness' | 'runtime';

/**
 * Apply a trial-level `--repair-policy` to a scenario.
 *
 * The runner's repair channel — re-engage nudges, plateau kills,
 * poisoned-session recovery — applies to every scenario, so the override
 * does too. An earlier version skipped scenarios that did not declare
 * `repairPolicy` themselves, on the theory that only craftbook scenarios
 * took part; the breadth run of 2026-09-18 then re-engaged a Meester-driven
 * authoring scenario under a campaign that was meant to leave the runtime
 * alone. A scenario's own `runtime` declaration is kept as is.
 *
 * Why an override exists at all: the generalist A/B dry run (2026-09-18)
 * showed the default `harness` policy measuring itself instead of the
 * runtime. Twenty milliseconds after a five-step invoice book was dispatched
 * the harness told its owner, in a plain session, that the task "has not
 * reached a terminal step"; two minutes in it recruited a Developer to write
 * the book's LAST deliverable because the owner's role did not score as an
 * implementer; the trial was then failed on that Developer's file while the
 * real task sat on step one. `runtime` leaves the craftbook's own gates,
 * retries and stall sweep in charge and lets the watchdogs bound a hang.
 */
export function withRepairPolicy(
  scenario: EvalScenario,
  policy: RepairPolicy | undefined,
): EvalScenario {
  if (policy === undefined) return scenario;
  if (scenario.repairPolicy === policy) return scenario;
  return { ...scenario, repairPolicy: policy };
}
