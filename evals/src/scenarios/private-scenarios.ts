import type { EvalScenario } from '../types.ts';
import {
  molenFootballStadiumScenario,
  molenSpaceNeedleScenario,
  molenStructureAssetsScenario,
  molenStructureWorkshopScenario,
} from './molen-structure-workshop.ts';

/**
 * Scenarios that drive Bendyline's private repositories. They only run from a
 * source checkout beside those repositories, and their names, descriptions and
 * file layouts must not be published: the harness compiled into
 * `@bendyline/gezel-service` swaps this module for
 * `private-scenarios.published.ts` (see `buildEvalHarness` in the service's
 * tsup config), and `tests/published/bundledAssets.test.ts` fails if one leaks.
 */
export const PRIVATE_SCENARIOS: readonly EvalScenario[] = [
  molenSpaceNeedleScenario,
  molenFootballStadiumScenario,
  molenStructureWorkshopScenario,
  molenStructureAssetsScenario,
];
