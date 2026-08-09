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

const PRODUCTIVITY_SCENARIO_IDS = [
  'constrained-comms',
  'craftbook-week-plan',
  'craftbook-ab-test-readout',
  'craftbook-annotated-bibliography',
  'records-intake',
  'plan-and-estimate',
  'meeting-followup',
  'craftbook-spreadsheet-model',
  'conflict-synthesis',
  'docblocks-theme-roundtrip',
  'craftbook-research-to-document',
  'craftbook-powerpoint-deck',
  'wikipedia-research-brief',
] as const;

/**
 * Suites whose members must each declare an explicit max duration.
 *
 * A scenario with no `timeoutMs` inherits the runner's 8-hour default,
 * which is defensible for a one-off book run and ruinous inside a curated
 * suite: a few unbounded members silently turn a scorecard into a
 * multi-day job, and nothing in `--list` warns you first. Suites people
 * are told to run end-to-end have to be predictable.
 */
const BUDGETED_SUITE_IDS = ['core', 'smoke', 'productivity', 'productivity-smoke'] as const;

/**
 * Suites that additionally hold to a wall-clock ceiling.
 *
 * `core` is deliberately absent: its frozen game anchors carry a 2-hour
 * budget each (~10h worst case for the suite) and re-budgeting them would
 * break the longitudinal comparability those anchors exist for. New suites
 * do not get to inherit that.
 */
const CEILINGED_SUITE_IDS = ['productivity', 'productivity-smoke'] as const;

/** Per-scenario and whole-suite worst-case ceilings for new suites. */
const MAX_SUITE_SCENARIO_MS = 45 * 60_000;
const MAX_SUITE_TOTAL_MS = 6.5 * 60 * 60_000;

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

  it('pins the productivity scorecard membership and run order', () => {
    expect(SUITES.productivity!.scenarios).toEqual(PRODUCTIVITY_SCENARIO_IDS);
  });

  it('keeps productivity-smoke a strict subset of productivity', () => {
    const full = new Set(SUITES.productivity!.scenarios);
    for (const sid of SUITES['productivity-smoke']!.scenarios) {
      expect(full.has(sid), `productivity-smoke member "${sid}" is not in productivity`).toBe(true);
    }
    expect(SUITES['productivity-smoke']!.scenarios.length).toBeLessThan(full.size);
  });

  it('every scenario in a budgeted suite declares an explicit timeout', () => {
    for (const suiteId of BUDGETED_SUITE_IDS) {
      for (const scenario of suiteScenarios(suiteId)) {
        expect(
          scenario.timeoutMs,
          `suite "${suiteId}" member "${scenario.id}" has no timeoutMs and would inherit the runner's 8-hour default`,
        ).toBeDefined();
      }
    }
  });

  it('holds new suites to a per-scenario and whole-suite wall-clock ceiling', () => {
    for (const suiteId of CEILINGED_SUITE_IDS) {
      const scenarios = suiteScenarios(suiteId);
      for (const scenario of scenarios) {
        expect(
          scenario.timeoutMs,
          `suite "${suiteId}" member "${scenario.id}" exceeds the ${MAX_SUITE_SCENARIO_MS / 60_000}-minute per-scenario ceiling`,
        ).toBeLessThanOrEqual(MAX_SUITE_SCENARIO_MS);
      }
      const totalMs = scenarios.reduce((sum, s) => sum + (s.timeoutMs ?? 0), 0);
      expect(
        totalMs,
        `suite "${suiteId}" worst case is ${Math.round(totalMs / 60_000)} min at --count 1`,
      ).toBeLessThanOrEqual(MAX_SUITE_TOTAL_MS);
    }
  });

  it('orders the productivity suite cheapest-first so a cut-short run still says something', () => {
    const budgets = suiteScenarios('productivity').map((s) => s.timeoutMs ?? 0);
    expect(budgets).toEqual([...budgets].sort((a, b) => a - b));
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
