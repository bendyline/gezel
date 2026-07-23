import type { EvalScenario } from '../../types.ts';
import { authorLinearScenario } from './author-linear.ts';
import { editMidtaskScenario } from './edit-midtask.ts';
import { findVsCreateScenario } from './find-vs-create.ts';
import { gateScriptScenario } from './gate-script.ts';

/**
 * The craftbook AUTHORING scenarios — the matrix for the craftbook
 * document-format A/B ([bin/ab-craftbook-format.ts](../../bin/ab-craftbook-format.ts)).
 *
 * Deliberately OPT-IN: this map is NOT spread into `SCENARIOS`
 * ([scenarios/index.ts](../../scenarios/index.ts)) so `pnpm eval:all` /
 * full matrices do not grow. `getScenario()` consults it after the main
 * registry, so `pnpm eval:run craftbook-author-linear` still works, and
 * `listScenarios()` output is unchanged.
 */
export const CRAFTBOOK_AUTHORING_SCENARIOS: Record<string, EvalScenario> = {
  [authorLinearScenario.id]: authorLinearScenario,
  [gateScriptScenario.id]: gateScriptScenario,
  [editMidtaskScenario.id]: editMidtaskScenario,
  [findVsCreateScenario.id]: findVsCreateScenario,
};

export function listCraftbookAuthoringScenarios(): EvalScenario[] {
  return Object.values(CRAFTBOOK_AUTHORING_SCENARIOS);
}
