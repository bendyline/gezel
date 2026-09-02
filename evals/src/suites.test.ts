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

const DEVELOPER_SCENARIO_IDS = [
  'fix-squisq-bugs',
  'dev-craftbook-routing',
  'interface-contract',
  'craftbook-code-review',
  'craftbook-api-contract-review',
  'craftbook-codemod-sweep',
  'large-pr-review',
  'craftbook-bug-fix-tdd',
  'craftbook-deep-security-review',
  'craftbook-refactor-module',
] as const;

const COMPLEX_WORK_SCENARIO_IDS = [
  'craftbook-find-vs-create',
  'craftbook-route-multi',
  'craftbook-invoice-run',
  'craftbook-author-params',
  'craftbook-export-generalize',
  'craftbook-author-linear',
  'craftbook-author-gate-script',
  'craftbook-edit-midtask',
  'craftbook-author-fanout',
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
const BUDGETED_SUITE_IDS = [
  'core',
  'smoke',
  'productivity',
  'productivity-smoke',
  'developer',
  'developer-smoke',
  'complex-work',
  'complex-work-smoke',
] as const;

/**
 * Suites that additionally hold to a wall-clock ceiling.
 *
 * `core` is deliberately absent: its frozen game anchors carry a 2-hour
 * budget each (~10h worst case for the suite) and re-budgeting them would
 * break the longitudinal comparability those anchors exist for. New suites
 * do not get to inherit that.
 */
const CEILINGED_SUITE_IDS = [
  'productivity',
  'productivity-smoke',
  'developer',
  'developer-smoke',
  'complex-work',
  'complex-work-smoke',
] as const;

/**
 * Per-scenario and whole-suite AUTHORED budgets for new suites.
 *
 * Deliberately not the worst case, which is larger by two independent
 * multipliers the runner applies at trial time:
 *
 *   - `throughputScaledMaxDurationMs` scales the authored ceiling by
 *     measured decode rate, up to 8x, so capability is not a property of
 *     the hardware. Small for the 27b/31b class (large-pr-review scaled
 *     1.03x on qwen3.8-27b-q4), large for a genuinely slow model.
 *   - `hardCeilingCapMs` then allows extensions to 2x whenever hard
 *     progress moved recently. This rarely fires on `core`, where trials
 *     pass early or stall outright, and reliably fires on a hard suite,
 *     where a model grinds without converging and looks like progress
 *     every ten minutes. Wild-caught on the 2026-08-30 sweep:
 *     `craftbook-author-params` is authored at 35m and PASSED at 62m.
 *
 * So these bound what a suite is DESIGNED to cost, which is what belongs
 * in a membership test. Whoever plans a sweep budgets from the note on
 * `SCORECARD_SUITES` in bin/scorecard.ts, not from these.
 */
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

  it('pins the developer scorecard membership and run order', () => {
    expect(SUITES.developer!.scenarios).toEqual(DEVELOPER_SCENARIO_IDS);
  });

  it('pins the complex-work scorecard membership and run order', () => {
    expect(SUITES['complex-work']!.scenarios).toEqual(COMPLEX_WORK_SCENARIO_IDS);
  });

  // Both new suites are deliberately hard, which makes cheapest-first
  // ordering matter MORE than it does for productivity: a run that gets cut
  // short mid-sweep should still have spent its time on the members most
  // likely to have produced a verdict.
  it.each(['developer', 'complex-work'])(
    'orders the %s suite cheapest-first so a cut-short run still says something',
    (suiteId) => {
      const budgets = suiteScenarios(suiteId).map((s) => s.timeoutMs ?? 0);
      expect(budgets).toEqual([...budgets].sort((a, b) => a - b));
    },
  );

  it.each([
    ['developer-smoke', 'developer'],
    ['complex-work-smoke', 'complex-work'],
  ])('keeps %s a strict subset of %s', (smokeId, fullId) => {
    const full = new Set(SUITES[fullId]!.scenarios);
    for (const sid of SUITES[smokeId]!.scenarios) {
      expect(full.has(sid), `${smokeId} member "${sid}" is not in ${fullId}`).toBe(true);
    }
    expect(SUITES[smokeId]!.scenarios.length).toBeLessThan(full.size);
  });

  // The two hard suites exist to rank models that saturate core, so they
  // must not be re-billing trials core already pays for. Sharing across
  // suites is legitimate in general (productivity shares six on purpose),
  // but a suite whose value proposition is HEADROOM has to be measuring
  // something core is not.
  it('shares no members with core', () => {
    const core = new Set(SUITES.core!.scenarios);
    for (const suiteId of ['developer', 'complex-work'] as const) {
      for (const sid of SUITES[suiteId]!.scenarios) {
        expect(core.has(sid), `${suiteId} member "${sid}" is already billed by core`).toBe(false);
      }
    }
  });

  // Authoring is the axis complex-work uniquely buys, and the majority
  // share is the design commitment — not an accident of which scenarios
  // happened to exist. Dropping below half means the suite has drifted into
  // being a second execution suite.
  it('keeps complex-work majority-authoring', () => {
    const authoring = SUITES['complex-work']!.scenarios.filter((sid) =>
      /^craftbook-(author-|edit-midtask|export-generalize)/.test(sid),
    );
    expect(authoring.length * 2).toBeGreaterThan(SUITES['complex-work']!.scenarios.length);
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
