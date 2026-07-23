import { ANCHORED_SCENARIOS, getScenario } from './scenarios/index.ts';
import type { EvalScenario } from './types.ts';

/**
 * Named eval suites — the standardized units of "evaluate a model."
 *
 * The suite registry exists so model-health checks stop defaulting to the
 * three anchored game scenarios (now too easy to differentiate current
 * models) or to the full registry (too slow to be routine). `core` is THE
 * standard answer to "how good is this model in gezel?"; the extended
 * suites are per-axis deep dives you reach for when core surfaces a
 * weakness or when a change targets that axis specifically.
 *
 * Rules of the registry (enforced by suites.test.ts):
 * - every scenario id must resolve in the main registry
 * - `core` always contains the frozen anchors (longitudinal signal) and
 *   at least 8 distinct capability axes total
 * - suites may overlap each other, but never duplicate ids internally
 *
 * Membership changes are deliberate acts: adding to `core` means every
 * future model scorecard pays that scenario's wall-clock, and removing
 * breaks scorecard comparability across time. Prefer growing an extended
 * suite; promote into `core` only when the axis has proven to
 * differentiate models AND is missing from core.
 */
export interface EvalSuite {
  id: string;
  description: string;
  /** Scenario ids, in intended run order (cheap/broad first). */
  scenarios: readonly string[];
}

export const SUITES: Record<string, EvalSuite> = {
  // ~30-60 min on a healthy medium local model. A pulse check, not a
  // scorecard — one game anchor, one tool-routing probe, one debugging
  // probe. Use before/after a risky framework change or engine bump.
  smoke: {
    id: 'smoke',
    description:
      'Fast pulse check (3 scenarios): one anchored game, tool routing, and read-debug-fix. ' +
      'Not a model scorecard — use core for that.',
    scenarios: ['tictactoe', 'tool-routing-image', 'symptom-debug'],
  },

  // The standard model scorecard: 3 frozen anchors (longitudinal
  // comparability) + 8 scenarios each covering a distinct capability
  // axis. Everything here is hermetic (no network) and passable by a
  // well-tuned medium local model per docs/eval-strategy.md.
  core: {
    id: 'core',
    description:
      'The standard 11-scenario model scorecard: the 3 frozen anchors plus 8 diverse axes ' +
      '(multi-file refactor, tests-as-spec, debugging, ETL precision, dense read/structured ' +
      'write, runbook execution, planning, conflict synthesis).',
    scenarios: [
      // Frozen anchors — single-file JS gen, multi-tool + image
      // orchestration, game loop. Kept for cross-time comparability even
      // though current models mostly saturate them.
      'tictactoe',
      'petshop',
      'tankcombat',
      // Coding beyond single-file generation
      'schema-migration', // multi-file refactor gated by tsc
      'failing-tests-spec', // implement against a test suite as the only spec
      'symptom-debug', // diagnose an undocumented semantic bug from observed output
      'data-wrangle', // precision ETL with behavioral property checks
      // Non-code task execution
      'incident-postmortem', // dense multi-file reading, structured cited writing
      'ops-runbook-anomaly', // procedure-following + stop-on-anomaly
      'plan-and-estimate', // planning decomposition with checkable structure
      'conflict-synthesis', // multi-source reconciliation with explicit conflicts
    ],
  },

  // Deep dive on the coding axis when core shows a coding weakness or a
  // change targets code-generation/tooling behavior.
  'extended-coding': {
    id: 'extended-coding',
    description:
      'Coding deep-dive: read-debug-fix, seeded real-codebase bug hunting, algorithmic ' +
      'optimization, doc-grounded SDK use, coupled delegation, phased evolution, mid-flight ' +
      'requirement changes, structured API authoring, and untrusted-workspace rescue.',
    scenarios: [
      'self-correction-broken-js',
      'fix-squisq-bugs',
      'perf-budget',
      'fictional-sdk',
      'interface-contract',
      'codebase-evolution',
      'redline-revision',
      'bookstore-openapi',
      'stale-workspace-rescue',
    ],
  },

  // Deep dive on grounding, precision-off-code, and constraint-following.
  'extended-grounding': {
    id: 'extended-grounding',
    description:
      'Grounding + precision deep-dive: constraint-bound comms, records consolidation, ' +
      'distractor-resistant research, and the three research-verify trust tiers.',
    scenarios: [
      'constrained-comms',
      'records-intake',
      'decoy-research',
      'research-verify-t1',
      'research-verify-t2',
      'research-verify-t3',
    ],
  },

  // Deep dive on tool routing and index-leverage. The squisq-* pair is the
  // warm-vs-cold index probe (see ab-index); run standalone they still
  // measure retrieval-first orientation on a real corpus.
  'extended-retrieval': {
    id: 'extended-retrieval',
    description:
      'Tool-routing + retrieval deep-dive: image-gen routing, retrieval-before-file-walking, ' +
      'codebase Q&A, and the wide mechanical rename on the pinned squisq corpus.',
    scenarios: [
      'tool-routing-image',
      'tool-routing-retrieval',
      'tool-routing-craftbook',
      'squisq-codebase-qa',
      'squisq-broad-refactor',
    ],
  },

  // Deep dive on creative writing. Pass/fail measures brief-compliance
  // (the deterministic gates); the qualitative signal is the advisory
  // LLM judge, so run this suite with --llm-judge for the axis scores
  // that actually differentiate models.
  'extended-writing': {
    id: 'extended-writing',
    description:
      'Creative-writing deep-dive: historical fiction grounded in a seeded fact sheet, and ' +
      'original fantasy against a constrained brief. Run with --llm-judge for the ' +
      'qualitative axis scores.',
    scenarios: ['historical-fiction', 'fantasy-fiction'],
  },

  // Deliberately hard probes that are NOT expected to pass 100% — they
  // give a saturated scorecard headroom and separate frontier-class from
  // medium-class execution. squisq-review needs network (clones GitHub).
  headroom: {
    id: 'headroom',
    description:
      'Hard probes with headroom (not expected 100%): the polished multi-screen arcade game ' +
      'and the full-repo architecture review (requires network).',
    scenarios: ['arcade-deluxe', 'squisq-review'],
  },

  // Bundled project-type rails, driven through the Job Hunt exemplar:
  // typed create, two-gezel crew, named store tools, seeded workspace
  // stores. Non-frozen — grows a scenario per new bundled type worth
  // guarding.
  'extended-project-types': {
    id: 'extended-project-types',
    description:
      'Bundled project-type rails: typed create, named store tools, two-gezel crew — the Job ' +
      'Hunt exemplar.',
    scenarios: ['job-hunt-track'],
  },
};

/** The suite a bare "evaluate this model" request should run. */
export const DEFAULT_SUITE_ID = 'core';

export function getSuite(id: string): EvalSuite {
  const suite = SUITES[id];
  if (!suite) {
    throw new Error(`unknown suite "${id}". Known suites: ${Object.keys(SUITES).join(', ')}`);
  }
  return suite;
}

export function listSuites(): EvalSuite[] {
  return Object.values(SUITES);
}

/** Resolve a suite's scenario ids to full scenario objects, in suite order. */
export function suiteScenarios(id: string): EvalScenario[] {
  return getSuite(id).scenarios.map((sid) => getScenario(sid));
}

export { ANCHORED_SCENARIOS };
