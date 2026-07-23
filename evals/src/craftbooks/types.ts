import type {
  CraftbookTestMockExpectation,
  CraftbookTestRubric,
  DeliverableKind,
  GateCheck,
  MockService,
} from '@bendyline/gezel';

export interface PrometheusAlertsGateCheck {
  kind: 'prometheusAlerts';
  file: string;
  minRules?: number;
  maxPageAlerts?: number;
  allowedSeverities?: string[];
  requiredServices?: string[];
  requiredRunbookUrls?: string[];
}

export interface NodeScriptPassesGateCheck {
  kind: 'nodeScriptPasses';
  script: string;
  timeoutMs?: number;
  requiredOutput?: Array<{
    pattern: string;
    flags?: string;
    label?: string;
  }>;
}

export type CraftbookEvalGateCheck =
  | GateCheck
  | PrometheusAlertsGateCheck
  | NodeScriptPassesGateCheck;

export type CraftbookEvalCoverageStatus = 'missing' | 'planned' | 'implemented' | 'validated';

export type CraftbookEvalFixtureSurface = 'workspace' | 'artifact';

export interface CraftbookEvalFixtureFile {
  path: string;
  content: string;
  surface?: CraftbookEvalFixtureSurface;
}

export interface CraftbookEvalSimulator {
  /**
   * Stable id for the fake dependency. Examples: `stripe-api`,
   * `github-cli`, `inventory-mcp`. The harness uses it for coverage
   * reporting; an implemented scenario may also materialize files/scripts
   * from it.
   */
  id: string;
  kind: 'cli' | 'mcp' | 'http' | 'data-source' | 'browser' | 'native';
  status: 'planned' | 'implemented';
  description: string;
}

export interface CraftbookEvalWorkerSetup {
  name: string;
  role: string;
  description?: string;
  about?: string;
}

export interface CraftbookEvalSetup {
  projectName: string;
  about?: string;
  missionObjectives?: string;
  files?: CraftbookEvalFixtureFile[];
  simulators?: CraftbookEvalSimulator[];
  /**
   * Optional direct execution target for generic adapter scenarios. Use
   * this when the eval measures whether the craftbook guides the work,
   * not whether the Meester can recruit and route a worker.
   */
  worker?: CraftbookEvalWorkerSetup;
}

export interface CraftbookEvalDeliverable {
  path: string;
  kind: DeliverableKind;
  minBytes?: number;
  checks?: CraftbookEvalGateCheck[];
}

export interface CraftbookEvalSuccessSpec {
  /**
   * Human-readable target; shown in coverage output and useful in
   * postmortems when deciding whether a scenario actually measures the
   * craftbook's intended work.
   */
  summary: string;
  /**
   * Deterministic file checks the generic scenario adapter can evaluate.
   * For richer scenarios, pair this spec with `existingScenarioId` and keep
   * the custom grader in `evals/src/scenarios`.
   */
  deliverables?: CraftbookEvalDeliverable[];
  checks?: CraftbookEvalGateCheck[];
  taskNotes?: {
    minBytes?: number;
    checks?: CraftbookEvalGateCheck[];
    /**
     * When true, the notes must belong to a task created from the spec's
     * craftbook id. This distinguishes "the worker wrote some notes" from
     * "the craftbook was actually invoked and used."
     */
    requireCraftbookTask?: boolean;
  };
  taskGraph?: {
    checks?: CraftbookEvalGateCheck[];
    requireCraftbookTask?: boolean;
    requireDraftRef?: boolean;
    draft?: {
      status?: 'draft' | 'paused' | 'active' | 'complete' | 'canceled';
      minDescriptionBytes?: number;
      minOutcomes?: number;
      minSteps?: number;
      requireTerminalVerification?: boolean;
      requireGatedBuildSteps?: boolean;
    };
  };
  /** Request-log assertions against the live mock services. */
  mocks?: CraftbookTestMockExpectation[];
}

export interface CraftbookEvalSpec {
  /** Bundled craftbook template id, e.g. `html-arcade-game`. */
  craftbookId: string;
  /** Scenario id when this spec is runnable in the eval matrix. */
  scenarioId: string;
  title: string;
  objective: string;
  /**
   * When set, this spec documents/links an existing hand-authored scenario
   * instead of being generated through the generic adapter.
   */
  existingScenarioId?: string;
  /** Prompt sent by the generic scenario adapter to the Meester or configured worker. */
  prompt?: string;
  setup?: CraftbookEvalSetup;
  success: CraftbookEvalSuccessSpec;
  coverage: {
    status: Exclude<CraftbookEvalCoverageStatus, 'missing'>;
    localModels?: string[];
    lastRun?: string;
    notes?: string;
  };
  qualityFocus: string[];
  /**
   * Future work needed before calling the eval validated. Keep these
   * concrete: missing simulator, weak grader, prompt not proving selection,
   * etc.
   */
  gaps?: string[];
  /**
   * Advisory AI-scoring rubric from the book's `test.json`. The scenario
   * factory wires it onto `EvalScenario.judge` so `--llm-judge` scores
   * these axes; it never affects pass/fail.
   */
  rubric?: CraftbookTestRubric;
  /** Task-class tags from `test.json` (single declared taxonomy). */
  tags?: string[];
  /** Live mock services from `test.json` `mocks[]`. */
  mocks?: MockService[];
  /** Version of the test.json the spec was adapted from (shim provenance header). */
  testSpecVersion?: string;
  /**
   * The book is a declarative-fanout spawn host (its `craftbook.json` carries
   * a `spawn` block). The scenario runs it as a real craftbook TASK — create
   * the task from the craftbook and dispatch its entry step, so the runtime
   * drives the step chain and the per-item fanout — instead of the freehand
   * direct-worker kickoff. Scoped to spawn books only; non-spawn books keep
   * the direct-worker path. Set from the loaded craftbook by the adapter.
   */
  runAsCraftbookTask?: boolean;
}

export interface CraftbookTemplateSummary {
  id: string;
  name: string;
  description?: string;
  version?: string;
  triggers: string[];
  steps: CraftbookTemplateStepSummary[];
  entryStepId: string;
}

export interface CraftbookTemplateStepSummary {
  id: string;
  name: string;
  description?: string;
  prompt?: string;
  suggestedRole?: string;
  advanceWhen?: unknown;
  gate?: unknown;
  next?: string;
  terminal?: boolean;
}

export interface CraftbookAuditIssue {
  severity: 'info' | 'warn' | 'fail';
  code: string;
  message: string;
  stepId?: string;
}

export interface CraftbookAuditResult {
  craftbookId: string;
  name: string;
  score: number;
  maxScore: number;
  band: 'strong' | 'needs-work' | 'weak';
  hasEvalSpec: boolean;
  evalStatus: CraftbookEvalCoverageStatus;
  issues: CraftbookAuditIssue[];
}

export interface CraftbookCoverageSummary {
  totalTemplates: number;
  evalSpecs: number;
  implementedSpecs: number;
  validatedSpecs: number;
  averageQualityScore: number;
  byBand: Record<CraftbookAuditResult['band'], number>;
  byEvalStatus: Record<CraftbookEvalCoverageStatus, number>;
}
