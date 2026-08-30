import type { EvalScenario } from '../../types.ts';
import { authorLinearScenario } from './author-linear.ts';
import { editMidtaskScenario } from './edit-midtask.ts';
import { findVsCreateScenario } from './find-vs-create.ts';
import { gateScriptScenario } from './gate-script.ts';
import { devCraftbookRoutingScenario } from './route-dev.ts';

/**
 * The craftbook SELECTION + AUTHORING scenarios — the matrix for the
 * craftbook document-format A/B
 * ([bin/ab-craftbook-format.ts](../../bin/ab-craftbook-format.ts)), and the
 * authoring half of the `complex-work` suite.
 *
 * This map WAS deliberately opt-in, so `pnpm eval:all` did not grow. That
 * ended when these became suite members: `suites.test.ts` resolves
 * membership through `SCENARIOS[sid]`, not `getScenario()`, so a scenario
 * reachable only by name cannot join a suite. It is now spread into
 * `SCENARIOS` ([scenarios/index.ts](../../scenarios/index.ts)) and every
 * member carries an explicit `timeoutMs` for the budgeted-suite contract.
 */
export const CRAFTBOOK_AUTHORING_SCENARIOS: Record<string, EvalScenario> = {
  [authorLinearScenario.id]: authorLinearScenario,
  [gateScriptScenario.id]: gateScriptScenario,
  [editMidtaskScenario.id]: editMidtaskScenario,
  [findVsCreateScenario.id]: findVsCreateScenario,
  [devCraftbookRoutingScenario.id]: devCraftbookRoutingScenario,
};

export function listCraftbookAuthoringScenarios(): EvalScenario[] {
  return Object.values(CRAFTBOOK_AUTHORING_SCENARIOS);
}
