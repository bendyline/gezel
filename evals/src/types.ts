import type { EvalHints } from '@bendyline/gezel';
import type { GezelClient } from '@bendyline/gezel-client/node';
import type { ChatProvider } from './providers.ts';

/**
 * Result of a single poll of a scenario's success check. `done: false` keeps
 * the runner polling until timeout. `done: true` ends the trial — `success`
 * decides whether it counts toward the success rate.
 */
export type SuccessCheckResult =
  | { done: false }
  | { done: true; success: true; reason: string }
  | { done: true; success: false; reason: string; failureMode?: FailureMode };

/**
 * Bounded scenario helpers can hand a terminal failure to the runner without
 * making every success-check call site translate helper-specific outcomes.
 * The runner applies this only after the current success check returns, so a
 * gate that closes on the same poll still wins over a stale failure request.
 */
export interface EvalTerminalFailure {
  reason: string;
  failureMode: FailureMode;
}

/**
 * Persisted, completed repair activity for one chat session. The eval
 * runner derives this from successful file-mutation tool calls on committed
 * assistant messages, so an in-flight tool call cannot advance a bounded
 * repair ladder merely because it was dispatched.
 */
export interface EvalRepairActionSnapshot {
  /** Number of assistant turns that completed at least one successful file mutation. */
  completedMutationTurns: number;
  /** True when this session currently has an uncommitted turn in flight. */
  inflight: boolean;
}

export interface EvalContext {
  client: GezelClient;
  meesterId: string;
  /**
   * Live mock-service runtime for this trial, present when the scenario
   * declared `mockServices`. The runner boots the fake HTTPS services
   * BEFORE the daemon spawns (the daemon needs NODE_EXTRA_CA_CERTS +
   * GEZEL_SEED_SECRETS_FILE at start) and closes them at teardown.
   * Scenarios use it to grant credentials on the trial project, seed the
   * discovery fixtures, substitute `{{mock:*}}` placeholders, and grade
   * `success.mocks` request-log assertions.
   */
  mocks?: import('./mock/mock-server.ts').MockServicesRuntime;
  log: (line: string) => void;
  /**
   * Log a line only when it differs from the last line logged under
   * the same `key`. Used by success-check loops that poll the same
   * artifact every ~5s — without dedup the trial log gets spammed
   * with 200+ identical sniff lines and the meaningful state changes
   * (a new signal firing, a new `failReason`) get buried. State is
   * per-trial; the runner provisions a fresh map for each trial so
   * batch runs with overlapping artifact paths don't bleed state
   * across trials.
   */
  logChanged: (key: string, line: string) => void;
  /**
   * Report the latest scenario sniff state to the runner so it can feed
   * the progress fingerprint. Scenarios call this from `successCheck`
   * whenever they evaluate the target artifact — even when the artifact
   * isn't present yet (score 0, bytes 0). The runner uses the delta as
   * one of the "is the team making progress?" signals so trials that
   * are growing the deliverable don't get killed by the no-progress
   * timeout. No-op when omitted (back-compat for scenarios that don't
   * yet wire it in).
   *
   * `runtimePassed` / `runtimeFailed`: when the scenario runs a runtime
   * assertion layer (Playwright) after sniff, scenarios may report the
   * pass/fail counts so the retry-loop watchdog can see runtime
   * iteration as movement. Wild-caught (nemotron-super
   * v5 tictactoe): sniff hit 6/6 fast but Playwright kept failing
   * (`click-marks-a-cell`); without runtime state in the fingerprint,
   * the watchdog's "sniff stuck" key didn't move while the team was
   * actively fixing runtime issues, and the trial got killed mid-fix.
   */
  recordSniff?: (state: {
    key: string;
    score: number;
    bytes: number;
    failReason?: string;
    /**
     * Workspace-relative file the scenario has selected for the next repair.
     * This is separate from `key`: a multi-file gate can keep one stable
     * scenario key while routing successive failures to different files.
     */
    repairFilePath?: string;
    runtimePassed?: number;
    runtimeFailed?: number;
  }) => void;
  /**
   * Request a terminal trial failure after the current success check. Used by
   * bounded repair helpers once their final allowed attempt is exhausted.
   * Optional for lightweight scenario-unit contexts; the real runner always
   * provides it.
   */
  requestTerminalFailure?: (failure: EvalTerminalFailure) => void;
  /**
   * Snapshot completed repair actions for a target session. Sniff feedback
   * records this when a nudge is delivered, then compares a later snapshot
   * to recognize a completed repair whose resulting bytes are identical.
   * Optional for lightweight scenario-unit contexts and older clients; the
   * real runner provides it.
   */
  snapshotRepairActions?: (scope: {
    sessionId: string;
    gezelId: string;
    projectId?: string;
  }) => Promise<EvalRepairActionSnapshot | null>;
  /**
   * Per-model eval-harness hints loaded from the model's catalog
   * manifest (`ChatModelManifestSchema.evalHints`). Interactive-game
   * scenarios consume `sniffThresholds.inlineJsMinBytes` and
   * `sniffThresholds.htmlMinBytes` to lower anti-stub floors for model
   * families that write tighter idiomatic code. Unset for most models
   * — the default floors apply.
   */
  evalHints?: EvalHints;
}

/**
 * Per-scenario configuration for the advisory LLM-judge pass
 * (`--llm-judge`). Without a spec, the judge falls back to the legacy
 * behavior: first HTML file in the trial snapshot, default 4-axis HTML
 * rubric. Scenarios whose deliverable is a named non-HTML file (the
 * creative-writing pair, incident-postmortem-style docs) declare the
 * artifact and their own axes here. Advisory only — never changes the
 * trial's pass/fail (see llm-judge.ts for the rationale).
 */
export interface ScenarioJudgeSpec {
  /** Basename of the deliverable inside the trial's workspace/artifacts snapshot (e.g. `story.md`). */
  artifactBasename: string;
  artifactKind: 'html' | 'markdown' | 'yaml' | 'typescript' | 'json' | 'text';
  /** Scenario-specific rubric axes; each name becomes a key on JudgeReport.scoreAxes. */
  axes: ReadonlyArray<{ name: string; description: string }>;
  /** Ground-truth summary injected into the judge prompt (fact sheets, brief constraints). */
  contextNote?: string;
}

export interface EvalScenario {
  id: string;
  description: string;
  /** Sent verbatim to the Meester as the kickoff message. */
  prompt: string;
  /**
   * Grader-lint contract: for every signal the scenario's grader hard-
   * REQUIRES, the pattern that must be satisfiable from the prompt text
   * itself. `grader-lint.test.ts` asserts `pattern.test(prompt)` for each
   * entry — a grader requiring vocabulary the prompt never asks for is an
   * unwinnable gate (wild-caught: arcade-deluxe reused the tank
   * sniff, so `tank-vocab` was REQUIRED for a prompt that never says
   * "tank"; a 120B model burned 8 polish rewrites against it). Declare an
   * entry for every required subject-vocab gate; structural gates (JS
   * parses, byte floors) don't need entries.
   */
  requiredPromptEvidence?: Array<{ signal: string; pattern: RegExp }>;
  /**
   * User-shaped texts beyond `prompt` that count as "what the user
   * asked for" when linting `requiredPromptEvidence` satisfiability —
   * for seeded scenarios that's the kickoff message and the project's
   * missionObjectives (the prompt is often just a benign meester note).
   * Export the constants from the scenario module and list them here so
   * the lint and the setup hook can't drift apart.
   */
  evidenceTexts?: string[];
  /**
   * Matrix-run trial cap for saturated scenarios. When set, `runMatrix`
   * runs `min(count, suggestedTrials)` trials of this scenario instead
   * of the full `--count` — a regression canary keeps coverage while the
   * freed budget goes to scenarios with real headroom. Explicit
   * single-scenario `runBatch` calls ignore this (asking for one
   * scenario by name is an intentional deep-dive).
   */
  suggestedTrials?: number;
  /**
   * Per-scenario override of the hard ceiling on trial duration.
   * Defaults to `DEFAULT_MAX_DURATION_MS` (8 hours) in the runner.
   * Scenarios shouldn't set this for normal models — the no-progress
   * watchdog is the primary kill mechanism. Set only when a scenario
   * has a known structural reason to bound wall-clock time (e.g.
   * `self-correction-broken-js` should finish in seconds, not hours).
   *
   * Historically this was a tight wall-clock budget — see the long
   * comment in `runner.ts:pollUntilDone` for the rationale on moving
   * to progress-based completion. Kept as `timeoutMs` for back-compat
   * with existing scenarios; new scenarios should leave it unset.
   */
  timeoutMs?: number;
  /**
   * No-progress threshold (ms). When the progress fingerprint hasn't
   * changed for this long, the trial fails with `failureMode:
   * 'no-progress'`. Defaults to `DEFAULT_PROGRESS_TIMEOUT_MS` (5 min)
   * in the runner. Lower → more aggressive stall detection (catches
   * stuck trials sooner; risks false-failing slow-but-real progress);
   * higher → more patient (gives the model more recovery room). 5 min
   * is the lowest value where a token-heavy thinking phase on
   * qwen3.6-class models doesn't trip the watchdog.
   */
  progressTimeoutMs?: number;
  /** Polled every `pollIntervalMs` (default 5000). */
  successCheck: (ctx: EvalContext) => Promise<SuccessCheckResult>;
  /**
   * Optional setup hook. Called after the meester exists and the trial
   * daemon is fully booted, but *before* the kickoff prompt is sent.
   * Use this to seed workspace files, pre-populate artifacts, or set up
   * project state the scenario assumes. The runner gates the kickoff
   * prompt on `setup` resolving — a thrown error fails the trial
   * cleanly with failureMode='spawn-error' so the postmortem says why.
   *
   * Most scenarios don't need this (the Meester sets everything up from
   * the prompt). It exists for scenarios like `self-correction-broken-js`
   * that test read-debug-fix on a pre-existing artifact.
   */
  setup?: (ctx: EvalContext) => Promise<void>;
  /**
   * Skip the standard Meester kickoff prompt after setup. Use only for
   * scenarios whose setup hook already sends the actionable prompt to
   * the target gezel; otherwise the trial may have no work in flight.
   */
  skipInitialPrompt?: boolean;
  /**
   * Advisory LLM-judge configuration for this scenario's deliverable.
   * Consumed by the `--llm-judge` pass in bin/run.ts. Optional — HTML
   * scenarios get the legacy default rubric without declaring anything.
   */
  judge?: ScenarioJudgeSpec;
  /**
   * Live mock services this scenario needs (from the craftbook's
   * `test.json` `mocks[]`). When any `http`/`webhook`/`mcp` entries exist
   * the runner boots them before spawning the trial daemon, injects
   * `NODE_EXTRA_CA_CERTS` + `GEZEL_SEED_SECRETS_FILE` into the daemon
   * env, writes local-catalog `mock-mcp-<id>` toolset manifests into the
   * trial home for `mcp` entries, exposes the runtime as `ctx.mocks`, and
   * closes it at teardown.
   */
  mockServices?: import('@bendyline/gezel').MockService[];
  /**
   * Default image-model catalog id to warm when running this scenario.
   * Set on scenarios that need image generation (petshop, etc.). The
   * runner warms + links it before spawning the trial daemon and
   * configures `imageProvider: 'sd-cpp'`. Skipped when unset.
   * `--image-model <id>` on the CLI overrides this.
   */
  defaultImageModelId?: string;
}

export interface TrialOptions {
  /** Catalog id of the chat model to use (e.g. `gemma4-e4b-q8`). */
  modelId: string;
  /**
   * Chat provider that drives the trial. Defaults to `llama-cpp`. The
   * runner gates whole phases on the provider's category (see
   * [providers.ts](./providers.ts) → `categorizeProvider`):
   *
   *  - `llama-cpp` / `mlx` — local engines; warm-cache + binary probe
   *    + GPU/process perf sampling all apply.
   *  - `codex-cli` / `anthropic-cli` — CLI-wrapper providers; the
   *    daemon spawns a per-turn subprocess. No warm-cache, no local
   *    sampling, auth comes from the CLI's own login files or env.
   *  - `copilot` / `anthropic` / `openai` — pure cloud SDKs; no local
   *    pipeline at all, auth from env vars (or `gh` login for
   *    copilot).
   *
   * `mlx` additionally requires `mlxSourceHome` (or the default
   * `~/.gezel-dev`) to contain the engine subtree.
   */
  engine?: ChatProvider;
  /**
   * For `engine: 'mlx'` only — gezel home that already has the model
   * weights laid out at `engines/mlx/models/<modelId>/`. The trial
   * symlinks from there instead of downloading a copy. Defaults to
   * `~/.gezel-dev` (the dev-mode home `pnpm app` writes to).
   */
  mlxSourceHome?: string;
  /**
   * Catalog id of a SECOND local model to warm + link in and route index
   * enrichment to (`GEZEL_ENRICH_MODEL` in the daemon env, read by
   * `buildEnrichDeps`). Decouples the enricher from the executor for
   * agent-outcome index benches: one model can't fill both roles — a 9B
   * enricher takes hours over a 350-file corpus, a fast e4b executor
   * floors the task metric. Same engine as `engine`; ignored for
   * cloud/CLI providers (they have no local enrichment path to feed).
   */
  enrichModelId?: string;
  /**
   * Catalog id of the image model to warm + link in (e.g. `sdxl-base-1.0`).
   * Set when the scenario needs image generation. Omitting it leaves
   * the trial daemon without a configured image provider — scenarios
   * that try to render anyway will surface a clear error.
   */
  imageModelId?: string;
  /**
   * Execution density for the trial daemon (`--render-mode`). `flat` routes
   * the meester to a solo ambachtsman (collapsed craftbook) instead of a
   * crew; `scaffold` is the full team; `auto` picks by provider. Threaded
   * into the daemon's `config.executionDensity`. Omitted ⇒ daemon default
   * (`scaffold`). The A/B lever for frontier-adaptive execution.
   */
  executionDensity?: 'auto' | 'flat' | 'scaffold';
  /** Override the default poll cadence (ms). */
  pollIntervalMs?: number;
  /** Override the scenario's timeout. */
  timeoutMs?: number;
  /** Where to put the per-trial output. Defaults to `<repo>/evals/runs/<trialId>/`. */
  runsDir?: string;
  /** Shared model cache root. Defaults to `<HOME>/.gezel-eval-cache`. */
  cacheRoot?: string;
  /** Override the resolved llama-server binary path. */
  llamaBin?: string;
  /** Override the resolved sd-server binary path. */
  sdBin?: string;
  /**
   * When set, the runner aborts the polling loop and runs cleanup as soon
   * as the signal fires. Bin entry points wire this to SIGINT/SIGTERM so
   * Ctrl+C still produces a fully captured postmortem instead of leaving
   * orphaned daemons + an empty runDir.
   */
  signal?: AbortSignal;
  /**
   * Behavior ids to FORCE ON for this run, injected into the daemon via
   * `GEZEL_FORCE_BEHAVIORS` (read by `applyBehaviorEnvOverrides` at
   * session build). The general per-run A/B toggle — e.g.
   * `['tools.gezels-as-roles']` for the treatment arm. No catalog edits
   * or rebuilds needed between control and treatment.
   */
  forceBehaviors?: string[];
  /** Behavior ids to FORCE OFF for this run, via `GEZEL_REMOVE_BEHAVIORS`. */
  removeBehaviors?: string[];
  /**
   * Enable Keurmeester supervision for this trial: a frontier model is
   * consulted when the local model exhausts its recovery budget (see
   * packages/service/src/keurmeester/). Sets `config.keurmeester =
   * { enabled: true, providerName, model }` in the trial daemon and adds
   * `supervision.keurmeester` to the forced behaviors so the arm is
   * visible in the daemon env. The supervisor-on vs -off A/B lever;
   * `providerName` must be a non-local provider with credentials
   * available to the trial daemon (env vars, gh login, …). Case records
   * are harvested into `<runDir>/keurmeester/` at capture time.
   */
  keurmeester?: { providerName: string; model?: string };
  /**
   * Craftbook whole-document codec for this run, injected into the daemon
   * via `GEZEL_CRAFTBOOK_DOC_FORMAT` (read at service boot). Picks the
   * default codec AND the format the `craftbook_write`/`craftbook_read`
   * tool descriptions advertise. The entire lever for the craftbook
   * format A/B (`ab-craftbook-format`). Unset ⇒ daemon default.
   */
  craftbookDocFormat?: 'json' | 'md';
  /**
   * MCP tool-naming arm for this run, injected into the daemon via
   * `GEZEL_MCP_TOOL_NAMING` (forwarded by ChatManager into the gezel-mcp
   * subprocess env, read at MCP-server module load). `legacy` re-advertises
   * the pre-rename spellings (`readFile`/`writeFile`/`readdir`/…); `snake`
   * (or unset) advertises the canonical snake_case names. The entire lever
   * for the naming A/B (`ab-tool-naming`). Dispatch aliases accept both
   * spellings in both arms.
   */
  toolNaming?: 'snake' | 'legacy';
  /**
   * Disable the idle-gated background enrichment tick in the trial daemon
   * (`GEZEL_DISABLE_BACKGROUND_ENRICH=1`). Index-arm trials drive enrichment
   * explicitly (warm) or not at all (cold); disabling the tick keeps cold
   * arms genuinely cold and cost metrics uncontended.
   */
  disableBackgroundEnrich?: boolean;
  /**
   * Opt back IN to capability-floor model routing
   * (`GEZEL_DISABLE_MODEL_ROUTING` is set in every trial daemon by
   * default — multi-model trial homes would otherwise let routing swap
   * craftbook worker steps off the model under evaluation). Only a
   * dedicated routing eval should set this.
   */
  enableModelRouting?: boolean;
}

export type FailureMode =
  | 'timeout'
  | 'no-progress'
  | 'chat-stalled'
  | 'model-stuck'
  | 'success-check-false'
  | 'spawn-error'
  | 'crash'
  | 'engine-crash'
  | 'interrupted'
  /**
   * A native engine (sd-server render, etc.) started a job and then
   * went silent for the whole soft window. Infra failure — distinct
   * from `chat-stalled` so pass-rate accounting doesn't blame the
   * model for a wedged engine.
   */
  | 'engine-hung';

/**
 * Who broke the trial — the coarse accountability tag that makes
 * pass-rate tables trustworthy. `model` is the only class that should
 * count against a model in capability comparisons; see
 * `failure-class.ts` for the rule definitions and the
 * analysis that motivated this (operator SIGINTs, capacity denials, and
 * grader bugs were all silently polluting the `model` column).
 */
export type FailureClass = 'pass' | 'model' | 'infra' | 'grader' | 'operator';

export interface NativeEngineIncidentSummary {
  count: number;
  kinds: Record<string, number>;
  incidentIds: string[];
  /** Short panic/exit excerpts; no prompt or tool content. */
  evidence: string[];
}

export interface TrialResult {
  trialId: string;
  scenarioId: string;
  modelId: string;
  /**
   * Capability tier of the model that ran this trial (Theme E / E1-B).
   * Stamped at finalize from `classifyEvalModelTier`; drives count-not-
   * rate rendering at tiny tier in the reporting bins.
   */
  modelTier?: import('@bendyline/gezel').ModelTier;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  success: boolean;
  /** Why the trial ended — same string the user sees in `result.json`. */
  reason: string;
  /** Set when `success === false`. */
  failureMode?: FailureMode;
  /** Coarse accountability tag (see {@link FailureClass}). */
  failureClass?: FailureClass;
  /** The classifier rule that assigned `failureClass` (e.g. 'capacity-denial'). */
  failureClassRule?: string;
  /** Short excerpt of the matched reason/log evidence. */
  failureClassEvidence?: string;
  /** Reliability signal retained even when the trial recovered and passed. */
  nativeEngineIncidents?: NativeEngineIncidentSummary;
  /**
   * Structured salvage: the last scenario sniff state at the moment a
   * FAILED trial terminated. Makes "killed at 6/7 signals" queryable
   * without parsing reason strings — near-miss accounting for the
   * failure-class pipeline. Absent on passes and on trials that died
   * before any sniff.
   */
  finalSniff?: TrialFinalSniff;
  /**
   * Supervisor-arm trials only: aggregate of the Keurmeester
   * intervention case records harvested into `<runDir>/keurmeester/`.
   * Absent on control-arm trials; `consults: 0` on armed trials where
   * the supervisor never triggered (the expected control-scenario
   * reading — an over-eager supervisor shows up here first).
   */
  keurmeester?: import('./keurmeester-metrics.ts').KeurmeesterTrialSummary;
  runDir: string;
}

export interface TrialFinalSniff {
  key: string;
  score: number;
  bytes: number;
  failReason?: string;
  /** Workspace-relative file selected by the scenario for the next repair. */
  repairFilePath?: string;
  runtimePassed?: number;
  runtimeFailed?: number;
}

/**
 * Early "this trial is running" marker, written to `<runDir>/status.json`
 * the moment the run directory is created and removed once `result.json`
 * lands. Lets the eval viewer surface in-flight trials live, before the
 * terminal `TrialResult` exists. See `writeTrialStatus` in `runner.ts`.
 */
export interface TrialStatus {
  trialId: string;
  scenarioId: string;
  modelId: string;
  engine: string;
  startedAt: string;
  status: 'running';
}

/**
 * A surfaced consecutive-failure cluster (Theme E / E2 auto-triage).
 * Written onto `BatchSummary` and threaded into `MatrixSummary` so both
 * `summary.json` and the console carry a greppable record of "this cell
 * died the same way k times in a row." Built by `detectTriageCluster`
 * (trial-signature.ts).
 */
export interface TriageCluster {
  /** The `trialSignature` value that repeated — human-greppable. */
  signature: string;
  /** Run length of the identical-signature streak. */
  count: number;
  /** The threshold that fired. */
  k: number;
  /** True when the cell early-stopped (parallel===1); false when reported-only (parallel>1). */
  stopped: boolean;
  /** requestedCount − trialsRun when stopped; 0 otherwise. */
  skipped: number;
  /** Verbatim `reason` of the run's first (representative) trial. */
  representativeReason: string;
  failureClass?: FailureClass;
  failureClassRule?: string;
  /** `failureClassEvidence` of the representative trial. */
  representativeEvidence?: string;
  representativeSniff?: TrialFinalSniff;
  /** The clustered trial ids, in push order. */
  trialIds: string[];
}

export interface BatchOptions extends TrialOptions {
  count: number;
  parallel?: number;
  /**
   * Skip the per-model preflight admission gate. The gate runs one cheap
   * probe trial before the batch and refuses to burn N trials on a model
   * whose capacity/tuning/tool-call/throughput plumbing is broken — see
   * `preflight.ts`. Skipping is for deliberate debugging of a known-bad
   * configuration.
   */
  skipPreflight?: boolean;
  /**
   * Auto-triage threshold (Theme E / E2): stop launching more trials of a
   * cell once this many *consecutive* trials fail with an identical
   * `trialSignature`, and surface the cluster. `0` disables. Precedence:
   * this field › `GEZEL_EVAL_TRIAGE_K` env › default 3. Only enforced at
   * `parallel === 1` (where "consecutive" is well-defined); at higher
   * parallelism the cluster is reported but no early stop happens.
   */
  triageK?: number;
}

/**
 * Provenance of the per-model preflight admission gate for a sweep
 * (Theme E / E4). Recorded on every batch/matrix summary so a postmortem
 * can see whether the sweep was admission-checked and, if not, WHY —
 * closing the "this sweep never preflighted" silent gap.
 */
export interface BatchPreflight {
  ran: boolean;
  /** Why preflight didn't run (only set when `ran` is false). */
  skippedReason?: 'flag' | 'non-local-engine';
  /** Preflight verdict when it ran. */
  admitted?: boolean;
  /** Measured throughput from the probe (tok/s), when it ran. */
  genTokensPerSec?: number | null;
}

export interface BatchSummary {
  scenarioId: string;
  modelId: string;
  startedAt: string;
  finishedAt: string;
  /**
   * Terminal orchestration state for this cell. A deliberately auto-triaged
   * cell is complete (the triage record explains its skipped trials), while
   * an abort or unexpected short run is never allowed to masquerade as an
   * all-pass batch.
   */
  status: 'complete' | 'incomplete' | 'interrupted';
  /** Trials requested before an abort/rejection/triage shortened the cell. */
  requestedTrials: number;
  trials: number;
  successes: number;
  successRate: number;
  trialIds: string[];
  /** Preflight admission provenance for this cell's model (Theme E / E4). */
  preflight?: BatchPreflight;
  perTrial: Array<
    Pick<TrialResult, 'trialId' | 'success' | 'durationMs' | 'reason' | 'failureMode'>
  >;
  /** Set when auto-triage detected a consecutive-failure cluster (Theme E / E2). */
  triage?: TriageCluster;
}

/**
 * Aggregate of multiple `BatchSummary`s — one per scenario in a matrix
 * run (e.g. `pnpm eval:all` or `pnpm eval:batch tictactoe petshop ...`).
 * Lives at `<matrixDir>/summary.json`; each per-scenario batch keeps
 * its own `summary.json` at `<matrixDir>/<scenarioId>/summary.json` so
 * the existing single-scenario tooling keeps working unchanged.
 */
export interface MatrixSummary {
  modelId: string;
  startedAt: string;
  finishedAt: string;
  /**
   * Terminal orchestration state. `interrupted` means the caller's abort
   * signal fired; `incomplete` means the runner returned without producing
   * all planned coverage (for example, an unexpected rejected trial
   * promise). Neither state is a passing matrix, even when every trial that
   * did finish happened to pass.
   */
  status: 'complete' | 'incomplete' | 'interrupted';
  /**
   * Exact scenario/trial plan selected by the caller. This remains complete
   * when an interrupted matrix's `scenarios` array contains only the prefix
   * that actually ran, preserving suite/filter provenance in summary.json.
   */
  requestedScenarios: Array<{
    scenarioId: string;
    trials: number;
  }>;
  /**
   * Nominal trials requested per scenario before `suggestedTrials` caps.
   * `requestedScenarios` is the authoritative per-scenario execution plan.
   */
  count: number;
  scenarios: Array<{
    scenarioId: string;
    trials: number;
    successes: number;
    successRate: number;
    /** `<scenarioId>/summary.json` — relative to the matrix root. */
    summaryPath: string;
    /** Auto-triage cluster for this cell, if one fired (Theme E / E2). */
    triage?: TriageCluster;
  }>;
  totalTrials: number;
  totalSuccesses: number;
  overallSuccessRate: number;
  /** Preflight admission provenance for the matrix's model (Theme E / E4). */
  preflight?: BatchPreflight;
}
