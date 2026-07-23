import { describe, expect, it } from 'vitest';

import { SCENARIOS } from './scenarios/index.ts';
import {
  ANCHORED_SCENARIOS,
  DEFAULT_SUITE_ID,
  SUITES,
  listSuites,
  suiteScenarios,
} from './suites.ts';

const CORE_SCENARIO_IDS = [
  'tictactoe',
  'petshop',
  'tankcombat',
  'schema-migration',
  'failing-tests-spec',
  'symptom-debug',
  'data-wrangle',
  'incident-postmortem',
  'ops-runbook-anomaly',
  'plan-and-estimate',
  'conflict-synthesis',
] as const;

describe('eval suites', () => {
  it('every suite scenario id resolves in the main registry', () => {
    for (const suite of listSuites()) {
      for (const sid of suite.scenarios) {
        expect(
          SCENARIOS[sid],
          `suite "${suite.id}" references unknown scenario "${sid}"`,
        ).toBeDefined();
      }
    }
  });

  it('suite ids match their registry keys and contain no internal duplicates', () => {
    for (const [key, suite] of Object.entries(SUITES)) {
      expect(suite.id).toBe(key);
      expect(new Set(suite.scenarios).size).toBe(suite.scenarios.length);
    }
  });

  it('pins the exact core scorecard membership and run order', () => {
    expect(SUITES.core!.scenarios).toEqual(CORE_SCENARIO_IDS);
    expect(SUITES.core!.scenarios.slice(0, ANCHORED_SCENARIOS.length)).toEqual(ANCHORED_SCENARIOS);
  });

  it('the default suite exists and resolves', () => {
    expect(SUITES[DEFAULT_SUITE_ID]).toBeDefined();
    expect(suiteScenarios(DEFAULT_SUITE_ID)).toHaveLength(CORE_SCENARIO_IDS.length);
  });

  it('suiteScenarios preserves suite order', () => {
    const ids = suiteScenarios('core').map((s) => s.id);
    expect(ids).toEqual([...SUITES.core!.scenarios]);
  });
});
