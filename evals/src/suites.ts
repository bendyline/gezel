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
      'transcript-to-action-register reconciliation, tool-sourced cited research, ' +
      'distractor-resistant research, and the three research-verify trust tiers.',
    scenarios: [
      'constrained-comms',
      'records-intake',
      // Both also sit in `productivity`. This is where their AXIS lives,
      // so a grounding deep-dive reaches them without anyone remembering
      // that the office suite exists.
      'meeting-followup',
      'wikipedia-research-brief',
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
      'Tool-routing + retrieval deep-dive: image-gen routing, browser primitive choreography, ' +
      'direct HTTP fetch routing, retrieval-before-file-walking, codebase Q&A, and the wide ' +
      'mechanical rename on the pinned squisq corpus.',
    scenarios: [
      'tool-routing-image',
      'tool-routing-browser',
      'tool-routing-fetch-url',
      'tool-routing-retrieval',
      'tool-routing-craftbook',
      'squisq-codebase-qa',
      'squisq-broad-refactor',
    ],
  },

  // Deep dive on creative writing. Pass/fail measures brief-compliance
  // (the deterministic gates); the qualitative signal is the advisory
  // LLM judge, so judge this suite post-hoc (pnpm eval:judge-sweep) for the axis scores
  // that actually differentiate models.
  'extended-writing': {
    id: 'extended-writing',
    description:
      'Creative-writing deep-dive: historical fiction grounded in a seeded fact sheet, and ' +
      'original fantasy against a constrained brief. Judge post-hoc with eval:judge-sweep for the ' +
      'qualitative axis scores.',
    scenarios: ['historical-fiction', 'fantasy-fiction'],
  },

  // End-user office and knowledge-work scorecard. Unlike core, which
  // deliberately spans product-wide capabilities, this suite stays on
  // artifacts a non-technical user would recognize: communications,
  // meeting follow-through, planning, research, quantitative readouts,
  // spreadsheets, and presentations. Every external-looking dependency is
  // a deterministic local mock, and the hermetic claim is ENFORCED — see
  // wikipedia-research-brief's three layers, not just asserted in prose.
  //
  // Two deliberate exclusions. Creative writing lives in
  // `extended-writing`; a fantasy short story is not office work, and
  // including it made "productivity score" mean two different things.
  // Coding lives in `core` and `extended-coding`.
  //
  // Six of the thirteen members are shared on purpose — two with core
  // (plan-and-estimate, conflict-synthesis) and four with
  // extended-grounding — because the axes genuinely overlap with office
  // work. The seven remaining members are exclusive — six craftbook-driven
  // artifacts plus the hand-authored theme round-trip — and they are what
  // this suite uniquely buys you. Running core AND productivity double-pays
  // for the shared two; do that deliberately, not by habit.
  //
  // `incident-postmortem` was dropped when the DocBlocks members landed:
  // it is the most expensive scenario in the set, it already runs in core,
  // and the dense-reading axis it covered is now carried by the research
  // brief, the theme round-trip, and meeting follow-up.
  //
  // Three members produce a REAL binary document (a ZIP-shaped PPTX or
  // DOCX) through the DocBlocks tool chain and assert the container, not
  // just a byte count. That is the capability a byte floor silently failed
  // to measure for as long as it existed.
  //
  // Every member declares a bounded `timeoutMs`, ordered cheapest-first,
  // both enforced in suites.test.ts. Worst case is 365 min at --count 1,
  // so a defensible --count 3 scorecard (below n=3 the harness refuses to
  // quote a rate at all) is a ~17h job. Plan for it, or use
  // `productivity-smoke`.
  productivity: {
    id: 'productivity',
    description:
      'Knowledge-work scorecard (13 scenarios, <=6h05m at --count 1): constrained communications, ' +
      'meeting follow-up, records, planning, calendar synthesis, experiment analysis, ' +
      'local-MCP research, bibliography, conflict synthesis, spreadsheet modeling, and DocBlocks ' +
      'document production (PPTX, DOCX, theme round-trip). Fully hermetic. Judge post-hoc with eval:judge-sweep — ' +
      'the deterministic gates measure ' +
      'brief-compliance; the judge axes are what differentiate models.',
    // Cheap and broad first, so a run that gets cut short still says
    // something. Roughly ascending by authored timeoutMs.
    scenarios: [
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
    ],
  },

  // Pulse check for "is office work broken?" — one of each KIND of gate
  // the suite carries, which is what makes three scenarios informative:
  // prose constraints, a harness-owned arithmetic oracle, and a real
  // binary container produced through DocBlocks. Not a scorecard; the same
  // relationship to `productivity` that `smoke` has to `core`.
  'productivity-smoke': {
    id: 'productivity-smoke',
    description:
      'Fast knowledge-work pulse check (3 scenarios, <=1h15m): constrained comms, an A/B ' +
      'readout checked against an arithmetic oracle, and a DOCX produced through DocBlocks. ' +
      'Not a scorecard — use productivity for that.',
    scenarios: ['constrained-comms', 'craftbook-ab-test-readout', 'craftbook-research-to-document'],
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

  // Engineering scorecard, and deliberately HARD: the target band is a
  // frontier cloud model passing most of it, the best local model landing
  // around 4/10, and a small local model 1-2/10. That difficulty does NOT
  // come from stacking constraints onto one artifact — at a ~0.92 per-gate
  // base rate you would need eleven conjunctive gates to reach 40%, which
  // buys brittleness, not difficulty. It comes from three axes where a good
  // local model is measurably weak:
  //
  //   - ROUTING. Recognizing which library recipe fits and invoking it.
  //     qwen3.6-27b managed 1 of 4 even when steered
  //     (prompt-meester-craftbook-prelude.ts). No scorecard suite measured
  //     this before.
  //   - PRECISION UNDER DECOYS. Finding the real defect without reporting
  //     three that aren't. The seeded defects are deliberately OBVIOUS —
  //     an authorization check that returns true for everyone, a rename
  //     that missed three call sites. A subtle defect makes the scenario a
  //     coin flip, which measures nothing.
  //   - EXECUTION RECEIPTS. Red-then-green commandEvidence and runtime
  //     oracles that prose cannot fake.
  //
  // Hermetic: every codebase, diff, and dependency corpus is written by
  // scenario setup. squisq-review stays in `headroom` because it needs
  // network.
  //
  // schema-migration, failing-tests-spec and symptom-debug are deliberately
  // NOT duplicated from `core`. A scorecard that charges the same trial to
  // two suites reads as a bigger sample than it is.
  //
  // Budget 5h40m at --count 1, ordered cheapest-first.
  developer: {
    id: 'developer',
    description:
      'Engineering scorecard (10 scenarios, <=9h15m at --count 1), deliberately hard: craftbook ' +
      'routing under near-neighbour ambiguity, defect identification graded on precision as ' +
      'well as recall, and code change proven by execution receipts. Fully hermetic. Not ' +
      'expected to pass 100% — it exists to rank models that saturate core.',
    scenarios: [
      'fix-squisq-bugs', // 25m — three documented bugs in a seeded codebase, runtime driver + tsc
      'dev-craftbook-routing', // 25m — 3-way recipe discrimination; a wrong-but-plausible pick is terminal
      'interface-contract', // 30m — coupled delegation across a shared type module
      'craftbook-code-review', // 30m — one staged change set, precision-graded
      'craftbook-api-contract-review', // 30m — OpenAPI reconciled against implemented routes
      'craftbook-deep-security-review', // 40m — seeded source-to-sink vulns, structured findings
      'large-pr-review', // 60m — 120-file corpus, planted defect AND planted false-positive trap
      'craftbook-codemod-sweep', // 90m — 9-file rename with a deliberate CHANGELOG exception
      'craftbook-bug-fix-tdd', // 105m — red-then-green receipts plus a mutant oracle
      'craftbook-refactor-module', // 120m — behavior-equivalence matrix + duplication oracle
    ],
  },

  // Pulse check for "is the engineering suite broken?" — one member per
  // GATE KIND, which is what makes three scenarios informative: recipe
  // routing, an executed code oracle, and precision/recall over seeded
  // defects. Same relationship to `developer` that `smoke` has to `core`.
  'developer-smoke': {
    id: 'developer-smoke',
    description:
      'Fast engineering pulse check (3 scenarios, <=2h35m): recipe routing, an executed codemod ' +
      'oracle, and a precision-graded security review. Not a scorecard — use developer for that.',
    scenarios: [
      'dev-craftbook-routing', // 25m
      'craftbook-deep-security-review', // 40m
      'craftbook-codemod-sweep', // 90m
    ],
  },

  // The other half of the headroom pair: multi-phase orchestration, and
  // BUILDING the recipe rather than consuming one. Six of the nine members
  // grade the craftbook the model authored — its paramSchema, its spawn
  // block, its embedded gate script, its repaired step — rather than an
  // artifact some crew produced. That is a capability the product sells and
  // no scorecard suite has ever measured.
  //
  // Two structural facts from the bundled library shape this suite, and
  // both are worth knowing before editing it:
  //   - Only 3 of 287 bundled books carry a `spawn` block (invoice-run,
  //     nightly-fix-sweep, pull-request-review), so craftbook-author-fanout
  //     is the member most likely to be unwinnable rather than merely hard.
  //     It stays until the frontier ceiling check says otherwise.
  //   - Exactly ONE book uses `branches` (ship), and ship is already
  //     validated on gemma4-e4b-q4. So there is no branch-authoring member
  //     here: with 286 of 287 books offering no example to read, that
  //     scenario would measure inventing an unexemplified schema feature,
  //     not authoring. Revisit when gilde ships a second branching book.
  //
  // craftbook-executive-level-review was the tenth candidate and is the
  // first promotion candidate if a member has to be replaced: 7 steps, two
  // terminal, no local validation recorded. It was left out because its
  // difficulty is genuinely UNMEASURED, which is a weaker seat than every
  // other member can claim, and because the 45m it costs bought no axis the
  // nine below do not already cover.
  //
  // Budget 5h40m at --count 1, ordered cheapest-first.
  'complex-work': {
    id: 'complex-work',
    description:
      'Complex-workflow scorecard (9 scenarios, <=10h50m at --count 1), deliberately hard: ' +
      'selecting and executing multi-phase recipes, and AUTHORING new ones — parameterized, ' +
      'fanned-out, self-gating, and repaired mid-flight. Six of nine members grade the craftbook ' +
      'the model wrote. Fully hermetic. Not expected to pass 100%.',
    scenarios: [
      'craftbook-find-vs-create', // 20m — find the library recipe instead of authoring one
      'craftbook-author-linear', // 45m — the authoring anchor: three gated steps, run to completion
      'craftbook-edit-midtask', // 45m — diagnose an unwinnable gate and repair the live book
      'craftbook-invoice-run', // 50m — declarative fanout execution, non-code
      'craftbook-route-multi', // 80m — route AND execute: the selection-to-delivery handoff
      'craftbook-export-generalize', // 80m — generalize finished one-off work into a reusable recipe
      'craftbook-author-params', // 90m — a recipe reusable across two inputs, not hardcoded to one
      'craftbook-author-gate-script', // 120m — embedded inline gate script with an anti-stub floor
      'craftbook-author-fanout', // 120m — author a spawn block; the hardest document shape
    ],
  },

  // Pulse check for "is the workflow suite broken?" — one member per KIND
  // of work the suite grades: SELECTING a recipe, AUTHORING one, and
  // EXECUTING an existing one. Same shape as `productivity-smoke`, which is
  // one member per kind of GATE.
  //
  // `craftbook-author-fanout` was the third member and was swapped out on
  // measurement, not taste. A pulse check answers "is this broken?", which
  // requires a healthy system to pass it: the inaugural run put frontier at
  // 2/3 and qwen3.8-27b-q4 at 1/3 on the old set, because fanout authoring
  // is the member deliberately placed AT the difficulty ceiling — frontier
  // stalls at 6/8, the best local model at 2/8. A subset that a healthy
  // system fails cannot distinguish "hard" from "broken", which is the only
  // question a smoke suite is for. Fanout stays in the full suite, where
  // being unpassable is the job.
  'complex-work-smoke': {
    id: 'complex-work-smoke',
    description:
      'Fast complex-workflow pulse check (3 scenarios, <=1h55m): recipe selection, baseline ' +
      'craftbook authoring, and declarative-fanout execution — one per kind of work the suite ' +
      'grades. Not a scorecard — use complex-work for that.',
    scenarios: [
      'craftbook-find-vs-create', // 20m
      'craftbook-author-linear', // 45m
      'craftbook-invoice-run', // 50m
    ],
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
