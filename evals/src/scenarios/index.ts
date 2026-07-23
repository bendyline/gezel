import { CRAFTBOOK_AUTHORING_SCENARIOS } from '../craftbooks/authoring/index.ts';
import { craftbookScenarioFromSpec } from '../craftbooks/scenario.ts';
import { runnableGenericCraftbookSpecs } from '../craftbooks/specs.ts';
import type { EvalScenario } from '../types.ts';
import { arcadeDeluxeScenario } from './arcade-deluxe.ts';
import { bookstoreOpenapiScenario } from './bookstore-openapi.ts';
import { codebaseEvolutionScenario } from './codebase-evolution.ts';
import { conflictSynthesisScenario } from './conflict-synthesis.ts';
import { constrainedCommsScenario } from './constrained-comms.ts';
import { dataWrangleScenario } from './data-wrangle.ts';
import { decoyResearchScenario } from './decoy-research.ts';
import { failingTestsSpecScenario } from './failing-tests-spec.ts';
import { fantasyFictionScenario } from './fantasy-fiction.ts';
import { fictionalSdkScenario } from './fictional-sdk.ts';
import { fixSquisqBugsScenario } from './fix-squisq-bugs.ts';
import { historicalFictionScenario } from './historical-fiction.ts';
import { incidentPostmortemScenario } from './incident-postmortem.ts';
import { indexBenchScenario } from './index-bench.ts';
import { interfaceContractScenario } from './interface-contract.ts';
import { jobHuntScenario } from './job-hunt.ts';
import { opsRunbookScenario } from './ops-runbook.ts';
import { perfBudgetScenario } from './perf-budget.ts';
import { petShopScenario } from './petshop.ts';
import { planAndEstimateScenario, plannerFileHandoffScenario } from './plan-and-estimate.ts';
import { recordsIntakeScenario } from './records-intake.ts';
import { redlineRevisionScenario } from './redline-revision.ts';
import { researchVerifyT1, researchVerifyT2, researchVerifyT3 } from './research-verify.ts';
import { schemaMigrationScenario } from './schema-migration.ts';
import { selfCorrectionScenario } from './self-correction.ts';
import { squisqBroadRefactorScenario } from './squisq-broad-refactor.ts';
import { squisqCodebaseQaScenario } from './squisq-codebase-qa.ts';
import { squisqReviewScenario } from './squisq-review.ts';
import { staleWorkspaceRescueScenario } from './stale-workspace-rescue.ts';
import { symptomDebugScenario } from './symptom-debug.ts';
import { tankCombatScenario } from './tankcombat.ts';
import { ticTacToeScenario } from './tictactoe.ts';
import { toolRoutingCraftbookScenario } from './tool-routing-craftbook.ts';
import { toolRoutingImageScenario } from './tool-routing-image.ts';
import { toolRoutingRetrievalScenario } from './tool-routing-retrieval.ts';

const CRAFTBOOK_SCENARIOS = Object.fromEntries(
  runnableGenericCraftbookSpecs().map((spec) => [spec.scenarioId, craftbookScenarioFromSpec(spec)]),
) as Record<string, EvalScenario>;

export const SCENARIOS: Record<string, EvalScenario> = {
  [ticTacToeScenario.id]: ticTacToeScenario,
  [petShopScenario.id]: petShopScenario,
  [tankCombatScenario.id]: tankCombatScenario,
  [toolRoutingImageScenario.id]: toolRoutingImageScenario,
  // Retrieval-before-file-walking probe: measures the
  // Tier-3 retrieval-first steering + workspace-gestalt behaviors. A/B via
  // forceBehaviors/removeBehaviors on prompt.retrieval-first /
  // prompt.workspace-gestalt.
  [toolRoutingRetrievalScenario.id]: toolRoutingRetrievalScenario,
  // Craftbook-adoption probe for one-off data-transform asks: does the meester
  // route "clean these spreadsheets"
  // through suggest/invoke_craftbook (gated task) instead of raw
  // delegation? A/B via prompt.meester-craftbook-prelude.
  [toolRoutingCraftbookScenario.id]: toolRoutingCraftbookScenario,
  // Theme D2: the six non-code scenario classes from
  // task-completion-strategy Part 4 — constraint-following comms,
  // records precision, structural planning, explicit conflict
  // reconciliation, tiered grounding/citations, and runbook execution
  // with stop-on-anomaly. Graders are the productized
  // @bendyline/gezel/checks functions (one codebase for gates + evals).
  [constrainedCommsScenario.id]: constrainedCommsScenario,
  [recordsIntakeScenario.id]: recordsIntakeScenario,
  [planAndEstimateScenario.id]: planAndEstimateScenario,
  [plannerFileHandoffScenario.id]: plannerFileHandoffScenario,
  [conflictSynthesisScenario.id]: conflictSynthesisScenario,
  [researchVerifyT1.id]: researchVerifyT1,
  [researchVerifyT2.id]: researchVerifyT2,
  [researchVerifyT3.id]: researchVerifyT3,
  [opsRunbookScenario.id]: opsRunbookScenario,
  // Direct index-quality benchmark (no agent): golden-query
  // retrieval before/after enrichment on a pinned squisq corpus. The
  // `index-bench` bin sweeps it across models (= enricher A/B).
  [indexBenchScenario.id]: indexBenchScenario,
  // Index-leverage agent probes on the same pinned corpus:
  // a 34-file mechanical rename and a 6-question "where does X live" Q&A.
  // Run warm-vs-cold via the ab-index bin (GEZEL_INDEX_ARM).
  [squisqBroadRefactorScenario.id]: squisqBroadRefactorScenario,
  [squisqCodebaseQaScenario.id]: squisqCodebaseQaScenario,
  [selfCorrectionScenario.id]: selfCorrectionScenario,
  [squisqReviewScenario.id]: squisqReviewScenario,
  // Three "push-harder" scenarios added — each exercises a
  // capability dimension the legacy trio doesn't cover: multi-file
  // planning + execution, structured-output validation, and dense
  // reading + structured writing. See evals/runs/SESSION-2026-05-29-*
  // for design rationale.
  [schemaMigrationScenario.id]: schemaMigrationScenario,
  [bookstoreOpenapiScenario.id]: bookstoreOpenapiScenario,
  [incidentPostmortemScenario.id]: incidentPostmortemScenario,
  // Deliberately HARD, multi-phase probe: a polished
  // multi-screen arcade game gated on the full title → play → game-over →
  // restart cycle. Unlike the rest of the suite it is NOT expected to be
  // 100% — it exists to give the saturated suite headroom and to A/B the
  // craftbook stack (steered vs GEZEL_DISABLE_CRAFTBOOK_HINT=1 baseline).
  // See docs/craftbook-ab-eval.md.
  [arcadeDeluxeScenario.id]: arcadeDeluxeScenario,
  // Find-and-fix-bugs in an EXISTING codebase: the
  // control arm for the "can a small model plan + execute against a real
  // codebase, and does a consolidated tool surface help?" experiment.
  // Seeds squisq's documented Quality-Audit bug trio. See the
  // toolset-consolidation A/B notes.
  [fixSquisqBugsScenario.id]: fixSquisqBugsScenario,
  // Nine orthogonal scenarios — each targets a
  // capability axis the suite above doesn't measure, designed against
  // the 912-trial failure history. All graders are behavioral/runtime
  // gates with reference-solution tests proving each gate is winnable.
  // See docs/orthogonal-scenarios-2026-06.md for the design rationale.
  [failingTestsSpecScenario.id]: failingTestsSpecScenario, // tests-as-spec inference
  [symptomDebugScenario.id]: symptomDebugScenario, // undocumented-bug debugging
  [staleWorkspaceRescueScenario.id]: staleWorkspaceRescueScenario, // audit-before-act
  [dataWrangleScenario.id]: dataWrangleScenario, // precision ETL
  [perfBudgetScenario.id]: perfBudgetScenario, // algorithmic optimization
  [fictionalSdkScenario.id]: fictionalSdkScenario, // doc-grounding vs priors
  [redlineRevisionScenario.id]: redlineRevisionScenario, // requirement stacking
  [decoyResearchScenario.id]: decoyResearchScenario, // distractor grounding
  [interfaceContractScenario.id]: interfaceContractScenario, // coupled delegation
  [codebaseEvolutionScenario.id]: codebaseEvolutionScenario, // phased codebase evolution + refactor
  // Creative-writing pair: grounded story from a
  // seeded fact sheet about an INVENTED obscure historical figure, and
  // pure invention against a constrained "dragons and castles" brief.
  // Deterministic gates check brief-compliance (fact/element anchors,
  // prose form, dialogue, length); creative QUALITY is the advisory
  // --llm-judge layer via each scenario's `judge` axes (story-checks.ts
  // holds the shared gates).
  [historicalFictionScenario.id]: historicalFictionScenario,
  [fantasyFictionScenario.id]: fantasyFictionScenario,
  // Project-type rails probe: typed create of the bundled Job Hunt type
  // (two-gezel crew, seeded stores, named script-tools), then one coach
  // turn that must persist an application into the workspace pipeline.
  [jobHuntScenario.id]: jobHuntScenario,
  ...CRAFTBOOK_SCENARIOS,
};

/**
 * The frozen longitudinal anchors (Theme E / E4). These three scenarios'
 * prompts + success criteria must NOT drift — they're the "did anything
 * regress?" signal across model bumps, native-bundle bumps, and framework
 * upgrades (docs/eval-strategy.md). The discipline is "keep anchors
 * frozen; expand by adding": if an anchor's outcome changes, fix the
 * tuning/prompt/framework gap, don't edit the scenario. `anchored.test.ts`
 * makes that structural — a checksum over each anchor's prompt/evidence
 * and its source file, so any edit forces a deliberate hash bump.
 */
export const ANCHORED_SCENARIOS = ['tictactoe', 'petshop', 'tankcombat'] as const;

export function getScenario(id: string): EvalScenario {
  // Opt-in maps are consulted AFTER the main registry: the craftbook
  // authoring scenarios are runnable by name (and by the
  // ab-craftbook-format bin) without growing `pnpm eval:all` /
  // `listScenarios()` output.
  const scenario = SCENARIOS[id] ?? CRAFTBOOK_AUTHORING_SCENARIOS[id];
  if (!scenario) {
    const known =
      [...Object.keys(SCENARIOS), ...Object.keys(CRAFTBOOK_AUTHORING_SCENARIOS)].join(', ') ||
      '(none)';
    throw new Error(`unknown scenario "${id}". Known scenarios: ${known}`);
  }
  return scenario;
}

export function listScenarios(): EvalScenario[] {
  return Object.values(SCENARIOS);
}
