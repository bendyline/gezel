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

/**
 * Assert a binary office/media deliverable really is the container its
 * extension claims. Eval-only; mirrors `BinaryDocumentCheckSchema` in core.
 */
export interface BinaryDocumentGateCheck {
  kind: 'binaryDocument';
  file: string;
  artifact?: boolean;
  minBytes?: number;
}

export type CraftbookEvalGateCheck =
  | GateCheck
  | PrometheusAlertsGateCheck
  | NodeScriptPassesGateCheck
  | BinaryDocumentGateCheck;

export type CraftbookEvalCoverageStatus = 'missing' | 'planned' | 'implemented' | 'validated';

/**
 * The contract exercised by a craftbook eval.
 *
 * `artifact-task` sends a bounded prompt directly to a worker and proves the
 * requested artifact. It does not claim that the craftbook runtime drove the
 * work. `workflow` creates and dispatches a real craftbook task; the generic
 * harness additionally requires craftbook attribution and terminal progress.
 */
export type CraftbookEvalMode = 'artifact-task' | 'workflow';

/**
 * What a recorded local-model validation actually proves. Artifact-only
 * validations show that the prompt produced deliverables which passed the
 * scenario gates. Workflow validations ran under the workflow-mode invariant:
 * an attributed craftbook task reached a terminal step or completed. Mere task
 * existence is intentionally insufficient.
 */
export type CraftbookEvalValidationScope = 'none' | 'artifact-only' | 'workflow';

export type CraftbookEvalFixtureSurface = 'workspace' | 'artifact' | 'harness';

export interface CraftbookEvalFixtureFile {
  path: string;
  content: string;
  surface?: CraftbookEvalFixtureSurface;
  /** False seeds the fixture without presenting it as model-readable source. */
  modelInput?: boolean;
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
  managedWorkspaceWritePolicy?: 'auto' | 'allow' | 'deny';
  files?: CraftbookEvalFixtureFile[];
  craftbookParams?: Record<string, string>;
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
  artifact?: boolean;
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
    requireTerminalStep?: boolean;
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
  /** Append-only project History evidence proving runtime behavior occurred. */
  history?: Array<{
    kind: string;
    minEntries?: number;
    maxEntries?: number;
    summaryPattern?: string;
    flags?: string;
    details?: Record<string, string | number | boolean | null>;
  }>;
  /** Workspace fixtures that must remain byte-for-byte unchanged. */
  unchangedFixtures?: string[];
}

export interface CraftbookEvalSpec {
  /** Bundled craftbook template id, e.g. `html-arcade-game`. */
  craftbookId: string;

  /** Explicitly states whether this eval proves an artifact or the workflow. */
  mode: CraftbookEvalMode;

  /**
   * Backticked slash-containing path tokens from the book's own step
   * prompts, uninterpolated. Fed (with params) to the runtime's citation
   * forgiveness so the grader matches production — see
   * `taskSuppliedCitationPaths`.
   */
  stepPathTokens?: string[];
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
    /** Mode used by the recorded validation; omit for migrated artifact-only evidence. */
    validatedMode?: CraftbookEvalMode;
    localModels?: string[];
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
  /** Max trial duration, ms. Unset inherits the runner's 8-hour default. */
  timeoutMs?: number;
  /** Hard no-progress timeout, ms. Unset inherits the runner's 45 minutes. */
  progressTimeoutMs?: number;
}

export interface CraftbookTemplateSummary {
  id: string;
  name: string;
  description?: string;
  version?: string;
  triggers: string[];
  steps: CraftbookTemplateStepSummary[];
  entryStepId: string;
  /** Runtime safety/automation hooks carried by the indexed craftbook. */
  hooks?: Array<{
    phase: string;
    matcher: string;
    script?: { name: string; scope?: string };
    decision?: 'allow' | 'deny' | 'ask';
  }>;
  /** Inline craftbook scripts addressable by hook script refs. */
  scripts?: Record<string, string>;
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
  evalMode: CraftbookEvalMode | 'none';
  validationScope: CraftbookEvalValidationScope;
  issues: CraftbookAuditIssue[];
}

export interface CraftbookCoverageSummary {
  totalTemplates: number;
  evalSpecs: number;
  implementedSpecs: number;
  validatedSpecs: number;
  artifactTaskSpecs: number;
  workflowSpecs: number;
  artifactOnlyValidatedSpecs: number;
  workflowValidatedSpecs: number;
  averageQualityScore: number;
  byBand: Record<CraftbookAuditResult['band'], number>;
  byEvalStatus: Record<CraftbookEvalCoverageStatus, number>;
}
