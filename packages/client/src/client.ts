import type {
  AudioEngineStatusResponse,
  AudioModelPullEvent,
  AudioSynthesizeRequest,
  AudioSynthesizeResponse,
  AudioTranscribeRequest,
  AudioTranscribeResponse,
  ImageEngineStatusResponse,
  ImageGenerationRequest,
  ImageGenerationResponse,
  ImageModelPullEvent,
  ListActiveImagePullsResponse,
  ListActiveVideoPullsResponse,
  ListAudioCatalogResponse,
  ListAudioVoicesResponse,
  ListInstalledAudioModelsResponse,
  ListInstalledImageModelsResponse,
  ListInstalledVideoModelsResponse,
  VideoEngineStatusResponse,
  VideoGenerationRequest,
  VideoGenerationResponse,
  VideoModelPullEvent,
} from '@bendyline/gezel';
import type {
  AnswerQuestionRequest,
  AppendTaskNoteRequest,
  AppendTaskNoteResponse,
  AppliedProjectType,
  ApplyPatchToProjectWorkspaceFileRequest,
  ApplyProjectTypeRequest,
  ArchiveExtractRequest,
  ArchiveExtractResponse,
  ArchiveListRequest,
  ArchiveListResponse,
  AskQuestionRequest,
  AskQuestionResponse,
  CancelCodeReviewResponse,
  CatalogItemDetail,
  CatalogItemSummary,
  CatalogItemVersionInfo,
  CatalogKind,
  ChannelStatus,
  ChannelsConfig,
  ChatHistoryResponse,
  ChatSession,
  ChatSessionSummary,
  CodeReviewResponse,
  CompleteStepRequest,
  CompleteStepResponse,
  CopilotAvailability,
  CopyArtifactToWorkspaceRequest,
  CopyArtifactToWorkspaceResponse,
  Craftbook,
  CraftbookResponse,
  CraftbookToolsetNeed,
  CreateChatSessionRequest,
  CreateCraftbookRequest,
  CreateGezelRequest,
  CreatePreviewCapabilityRequest,
  CreatePreviewCapabilityResponse,
  CreateProjectRequest,
  CreateScriptRequest,
  CreateScriptResponse,
  CreateTaskRequest,
  CreateTypedProjectRequest,
  CreateTypedProjectResponse,
  DelegateSecurityFindingRequest,
  DelegateSecurityFindingResponse,
  DescribeFolderRequest,
  DescribeFolderResponse,
  DeviceSafetyPolicyConfig,
  DiffFilesRequest,
  DiffFilesResponse,
  DismissReportActionRequest,
  DocumentMediaExportRequest,
  DraftScriptRequest,
  DraftScriptResponse,
  DriveIndexEnrichmentRequest,
  DriveIndexEnrichmentResponse,
  EnableSuggestedWorkRequest,
  EnsureGezelRequest,
  EnsureGezelResponse,
  FetchDiffRequest,
  FetchDiffResponse,
  FetchRepoRequest,
  FetchRepoResponse,
  FetchUrlRequest,
  FetchUrlResponse,
  FileContextRequest,
  FileContextResponse,
  FileMapRequest,
  FileMapResponse,
  FileReviewRequest,
  FileReviewResponse,
  FindEntityRequest,
  FindEntityResponse,
  FindFilesRequest,
  FindFilesResponse,
  FindReferencesRequest,
  FindReferencesResponse,
  FindSimilarImagesRequest,
  FindSimilarImagesResponse,
  FindSymbolRequest,
  FindSymbolResponse,
  FireReportActionRequest,
  FireReportActionResponse,
  GenerateGezelAboutRequest,
  GenerateGezelIconRequest,
  GetScriptSourceResponse,
  GezelGender,
  GezelGrowthResponse,
  GezelIconHistoryResponse,
  GezelResponse,
  GezmodelEngine,
  GezmodelImportReview,
  GitAbandonMergeResponse,
  GitAiMergeResponse,
  GitBranchesResponse,
  GitChangesResponse,
  GitCloneResponse,
  GitCommitDetailResponse,
  GitCommitResponse,
  GitCompleteMergeResponse,
  GitConflictVersionsResponse,
  GitDiscardResponse,
  GitFetchResponse,
  GitFileDiffResponse,
  GitHubCheckStatusResponse,
  GitHubCreateCommentResponse,
  GitHubCreatePullRequest,
  GitHubCreatePullResponse,
  GitHubIdentityResponse,
  GitHubLoginPollResponse,
  GitHubLoginStartResponse,
  GitHubPullDetail,
  GitHubPullDiffResponse,
  GitHubRepoPreviewResponse,
  GitHubReposResponse,
  GitLogResponse,
  GitMergeStateResponse,
  GitPushResponse,
  GitResolveConflictResponse,
  GitStatusResponse,
  GitSuggestMessageResponse,
  GitSyncResponse,
  GrepArtifactRequest,
  GrepArtifactResponse,
  GzelBundleManifest,
  HandboekArticle,
  HandboekHowDoIResponse,
  HandboekNarrationResponse,
  HandboekRenderMode,
  HandboekToc,
  HealthResponse,
  ImportCustomMcpConfigRequest,
  ImportCustomMcpConfigResponse,
  InsertAtMarkerInProjectWorkspaceFileRequest,
  InstallPackageRequest,
  InstallPackageResponse,
  InstalledToolset,
  InvokePageToolRequest,
  InvokePageToolResponse,
  InvokeSessionToolResponse,
  ListChatSessionsResponse,
  ListCodeReviewsResponse,
  ListCraftbooksResponse,
  ListDependenciesResponse,
  ListEntityMentionsRequest,
  ListEntityMentionsResponse,
  ListFileIssuesRequest,
  ListFileIssuesResponse,
  ListGezelsResponse,
  ListGitHubPullCommentsResponse,
  ListGitHubPullFilesResponse,
  ListGitHubPullsResponse,
  ListGitHubWorkflowRunsResponse,
  ListHistoryResponse,
  ListMentionCandidatesResponse,
  ListModelsResponse,
  ListProjectsForGezelResponse,
  ListProjectsResponse,
  ListQuestionsResponse,
  ListScriptsResponse,
  ListSessionQueueResponse,
  ListSessionToolsResponse,
  ListTaskNotesResponse,
  ListTasksResponse,
  ListTerminalThreadsResponse,
  ListTimelineResponse,
  MachineMemoryUsage,
  MapAttackSurfaceResponse,
  MapRepoRequest,
  MapRepoResponse,
  MeesterStatusResponse,
  MessageGezelRequest,
  MessageGezelResponse,
  MlxRuntimeStatus,
  ModelDownloadPreflightRequest,
  ModelDownloadPreflightResponse,
  NativeEngineName,
  NativeEngineResolveEvent,
  NativeEngineStatusResponse,
  NewCraftbookStep,
  NightShiftReviewResponse,
  NightShiftTasksResponse,
  OutlineFileRequest,
  OutlineFileResponse,
  PageCheckRequest,
  PageCheckResponse,
  PendingImports,
  Poppetje,
  PreviewLogEntry,
  ProjectAboutPreviewRequest,
  ProjectAboutPreviewResponse,
  ProjectApprovalsResponse,
  ProjectFolderPreviewResponse,
  ProjectResponse,
  ProviderName,
  Question,
  ReadArtifactSliceOpts,
  ReadArtifactSliceResponse,
  ReadDocAsMarkdownRequest,
  ReadDocAsMarkdownResponse,
  ReadImageBase64Request,
  ReadImageBase64Response,
  ReadSymbolRequest,
  ReadSymbolResponse,
  ReferenceFileLocationRequest,
  ReferenceFileLocationResponse,
  ReferencePreviewRequest,
  ReferencePreviewResponse,
  RenameGezelRequest,
  RenderImageRequest,
  RenderImageResponse,
  ReplaceInProjectWorkspaceFileRequest,
  ReplaceLinesInProjectWorkspaceFileRequest,
  ReportActionRecord,
  ReportActionsResponse,
  ReportPreviewLogRequest,
  RequestAskRequest,
  RequestAskResponse,
  RerollGezelPoppetjeRequest,
  ResolveArtifactResponse,
  ResolveSecurityFindingRequest,
  ResolveSecurityFindingResponse,
  RevertGezelIconRequest,
  RewriteTextRequest,
  RewriteTextResponse,
  RunGitRequest,
  RunGitResponse,
  RunScriptRequest,
  RunScriptResponse,
  RunTerminalCommandRequest,
  RunTerminalCommandResponse,
  SaveScriptSourceRequest,
  SaveScriptSourceResponse,
  ScanFindingsRequest,
  ScanFindingsResponse,
  ScriptRun,
  SdkTypesResponse,
  SearchCodeRequest,
  SearchCodeResponse,
  SearchDocsRequest,
  SearchDocsResponse,
  SearchDocumentsRequest,
  SearchDocumentsResponse,
  SearchFilesRequest,
  SearchFilesResponse,
  SearchImagesRequest,
  SearchImagesResponse,
  SearchSessionsRequest,
  SearchSessionsResponse,
  SecurityOverviewResponse,
  SecurityPolicy,
  SecurityScanRequest,
  SecurityScanResponse,
  SendChatRequest,
  SendChatResponse,
  SessionDebugSnapshot,
  SessionTelemetry,
  SessionTelemetryListResponse,
  SharedModelMigrationCandidatesResponse,
  SharedModelMigrationRequest,
  SharedModelMigrationResult,
  SpawnTaskInstancesRequest,
  StartCodeReviewRequest,
  StartCodeReviewResponse,
  StepPosition,
  SuggestCraftbooksResponse,
  SuggestedWorkItem,
  SuggestedWorkResponse,
  SystemBootstrapStatus,
  SystemDiagnostics,
  SystemHomeInfo,
  SystemToolsetInstallEvent,
  SystemToolsetInstallSnapshot,
  Task,
  TaskAssignee,
  TaskStatus,
  TerminalThread,
  ToolsetsScope,
  TraceTaintRequest,
  TraceTaintResponse,
  TransformStreamEvent,
  TransformTextRequest,
  UnifiedSearchResponse,
  UpdateConfigRequest,
  UpdateCraftbookRequest,
  UpdateGezelAboutRequest,
  UpdateGezelFixedFunctionDefaultsRequest,
  UpdateGezelIconRequest,
  UpdateGezelMarkdownRequest,
  UpdateGezelPoppetjeRequest,
  UpdateGezelSettingsRequest,
  UpdateProjectRequest,
  UpdateQueuedMessageResponse,
  UpdateTaskCraftbookRequest,
  UpdateTaskNoteRequest,
  UpdateTaskNoteResponse,
  UpdateTaskRequest,
  UpdateTaskStepRequest,
  UpdateTaskStepResponse,
  WebSearchRequest,
  WebSearchResponse,
  WikipediaSearchRequest,
  WorkspaceCommandIndex,
  WorkspaceEditResponse,
  WorkspaceIndexStatus,
  WorkspaceSkillIndex,
} from '@bendyline/gezel';
import { parseTaskRef } from '@bendyline/gezel';
import type { DeviceHealthStatusSnapshot } from '@bendyline/gezel/native';
import {
  AudioModelPullEventSchema,
  ImageModelPullEventSchema,
  type ImageRecognition,
  type ImageStaticMeta,
  type ListInstalledRecognitionModelsResponse,
  type ListRecognitionCatalogResponse,
  NativeEngineResolveEventSchema,
  type RecognitionHealth,
  type RecognitionMode,
  type RecognitionPullEvent,
  RecognitionPullEventSchema,
  type RecognitionRequest,
  SystemToolsetInstallEventSchema,
  VideoModelPullEventSchema,
} from '@bendyline/gezel/schemas';
import { z } from 'zod';
import {
  type ConsumeSseJsonOptions,
  SseResponseError,
  SseStreamStaleError,
  consumeSseJson,
} from './sse.js';

const MODEL_DOWNLOAD_STALL_TIMEOUT_MS = 40 * 60_000;
const MODEL_DOWNLOAD_STALLED_MESSAGE = 'Download stopped: server has gone quiet.';
const MODEL_DOWNLOAD_SSE_POLICY = {
  keepaliveTimeoutMs: MODEL_DOWNLOAD_STALL_TIMEOUT_MS,
  staleMessage: MODEL_DOWNLOAD_STALLED_MESSAGE,
} as const;

/** Success payload of the craftbook document write routes. */
export interface CraftbookDocumentWriteResponse {
  craftbook: Craftbook;
  format: 'json' | 'markdown';
  stepCount: number;
  gatedSteps: number;
}

export interface GezelClientOptions {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
}

export type MemoryKind = 'fact' | 'decision' | 'pref' | 'status';

export interface QuotaBucket {
  name: string;
  isUnlimited: boolean;
  limit: number;
  used: number;
  remaining: number;
  remainingPercent: number;
  overage: number;
  resetDate?: string;
}

export interface ProviderUsage {
  quotaBuckets: QuotaBucket[];
  todayTurns: number;
  todayTokensIn: number;
  todayTokensOut: number;
  todayCost: number;
  totalTurns: number;
  totalTokensIn: number;
  totalTokensOut: number;
  totalCost: number;
  /**
   * Median engine-reported decode rate (tokens/sec) across turns that
   * reported one; `null` when none did. Populated by local engines
   * (llama.cpp, MLX); cloud providers don't report throughput, so `null`
   * there is expected and should render as "n/a", never as zero.
   *
   * Optional so an older daemon that predates the field still typechecks.
   */
  medianOutputTokensPerSec?: number | null;
  lastUpdated: string | null;
}

export interface UsageResponse {
  providers: {
    copilot?: ProviderUsage;
    openai?: ProviderUsage;
    ollama?: ProviderUsage;
  };
  lastUpdated: string | null;
}

/**
 * Per-provider queue state — lets the UI render a "3 waiting on
 * Copilot" indicator and (on click) a breakdown of what's running
 * and pending.
 */
export interface ProviderQueueState {
  running: number;
  queuedInteractive: number;
  queuedBackground: number;
  /** Ambient jobs currently held until the provider has been quiet long enough. */
  ambientHeld?: number;
  concurrency: number;
  /**
   * Cap on how many of the `concurrency` slots can be held by the
   * interactive lane at once. Equal to `concurrency` when no cap is
   * configured (cloud providers); lower for local providers that
   * reserve a slot for background work (llama-cpp ships at 2/1).
   */
  interactiveConcurrency?: number;
  /**
   * Cap on how many slots the background lane can hold — the dual of
   * `interactiveConcurrency`. `concurrency - backgroundConcurrency` is the
   * headroom reserved for interactive turns under the adaptive batched-
   * inference policy.
   */
  backgroundConcurrency?: number;
  /**
   * The engine's true concurrent-generation width (its batch capability):
   * 1 for a serial engine (MLX today), the `--parallel` slot count for
   * llama-cpp with batched inference on. Surfaced by the EngineStatusPill
   * as "N concurrent sessions". Distinct from `concurrency`, which can be
   * raised for ask-overlap without parallel generation.
   */
  maxConcurrency?: number;
  active: Array<{
    sessionId?: string;
    gezelId?: string;
    /** Project that owns this queued work, when it is session-scoped. */
    projectId?: string;
    /** Display owner for service work that is not attached to a persisted gezel. */
    actorLabel?: string;
    /**
     * Short, human-readable label describing what this turn is doing
     * — e.g. "atari/3 · plan", "summary", "icon · Maya". Set by the
     * call site; surfaced verbatim in the QueueMeter.
     */
    job?: string;
    runningForMs: number;
  }>;
  pending: Array<{
    /**
     * Queue-internal id used to target this entry from the cancel and
     * reorder routes. Stable for the lifetime of the entry; once the
     * entry runs or is cancelled, the id is gone.
     */
    id: number;
    lane: 'interactive' | 'background';
    sessionId?: string;
    gezelId?: string;
    /** Project that owns this queued work, when it is session-scoped. */
    projectId?: string;
    /** Display owner for service work that is not attached to a persisted gezel. */
    actorLabel?: string;
    /** See active[].job. */
    job?: string;
    /** Housekeeping work that yields until the provider is otherwise idle. */
    ambient?: boolean;
    waitedMs: number;
  }>;
}

/**
 * TaskRunner pending-handoff summary — a separate layer from the
 * provider queue (phase handoffs that haven't been dispatched yet).
 */
/** One side of the pending-handoff split. */
export interface TaskHandoffBucket {
  count: number;
  byGezel: Record<string, number>;
}

export interface TaskRunnerState {
  /** Every queued handoff, whatever is holding it. */
  pendingCount: number;
  pendingByGezel: Record<string, number>;
  pendingByProject: Record<string, number>;
  /**
   * Handoffs waiting on a free provider slot — a real backlog, and the
   * only bucket the header's Tasks chip counts. Optional so a UI newer
   * than its daemon degrades to the `pending*` totals.
   */
  dispatchable?: TaskHandoffBucket;
  /**
   * Handoffs parked until the next Night Shift window. Not a backlog:
   * nobody is waiting on them and there is nothing to act on, so they
   * stay out of the header badge and live in the Night Shift menu.
   */
  scheduled?: TaskHandoffBucket;
  /** Why `dispatchable` work isn't moving. Absent when it is. */
  holdReason?: 'engagement-off' | 'engagement-paused' | 'provider-busy';
  /** Night Shift state, for dating the `scheduled` bucket. */
  nightShift?: {
    active: boolean;
    /** ISO time the next window opens; null when Night Shift is off. */
    opensAt: string | null;
  };
}

/**
 * Per-session pending messages from the SessionQueue layer. Distinct
 * from `ProviderQueueState.pending` — those are at the provider level
 * (rate-limiting across sessions); these are per-session (serializing
 * messages within a single conversation).
 */
export interface SessionQueueState {
  sessionId: string;
  /** Session-pinned provider, used to attribute this backlog to an engine. */
  providerName?: ProviderName;
  depth: number;
  nextPreview: string;
  entries: Array<{
    queueId: string;
    preview: string;
    enqueuedAt: string;
    /** Queued as a mid-turn nudge — merges with adjacent nudges on drain. */
    nudge?: boolean;
  }>;
}

export interface QueueStatusResponse {
  providers: {
    copilot?: ProviderQueueState;
    openai?: ProviderQueueState;
    anthropic?: ProviderQueueState;
    'anthropic-cli'?: ProviderQueueState;
    'codex-cli'?: ProviderQueueState;
    ollama?: ProviderQueueState;
    'llama-cpp'?: ProviderQueueState;
    mlx?: ProviderQueueState;
    ds4?: ProviderQueueState;
  };
  taskRunner: TaskRunnerState;
  /** Per-session queued messages keyed implicitly by `sessionId` inside each entry. */
  sessions: SessionQueueState[];
  /**
   * Per-provider prompt-cache stats. Empty array when no local provider
   * has been initialized or no controller is wired. Surfaced by the
   * EngineStatusPill popover as "warm sessions: N, cache memory: X MB".
   */
  cache: ProviderCacheStatsResponse[];
  /** Latest normalized accelerator health used by the local-engine pill. */
  deviceHealth?: DeviceHealthStatusSnapshot;
  /**
   * Claude CLI worker pool snapshot when the `anthropic-cli` provider
   * has been initialized. Drives the header `ClaudeCliPoolPill`:
   * always-visible "N/M warm" indicator with a per-worker dropdown
   * showing the (gezel, project) pinned to each warm `claude`
   * subprocess and a live "active" light per busy worker.
   */
  anthropicCliPool?: ClaudeCliPoolView;
  /** Server clock at the time this snapshot was taken (ISO 8601). */
  at: string;
}

export interface ClaudeCliPoolView {
  size: number;
  poolSize: number;
  workers: Array<{
    sessionId: string;
    gezelId: string;
    gezelName: string;
    projectId: string;
    projectName: string;
    idle: boolean;
    alive: boolean;
    lastUsedAt: number;
    claudeSessionId: string | null;
  }>;
}

export interface EngineStatusEntry {
  key: string;
  provider: 'llama-cpp' | 'mlx';
  modelId: string;
  replicaIdx: number;
  residentBytes: number;
  lastUsedAt: number;
  createdAt: number;
}

export interface EngineStatusResponse {
  /** True when the broker is enforcing a budget; false for cloud-only installs. */
  enforced: boolean;
  budgetBytes: number;
  committedBytes: number;
  entries: EngineStatusEntry[];
  /** Physical RAM — the memory slider's ceiling. Absent pre-boot. */
  systemRamBytes?: number;
  /** Host-derived budget; the slider's "Auto" mark. Absent pre-boot. */
  autoBudgetBytes?: number;
  /** True when `localEngineMemoryGb` overrides the auto value. */
  overridden?: boolean;
  /**
   * Which memory pools the budget draws on. A discrete-GPU host's budget is
   * graphics memory PLUS a system-RAM share, so describing it as a slice of
   * RAM (the only shape this response used to carry) names the wrong pool.
   * Absent pre-boot and on daemons that predate the field.
   */
  pools?: {
    kind: 'unified' | 'discrete-gpu' | 'system-ram';
    /** Usable VRAM on a discrete card; 0 on unified / CPU-only hosts. */
    vramBytes: number;
    /** The system-RAM share of the budget. */
    ramShareBytes: number;
    /** Fast (on-accelerator) memory — VRAM on a card, the budget otherwise. */
    fastBytes: number;
  };
  /**
   * Whether models sharing a discrete card may spill into system RAM. Governs
   * co-residency only — one model alone always gets the full budget. Absent
   * pre-boot and on daemons that predate the field.
   */
  ramSpillover?: {
    allowed: boolean;
    /** What the host picks on its own; the toggle's "Automatic" position. */
    auto: boolean;
    overridden: boolean;
    /** Ceiling the resident set fits under while more than one model is loaded. */
    coResidencyBytes: number;
  };
}

export interface ReconcileEnginePoolRequest {
  provider: 'llama-cpp' | 'mlx';
  /** Clone count per modelId. Missing modelIds are left alone. */
  clones: Record<string, number>;
}

export interface ProviderCacheStatsResponse {
  providerName: string;
  totalBytes: number;
  budgetBytes: number;
  /** RAM-aware suggested budget for this machine (override-independent). */
  defaultBudgetBytes?: number;
  /** Physical system RAM — upper bound for the Settings budget slider. */
  systemRamBytes?: number;
  warmSessionCount: number;
  hits: number;
  misses: number;
  recentHitRate: number;
  sessions: Array<{
    sessionId: string;
    gezelId?: string;
    tokenCount: number;
    bytes: number;
    lastUsedAt: number;
    evictionPriority: 'low' | 'normal';
  }>;
}

export type FolderScope = 'documents' | 'gezels' | 'projects';

export interface FoldersStatusResponse {
  /** Default (un-externalized) location of each scope. */
  defaults: Record<FolderScope, string>;
  /** Currently-resolved location (external if configured, else default). */
  current: Record<FolderScope, string>;
  /** Configured external path per scope, or null when on default. */
  externalized: Record<FolderScope, string | null>;
  /** True when a folder-move job is queued or running — the UI should
   *  disable the move buttons rather than queueing parallel ops. */
  activeJob: boolean;
  /** Backup folder summary for the UI footer. */
  backups: { count: number; totalBytes: number; path: string };
}

export interface FolderMovePlanValidation {
  ok: boolean;
  reason?: string;
}

export interface FolderMovePlan {
  scope: FolderScope;
  sourcePath: string;
  destPath: string;
  files: number;
  bytes: number;
  conflicts: number;
  sourceExists: boolean;
  destExists: boolean;
  destNonEmpty: boolean;
  validation: FolderMovePlanValidation;
}

export interface FolderMoveStatus {
  id: string;
  scope: FolderScope;
  sourcePath: string;
  destPath: string;
  status: 'queued' | 'running' | 'done' | 'error' | 'cancelled';
  phase?: 'scan' | 'backup' | 'copy' | 'verify' | 'swap' | 'cleanup' | 'prune';
  filesDone: number;
  totalFiles: number;
  bytesDone: number;
  totalBytes: number;
  error?: string;
  restartRequired: boolean;
  startedAt: string;
  endedAt?: string;
}

export interface ConfigResponse {
  provider: ProviderName;
  githubToken?: string;
  hasGithubToken: boolean;
  openaiApiKey?: string;
  hasOpenaiApiKey: boolean;
  openaiOrganization?: string;
  hasOpenaiOrganization?: boolean;
  /** Anthropic API key (masked when set). Drives the `anthropic` provider. */
  anthropicApiKey?: string;
  hasAnthropicApiKey?: boolean;
  /** Google AI Studio API key (masked when set). Drives the `google-ai`
   *  image provider (Nano Banana 2). */
  googleAiApiKey?: string;
  hasGoogleAiApiKey?: boolean;
  ollamaBaseUrl?: string;
  autoStartOllama?: boolean;
  ollamaNumCtx?: number;
  /** Max tokens generated per turn (Ollama's `options.num_predict`). */
  ollamaNumPredict?: number;
  /** Force-enable / force-disable Ollama's reasoning mode. Undefined =
   *  auto (reasoning families → off, others → Ollama default). */
  ollamaThink?: boolean;
  /** Mid-stream silence cap before the watchdog aborts (seconds). */
  ollamaStreamingIdleSec?: number;
  /** Cold-start + prompt-prefill silence cap before first token (seconds). */
  ollamaPreFirstByteIdleSec?: number;
  /** Hard total per-turn cap, regardless of activity (minutes). */
  ollamaTurnTimeoutMin?: number;
  /** Copilot-only hard per-turn cap, in minutes. Default 3. */
  copilotTurnTimeoutMin?: number;
  /**
   * llama-cpp: absolute path to a single GGUF file the supervised
   * llama-server should load. Phase 1 MVP; replaced by a model
   * manager in Phase 2.
   */
  llamaCppModelPath?: string;
  /**
   * llama-cpp: base URL of an already-running llama-server. When
   * set, the service talks to the user-managed server instead of
   * supervising its own.
   */
  llamaCppBaseUrl?: string;
  /**
   * llama-cpp: context window (tokens) llama-server is booted with.
   * When unset, the service picks a model-aware default (32 k or the
   * model's advertised max, whichever is smaller).
   */
  llamaCppNumCtx?: number;
  /** ds4 (DeepSeek-V4): base URL of an already-running ds4-server (external mode). */
  ds4BaseUrl?: string;
  /** ds4: explicit DeepSeek-V4 GGUF path passed to `ds4-server --model`. */
  ds4ModelPath?: string;
  /** ds4: context window (tokens) ds4-server is booted with (`--ctx`). */
  ds4NumCtx?: number;
  /** ds4: request SSD expert streaming (safe default; unsafe `false` is ignored). */
  ds4SsdStreaming?: boolean;
  /** ds4: requested expert-cache GiB; the service clamps it to safe headroom. */
  ds4CacheExpertsGb?: number;
  /**
   * llama-cpp: force a specific backend variant instead of letting the
   * Electron supervisor auto-detect. `'auto'` or undefined keeps the
   * auto-detect (CUDA → Vulkan → CPU on PC, Metal on Mac). Read by
   * the supervisor at app boot — changes take effect on next launch.
   */
  llamaCppBackendOverride?: 'auto' | 'cuda' | 'vulkan' | 'metal' | 'cpu';
  /**
   * llama-cpp: KV-cache quantization (`--cache-type-k`/`--cache-type-v`).
   * Undefined → `q8_0` default. Lower precision frees RAM for longer
   * contexts at a minor accuracy cost. Read at engine launch.
   */
  llamaCppKvCacheType?: 'f16' | 'q8_0' | 'q4_0';
  /**
   * llama-cpp: Flash Attention mode (`--flash-attn on|off|auto`).
   * Tri-state string, or a legacy boolean (`true` = on). Undefined →
   * server default (`auto`); the launcher forces `on` under a quantized
   * KV cache. Read at engine launch.
   */
  llamaCppFlashAttn?: boolean | 'on' | 'off' | 'auto';
  /**
   * llama-cpp: keep ALL Mixture-of-Experts weights in system RAM
   * (`--cpu-moe`) while attention/dense layers run on the GPU — the
   * lever for running a big MoE on a constrained-VRAM discrete GPU.
   * Undefined → off (Phase v2's planner may enable it automatically).
   */
  llamaCppCpuMoe?: boolean;
  /**
   * llama-cpp: keep the MoE weights of only the first N layers in system
   * RAM (`--n-cpu-moe N`) — the partial-split form of `llamaCppCpuMoe`.
   */
  llamaCppNCpuMoe?: number;
  /**
   * llama-cpp: allocate a full-size sliding-window KV cache (`--swa-full`)
   * instead of the memory-efficient windowed one, for SWA models (Gemma).
   * ~30% more memory at long context, and the precondition for the engine
   * accepting `--cache-reuse` at all on those models — with a windowed
   * cache it refuses ("cache_reuse is not supported by this context").
   * No effect on Qwen 3.5/3.6, which cannot KV-shift regardless.
   * Undefined → off (windowed cache).
   */
  llamaCppSwaFull?: boolean;
  /**
   * llama-cpp: speculative-decoding mode (`--spec-type`). Lossless
   * decode speedup. `ngram-*` need no draft model; `draft-mtp` uses the
   * model's own MTP head (only when the GGUF ships it). Undefined → off.
   */
  llamaCppSpecType?:
    | 'none'
    | 'draft-mtp'
    | 'draft-eagle3'
    | 'draft-dflash'
    | 'draft-simple'
    | 'ngram-mod'
    | 'ngram-simple'
    | 'ngram-map-k'
    | 'ngram-map-k4v'
    | 'ngram-cache';
  /**
   * First-run bootstrap bookkeeping — set once the on-device default-
   * provider bootstrap has evaluated (success or failure). Prevents
   * re-running on every boot. Cloud-provider users get this flipped
   * true immediately; local-install-in-progress users see it true
   * even while the download is still running.
   */
  firstRunCompleted?: boolean;
  /**
   * Human-readable error from the last first-run model install, if
   * any. Home view surfaces a Retry affordance when set.
   */
  firstRunInstallError?: string;
  defaultModel?: {
    copilot?: string;
    openai?: string;
    anthropic?: string;
    'anthropic-cli'?: string;
    'codex-cli'?: string;
    ollama?: string;
    'llama-cpp'?: string;
    mlx?: string;
    ds4?: string;
    /** Namespaced `remote:<remoteId>/<model>` default; rarely set. */
    remote?: string;
  };
  defaultReasoningEffort?: {
    copilot?: string;
    openai?: string;
    anthropic?: string;
    'anthropic-cli'?: string;
    'codex-cli'?: string;
    ollama?: string;
    'llama-cpp'?: string;
    mlx?: string;
    ds4?: string;
    remote?: string;
  };
  /**
   * Install-wide per-model tuning overrides, keyed by catalog model id.
   * Sits between per-gezel `tuning` overrides and the catalog manifest's
   * recommended defaults in the resolution stack.
   */
  modelTuning?: Record<string, import('@bendyline/gezel').ChatModelTuning>;
  /**
   * Install-wide per-model preset (tuning profile) selection, keyed by
   * catalog model id. The resolver applies it as a profile layer when
   * the gezel hasn't picked its own `tuningProfile`. Sparse: only set
   * for models the user has explicitly configured.
   */
  modelTuningProfile?: Record<string, string>;
  /**
   * Shared accelerator-health admission policy. The UI exposes Observe and
   * Manage while retaining `off` as an operator/configuration escape hatch.
   */
  deviceSafety?: DeviceSafetyPolicyConfig;
  /** MLX: base URL of an already-running mlx_lm.server, for dev/LAN. */
  mlxBaseUrl?: string;
  /** MLX: absolute path to an MLX model directory override. */
  mlxModelPath?: string;
  /** MLX: optional managed context cap; defaults to the model's native window. */
  mlxNumCtx?: number;
  /** MLX: pip-style spec for mlx-lm; pinned versions avoid surprise breaks. */
  mlxPackageSpec?: string;
  /**
   * MLX: bits to quantize the KV cache to (`--kv-bits`). 0/undefined →
   * off (full precision). Lower precision speeds generation and lowers
   * memory, but can crash long sessions that hit a rotating KV cache.
   */
  mlxKvBits?: number;
  /**
   * Multi-engine pool: combined RAM budget (GB) across all resident
   * local engines. Unset → auto-derive from the host (unified-memory
   * machines get a larger share than discrete-GPU ones — see
   * `autoDetectBudgetBytes`). Authoritative when present; `null` clears
   * the override and returns to auto.
   */
  localEngineMemoryGb?: number | null;
  /**
   * Multi-engine pool: per-model clone count keyed by catalog `modelId`.
   * Missing keys default to 1 resident replica.
   */
  localEngineReplicas?: Record<string, number>;
  /**
   * Hard ceiling for the Settings clone-count picker. Defaults to 4 server-side.
   */
  localEngineReplicasMax?: number;
  /**
   * Per-engine prompt-cache memory budget in MB. Operator override; when
   * unset the controller picks a tiered RAM-aware default (1/2/4/8 GB
   * across <16/16-32/32-64/≥64 GB systems). Read by CacheControlsPanel.
   */
  cacheBudgetMb?: {
    mlx?: number;
    'llama-cpp'?: number;
  };
  /** Read-only snapshot of the resolved Python runtime after first venv provision. */
  pythonRuntime?: {
    source: 'system-uv' | 'system-python' | 'bundled-uv';
    installerPath?: string;
    uvVersion?: string;
    pythonVersion?: string;
    resolvedAt?: string;
  };
  meesterGezelId?: string;
  klerkGezelId?: string;
  boekwachterGezelId?: string;
  keurmeesterGezelId?: string;
  /** Keurmeester supervision — see `GezelConfigSchema.keurmeester` in core. */
  keurmeester?: {
    enabled?: boolean;
    providerName?: string;
    model?: string;
    allowTakeover?: boolean;
    maxConsultsPerSession?: number;
    maxConsultsPerTask?: number;
    cooldownMs?: number;
  };
  autoRecall?: {
    enabled?: boolean;
    topK?: number;
    minScore?: number;
  };
  summarization?: {
    enabled?: boolean;
    provider?: 'copilot' | 'openai' | 'ollama';
    model?: string;
    minUserTurns?: number;
    idleHours?: number;
  };
  debugMode?: boolean;
  /**
   * When true, advanced/power-user surfaces are revealed in the UI —
   * currently the "Scripts" area link in the sidebar. Materialized on GET
   * (defaults to `false` when unset) so the Settings UI can bind directly.
   * Default `false`.
   */
  showAdvancedFeatures?: boolean;
  /**
   * Debug-only opt-in: when true, the service restores every
   * template-derived gezel's about.md to its catalog default on each boot,
   * discarding local edits. Materialized on GET (defaults to `false` when
   * unset) so the Settings UI can bind directly.
   */
  resetTemplatesOnStartup?: boolean;
  /**
   * "Boring mode" — when true, the UI renders every gezel's
   * `roleBasedName` (e.g. `visual-designer`) instead of their friendly
   * name, drops "Meester" / role titles from headers, and the service
   * substitutes the same value into system prompts. Default `false`.
   */
  roleBasedNameOnlyMode?: boolean;
  /**
   * Whether poppetje avatars are shown across the UI (chat, sidebar,
   * project chips, home cards). When false, those surfaces fall back to a
   * legacy sigil or letter avatar. Default `true`.
   */
  showPoppetjes?: boolean;
  /**
   * When true, the chat UI calls `/api/audio/synthesize` for each
   * completed assistant message and plays the resulting WAV using the
   * speaking gezel's per-character voice. Opt-in; default `false`.
   */
  narrateAssistantReplies?: boolean;
  /**
   * Global AI engagement mode — panic-button control over proactive
   * behavior. Materialized on GET so the Settings UI can bind directly.
   * Default when unset: `proactive`.
   */
  aiEngagementMode?: 'proactive' | 'scheduled' | 'reactive' | 'off';
  /**
   * Whether the desktop app shows a persistent system-tray icon.
   * Materialized on GET (defaults to `true` when unset) so the Settings
   * UI can bind directly. Consumed by the Electron main process.
   */
  showSystemTray?: boolean;
  /**
   * Whether the packaged desktop app checks for updates on launch.
   * Materialized on GET (defaults to `true` when unset). Turning this off
   * does not disable the user-initiated tray action.
   */
  autoUpdateChecks?: boolean;
  /**
   * When the tray is enabled, whether the window's close button quits the
   * whole app (and removes the tray icon) instead of hiding to the tray.
   * Materialized on GET (defaults to `false` when unset). Windows/Linux
   * only; consumed by the Electron main process.
   */
  quitOnClose?: boolean;
  /**
   * Persisted UI theme preference (server-side mirror of the
   * renderer's `localStorage`). The embedded service binds an
   * ephemeral port every launch, so a localStorage-only pref strands
   * itself across reboots — this field is the cross-boot source of
   * truth. See `theme.ts`.
   */
  themePref?: 'system' | 'light' | 'dark';
  /**
   * Last-used markdown/document export settings. Mirrored server-side so the
   * quick-export action survives the embedded daemon's changing loopback port.
   */
  documentExportOptions?: import('@bendyline/gezel').DocumentExportOptions;
  /**
   * Which side the primary navigation sidebar sits on. Cross-boot source
   * of truth (same ephemeral-port reasoning as `themePref`). Absent =
   * `right` (the default); only an explicit `left` opts out. See
   * `sidebar-side.ts`.
   */
  sidebarSide?: 'left' | 'right';
  /**
   * Whether the Home greeting band is collapsed to its single status
   * row. Cross-boot source of truth (same ephemeral-port reasoning as
   * `themePref`). Absent/false = expanded.
   */
  homeGreetingCollapsed?: boolean;
  /**
   * Workshop tempo — how frenetic proactive behavior feels. Only
   * meaningful when `aiEngagementMode === 'proactive'`. Default
   * `bedrijvig` preserves pre-tempo behavior.
   */
  workshopTempo?: 'gezellig' | 'bedrijvig' | 'druk' | 'dolle-boel';
  /**
   * Night Shift configuration. See `GezelConfig.nightShift` in core
   * schemas. Window hours are local; the two power flags drive the
   * Electron shell via the power-intent poll.
   */
  nightShift?: {
    enabled?: boolean;
    window?: { startHour: number; endHour: number };
    keepAwakeWhileRunning?: boolean;
    wakeOnStart?: boolean;
    /** Optional provider/model defaults used only by Night Shift work. */
    modelOverride?: {
      enabled?: boolean;
      provider?: ProviderName;
      model?: string;
    };
  };
  /**
   * Tool-filtering policy. See `GezelConfig.toolFilterMode` in core
   * schemas. The GET response always materializes this (defaults to
   * `small-model`) so the Settings UI can bind to it without a
   * separate "is-unset" branch.
   */
  toolFilterMode?: 'always' | 'never' | 'small-model';
  channels?: ChannelsConfig;
  /** Copilot SDK built-ins are denied by default; explicit false opts out. */
  sandboxCopilot?: boolean;
  /** Allow/deny globs for the `fetch_url` MCP tool. */
  fetchUrl?: {
    allow?: string[];
    deny?: string[];
  };
  /** Configuration for the `web_search` MCP tool. */
  webSearch?: {
    provider?: 'brave' | 'wikipedia' | 'tavily' | 'mock';
    fallbackProvider?: 'brave' | 'wikipedia' | 'tavily';
    defaultLimit?: number;
    allow?: string[];
    deny?: string[];
  };
  braveSearchApiKey?: string;
  hasBraveSearchApiKey: boolean;
  tavilyApiKey?: string;
  hasTavilyApiKey: boolean;
  /**
   * Centralized security & compliance posture (the Security & Compliance
   * panel + first-run slider). Absent → the app treats the install as the
   * `free` posture. See `SecurityPolicy` / `resolveSecurityPolicy`.
   */
  securityPolicy?: SecurityPolicy;
  /** When true (the default), the Playwright MCP toolset runs headless. */
  playwrightHeadless?: boolean;
  /** Recently-opened projects, newest-first. Deprecated — superseded by
   *  `recentTabs` which carries projects alongside gezels, documents,
   *  and tasks. The UI still reads this once on boot for migration. */
  projectMru?: { id: string; at: number }[];
  /** Last N items the user has clicked across all four entity kinds.
   *  `at` is `lastAccessedAt` (LRU eviction); `order` is the stable
   *  left-to-right tab position. */
  recentTabs?: Array<
    | { kind: 'project'; id: string; at: number; order: number }
    | { kind: 'gezel'; id: string; at: number; order: number }
    | { kind: 'document'; path: string; at: number; order: number }
    | { kind: 'task'; ref: string; at: number; order: number }
  >;
  webhookBearerToken?: string;
  hasWebhookBearerToken: boolean;
  webhookBasicAuth?: string;
  hasWebhookBasicAuth: boolean;
  /**
   * Absolute path to the Copilot SDK install under
   * `~/.gezel/system-toolsets/`, present once system bootstrap
   * has finished. The Home tab uses this to show an exact
   * `cd <path> && npx copilot login` command that reuses the
   * pinned + integrity-verified copy instead of downloading fresh.
   */
  copilotCliInstallDir?: string;
  /**
   * Per-provider parallelism caps. Caps how many concurrent
   * `sendAndWait` calls run against a given backend at once. See
   * `GezelConfig.providerConcurrency` for defaults.
   */
  providerConcurrency?: {
    copilot?: number;
    openai?: number;
    anthropic?: number;
    'anthropic-cli'?: number;
    'codex-cli'?: number;
    ollama?: number;
    'llama-cpp'?: number;
    mlx?: number;
  };
  /** Settings for the `anthropic-cli` provider. See `GezelConfig.anthropicCli`. */
  anthropicCli?: {
    binaryPath?: string;
    manageRuntimeFiles?: boolean;
    defaultPermissionMode?: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';
    extraModels?: Array<{ id: string; name: string }>;
    poolSize?: number;
    workerIdleSec?: number;
  };
  /** Settings for the `codex-cli` provider. See `GezelConfig.codexCli`. */
  codexCli?: {
    binaryPath?: string;
    manageRuntimeFiles?: boolean;
    defaultPermissionMode?: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';
    defaultReasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
    extraModels?: Array<{ id: string; name: string }>;
    extraConfigOverrides?: Record<string, string>;
  };
  /**
   * Cached health probe for the `claude` binary. `installed` is the
   * boolean the dropdown / Settings panel should gate on; `path` and
   * `version` are populated when the probe succeeded; `error` is the
   * underlying failure message when it didn't (useful for "binary at
   * X is not executable: ENOENT" diagnostics in Settings).
   *
   * Cached server-side with a 60s TTL so repeated config GETs don't
   * spawn `claude --version` per-poll.
   */
  anthropicCliStatus?: {
    installed: boolean;
    path?: string;
    version?: string;
    error?: string;
  };
  /** Cached health probe for the `codex` binary. Mirrors `anthropicCliStatus`. */
  codexCliStatus?: {
    installed: boolean;
    path?: string;
    version?: string;
    error?: string;
  };
  /** Active image-generation provider; undefined → 'sd-cpp'. */
  imageProvider?: 'sd-cpp' | 'google-ai' | 'openai' | 'mock';
  /** Per-cloud-provider default image model id. */
  defaultImageModel?: {
    'google-ai'?: string;
    openai?: string;
  };
  /**
   * Cost-confirmation behaviour for cloud image generation. `'ask'`
   * (or undefined) prompts the user before each cloud call.
   */
  imageGenerationConfirmation?: 'always-allow' | 'ask' | { mode: 'snooze'; until: string };
  /** Active video-generation provider; undefined → 'diffusers'. */
  videoProvider?: 'diffusers' | 'mock';
  /** Default video model id (the local engine otherwise picks the first installed). */
  defaultVideoModel?: string;
  /**
   * Confirmation behaviour for video generation. `'ask'` (or undefined)
   * prompts before each generation — local included, since video is
   * long-running and GPU-monopolizing.
   */
  videoGenerationConfirmation?: 'always-allow' | 'ask' | { mode: 'snooze'; until: string };
  /** Active image-recognition engine; undefined → 'llama-cpp'. */
  recognitionProvider?: 'llama-cpp' | 'mlx' | 'mock';
  /** Catalog id of the vision model used for image recognition. */
  defaultRecognitionModel?: string;
  /** Image-recognition policy. See `GezelConfigSchema.recognition`. */
  recognition?: {
    mode?: 'auto' | 'always' | 'off';
    modes?: RecognitionMode[];
    maxImagesPerTurn?: number;
    timeoutMsPerImage?: number;
    maxDigestChars?: number;
    maxMegapixels?: number;
  };
  /** Per-model native-vision opt-in, keyed by catalog id. Absent → off. */
  nativeVision?: Record<string, boolean>;
  /**
   * OpenAI-compatible endpoint controls (Settings → Connected Apps).
   * `enabled` unset means ON; `servingGezelId` optionally overrides the
   * Meester/first-gezel fallback for requests naming an unknown model;
   * `supportingBehaviors` (unset = on) applies gezel's per-model
   * behavior profile to app sessions — model tuning applies regardless. See
   * `GezelConfig.openaiEndpoints` in core schemas.
   */
  openaiEndpoints?: {
    enabled?: boolean;
    servingGezelId?: string;
    supportingBehaviors?: boolean;
    /** Host an unauthenticated Ollama-compatible listener on port 11434. Default off. */
    emulateOllama?: boolean;
  };
  /** Remote model execution: serving this device's models to paired clients. */
  remoteServing?: {
    enabled?: boolean;
    bindAddress?: string;
    port?: number;
    priority?: 'equal' | 'below-local' | 'above-local';
    reserveLocalGb?: number;
    allowModels?: string[];
    limits?: {
      maxConcurrentPerDevice?: number;
      maxChatPerDevice?: number;
      requestsPerMinute?: number;
    };
  };
}

/** One server this device has paired with (token redacted). */
export interface PairedRemoteInfo {
  remoteId: string;
  baseUrl: string;
  displayName: string;
  pinnedIdentityFingerprint: string;
  scopes: string[];
  pairedAt: number;
  lastSeenAt?: number;
  hasToken: boolean;
}

export type SendChannelResult =
  | { ok: true; id?: string; channel?: 'webhook' }
  | { ok: false; error: string; channel?: 'webhook' };

/**
 * Streaming progress event for `pullOllamaModel`. `progress.chunk` is the
 * raw NDJSON chunk straight from Ollama (`{status, digest?, total?,
 * completed?}`). `done` is terminal. `error` arrives right before `done`
 * on failure.
 */
export type OllamaPullEvent =
  | { type: 'progress'; chunk: OllamaPullChunk }
  | { type: 'error'; error: string }
  | { type: 'done' };

export interface OllamaPullChunk {
  status: string;
  digest?: string;
  total?: number;
  completed?: number;
}

/**
 * Events emitted by the `/api/llama-cpp/models/:id/install` SSE
 * stream. Mirrors the `InstallEvent` shape on the service side.
 */
export type LlamaCppInstallEvent =
  | { type: 'progress'; bytesWritten: number; totalBytes: number }
  /**
   * Surfaced by the shared `downloadWithRetry` helper between
   * attempts. Render "Connection dropped — retrying in 4s
   * (attempt 3/5)…" instead of a fatal error banner.
   */
  | {
      type: 'retrying';
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      reason: string;
    }
  | { type: 'verifying' }
  | { type: 'extracting-metadata' }
  | {
      type: 'companion';
      kind: 'image-recognition';
      id: string;
      name: string;
      bytesWritten: number;
      totalBytes: number;
      error?: string;
    }
  | { type: 'done'; id: string; warning?: string }
  /**
   * Terminal failure. When `mismatch` is present, the failure is a
   * sha256 mismatch against the catalog — the UI can offer "Download
   * anyway" which retries with `{skipSha: true}`.
   */
  | {
      type: 'error';
      error: string;
      mismatch?: { file: string; expected: string; actual: string };
    };

// ── Evals (in-app Benchmarks panel) ──
// Mirror of packages/service/src/eval/{scenarios,runner}.ts shapes —
// kept in the client for now to avoid coupling the client to the
// service package. When the catalog moves into `@bendyline/gezel`
// proper this duplication goes away.

export interface EvalScenarioManifest {
  id: string;
  name: string;
  description: string;
  capabilityAxis: string;
  defaultModel: string;
  defaultImageModel?: string;
  timeoutMs: number;
  anchored: boolean;
}

export interface TrialOutcome {
  trialId: string;
  scenarioId: string;
  modelId: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  success: boolean;
  reason: string;
  failureMode?: string;
  runDir: string;
}

export type RunEvalEvent =
  | { type: 'spawned'; trialId?: string; runDir?: string }
  | { type: 'log'; line: string }
  | { type: 'done'; result: TrialOutcome }
  | { type: 'error'; error: string };

/**
 * Snapshot of an in-flight install reported by
 * `GET /api/llama-cpp/active-installs`. The Settings catalog UI
 * polls this endpoint so background-driven installs (the first-run
 * bootstrap) light up the same progress UI a click-driven install
 * would have shown via SSE — without it, the bootstrap install runs
 * to completion server-side while the catalog reads "no model
 * installed" the entire time.
 */
export interface LocalActiveInstall {
  catalogId: string;
  bytesWritten: number;
  totalBytes: number;
  phase: 'downloading' | 'verifying' | 'extracting-metadata';
  startedAt: string;
}

/**
 * An incomplete on-disk download — bytes present but no install manifest, so
 * it's invisible to the installed-model listings. Returned by the per-engine
 * `listIncomplete*` methods so the Settings UI can surface resume/delete
 * before the daemon's 7-day reclaim sweep removes it. Shape mirrors the
 * service's `IncompleteModelDownloadInfo`.
 */
export interface IncompleteModelDownload {
  id: string;
  /** Total bytes on disk (payload + `.partial`). */
  bytes: number;
  /** ISO timestamp of the newest write in the directory. */
  updatedAt: string;
  /** Whether a `.partial` file is present. */
  hasPartial: boolean;
  /** True when re-installing this id would resume from the on-disk bytes. */
  resumable: boolean;
  /** Catalog display name, when the id still resolves. */
  name?: string;
}

/**
 * One installed llama.cpp model on disk. Returned by
 * {@link GezelClient.listLlamaCppModels}.
 */
export interface LlamaCppInstalledModel {
  id: string;
  name: string;
  approxSizeBytes: number;
  installedAt: string;
  weightsPath: string;
  contextWindow?: number;
  quantization?: string;
  chatTemplatePresent: boolean;
  architecture?: string;
  /**
   * True when the catalog now ships a different version than the one this
   * model was downloaded against. The model manager surfaces an "Update"
   * action (re-download + replace in place) when set.
   */
  updateAvailable?: boolean;
  /** The catalog's current version, when it differs from the installed one. */
  availableVersion?: string;
  /**
   * True when the model lives in a read-only overlay (the machine/shared asset
   * store), not this daemon's writable root. The delete endpoint refuses these,
   * so the UI shows them as machine-provided instead of offering Delete.
   */
  readOnly?: boolean;
}

/**
 * One persisted model-fitness record (the proeve result), resolved
 * with read-time freshness flags. Returned by
 * {@link GezelClient.listModelFitness}. Shape mirrors
 * `ModelFitnessRecordSchema` in @bendyline/gezel.
 */
export interface ModelFitnessEntry {
  /** `"<provider>:<modelId>"` map key. */
  key: string;
  record: {
    schemaVersion: 1;
    provider: string;
    modelId: string;
    status: 'probed' | 'failed' | 'deferred' | 'blocked';
    admitted: boolean;
    genTokensPerSec: number | null;
    createdAt: string;
    durationMs: number;
    trigger: 'install' | 'manual';
    sha256?: string;
    catalogVersion?: string;
    contextWindow?: number;
    host: { totalRamBytes: number; gpuVramBytes: number | null; source: string };
    checks: Record<
      'spawn' | 'toolRoundTrip' | 'throughput' | 'reasoningBudget' | 'contextFit',
      { ok: boolean; detail: string }
    >;
  };
  /** Installed weights/version changed since the probe — treat as unprobed. */
  stale: boolean;
  /** Host memory changed materially since the probe — soften, don't invalidate. */
  hardwareChanged: boolean;
}

/**
 * Events emitted by the `/api/mlx/models/:id/install` SSE stream. MLX
 * models are multi-file repos (config.json + weight shards) so the
 * `progress` event carries `fileIndex` / `fileCount` / `file` for
 * per-file progress inside the overall install.
 */
export type MlxInstallEvent =
  | {
      type: 'progress';
      fileIndex: number;
      fileCount: number;
      file: string;
      bytesWritten: number;
      totalBytes: number;
      /** Cumulative bytes downloaded across every file so far. */
      bytesWrittenAll: number;
      /** Sum of file sizes pinned in the manifest. */
      totalBytesAll: number;
    }
  /**
   * Retrying after a transient network error. UI shows
   * "Connection dropped on shard 2/5 — retrying in 4s (attempt 3/5)…"
   * — the `file` field is the MLX shard currently being attempted.
   */
  | {
      type: 'retrying';
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      reason: string;
      file: string;
    }
  | { type: 'verifying'; file: string }
  | { type: 'extracting-metadata' }
  | { type: 'done'; id: string; warning?: string }
  /**
   * Terminal failure. When `mismatch` is present, the failure is a
   * sha256 mismatch against the catalog — the UI can offer "Download
   * anyway" which retries with `{skipSha: true}`.
   */
  | {
      type: 'error';
      error: string;
      mismatch?: { file: string; expected: string; actual: string };
    };

/** One installed MLX model directory on disk. */
export interface MlxInstalledModel {
  id: string;
  name: string;
  approxSizeBytes: number;
  installedAt: string;
  /** Absolute path of the model directory; `mlx_lm.server --model` takes this. */
  modelDir: string;
  contextWindow?: number;
  quantization?: string;
  chatTemplatePresent: boolean;
  architecture?: string;
  /**
   * Catalog manifest `version` as of install — compare with the
   * live catalog's version to detect "stale install" when a catalog
   * bump changed the upstream repo or file set.
   */
  catalogVersion?: string;
  /**
   * True when the model lives in a read-only overlay (the machine/shared asset
   * store), not this daemon's writable root. Delete refuses these, so the UI
   * shows them as machine-provided instead of offering Delete.
   */
  readOnly?: boolean;
}

/** Snapshot of the Python runtime powering MLX venvs. */
export interface MlxRuntimeInfo {
  source: 'system-uv' | 'system-python' | 'bundled-uv' | null;
  installerPath?: string;
  uvVersion?: string;
  pythonVersion?: string;
  bundledUvAvailable: boolean;
  /** Populated when `source === null` — explains why no runtime was found. */
  reason?: string;
}

/** Result envelope shared by `runPackageScript` + `runNpx`. */
export interface RunWorkspaceCommandResult {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
  error?: string;
  /** Set when the project hasn't approved this script/bin yet. */
  approvalPending?: boolean;
  questionId?: string;
  /** Populated when the user previously declined this script/bin. */
  declined?: string;
}

export class GezelApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'GezelApiError';
  }
}

function describeTransportError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as Error & { cause?: unknown }).cause;
  if (cause instanceof Error && cause.message && cause.message !== error.message) {
    return `${error.message} (${cause.message})`;
  }
  if (cause && typeof cause === 'object' && 'code' in cause) {
    return `${error.message} (${String((cause as { code?: unknown }).code)})`;
  }
  return error.message;
}

type ConsumeApiSseJsonOptions<T> = ConsumeSseJsonOptions<T> & {
  staleMessage?: string;
};

async function consumeApiSseJson<T>(options: ConsumeApiSseJsonOptions<T>): Promise<void> {
  const { staleMessage, ...streamOptions } = options;
  try {
    await consumeSseJson(streamOptions);
  } catch (error) {
    if (error instanceof GezelApiError) throw error;
    const message =
      error instanceof SseStreamStaleError && staleMessage
        ? staleMessage
        : error instanceof Error
          ? error.message
          : 'SSE stream failed';
    const status = error instanceof SseResponseError ? error.status : 0;
    throw new GezelApiError(message, status, {
      cause: error instanceof Error ? error.name : 'unknown',
    });
  }
}

const mismatchSchema = z.object({ file: z.string(), expected: z.string(), actual: z.string() });
const LlamaCppInstallEventSchema: z.ZodType<LlamaCppInstallEvent> = z.discriminatedUnion('type', [
  z.object({ type: z.literal('progress'), bytesWritten: z.number(), totalBytes: z.number() }),
  z.object({
    type: z.literal('retrying'),
    attempt: z.number().int().positive(),
    maxAttempts: z.number().int().positive(),
    delayMs: z.number().nonnegative(),
    reason: z.string(),
  }),
  z.object({ type: z.literal('verifying') }),
  z.object({ type: z.literal('extracting-metadata') }),
  z.object({
    type: z.literal('companion'),
    kind: z.literal('image-recognition'),
    id: z.string(),
    name: z.string(),
    bytesWritten: z.number().nonnegative(),
    totalBytes: z.number().nonnegative(),
    error: z.string().optional(),
  }),
  z.object({ type: z.literal('done'), id: z.string(), warning: z.string().optional() }),
  z.object({ type: z.literal('error'), error: z.string(), mismatch: mismatchSchema.optional() }),
]);
const MlxInstallEventSchema: z.ZodType<MlxInstallEvent> = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('progress'),
    fileIndex: z.number().int().nonnegative(),
    fileCount: z.number().int().positive(),
    file: z.string(),
    bytesWritten: z.number().nonnegative(),
    totalBytes: z.number().nonnegative(),
    bytesWrittenAll: z.number().nonnegative(),
    totalBytesAll: z.number().nonnegative(),
  }),
  z.object({
    type: z.literal('retrying'),
    attempt: z.number().int().positive(),
    maxAttempts: z.number().int().positive(),
    delayMs: z.number().nonnegative(),
    reason: z.string(),
    file: z.string(),
  }),
  z.object({ type: z.literal('verifying'), file: z.string() }),
  z.object({ type: z.literal('extracting-metadata') }),
  z.object({ type: z.literal('done'), id: z.string(), warning: z.string().optional() }),
  z.object({ type: z.literal('error'), error: z.string(), mismatch: mismatchSchema.optional() }),
]);
const RunEvalEventSchema: z.ZodType<RunEvalEvent> = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('spawned'),
    trialId: z.string().optional(),
    runDir: z.string().optional(),
  }),
  z.object({ type: z.literal('log'), line: z.string() }),
  z.object({
    type: z.literal('done'),
    result: z.object({
      trialId: z.string(),
      scenarioId: z.string(),
      modelId: z.string(),
      startedAt: z.string(),
      finishedAt: z.string(),
      durationMs: z.number(),
      success: z.boolean(),
      reason: z.string(),
      failureMode: z.string().optional(),
      runDir: z.string(),
    }),
  }),
  z.object({ type: z.literal('error'), error: z.string() }),
]);
const TransformStreamEventSchema: z.ZodType<TransformStreamEvent> = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('status'),
    phase: z.enum(['queued', 'started']),
    detail: z.string().optional(),
  }),
  z.object({ type: z.literal('thinking-delta'), text: z.string() }),
  z.object({ type: z.literal('output-delta'), text: z.string() }),
  z.object({ type: z.literal('done'), text: z.string() }),
  z.object({ type: z.literal('error'), error: z.string() }),
]);
const OllamaPullEventSchema: z.ZodType<OllamaPullEvent> = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('progress'),
    chunk: z.object({
      status: z.string(),
      digest: z.string().optional(),
      total: z.number().optional(),
      completed: z.number().optional(),
    }),
  }),
  z.object({ type: z.literal('error'), error: z.string() }),
  z.object({ type: z.literal('done') }),
]);

export class GezelClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: GezelClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.token = opts.token;
    // Browser `fetch` is a native method bound to `window`; calling it as
    // `this.fetchImpl(...)` strips that binding and Chromium throws
    // "Illegal invocation". Rebind to the global so it works from any call
    // site (browser, Electron renderer, Node 22+).
    const baseFetch = opts.fetch ?? fetch;
    this.fetchImpl = baseFetch.bind(globalThis);
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(extraHeaders ?? {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      const message = describeTransportError(error);
      throw new GezelApiError(
        `Gezel API transport unavailable on ${method} ${path}: ${message}`,
        0,
        { kind: 'transport', cause: message },
      );
    }
    if (!res.ok) {
      // Read the body exactly once — fetch Response bodies are
      // one-shot streams, so calling `.json()` consumes them even on
      // parse failure. A chained `.text()` fallback would throw "Body
      // is unusable: Body has already been read", which then becomes
      // the primary error and masks the real HTTP status. Take the
      // raw text and attempt JSON locally so either shape surfaces
      // cleanly.
      let details: unknown;
      try {
        const text = await res.text();
        if (text.length === 0) {
          details = undefined;
        } else {
          try {
            details = JSON.parse(text);
          } catch {
            details = text;
          }
        }
      } catch (readErr) {
        details = readErr instanceof Error ? readErr.message : String(readErr);
      }
      throw new GezelApiError(
        `Gezel API error ${res.status} on ${method} ${path}`,
        res.status,
        details,
      );
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  health(signal?: AbortSignal): Promise<HealthResponse> {
    return this.request('GET', '/api/health', undefined, undefined, signal);
  }

  getUsage(): Promise<UsageResponse> {
    return this.request('GET', '/api/usage');
  }

  getQueueStatus(): Promise<QueueStatusResponse> {
    return this.request('GET', '/api/queues');
  }

  /**
   * Cancel a pending provider-queue entry by its id. The id comes from
   * `ProviderQueueState.pending[i].id` in the same `getQueueStatus`
   * payload the QueueMeter is rendering. Returns `{cancelled: true}`
   * when the entry was found and removed, false when the id was
   * unknown (already running, already cancelled, or different queue).
   */
  cancelProviderQueueItem(provider: string, id: number): Promise<{ cancelled: boolean }> {
    return this.request('DELETE', `/api/queues/${encodeURIComponent(provider)}/${id}`);
  }

  /**
   * Reorder a pending provider-queue entry within its lane. `'up'`
   * makes the entry sort before its predecessor, `'down'` makes it
   * sort after its successor. The dispatcher is affinity-aware (not
   * strict FIFO) so this nudges priority rather than guaranteeing a
   * specific dispatch order.
   */
  moveProviderQueueItem(
    provider: string,
    id: number,
    direction: 'up' | 'down',
  ): Promise<{ moved: boolean }> {
    return this.request('POST', `/api/queues/${encodeURIComponent(provider)}/${id}/move`, {
      direction,
    });
  }

  /**
   * Snapshot of every local provider's prompt-cache state. Same data
   * the EngineStatusPill consumes via `/api/queues` (where it's
   * embedded as a `cache` field) — this dedicated endpoint is for
   * Settings UI workflows ("show me everything that's warm right
   * now") and operator scripts.
   */
  getCacheStats(): Promise<{ providers: ProviderCacheStatsResponse[] }> {
    return this.request('GET', '/api/cache/stats');
  }

  /** Drop a single session's cache from whichever engine holds it. */
  evictSessionCache(sessionId: string): Promise<{ ok: boolean; sessionId: string }> {
    return this.request('POST', '/api/cache/evict', { sessionId });
  }

  /** Drop all warm sessions for a provider. Operator escape hatch. */
  clearProviderCache(provider: string): Promise<{ ok: boolean; provider: string }> {
    return this.request('POST', '/api/cache/clear', { provider });
  }

  /**
   * Phase 4: ask the daemon to pre-warm a session's prompt cache.
   * Returns 202 immediately; warming runs in the background. UI calls
   * this on session open so the first turn returns near-instantly.
   */
  warmSessionCache(sessionId: string): Promise<{ ok: boolean; sessionId: string }> {
    return this.request('POST', '/api/cache/warm', { sessionId });
  }

  getConfig(): Promise<ConfigResponse> {
    return this.request('GET', '/api/config');
  }

  updateConfig(body: UpdateConfigRequest): Promise<ConfigResponse> {
    return this.request('PUT', '/api/config', body);
  }

  // ---------- night shift ----------

  getNightShiftStatus(): Promise<{ active: boolean; source: 'scheduled' | 'manual' | null }> {
    return this.request('GET', '/api/night-shift/status');
  }

  setNightShiftManual(
    action: 'start' | 'stop',
  ): Promise<{ active: boolean; source: 'scheduled' | 'manual' | null }> {
    return this.request('POST', '/api/night-shift/manual', { action });
  }

  /** What the shift is working on now (background + active tasks), plus tasks
   *  genuinely present in the runner queue (upcoming). */
  getNightShiftTasks(): Promise<NightShiftTasksResponse> {
    return this.request('GET', '/api/night-shift/tasks');
  }

  /** The morning review: what the most recent night window accomplished. */
  getNightShiftReview(): Promise<NightShiftReviewResponse> {
    return this.request('GET', '/api/night-shift/review');
  }

  // ---------- suggested night work ----------

  /** The project's suggested-work toggle list (role + project-type sources). */
  listSuggestedWork(projectId: string): Promise<SuggestedWorkResponse> {
    return this.request('GET', `/api/projects/${encodeURIComponent(projectId)}/suggested-work`);
  }

  /** Enable a suggestion — materializes (or resurrects) its host task. */
  enableSuggestedWork(
    projectId: string,
    body: EnableSuggestedWorkRequest,
  ): Promise<{ item: SuggestedWorkItem; task: Task }> {
    return this.request(
      'POST',
      `/api/projects/${encodeURIComponent(projectId)}/suggested-work/enable`,
      body,
    );
  }

  /** Disable a suggestion — pauses its host task (re-enable resurrects it). */
  disableSuggestedWork(projectId: string, key: string): Promise<{ item: SuggestedWorkItem }> {
    return this.request(
      'POST',
      `/api/projects/${encodeURIComponent(projectId)}/suggested-work/disable`,
      { key },
    );
  }

  /** Hide (or un-hide) a suggestion from the project's toggle list. */
  dismissSuggestedWork(
    projectId: string,
    key: string,
    dismissed: boolean,
  ): Promise<{ ok: boolean }> {
    return this.request(
      'POST',
      `/api/projects/${encodeURIComponent(projectId)}/suggested-work/dismiss`,
      { key, dismissed },
    );
  }

  // ---------- report actions ----------

  /** Parse a report artifact's ```gezel-action blocks + lifecycle overlay. */
  getReportActions(projectId: string, path: string): Promise<ReportActionsResponse> {
    return this.request(
      'GET',
      `/api/projects/${encodeURIComponent(projectId)}/report-actions?path=${encodeURIComponent(path)}`,
    );
  }

  /** Fire one report action (create+dispatch a task, or apply an edit pack). */
  fireReportAction(
    projectId: string,
    body: FireReportActionRequest,
  ): Promise<FireReportActionResponse> {
    return this.request(
      'POST',
      `/api/projects/${encodeURIComponent(projectId)}/report-actions/fire`,
      body,
    );
  }

  /** Dismiss a report action ("don't offer this recommendation again"). */
  dismissReportAction(
    projectId: string,
    body: DismissReportActionRequest,
  ): Promise<{ record: ReportActionRecord }> {
    return this.request(
      'POST',
      `/api/projects/${encodeURIComponent(projectId)}/report-actions/dismiss`,
      body,
    );
  }

  // ---------- meester status report ----------

  getMeesterStatus(): Promise<MeesterStatusResponse> {
    return this.request('GET', '/api/meester-status');
  }

  /** Kick a user-requested status run. Returns immediately; completion
   *  arrives on the global SSE stream as a `meester_status` event. */
  runMeesterStatus(): Promise<{ started: boolean }> {
    return this.request('POST', '/api/meester-status/run');
  }

  // ---------- folders externalization ----------

  getFolders(): Promise<FoldersStatusResponse> {
    return this.request('GET', '/api/folders');
  }

  planFolderMove(body: { scope: FolderScope; destPath: string }): Promise<FolderMovePlan> {
    return this.request('POST', '/api/folders/plan', body);
  }

  startFolderMove(body: {
    scope: FolderScope;
    destPath: string;
    conflictPolicy: 'overwrite-all' | 'skip-all';
  }): Promise<{ jobId: string }> {
    return this.request('POST', '/api/folders/move', body);
  }

  getFolderMoveStatus(jobId: string): Promise<FolderMoveStatus> {
    return this.request('GET', `/api/folders/move/${encodeURIComponent(jobId)}`);
  }

  cancelFolderMove(jobId: string): Promise<{ ok: true }> {
    return this.request('POST', `/api/folders/move/${encodeURIComponent(jobId)}/cancel`);
  }

  resetFolder(scope: FolderScope): Promise<{ jobId: string }> {
    return this.request('POST', '/api/folders/reset', { scope });
  }

  /**
   * Create a brand-new Meester gezel (with the curated Meester about.md)
   * and make them the active meester. Optionally pass a custom name.
   */
  createNewMeester(body: { name?: string } = {}): Promise<{
    gezel: GezelResponse;
    config: ConfigResponse;
  }> {
    return this.request('POST', '/api/config/meester', body);
  }

  /**
   * Create a brand-new Klerk gezel (with the curated Klerk about.md) and
   * make them the active klerk. Optionally pass a custom name.
   */
  createNewKlerk(body: { name?: string } = {}): Promise<{
    gezel: GezelResponse;
    config: ConfigResponse;
  }> {
    return this.request('POST', '/api/config/klerk', body);
  }

  /**
   * Create a brand-new canonical Boekwachter gezel and make them the
   * install-wide index-keeper. Project memberships transfer from the
   * previous designation.
   */
  createNewBoekwachter(body: { name?: string } = {}): Promise<{
    gezel: GezelResponse;
    config: ConfigResponse;
  }> {
    return this.request('POST', '/api/config/boekwachter', body);
  }

  /**
   * Create a brand-new Keurmeester gezel (with the curated inspector
   * about.md) and make them the active keurmeester. Optionally pass a
   * custom name.
   */
  createNewKeurmeester(body: { name?: string } = {}): Promise<{
    gezel: GezelResponse;
    config: ConfigResponse;
  }> {
    return this.request('POST', '/api/config/keurmeester', body);
  }

  testProvider(
    provider: ProviderName,
  ): Promise<
    | { ok: true; provider: ProviderName; modelCount: number }
    | { ok: false; provider: ProviderName; error: string }
  > {
    return this.request('GET', `/api/models/test?provider=${encodeURIComponent(provider)}`);
  }

  listProviderModels(
    provider: ProviderName,
    opts?: { refresh?: boolean },
  ): Promise<ListModelsResponse> {
    const refresh = opts?.refresh ? '&refresh=1' : '';
    return this.request('GET', `/api/models?provider=${encodeURIComponent(provider)}${refresh}`);
  }

  // ── Communication channels ──

  listChannels(): Promise<{ channels: ChannelStatus[] }> {
    return this.request('GET', '/api/channels');
  }

  sendChannelMessage(body: {
    channel?: 'webhook';
    message: string;
    metadata?: Record<string, unknown>;
  }): Promise<SendChannelResult> {
    return this.request('POST', '/api/channels/send', body);
  }

  testChannel(name: 'webhook'): Promise<SendChannelResult> {
    return this.request('POST', `/api/channels/${encodeURIComponent(name)}/test`);
  }

  /** Mint a scoped artifacts-preview lease for a first-party client. */
  createProjectPreviewUrl(
    projectId: string,
    relativePath: string,
  ): Promise<CreatePreviewCapabilityResponse> {
    return this.createPreviewUrl('artifacts', projectId, relativePath);
  }

  /**
   * Same shape as `createProjectPreviewUrl` but scoped to the project's
   * workspace tree (either the external `workingDir` or the internal
   * fallback). Uses `/preview/:capability/:source/*`; both capability and
   * source live in the path — these segments must live in the path (not
   * a query string) so relative subresource URLs like `<link
   * href="style.css">` inherit it during browser resolution.
   */
  createProjectWorkspacePreviewUrl(
    projectId: string,
    relativePath: string,
  ): Promise<CreatePreviewCapabilityResponse> {
    return this.createPreviewUrl('workspace', projectId, relativePath);
  }

  /**
   * Preview URL for a page shipped by the project's applied custom project
   * type (the read-only `pages/` tree in the type's catalog entry). Same
   * sandboxed-iframe shape as the other preview sources. See
   * docs/project-types.md.
   */
  createProjectTypePreviewUrl(
    projectId: string,
    relativePath: string,
  ): Promise<CreatePreviewCapabilityResponse> {
    return this.createPreviewUrl('type', projectId, relativePath);
  }

  private async createPreviewUrl(
    source: CreatePreviewCapabilityRequest['source'],
    projectId: string,
    relativePath: string,
  ): Promise<CreatePreviewCapabilityResponse> {
    const lease = await this.request<CreatePreviewCapabilityResponse>(
      'POST',
      `/api/projects/${encodeURIComponent(projectId)}/preview-capability`,
      { source, path: relativePath },
    );
    return { ...lease, url: new URL(lease.url, this.baseUrl).toString() };
  }

  /**
   * Headless runtime smoke check of a workspace HTML page. `ran: false`
   * means "no browser available / no verdict" — treat as no signal, not
   * as a pass. Used by the MCP write tools after landing `*.html`.
   */
  checkProjectPage(projectId: string, relativePath: string): Promise<PageCheckResponse> {
    return this.request('POST', `/api/projects/${encodeURIComponent(projectId)}/page-check`, {
      path: relativePath,
    } satisfies PageCheckRequest);
  }

  /**
   * Report runtime errors the preview iframe's log shim captured, so the
   * service can surface them to the project's gezels on the next turn.
   */
  reportProjectPreviewLog(
    projectId: string,
    entries: PreviewLogEntry[],
  ): Promise<{ ok: boolean; pending: number }> {
    return this.request('POST', `/api/projects/${encodeURIComponent(projectId)}/preview-log`, {
      entries,
    } satisfies ReportPreviewLogRequest);
  }

  // ── Per-session image attachments ──
  //
  // Project-scoped attachments — images (and future file types) pasted
  // or uploaded in a chat. Saved once per project under
  // `artifacts/attachments/` so every session in the project can
  // reference them, and the Artifacts tab browses them. The
  // `relativePath` returned here is the form embedded in the chat
  // markdown (`attachments/<filename>`), which `extractImageAttachments`
  // resolves server-side.

  async uploadProjectAttachment(
    projectId: string,
    data: Blob | ArrayBuffer | Uint8Array,
    mimeType: string,
  ): Promise<{ relativePath: string; filename: string; url: string }> {
    const url = `${this.baseUrl}/api/projects/${encodeURIComponent(projectId)}/attachments`;
    const body =
      data instanceof Blob
        ? data
        : data instanceof Uint8Array
          ? data
          : new Uint8Array(data as ArrayBuffer);
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': mimeType,
        Authorization: `Bearer ${this.token}`,
      },
      body,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`upload failed (${res.status}): ${text}`);
    }
    return res.json() as Promise<{ relativePath: string; filename: string; url: string }>;
  }

  listProjectAttachments(
    projectId: string,
  ): Promise<{ attachments: Array<{ filename: string; size: number; mimeType: string }> }> {
    return this.request('GET', `/api/projects/${encodeURIComponent(projectId)}/attachments`);
  }

  deleteProjectAttachment(projectId: string, filename: string): Promise<{ ok: true }> {
    return this.request(
      'DELETE',
      `/api/projects/${encodeURIComponent(projectId)}/attachments/${encodeURIComponent(filename)}`,
    );
  }

  async fetchProjectAttachment(projectId: string, filename: string): Promise<Blob> {
    const url = `${this.baseUrl}/api/projects/${encodeURIComponent(projectId)}/attachments/${encodeURIComponent(filename)}`;
    const res = await this.fetchImpl(url, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) throw new Error(`attachment fetch failed: ${res.status}`);
    return res.blob();
  }

  // ── Legacy session-scoped images ─────────────────────────────
  // Kept so archived chats that pre-date the project-scoped
  // `attachments/` rework still render. New uploads should use
  // `uploadProjectAttachment` instead.
  async uploadSessionImage(
    projectId: string,
    sessionId: string,
    data: Blob | ArrayBuffer | Uint8Array,
    mimeType: string,
  ): Promise<{ relativePath: string; filename: string; url: string }> {
    const url = `${this.baseUrl}/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/images`;
    const body =
      data instanceof Blob
        ? data
        : data instanceof Uint8Array
          ? data
          : new Uint8Array(data as ArrayBuffer);
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': mimeType,
        Authorization: `Bearer ${this.token}`,
      },
      body,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`upload failed (${res.status}): ${text}`);
    }
    return res.json() as Promise<{ relativePath: string; filename: string; url: string }>;
  }

  listSessionImages(
    projectId: string,
    sessionId: string,
  ): Promise<{ images: Array<{ filename: string; size: number; mimeType: string }> }> {
    return this.request(
      'GET',
      `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/images`,
    );
  }

  deleteSessionImage(
    projectId: string,
    sessionId: string,
    filename: string,
  ): Promise<{ ok: true }> {
    return this.request(
      'DELETE',
      `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/images/${encodeURIComponent(filename)}`,
    );
  }

  /**
   * Fetch a project artifact (any file under `projects/{id}/artifacts/`)
   * as a Blob. Used by the chat UI to load tool-call screenshots that
   * the MCP bridge wrote into `artifacts/sessions/<friendly>/…`. Same
   * "bypass `<img src>` because it can't carry a bearer token" pattern
   * as `fetchSessionImage`.
   */
  async fetchProjectArtifactBlob(projectId: string, filePath: string): Promise<Blob> {
    const url = `${this.baseUrl}/api/projects/${encodeURIComponent(projectId)}/artifacts/read?path=${encodeURIComponent(filePath)}&raw=1`;
    const res = await this.fetchImpl(url, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) throw new Error(`artifact fetch failed: ${res.status}`);
    return res.blob();
  }

  /**
   * Sibling of `fetchProjectArtifactBlob` for the workspace tree.
   * Used by the Artifacts/Workspace file-viewer's image preview,
   * which also can't put a bearer token into an `<img src>`.
   */
  async fetchProjectWorkspaceBlob(projectId: string, filePath: string): Promise<Blob> {
    const url = `${this.baseUrl}/api/projects/${encodeURIComponent(projectId)}/workspace/read?path=${encodeURIComponent(filePath)}&raw=1`;
    const res = await this.fetchImpl(url, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) throw new Error(`workspace fetch failed: ${res.status}`);
    return res.blob();
  }

  /**
   * Fetch an image as a Blob (for rendering via `URL.createObjectURL`).
   * `<img src>` can't carry a bearer token so we do the fetch by hand.
   */
  async fetchSessionImage(projectId: string, sessionId: string, filename: string): Promise<Blob> {
    const url = `${this.baseUrl}/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/images/${encodeURIComponent(filename)}`;
    const res = await this.fetchImpl(url, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) throw new Error(`image fetch failed: ${res.status}`);
    return res.blob();
  }

  /**
   * Who is currently signed in to GitHub Copilot. Works for both the
   * CLI-based (`npx @github/copilot login`) flow and PAT auth — the SDK
   * returns a uniform status either way. Always resolves with an envelope;
   * auth failures come back as `{ ok: false, error }` rather than HTTP 500.
   */
  getCopilotUser(): Promise<
    | {
        ok: true;
        status: {
          isAuthenticated: boolean;
          authType?: 'user' | 'env' | 'gh-cli' | 'hmac' | 'api-key' | 'token';
          host?: string;
          login?: string;
          statusMessage?: string;
        };
      }
    | { ok: false; error: string }
  > {
    return this.request('GET', '/api/system/copilot-user');
  }

  // ── GitHub OAuth (device flow + identity + repo preview) ──

  /**
   * Begin a device-flow sign-in. The UI displays the returned `userCode`
   * and opens `verificationUri` in a browser, then polls
   * `pollGitHubLogin(deviceCode)` every `interval` seconds until the
   * user completes the auth or it expires.
   */
  startGitHubLogin(): Promise<GitHubLoginStartResponse> {
    return this.request('POST', '/api/system/github-login/start', {});
  }

  pollGitHubLogin(deviceCode: string): Promise<GitHubLoginPollResponse> {
    return this.request('POST', '/api/system/github-login/poll', { deviceCode });
  }

  gitHubLogout(): Promise<{ ok: true }> {
    return this.request('POST', '/api/system/github-logout', {});
  }

  /** Fetch the signed-in user's identity. `signedIn: false` if no token. */
  getGitHubIdentity(): Promise<GitHubIdentityResponse> {
    return this.request('GET', '/api/system/github-identity');
  }

  /**
   * List the authenticated user's accessible GitHub repos (sorted by
   * pushedAt desc). Returns an empty list when the user isn't signed
   * in — the dialog just renders no suggestions.
   */
  listGitHubRepos(): Promise<GitHubReposResponse> {
    return this.request('GET', '/api/system/github-repos');
  }

  /**
   * Fetch metadata + README for a GitHub repo URL. Used by the New
   * Project dialog to seed the project-about preview.
   */
  previewGitHubRepo(url: string, signal?: AbortSignal): Promise<GitHubRepoPreviewResponse> {
    return this.request('POST', '/api/system/github-repo-preview', { url }, undefined, signal);
  }

  /**
   * Run the project-about LLM generator against repo metadata + README.
   * Returns drafted `about` and `missionObjectives` strings the dialog
   * pre-fills.
   */
  previewProjectAbout(
    body: ProjectAboutPreviewRequest,
    signal?: AbortSignal,
  ): Promise<ProjectAboutPreviewResponse> {
    return this.request('POST', '/api/projects/preview-about', body, undefined, signal);
  }

  /**
   * Peek at a local folder for the New Project dialog's "from folder" flow.
   * Returns the folder's basename (suggested project name) and, when the
   * folder holds an AGENTS.md / CLAUDE.md / agent.md at its root, its contents
   * as a draft About.
   */
  previewFolder(path: string): Promise<ProjectFolderPreviewResponse> {
    return this.request('POST', '/api/projects/preview-folder', { path });
  }

  // ── Catalog (bundled + remote items) ──

  listCatalogItems(kind: CatalogKind): Promise<{ items: CatalogItemSummary[] }> {
    return this.request('GET', `/api/catalog/${kind}`);
  }

  /**
   * Craftbook templates applicable to a project — the catalog craftbooks
   * whose `requirements` the project's GitHub/branch state satisfies. The
   * command-launcher rail uses this instead of the project-agnostic
   * `listCatalogItems('craftbook-template')` so non-applicable craftbooks
   * aren't offered.
   */
  listProjectCraftbooks(projectId: string): Promise<{
    items: CatalogItemSummary[];
    /** Craftbook id → required toolsets it declares that aren't installed. */
    missingToolsets: Record<string, CraftbookToolsetNeed[]>;
    /** Resolved project type (override → detected → none), for the rail header. */
    projectType?: { id: string; label: string } | null;
    /** Ids of craftbooks suggested for the project type (tag intersection). */
    suggestedIds?: string[];
  }> {
    return this.request('GET', `/api/projects/${encodeURIComponent(projectId)}/craftbooks`);
  }

  getCatalogItem(
    kind: CatalogKind,
    id: string,
    opts?: { source?: string; version?: string },
  ): Promise<CatalogItemDetail> {
    const qs = new URLSearchParams();
    if (opts?.source) qs.set('source', opts.source);
    if (opts?.version) qs.set('version', opts.version);
    const tail = qs.toString() ? `?${qs.toString()}` : '';
    return this.request('GET', `/api/catalog/${kind}/${encodeURIComponent(id)}${tail}`);
  }

  listCatalogItemVersions(
    kind: CatalogKind,
    id: string,
    source?: string,
  ): Promise<{ versions: CatalogItemVersionInfo[] }> {
    const qs = source ? `?source=${encodeURIComponent(source)}` : '';
    return this.request('GET', `/api/catalog/${kind}/${encodeURIComponent(id)}/versions${qs}`);
  }

  /**
   * Fetch a catalog item's bundled file (logo, README, about.md) as a Blob,
   * given the server-composed path from `CatalogItemSummary.logoUrl`.
   *
   * Takes the whole path rather than (kind, id, rel, source) because the
   * service already built it — reassembling it here would duplicate
   * `logoUrlFor`'s escaping and drift from it.
   *
   * Exists because `/api/*` is bearer-gated and `<img src>` cannot send an
   * Authorization header: consumers fetch here and wrap the Blob in an
   * object URL. Do NOT "fix" this by admitting `?token=` on the catalog
   * file route — that would stamp the root credential across every logo
   * URL in the DOM. The SSE query-token exemption is one URL by design.
   */
  async fetchCatalogFile(path: string): Promise<Blob> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) throw new Error(`catalog file fetch failed: ${res.status}`);
    return res.blob();
  }

  createGezelFromTemplate(
    id: string,
    body: { name: string; version?: string; gender?: GezelGender },
  ): Promise<GezelResponse> {
    return this.request(
      'POST',
      `/api/catalog/gezel-template/${encodeURIComponent(id)}/install`,
      body,
    );
  }

  installToolset(
    id: string,
    body: {
      scope: ToolsetsScope;
      values?: Record<string, string>;
      secrets?: Record<string, string>;
      /** Pin to a specific catalog version. Omit for "install latest." */
      version?: string;
      /** Pin to an exact catalog source when provenance is security-relevant. */
      sourceId?: string;
    },
  ): Promise<{ ok: true; installed: InstalledToolset }> {
    return this.request('POST', `/api/catalog/toolset/${encodeURIComponent(id)}/install`, body);
  }

  importCustomMcpConfig(
    body: ImportCustomMcpConfigRequest,
  ): Promise<ImportCustomMcpConfigResponse> {
    return this.request('POST', '/api/catalog/custom-toolsets/import', body);
  }

  getToolsetConfig(id: string): Promise<{
    values: Record<string, string>;
    secretsPresent: Record<string, boolean>;
    secretMasks: Record<string, string>;
    missingRequired: string[];
    orphaned: { values: string[]; secrets: string[] };
  }> {
    return this.request('GET', `/api/toolset/${encodeURIComponent(id)}/config`);
  }

  updateToolsetConfig(
    id: string,
    patch: {
      values?: Record<string, string>;
      secrets?: Record<string, string | null>;
    },
  ): Promise<{ ok: true }> {
    return this.request('PUT', `/api/toolset/${encodeURIComponent(id)}/config`, patch);
  }

  uninstallToolset(id: string, scope: ToolsetsScope): Promise<{ ok: true }> {
    return this.request(
      'DELETE',
      `/api/catalog/toolset/${encodeURIComponent(id)}/install?${toolsetsQueryString(scope)}`,
    );
  }

  listInstalledToolsets(scope: ToolsetsScope): Promise<{
    toolsets: InstalledToolset[];
    roleDefault?: { role: string | null; groupIds: string[]; groupNames: string[] };
    discoveryWarnings?: Array<{ serverName?: string; message: string }>;
  }> {
    return this.request('GET', `/api/catalog/installed-toolsets?${toolsetsQueryString(scope)}`);
  }

  // ── Ollama-specific endpoints ──

  ollamaStatus(): Promise<
    | { ok: true; baseUrl: string; modelCount: number }
    | { ok: false; baseUrl: string; error: string }
  > {
    return this.request('GET', '/api/ollama/status');
  }

  ollamaProbe(): Promise<
    | {
        ok: true;
        baseUrl: string;
        elapsedMs: number;
        loaded: Array<{ name: string; sizeVram: number; expiresAt?: string }>;
      }
    | { ok: false; baseUrl: string; elapsedMs: number; error: string }
  > {
    return this.request('GET', '/api/ollama/probe');
  }

  ollamaDetect(): Promise<{
    installed: boolean;
    path?: string;
    installUrl: string;
  }> {
    return this.request('GET', '/api/ollama/detect');
  }

  ollamaStart(): Promise<{
    started: boolean;
    attempts: number;
    baseUrl: string;
    detection: { installed: boolean; path?: string; installUrl: string };
    error?: string;
  }> {
    return this.request('POST', '/api/ollama/start');
  }

  listPendingOllamaPulls(): Promise<{
    pulls: Array<{ name: string; startedAt: string }>;
  }> {
    return this.request('GET', '/api/ollama/pending-pulls');
  }

  clearPendingOllamaPull(name: string): Promise<{ ok: true }> {
    return this.request('DELETE', `/api/ollama/pending-pulls/${encodeURIComponent(name)}`);
  }

  getMemoryProfile(): Promise<{
    platform: string;
    totalRamBytes: number;
    gpuVramBytes: number | null;
    gpuMemoryKind?: 'discrete' | 'integrated' | 'unified' | 'none' | 'unknown';
    source:
      | 'darwin-unified'
      | 'gpu-nvidia'
      | 'gpu-vulkan'
      | 'gpu-integrated'
      | 'system-ram-fallback';
    /** Fast memory: VRAM on a discrete card, a RAM fraction otherwise. */
    usableBytes: number;
    /**
     * What the capacity broker will admit, summed across every pool a
     * resident engine can use — VRAM PLUS a system-RAM share on a discrete
     * card. Optional: daemons that predate the field omit it.
     */
    budgetBytes?: number;
    gpuVendor?: 'amd' | 'nvidia' | 'intel';
  }> {
    return this.request('GET', '/api/system/memory');
  }

  getMachineMemoryUsage(): Promise<MachineMemoryUsage> {
    return this.request('GET', '/api/system/memory/usage');
  }

  checkModelDownloadSpace(
    body: ModelDownloadPreflightRequest,
  ): Promise<ModelDownloadPreflightResponse> {
    return this.request('POST', '/api/system/model-download-preflight', body);
  }

  /**
   * Shareable machine profile for a bug report. Contains no paths, usernames,
   * hostnames, or user content — see `SystemDiagnosticsSchema`.
   */
  getSystemDiagnostics(signal?: AbortSignal): Promise<SystemDiagnostics> {
    return this.request('GET', '/api/system/diagnostics', undefined, undefined, signal);
  }

  /**
   * Identity card for the connected daemon: which home it serves, whether
   * that home has ever actually been used, and what is resident right now.
   * The Electron supervisor consults this before committing to a
   * machine-service adoption; it is also the only window into a machine
   * daemon whose home directories are ACL-private to the service identity.
   */
  getSystemHomeInfo(signal?: AbortSignal): Promise<SystemHomeInfo> {
    return this.request('GET', '/api/system/home', undefined, undefined, signal);
  }

  deleteOllamaModel(name: string): Promise<{ ok: true }> {
    return this.request('DELETE', `/api/ollama/models/${encodeURIComponent(name)}`);
  }

  // ── llama.cpp local model management ──

  listLlamaCppModels(): Promise<{ models: LlamaCppInstalledModel[] }> {
    return this.request('GET', '/api/llama-cpp/models');
  }

  /** Incomplete (interrupted/unverified) llama.cpp downloads on disk. */
  listIncompleteLlamaCppModels(): Promise<{ incomplete: IncompleteModelDownload[] }> {
    return this.request('GET', '/api/llama-cpp/incomplete');
  }

  // ── portable `.gezmodel` bundles ──

  /** Fetch a streaming model export response. Callers must consume the body. */
  async exportModelBundle(engine: GezmodelEngine, id: string): Promise<Response> {
    const url = `${this.baseUrl}/api/model-bundles/${encodeURIComponent(engine)}/${encodeURIComponent(id)}/export`;
    const res = await this.fetchImpl(url, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`model export failed (${res.status}): ${body}`);
    }
    return res;
  }

  /** Upload + fully scan a bundle. This stages bytes but does not install. */
  async scanModelBundle(
    data: Blob | ArrayBuffer | Uint8Array | ReadableStream<Uint8Array>,
  ): Promise<GezmodelImportReview> {
    const body =
      data instanceof Blob || data instanceof ReadableStream
        ? data
        : data instanceof Uint8Array
          ? data
          : new Uint8Array(data);
    const streaming = body instanceof ReadableStream;
    const res = await this.fetchImpl(`${this.baseUrl}/api/model-bundles/imports/scan`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/vnd.gezel.model+zip',
      },
      body: body as never,
      ...(streaming ? ({ duplex: 'half' } as RequestInit & { duplex: 'half' }) : {}),
    });
    if (!res.ok) {
      const payload = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(payload?.error ?? `model bundle scan failed (${res.status})`);
    }
    return res.json() as Promise<GezmodelImportReview>;
  }

  confirmModelBundleImport(
    importId: string,
    replace = false,
  ): Promise<{ ok: true; engine: GezmodelEngine; id: string }> {
    return this.request('POST', '/api/model-bundles/imports/confirm', { importId, replace });
  }

  cancelModelBundleImport(importId: string): Promise<{ ok: true }> {
    return this.request('DELETE', `/api/model-bundles/imports/${encodeURIComponent(importId)}`);
  }

  // ── private → shared model migration ──

  /** Current, complete per-user models eligible for the machine shared store. */
  listSharedModelMigrationCandidates(
    engine?: GezmodelEngine,
  ): Promise<SharedModelMigrationCandidatesResponse> {
    const query = engine ? `?engine=${encodeURIComponent(engine)}` : '';
    return this.request('GET', `/api/model-migrations/candidates${query}`);
  }

  /** Safely copy, broker-verify, publish, then remove one per-user model. */
  moveModelToShared(request: SharedModelMigrationRequest): Promise<SharedModelMigrationResult> {
    return this.request('POST', '/api/model-migrations/move', request);
  }

  // ── model fitness (the proeve) ──

  listModelFitness(): Promise<{ records: ModelFitnessEntry[]; probing: string[] }> {
    return this.request('GET', '/api/model-fitness');
  }

  /** Queue a manual fitness probe. 202 on accept; 404 when not installed. */
  runModelFitnessProbe(
    provider: 'llama-cpp' | 'ds4' | 'mlx',
    modelId: string,
  ): Promise<{ started: true }> {
    return this.request(
      'POST',
      `/api/model-fitness/${encodeURIComponent(provider)}/${encodeURIComponent(modelId)}/probe`,
    );
  }

  // ── ds4 (DeepSeek-V4) local model management — same shape as llama.cpp ──

  listDs4Models(): Promise<{ models: LlamaCppInstalledModel[] }> {
    return this.request('GET', '/api/ds4/models');
  }

  /** Incomplete (interrupted/unverified) ds4 downloads on disk. */
  listIncompleteDs4Models(): Promise<{ incomplete: IncompleteModelDownload[] }> {
    return this.request('GET', '/api/ds4/incomplete');
  }

  listDs4ActiveInstalls(): Promise<{ installs: LocalActiveInstall[] }> {
    return this.request('GET', '/api/ds4/active-installs');
  }

  deleteDs4Model(id: string): Promise<{ ok: true }> {
    return this.request('DELETE', `/api/ds4/models/${encodeURIComponent(id)}`);
  }

  /** Tail the supervised ds4-server's persistent stdout/stderr log. */
  getDs4Log(bytes?: number): Promise<{ path: string | null; tail: string }> {
    const q = typeof bytes === 'number' ? `?bytes=${bytes}` : '';
    return this.request('GET', `/api/ds4/log${q}`);
  }

  /**
   * Tail the supervised llama-server's rolling log file. Returns
   * `{ path, tail }`: `path` is the absolute path of the current
   * log file (null when no supervised engine exists — external
   * baseUrl mode or the provider has never started); `tail` is the
   * trailing window. `bytes` caps the window, default 4096, max
   * 65536 (service-side clamp).
   */
  getLlamaCppLog(bytes?: number): Promise<{ path: string | null; tail: string }> {
    const q = typeof bytes === 'number' ? `?bytes=${bytes}` : '';
    return this.request('GET', `/api/llama-cpp/log${q}`);
  }

  /**
   * Install a chat-model entry's llama.cpp source and stream the
   * progress events to `onEvent`. Resolves when the stream closes
   * (either `done` or `error`); rejects on HTTP error or if the
   * caller aborts the signal.
   *
   * Mirrors {@link pullOllamaModel} — bearer auth + SSE parsing
   * happen here so UI code doesn't need to reach for the raw
   * token.
   */
  async installLlamaCppModel(
    catalogId: string,
    onEvent: (event: LlamaCppInstallEvent) => void,
    signal?: AbortSignal,
    options?: { skipSha?: boolean },
  ): Promise<void> {
    return this.installGgufSse('llama-cpp', catalogId, onEvent, signal, options);
  }

  /**
   * Install a DeepSeek-V4 GGUF via the ds4 engine. Same SSE contract as
   * {@link installLlamaCppModel} (ds4 reuses the GGUF downloader); only the
   * route differs — this drives the model picker's "install DeepSeek V4" flow.
   */
  async installDs4Model(
    catalogId: string,
    onEvent: (event: LlamaCppInstallEvent) => void,
    signal?: AbortSignal,
    options?: { skipSha?: boolean },
  ): Promise<void> {
    return this.installGgufSse('ds4', catalogId, onEvent, signal, options);
  }

  /** Shared GGUF-install SSE driver for the llama-cpp + ds4 engines (identical event shape). */
  private async installGgufSse(
    enginePath: 'llama-cpp' | 'ds4',
    catalogId: string,
    onEvent: (event: LlamaCppInstallEvent) => void,
    signal?: AbortSignal,
    options?: { skipSha?: boolean },
  ): Promise<void> {
    const qs = options?.skipSha ? '?skipSha=1' : '';
    const url = `${this.baseUrl}/api/${enginePath}/models/${encodeURIComponent(catalogId)}/install${qs}`;
    await consumeApiSseJson({
      ...MODEL_DOWNLOAD_SSE_POLICY,
      url,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
      },
      signal,
      fetch: this.fetchImpl,
      schema: LlamaCppInstallEventSchema,
      onEvent,
      isTerminal: (event) => event.type === 'done' || event.type === 'error',
      label: `Install stream for "${catalogId}"`,
    });
  }

  deleteLlamaCppModel(id: string): Promise<{ ok: true }> {
    return this.request('DELETE', `/api/llama-cpp/models/${encodeURIComponent(id)}`);
  }

  /**
   * Cancel an in-flight llama-cpp model install. Installs run as background
   * jobs on the service — closing the SSE consumer no longer aborts them, so
   * this is the only way to stop one. `.partial` files stay on disk as
   * resume credit for a retried install.
   */
  cancelLlamaCppModelInstall(catalogId: string): Promise<{ aborted: boolean }> {
    return this.request('DELETE', `/api/llama-cpp/models/${encodeURIComponent(catalogId)}/install`);
  }

  /** Cancel an in-flight ds4 model install. Same contract as {@link cancelLlamaCppModelInstall}. */
  cancelDs4ModelInstall(catalogId: string): Promise<{ aborted: boolean }> {
    return this.request('DELETE', `/api/ds4/models/${encodeURIComponent(catalogId)}/install`);
  }

  // ── Evals (in-app Benchmarks panel) ──

  listEvalScenarios(): Promise<{ scenarios: readonly EvalScenarioManifest[] }> {
    return this.request('GET', '/api/eval/scenarios');
  }

  getEvalAvailability(): Promise<{ available: boolean; reason: string | null }> {
    return this.request('GET', '/api/eval/availability');
  }

  listEvalResults(filter?: {
    scenarioId?: string;
    limit?: number;
  }): Promise<{ results: TrialOutcome[] }> {
    const qs = new URLSearchParams();
    if (filter?.scenarioId) qs.set('scenario', filter.scenarioId);
    if (filter?.limit != null) qs.set('limit', String(filter.limit));
    const path = qs.toString() ? `/api/eval/results?${qs.toString()}` : '/api/eval/results';
    return this.request('GET', path);
  }

  /**
   * Run an eval trial end-to-end. SSE-streams progress events; resolves
   * when the child harness exits. The `done` event carries the final
   * outcome; `error` events surface harness-side failures. UI consumers
   * should keep the listener attached until they see `done` or `error`.
   */
  async runEval(
    body: {
      scenarioId: string;
      modelId: string;
      imageModelId?: string;
      timeoutMs?: number;
    },
    onEvent: (event: RunEvalEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    await consumeApiSseJson({
      url: `${this.baseUrl}/api/eval/run`,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal,
      fetch: this.fetchImpl,
      schema: RunEvalEventSchema,
      onEvent,
      isTerminal: (event) => event.type === 'done' || event.type === 'error',
      label: 'Eval stream',
    });
  }

  /**
   * Polled snapshot of llama.cpp installs in flight. Used by the
   * Settings catalog UI to surface background installs (notably the
   * first-run bootstrap one) that didn't originate from a click in
   * this UI session.
   */
  listLlamaCppActiveInstalls(): Promise<{ installs: LocalActiveInstall[] }> {
    return this.request('GET', '/api/llama-cpp/active-installs');
  }

  // ── MLX local model management (Apple Silicon only) ──

  listMlxModels(): Promise<{ models: MlxInstalledModel[] }> {
    return this.request('GET', '/api/mlx/models');
  }

  /** Incomplete (interrupted/unverified) MLX downloads on disk. */
  listIncompleteMlxModels(): Promise<{ incomplete: IncompleteModelDownload[] }> {
    return this.request('GET', '/api/mlx/incomplete');
  }

  /**
   * Install an MLX model from the catalog, streaming progress events
   * to `onEvent`. Same shape as `installLlamaCppModel`; MLX events
   * additionally carry `fileIndex` / `fileCount` so the UI can render
   * per-file progress inside the overall install.
   */
  async installMlxModel(
    catalogId: string,
    onEvent: (event: MlxInstallEvent) => void,
    signal?: AbortSignal,
    options?: { skipSha?: boolean },
  ): Promise<void> {
    const qs = options?.skipSha ? '?skipSha=1' : '';
    const url = `${this.baseUrl}/api/mlx/models/${encodeURIComponent(catalogId)}/install${qs}`;
    await consumeApiSseJson({
      ...MODEL_DOWNLOAD_SSE_POLICY,
      url,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
      },
      signal,
      fetch: this.fetchImpl,
      schema: MlxInstallEventSchema,
      onEvent,
      isTerminal: (event) => event.type === 'done' || event.type === 'error',
      label: `Install stream for "${catalogId}"`,
    });
  }

  deleteMlxModel(id: string): Promise<{ ok: true }> {
    return this.request('DELETE', `/api/mlx/models/${encodeURIComponent(id)}`);
  }

  /** Cancel an in-flight MLX model install. Same contract as {@link cancelLlamaCppModelInstall}. */
  cancelMlxModelInstall(catalogId: string): Promise<{ aborted: boolean }> {
    return this.request('DELETE', `/api/mlx/models/${encodeURIComponent(catalogId)}/install`);
  }

  /**
   * Polled snapshot of MLX installs in flight. Same role as
   * {@link listLlamaCppActiveInstalls} on the Apple Silicon side.
   */
  listMlxActiveInstalls(): Promise<{ installs: LocalActiveInstall[] }> {
    return this.request('GET', '/api/mlx/active-installs');
  }

  /** Describe the resolved Python runtime powering MLX. */
  getMlxRuntime(): Promise<MlxRuntimeInfo> {
    return this.request('GET', '/api/mlx/runtime');
  }

  /** Delete and recreate the MLX venv on the next chat turn. */
  resetMlxRuntime(): Promise<{ ok: true }> {
    return this.request('POST', '/api/mlx/runtime/reset');
  }

  // ── Multi-engine pool (Settings → Local Models) ──

  /** Live pool snapshot for the engines budget bar. */
  getEngineStatus(): Promise<EngineStatusResponse> {
    return this.request('GET', '/api/engines/status');
  }

  /** Source-pinned native release and executable availability in the daemon. */
  getNativeEngineStatus(): Promise<NativeEngineStatusResponse> {
    return this.request('GET', '/api/engines/binaries/status');
  }

  /**
   * Download, verify, extract, and activate one native executable. The
   * server-owned job survives an SSE listener disconnect; this call resolves
   * on the terminal `done` or `error` event.
   */
  async ensureNativeEngine(
    engine: NativeEngineName,
    onEvent: (event: NativeEngineResolveEvent) => void,
    variant?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const query = variant ? `?variant=${encodeURIComponent(variant)}` : '';
    await consumeApiSseJson({
      ...MODEL_DOWNLOAD_SSE_POLICY,
      url: `${this.baseUrl}/api/engines/binaries/${encodeURIComponent(engine)}/ensure${query}`,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
      },
      signal,
      fetch: this.fetchImpl,
      schema: NativeEngineResolveEventSchema,
      onEvent,
      isTerminal: (event) => event.type === 'done' || event.type === 'error',
      label: `Native engine install stream for "${engine}"`,
    });
  }

  /**
   * Apply a new clone-count target to a local provider. The capacity
   * broker is the final arbiter — values that exceed budget are
   * silently capped; the returned snapshot reflects what loaded.
   */
  reconcileEnginePool(body: ReconcileEnginePoolRequest): Promise<{
    ok: true;
    status: EngineStatusResponse;
  }> {
    return this.request('POST', '/api/engines/reconcile', body);
  }

  // ── Image generation (stable-diffusion.cpp sidecar or mock) ──

  generateImage(body: ImageGenerationRequest): Promise<ImageGenerationResponse> {
    return this.request('POST', '/api/image-gen/generate', body);
  }

  listInstalledImageModels(): Promise<ListInstalledImageModelsResponse> {
    return this.request('GET', '/api/image-gen/models');
  }

  /**
   * Combined engine-readiness probe + installed model count. Used by
   * Settings → Image generation to render an honest "Ready" pill (engine
   * is reachable AND ≥1 model installed) instead of declaring readiness
   * just because a model file exists on disk.
   */
  getImageEngineStatus(): Promise<ImageEngineStatusResponse> {
    return this.request('GET', '/api/image-gen/engine-status');
  }

  deleteImageModel(id: string): Promise<{ ok: true }> {
    return this.request('DELETE', `/api/image-gen/models/${encodeURIComponent(id)}`);
  }

  /**
   * Start (or attach to) the pull of a catalog image-model, invoking
   * `onEvent` for each progress chunk. The actual download is owned by
   * a server-side registry that survives the HTTP request — aborting
   * `signal` only detaches this SSE listener; use
   * {@link cancelImagePull} to actually stop the download.
   */
  async pullImageModel(
    id: string,
    onEvent: (event: ImageModelPullEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.consumeImagePullSse(
      `${this.baseUrl}/api/image-gen/models/${encodeURIComponent(id)}/pull`,
      'POST',
      onEvent,
      signal,
    );
  }

  /**
   * Snapshot of every in-flight (or just-finished) image-model pull on
   * the service. The UI calls this on mount so a returning user sees
   * progress for a pull that started in a previous mount of the
   * Settings page.
   */
  listActiveImagePulls(): Promise<ListActiveImagePullsResponse> {
    return this.request('GET', '/api/image-gen/pulls');
  }

  /**
   * Subscribe to live events for an in-progress pull without starting
   * one. Pairs with {@link listActiveImagePulls}: list the active
   * pulls on mount, then subscribe to each. The server replays the
   * latest snapshot on subscribe so the bar renders immediately.
   * Throws (404) when no pull is active for `id`.
   */
  subscribeImagePull(
    id: string,
    onEvent: (event: ImageModelPullEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.consumeImagePullSse(
      `${this.baseUrl}/api/image-gen/pulls/${encodeURIComponent(id)}/events`,
      'GET',
      onEvent,
      signal,
    );
  }

  /**
   * Explicitly cancel an in-flight pull. Disconnect alone is NOT
   * sufficient — the registry keeps the download running so other
   * subscribers (or a returning client) still see progress. Returns
   * `aborted: false` when nothing was in flight for that id.
   */
  cancelImagePull(id: string): Promise<{ aborted: boolean }> {
    return this.request('DELETE', `/api/image-gen/pulls/${encodeURIComponent(id)}`);
  }

  private async consumeImagePullSse(
    url: string,
    method: 'GET' | 'POST',
    onEvent: (event: ImageModelPullEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    await consumeApiSseJson({
      ...MODEL_DOWNLOAD_SSE_POLICY,
      url,
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
      },
      signal,
      fetch: this.fetchImpl,
      schema: ImageModelPullEventSchema,
      onEvent,
      isTerminal: (event) => event.type === 'done' || event.type === 'error',
      label: 'Image model pull stream',
    });
  }

  // ── Video generation (bundled diffusers / LTX sidecar or mock) ──

  generateVideo(body: VideoGenerationRequest): Promise<VideoGenerationResponse> {
    return this.request('POST', '/api/video-gen/generate', body);
  }

  listInstalledVideoModels(): Promise<ListInstalledVideoModelsResponse> {
    return this.request('GET', '/api/video-gen/models');
  }

  /**
   * Combined engine-readiness probe + installed model count. The
   * response's `engine.accelerator` lets Settings → Video generation warn
   * when generation will fall back to the (very slow) CPU path.
   */
  getVideoEngineStatus(): Promise<VideoEngineStatusResponse> {
    return this.request('GET', '/api/video-gen/engine-status');
  }

  deleteVideoModel(id: string): Promise<{ ok: true }> {
    return this.request('DELETE', `/api/video-gen/models/${encodeURIComponent(id)}`);
  }

  /**
   * Start (or attach to) the pull of a catalog video-model, invoking
   * `onEvent` for each progress chunk. The download is owned by a
   * server-side registry that survives the HTTP request — aborting
   * `signal` only detaches this SSE listener; use {@link cancelVideoPull}
   * to actually stop it.
   */
  async pullVideoModel(
    id: string,
    onEvent: (event: VideoModelPullEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.consumeVideoPullSse(
      `${this.baseUrl}/api/video-gen/models/${encodeURIComponent(id)}/pull`,
      'POST',
      onEvent,
      signal,
    );
  }

  listActiveVideoPulls(): Promise<ListActiveVideoPullsResponse> {
    return this.request('GET', '/api/video-gen/pulls');
  }

  subscribeVideoPull(
    id: string,
    onEvent: (event: VideoModelPullEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.consumeVideoPullSse(
      `${this.baseUrl}/api/video-gen/pulls/${encodeURIComponent(id)}/events`,
      'GET',
      onEvent,
      signal,
    );
  }

  cancelVideoPull(id: string): Promise<{ aborted: boolean }> {
    return this.request('DELETE', `/api/video-gen/pulls/${encodeURIComponent(id)}`);
  }

  private async consumeVideoPullSse(
    url: string,
    method: 'GET' | 'POST',
    onEvent: (event: VideoModelPullEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    await consumeApiSseJson({
      ...MODEL_DOWNLOAD_SSE_POLICY,
      url,
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
      },
      signal,
      fetch: this.fetchImpl,
      schema: VideoModelPullEventSchema,
      onEvent,
      isTerminal: (event) => event.type === 'done' || event.type === 'error',
      label: 'Video model pull stream',
    });
  }

  // ── Audio (whisper.cpp STT + Kokoro TTS) ──

  transcribeAudio(body: AudioTranscribeRequest): Promise<AudioTranscribeResponse> {
    return this.request('POST', '/api/audio/transcribe', body);
  }

  synthesizeSpeech(
    body: AudioSynthesizeRequest & { signal?: AbortSignal },
  ): Promise<AudioSynthesizeResponse> {
    const { signal, ...payload } = body;
    return this.request('POST', '/api/audio/synthesize', payload, undefined, signal);
  }

  /**
   * Combined STT + TTS engine readiness. Settings → Audio renders one
   * status pill per engine from this single round-trip.
   */
  getAudioEngineStatus(): Promise<AudioEngineStatusResponse> {
    return this.request('GET', '/api/audio/engine-status');
  }

  /** What's available to pull (split into stt/tts). */
  listAudioCatalog(): Promise<ListAudioCatalogResponse> {
    return this.request('GET', '/api/audio/catalog');
  }

  listInstalledSttModels(): Promise<ListInstalledAudioModelsResponse> {
    return this.request('GET', '/api/audio/stt/models');
  }

  listInstalledTtsModels(): Promise<ListInstalledAudioModelsResponse> {
    return this.request('GET', '/api/audio/tts/models');
  }

  deleteSttModel(id: string): Promise<{ ok: true }> {
    return this.request('DELETE', `/api/audio/stt/models/${encodeURIComponent(id)}`);
  }

  deleteTtsModel(id: string): Promise<{ ok: true }> {
    return this.request('DELETE', `/api/audio/tts/models/${encodeURIComponent(id)}`);
  }

  listAudioVoices(): Promise<ListAudioVoicesResponse> {
    return this.request('GET', '/api/audio/voices');
  }

  /**
   * Pull an audio model (STT or TTS), invoking `onEvent` for each
   * progress chunk. Same SSE shape as `pullImageModel`.
   */
  async pullAudioModel(
    kind: 'stt' | 'tts',
    id: string,
    onEvent: (event: AudioModelPullEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    await consumeApiSseJson({
      ...MODEL_DOWNLOAD_SSE_POLICY,
      url: `${this.baseUrl}/api/audio/${kind}/models/${encodeURIComponent(id)}/pull`,
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}` },
      signal,
      fetch: this.fetchImpl,
      schema: AudioModelPullEventSchema,
      onEvent,
      isTerminal: (event) => event.type === 'done' || event.type === 'error',
      label: 'Audio model pull stream',
    });
  }

  /** Image-recognition readiness. Never spawns the engine. */
  getRecognitionHealth(): Promise<RecognitionHealth> {
    return this.request('GET', '/api/recognition/health');
  }

  listRecognitionCatalog(): Promise<ListRecognitionCatalogResponse> {
    return this.request('GET', '/api/recognition/catalog');
  }

  listInstalledRecognitionModels(): Promise<ListInstalledRecognitionModelsResponse> {
    return this.request('GET', '/api/recognition/models');
  }

  deleteRecognitionModel(id: string): Promise<{ ok: true }> {
    return this.request('DELETE', `/api/recognition/models/${encodeURIComponent(id)}`);
  }

  clearRecognitionCache(): Promise<{ ok: true }> {
    return this.request('POST', '/api/recognition/cache/clear');
  }

  /** Describe / OCR / extract from one image. */
  describeImage(
    body: RecognitionRequest,
    opts?: { projectId?: string },
  ): Promise<ImageRecognition> {
    const qs = opts?.projectId ? `?project=${encodeURIComponent(opts.projectId)}` : '';
    return this.request('POST', `/api/recognition/describe${qs}`, body);
  }

  /**
   * Deterministic image file metadata — no model runs. `includeLocation`
   * surfaces GPS coordinates, which every other path withholds.
   */
  readImageMetadata(
    body: RecognitionRequest & { includeLocation?: boolean },
    opts?: { projectId?: string },
  ): Promise<ImageStaticMeta> {
    const qs = opts?.projectId ? `?project=${encodeURIComponent(opts.projectId)}` : '';
    return this.request('POST', `/api/recognition/metadata${qs}`, body);
  }

  /** Pull a vision model. Same SSE shape as `pullAudioModel`. */
  async pullRecognitionModel(
    id: string,
    onEvent: (event: RecognitionPullEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    await consumeApiSseJson({
      ...MODEL_DOWNLOAD_SSE_POLICY,
      url: `${this.baseUrl}/api/recognition/models/${encodeURIComponent(id)}/pull`,
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}` },
      signal,
      fetch: this.fetchImpl,
      schema: RecognitionPullEventSchema,
      onEvent,
      isTerminal: (event) => event.type === 'done' || event.type === 'error',
      label: 'Recognition model pull stream',
    });
  }

  /**
   * Pull an Ollama model, invoking `onEvent` for each progress chunk from
   * the server. Resolves when the stream closes. Pass an AbortSignal to
   * cancel the pull — the browser drops the HTTP connection but Ollama's
   * own pull continues server-side (it's robust to re-attachment via
   * re-issuing the pull).
   */
  async pullOllamaModel(
    name: string,
    onEvent: (event: OllamaPullEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    await consumeApiSseJson({
      ...MODEL_DOWNLOAD_SSE_POLICY,
      url: `${this.baseUrl}/api/ollama/pull`,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name }),
      signal,
      fetch: this.fetchImpl,
      schema: OllamaPullEventSchema,
      onEvent,
      isTerminal: (event) => event.type === 'done',
      label: 'Ollama pull stream',
    });
  }

  listGezels(): Promise<ListGezelsResponse> {
    return this.request('GET', '/api/gezels');
  }

  createGezel(body: CreateGezelRequest): Promise<GezelResponse> {
    return this.request('POST', '/api/gezels', body);
  }

  /**
   * Restore every template-derived gezel's about.md to its catalog
   * default, discarding local edits. Returns the ids reset vs. skipped
   * (bespoke / fixed-function / unresolved template).
   */
  resetGezelTemplates(): Promise<{ reset: string[]; skipped: string[] }> {
    return this.request('POST', '/api/gezels/reset-templates');
  }

  getGezel(id: string): Promise<GezelResponse> {
    return this.request('GET', `/api/gezels/${encodeURIComponent(id)}`);
  }

  deleteGezel(id: string): Promise<{ ok: true; id: string; name: string }> {
    return this.request('DELETE', `/api/gezels/${encodeURIComponent(id)}`);
  }

  renameGezel(id: string, body: RenameGezelRequest): Promise<GezelResponse> {
    return this.request('POST', `/api/gezels/${encodeURIComponent(id)}/rename`, body);
  }

  updateGezelSettings(id: string, body: UpdateGezelSettingsRequest): Promise<GezelResponse> {
    return this.request('POST', `/api/gezels/${encodeURIComponent(id)}/settings`, body);
  }

  updateGezelMarkdown(id: string, body: UpdateGezelMarkdownRequest): Promise<GezelResponse> {
    return this.request('PUT', `/api/gezels/${encodeURIComponent(id)}/md`, body);
  }

  /** Character sheet: growth state + active traits + drift detection. */
  getGezelGrowth(id: string): Promise<GezelGrowthResponse> {
    return this.request('GET', `/api/gezels/${encodeURIComponent(id)}/growth`);
  }

  /** User-initiated XP/proposal recompute (may call the Klerk; slow). */
  refreshGezelGrowth(id: string): Promise<GezelGrowthResponse> {
    return this.request('POST', `/api/gezels/${encodeURIComponent(id)}/growth/refresh`);
  }

  /** Resolve a pending level-up by accepting one proposal. */
  acceptGrowthProposal(id: string, proposalId: string): Promise<GezelGrowthResponse> {
    return this.request('POST', `/api/gezels/${encodeURIComponent(id)}/growth/accept`, {
      proposalId,
    });
  }

  /**
   * Decline one proposal (keeps the level-up pending), or — with no
   * proposalId — skip the whole level.
   */
  declineGrowthLevelUp(id: string, proposalId?: string): Promise<GezelGrowthResponse> {
    return this.request(
      'POST',
      `/api/gezels/${encodeURIComponent(id)}/growth/decline`,
      proposalId ? { proposalId } : {},
    );
  }

  /** Retire an adopted trait (removes it from frontmatter; audit kept). */
  retireGrowthTrait(id: string, traitId: string): Promise<GezelGrowthResponse> {
    return this.request(
      'DELETE',
      `/api/gezels/${encodeURIComponent(id)}/growth/traits/${encodeURIComponent(traitId)}`,
    );
  }

  updateGezelAbout(id: string, body: UpdateGezelAboutRequest): Promise<GezelResponse> {
    return this.request('PUT', `/api/gezels/${encodeURIComponent(id)}/about`, body);
  }

  /**
   * Replace the `defaults` map on a fixed-function gezel's frontmatter
   * (e.g. width/height/model on an `image-generator` gezel). Pass
   * `null` to clear all defaults. Throws when the gezel isn't
   * fixed-function.
   */
  updateGezelFixedFunctionDefaults(
    id: string,
    body: UpdateGezelFixedFunctionDefaultsRequest,
  ): Promise<GezelResponse> {
    return this.request(
      'PUT',
      `/api/gezels/${encodeURIComponent(id)}/fixed-function-defaults`,
      body,
    );
  }

  generateGezelAbout(id: string, body: GenerateGezelAboutRequest = {}): Promise<GezelResponse> {
    return this.request('POST', `/api/gezels/${encodeURIComponent(id)}/about/generate`, body);
  }

  generateGezelIcon(id: string, body: GenerateGezelIconRequest = {}): Promise<GezelResponse> {
    return this.request('POST', `/api/gezels/${encodeURIComponent(id)}/icon/generate`, body);
  }

  updateGezelIcon(id: string, body: UpdateGezelIconRequest): Promise<GezelResponse> {
    return this.request('PUT', `/api/gezels/${encodeURIComponent(id)}/icon`, body);
  }

  listGezelIconHistory(id: string): Promise<GezelIconHistoryResponse> {
    return this.request('GET', `/api/gezels/${encodeURIComponent(id)}/icons`);
  }

  revertGezelIcon(id: string, body: RevertGezelIconRequest): Promise<GezelResponse> {
    return this.request('POST', `/api/gezels/${encodeURIComponent(id)}/icon/revert`, body);
  }

  /** Read the gezel's persisted poppetje. Auto-generates on first read. */
  getGezelPoppetje(id: string): Promise<{ poppetje: Poppetje }> {
    return this.request('GET', `/api/gezels/${encodeURIComponent(id)}/poppetje`);
  }

  /** Replace the gezel's poppetje wholesale (used by future per-slot pickers). */
  setGezelPoppetje(id: string, body: UpdateGezelPoppetjeRequest): Promise<{ poppetje: Poppetje }> {
    return this.request('PUT', `/api/gezels/${encodeURIComponent(id)}/poppetje`, body);
  }

  /** Draw a fresh integer seed and return the new struct. */
  rerollGezelPoppetje(
    id: string,
    body: RerollGezelPoppetjeRequest = {},
  ): Promise<{ poppetje: Poppetje }> {
    return this.request('POST', `/api/gezels/${encodeURIComponent(id)}/poppetje/reroll`, body);
  }

  messageGezel(toIdOrName: string, body: MessageGezelRequest): Promise<MessageGezelResponse> {
    return this.request('POST', `/api/gezels/${encodeURIComponent(toIdOrName)}/message`, body);
  }

  /**
   * Synchronous gezel-to-gezel consultation (sibling of `messageGezel`).
   * The HTTP request blocks server-side until the target replies, hits
   * a timeout, or fails for a structured reason — returning an
   * `outcome: 'reply' | 'error'` envelope with the relevant payload.
   * Used by the `ask_gezel` MCP tool from the gezel-mcp subprocess.
   */
  askGezel(body: RequestAskRequest): Promise<RequestAskResponse> {
    return this.request('POST', '/api/asks/request-and-wait', body);
  }

  /**
   * Resolve a role to a concrete gezel — reusing an existing one when
   * the roster has a fit, otherwise creating from a gilde template or
   * writing a bespoke about. Single-call replacement for the
   * list→check→create sequence.
   */
  ensureGezel(body: EnsureGezelRequest): Promise<EnsureGezelResponse> {
    return this.request('POST', '/api/gezels/ensure', body);
  }

  /**
   * @deprecated Blocking rewrite path. New callers use
   * {@link transformTextStream}, which adds insert mode and live
   * thinking/output deltas. Kept for published-client compatibility.
   */
  rewriteText(body: RewriteTextRequest): Promise<RewriteTextResponse> {
    return this.request('POST', '/api/ai/rewrite', body);
  }

  /**
   * Streaming transform behind the editor's transformation dialog.
   * SSE events surface queue status, Klerk thinking metacommentary,
   * and a live output preview; the terminal `done` event's `text` is
   * the authoritative result. Resolves after `done` or `error`.
   */
  async transformTextStream(
    body: TransformTextRequest,
    onEvent: (event: TransformStreamEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    await consumeApiSseJson({
      url: `${this.baseUrl}/api/ai/transform`,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal,
      fetch: this.fetchImpl,
      schema: TransformStreamEventSchema,
      onEvent,
      isTerminal: (event) => event.type === 'done' || event.type === 'error',
      label: 'Transform stream',
    });
  }

  // ── Chat sessions (preferred) ──

  listChatSessions(filter?: {
    gezelId?: string;
    projectId?: string;
  }): Promise<ListChatSessionsResponse> {
    const params = new URLSearchParams();
    if (filter?.gezelId) params.set('gezel', filter.gezelId);
    if (filter?.projectId) params.set('project', filter.projectId);
    const qs = params.toString() ? `?${params.toString()}` : '';
    return this.request('GET', `/api/sessions${qs}`);
  }

  createChatSession(body: CreateChatSessionRequest): Promise<ChatSession> {
    return this.request('POST', '/api/sessions', body);
  }

  getChatSession(sessionId: string): Promise<ChatSession> {
    return this.request('GET', `/api/sessions/${encodeURIComponent(sessionId)}`);
  }

  /**
   * Snapshot of the freshly-computed system prompt + the metadata that
   * drove how it was built + the recent message thread. Used by the
   * UI's debug-mode "copy debug bundle" button. `atTimestamp` (the
   * `at` ISO string from `ChatMessage`), when supplied, slices the
   * message window so the bundle reflects the state at the time of a
   * specific assistant turn.
   */
  getChatSessionDebug(
    sessionId: string,
    opts?: { atTimestamp?: string; limit?: number },
  ): Promise<SessionDebugSnapshot> {
    const params = new URLSearchParams();
    if (opts?.atTimestamp) params.set('at', opts.atTimestamp);
    if (opts?.limit) params.set('limit', String(opts.limit));
    const qs = params.toString() ? `?${params.toString()}` : '';
    return this.request('GET', `/api/sessions/${encodeURIComponent(sessionId)}/debug${qs}`);
  }

  sendToChatSession(
    sessionId: string,
    body:
      | string
      | { message: string; mentions?: string[]; passiveCcGezelIds?: string[]; nudge?: boolean },
  ): Promise<{ accepted: true; sessionId: string }> {
    const payload = typeof body === 'string' ? { message: body } : body;
    return this.request('POST', `/api/sessions/${encodeURIComponent(sessionId)}/send`, payload);
  }

  /**
   * List the MCP tools available in a session's context — the same merged
   * toolset the model sees for this gezel. Backs the TUI "CLI mode" tool
   * picker.
   */
  listSessionTools(sessionId: string): Promise<ListSessionToolsResponse> {
    return this.request('GET', `/api/sessions/${encodeURIComponent(sessionId)}/tools`);
  }

  /**
   * List the project-wide MCP tools the terminal can run — the full,
   * NOT role-filtered surface. Powers the terminal's tool autocomplete.
   */
  listProjectTools(projectId: string): Promise<ListSessionToolsResponse> {
    return this.request('GET', `/api/projects/${encodeURIComponent(projectId)}/tools`);
  }

  /** Workspace file/dir paths matching a prefix — backs terminal path autocomplete. */
  searchProjectFiles(projectId: string, prefix: string): Promise<{ paths: string[] }> {
    const qs = prefix ? `?prefix=${encodeURIComponent(prefix)}` : '';
    return this.request('GET', `/api/projects/${encodeURIComponent(projectId)}/index/files${qs}`);
  }

  /**
   * Invoke one MCP tool by name in a session's context, outside the model
   * loop, and return its (wrapper-processed) result. Backs TUI "CLI mode"
   * `@tool <name> {…}`.
   */
  invokeSessionTool(
    sessionId: string,
    name: string,
    args?: Record<string, unknown>,
  ): Promise<InvokeSessionToolResponse> {
    return this.request(
      'POST',
      `/api/sessions/${encodeURIComponent(sessionId)}/tools/${encodeURIComponent(name)}/invoke`,
      { args: args ?? {} },
    );
  }

  /**
   * Post a structured `@user_question`. The MCP tool calls this; UIs
   * can call it directly for testing / debugging. The originating
   * session, gezel, and project must already exist.
   */
  askUserQuestion(body: AskQuestionRequest): Promise<AskQuestionResponse> {
    return this.request('POST', '/api/questions', body);
  }

  /**
   * List questions. Without `projectId`, returns *only* pending
   * questions across every project (the Home pane's data). With a
   * `projectId`, returns every question for that project; pass
   * `pending: true` to filter to unanswered.
   */
  listQuestions(opts?: {
    projectId?: string;
    pending?: boolean;
  }): Promise<ListQuestionsResponse> {
    const params = new URLSearchParams();
    if (opts?.projectId) params.set('project', opts.projectId);
    if (opts?.pending) params.set('pending', 'true');
    const qs = params.toString();
    return this.request('GET', `/api/questions${qs ? `?${qs}` : ''}`);
  }

  /**
   * Submit the user's answer to a structured question. The service
   * injects the formatted answer text back into the originating
   * session and kicks off the gezel's next turn — fire-and-forget,
   * so this resolves with the updated `Question` record well before
   * the gezel's reply lands.
   */
  answerQuestion(id: string, body: AnswerQuestionRequest): Promise<Question> {
    return this.request('POST', `/api/questions/${encodeURIComponent(id)}/answer`, body);
  }

  /**
   * Ranked list of projects where this gezel has presence. Drives the
   * project picker in the Gezel screen's Chat tab; the same heuristic
   * decides where a Meester-chat `@mention` re-anchors to, so the
   * dropdown's first entry matches the fan-out target.
   */
  listProjectsForGezel(gezelId: string): Promise<ListProjectsForGezelResponse> {
    return this.request('GET', `/api/gezels/${encodeURIComponent(gezelId)}/projects`);
  }

  /**
   * Roster for the chat composer's `@`-mention popover. Passing a
   * `projectId` weights the voorman + task assignees to the top of the
   * list; omit for the Meester chat (full roster, ungrouped).
   */
  listMentionCandidates(opts: {
    projectId?: string;
    query?: string;
  }): Promise<ListMentionCandidatesResponse> {
    const params = new URLSearchParams();
    if (opts.projectId) params.set('project', opts.projectId);
    if (opts.query) params.set('query', opts.query);
    const qs = params.toString();
    return this.request('GET', `/api/gezels/mention-candidates${qs ? `?${qs}` : ''}`);
  }

  archiveChatSession(sessionId: string): Promise<ChatSession> {
    return this.request('POST', `/api/sessions/${encodeURIComponent(sessionId)}/archive`);
  }

  deleteChatSession(sessionId: string): Promise<{ ok: true }> {
    return this.request('DELETE', `/api/sessions/${encodeURIComponent(sessionId)}`);
  }

  /**
   * Snapshot of any turn currently running on this session. Returns
   * `{ inflight: null }` when idle. Used by the composer to render a
   * "still waiting on X (Ys)" banner + cancel button when a previous
   * turn got wedged.
   */
  getChatSessionInflight(sessionId: string): Promise<{
    inflight: { userText: string; startedAt: number; elapsedMs: number } | null;
  }> {
    return this.request('GET', `/api/sessions/${encodeURIComponent(sessionId)}/inflight`);
  }

  /**
   * Snapshot of every turn currently mid-flight across a scope. Timeline
   * views query this on mount so the assistant's thinking-dots bubble
   * re-renders if the user tabbed away during a slow turn and came back
   * — otherwise the bubble is invisible until the next token arrives.
   */
  listInflightTurns(opts: { projectId?: string; gezelId?: string } = {}): Promise<{
    inflight: Array<{
      sessionId: string;
      gezelId: string;
      projectId: string;
      providerName: ProviderName;
      model?: string;
      userText: string;
      startedAt: number;
      elapsedMs: number;
      lastProgressAgoMs?: number;
    }>;
  }> {
    const qs = new URLSearchParams();
    if (opts.projectId) qs.set('project', opts.projectId);
    if (opts.gezelId) qs.set('gezel', opts.gezelId);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return this.request('GET', `/api/sessions/inflight${suffix}`);
  }

  /**
   * Live per-session progress counters (streamed chars, tool calls, file
   * mutations, activity timestamps). In-memory on the daemon — resets on
   * restart. The eval harness reads this instead of scraping daemon logs;
   * stall diagnostics and the UI share the same surface.
   */
  listSessionTelemetry(
    opts: { projectId?: string; gezelId?: string } = {},
  ): Promise<SessionTelemetryListResponse> {
    const qs = new URLSearchParams();
    if (opts.projectId) qs.set('project', opts.projectId);
    if (opts.gezelId) qs.set('gezel', opts.gezelId);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return this.request('GET', `/api/sessions/telemetry${suffix}`);
  }

  /** Telemetry for one session; `{ telemetry: null }` when untracked. */
  getSessionTelemetry(sessionId: string): Promise<{ telemetry: SessionTelemetry | null }> {
    return this.request('GET', `/api/sessions/${encodeURIComponent(sessionId)}/telemetry`);
  }

  /** Forcibly end a wedged turn. Safe to call when nothing's running. */
  cancelChatSessionTurn(sessionId: string): Promise<{ cancelled: boolean }> {
    return this.request('POST', `/api/sessions/${encodeURIComponent(sessionId)}/cancel`);
  }

  /**
   * Clear the poisoned state on every session in a project (the chat banner's
   * Continue button). One engine crash poisons several sessions, so a
   * project-wide reset is what gets the project working again. Returns the
   * number of sessions cleared.
   */
  clearProjectErrors(projectId: string): Promise<{ cleared: number }> {
    return this.request('POST', `/api/projects/${encodeURIComponent(projectId)}/clear-errors`);
  }

  /**
   * Projects with a "poisoned" session — a non-archived session whose last
   * turn aborted and is awaiting a user turn to clear it. One entry per
   * affected project (the most-recent poisoned session). Drives the sidebar
   * "last turn failed" indicator.
   */
  listPoisonedProjects(): Promise<{
    poisoned: Array<{ projectId: string; sessionId: string; gezelId: string; error: string }>;
  }> {
    return this.request('GET', '/api/projects/poisoned');
  }

  /**
   * Discard a specific queued message without running it. Used by
   * the ghost-bubble "Discard" action in the timeline.
   */
  cancelQueuedMessage(sessionId: string, queueId: string): Promise<{ cancelled: boolean }> {
    return this.request(
      'DELETE',
      `/api/sessions/${encodeURIComponent(sessionId)}/queue/${encodeURIComponent(queueId)}`,
    );
  }

  /**
   * Full-text snapshot of one session's pending queue. The
   * `queue_enqueued` event only carries a truncated preview; the
   * ghost-bubble edit affordance loads the complete text from here.
   */
  listSessionQueue(sessionId: string): Promise<ListSessionQueueResponse> {
    return this.request('GET', `/api/sessions/${encodeURIComponent(sessionId)}/queue`);
  }

  /**
   * Edit a queued message in place (FIFO position preserved). Rejects
   * with a 404-shaped error when the entry already started or was
   * discarded — callers treat that as "the moment passed".
   */
  updateQueuedMessage(
    sessionId: string,
    queueId: string,
    body: { message: string },
  ): Promise<UpdateQueuedMessageResponse> {
    return this.request(
      'PATCH',
      `/api/sessions/${encodeURIComponent(sessionId)}/queue/${encodeURIComponent(queueId)}`,
      body,
    );
  }

  /**
   * Cancel the in-flight turn (partial reply salvaged, exactly like
   * `cancelChatSessionTurn`) and send `message` immediately, ahead of
   * any queued entries. The composer's "Interrupt" action. 202 shape —
   * the reply streams over the session's SSE feed.
   */
  interruptChatSession(
    sessionId: string,
    body: { message: string },
  ): Promise<{ accepted: true; sessionId: string }> {
    return this.request('POST', `/api/sessions/${encodeURIComponent(sessionId)}/interrupt`, body);
  }

  // ── Memory (per-gezel + per-project daily files + summary) ──

  saveMemory(body: {
    scope: 'gezel' | 'project';
    id: string;
    text: string;
    kind?: MemoryKind;
  }): Promise<{ ok: true; status: 'saved' | 'duplicate' }> {
    return this.request('POST', '/api/memory/save', body);
  }

  listMemoryDays(scope: 'gezel' | 'project', id: string): Promise<{ days: string[] }> {
    return this.request('GET', `/api/memory/days?scope=${scope}&id=${encodeURIComponent(id)}`);
  }

  readMemoryDay(scope: 'gezel' | 'project', id: string, day: string): Promise<{ content: string }> {
    return this.request(
      'GET',
      `/api/memory/day?scope=${scope}&id=${encodeURIComponent(id)}&day=${encodeURIComponent(day)}`,
    );
  }

  updateMemoryDay(
    scope: 'gezel' | 'project',
    id: string,
    day: string,
    content: string,
  ): Promise<{ ok: true; indexed: boolean }> {
    return this.request(
      'PATCH',
      `/api/memory/day?scope=${scope}&id=${encodeURIComponent(id)}&day=${encodeURIComponent(day)}`,
      { content },
    );
  }

  readMemorySummary(scope: 'gezel' | 'project', id: string): Promise<{ content: string }> {
    return this.request('GET', `/api/memory/summary?scope=${scope}&id=${encodeURIComponent(id)}`);
  }

  readMemoryLessons(gezelId: string): Promise<{ content: string }> {
    return this.request('GET', `/api/memory/lessons?gezelId=${encodeURIComponent(gezelId)}`);
  }

  sessionEventsUrl(sessionId: string): string {
    return `${this.baseUrl}/events/chat?session=${encodeURIComponent(sessionId)}`;
  }

  // ── Timeline (interleaved cross-session view) ──

  listProjectTimeline(
    projectId: string,
    opts?: { limit?: number; before?: string; gezelId?: string; taskRef?: string },
  ): Promise<ListTimelineResponse> {
    const params = new URLSearchParams();
    if (opts?.limit != null) params.set('limit', String(opts.limit));
    if (opts?.before) params.set('before', opts.before);
    if (opts?.gezelId) params.set('gezel', opts.gezelId);
    if (opts?.taskRef) params.set('task', opts.taskRef);
    const qs = params.toString() ? `?${params.toString()}` : '';
    return this.request('GET', `/api/projects/${encodeURIComponent(projectId)}/timeline${qs}`);
  }

  listGezelTimeline(
    gezelId: string,
    opts?: { limit?: number; before?: string; projectId?: string },
  ): Promise<ListTimelineResponse> {
    const params = new URLSearchParams();
    if (opts?.limit != null) params.set('limit', String(opts.limit));
    if (opts?.before) params.set('before', opts.before);
    if (opts?.projectId) params.set('project', opts.projectId);
    const qs = params.toString() ? `?${params.toString()}` : '';
    return this.request('GET', `/api/gezels/${encodeURIComponent(gezelId)}/timeline${qs}`);
  }

  listGlobalTimeline(opts?: {
    limit?: number;
    before?: string;
  }): Promise<ListTimelineResponse> {
    const params = new URLSearchParams();
    if (opts?.limit != null) params.set('limit', String(opts.limit));
    if (opts?.before) params.set('before', opts.before);
    const qs = params.toString() ? `?${params.toString()}` : '';
    return this.request('GET', `/api/timeline${qs}`);
  }

  projectEventsUrl(projectId: string): string {
    return `${this.baseUrl}/events/chat/project?project=${encodeURIComponent(projectId)}`;
  }

  gezelEventsUrl(gezelId: string): string {
    return `${this.baseUrl}/events/chat/gezel?gezel=${encodeURIComponent(gezelId)}`;
  }

  allEventsUrl(): string {
    return `${this.baseUrl}/events/chat/all`;
  }

  // ── Terminal threads (per-project, in-chat terminal) ──

  listTerminalThreads(projectId: string): Promise<ListTerminalThreadsResponse> {
    return this.request('GET', `/api/projects/${encodeURIComponent(projectId)}/terminals`);
  }

  getTerminalThread(projectId: string, threadId: string): Promise<TerminalThread> {
    return this.request(
      'GET',
      `/api/projects/${encodeURIComponent(projectId)}/terminals/${encodeURIComponent(threadId)}`,
    );
  }

  runTerminalCommand(
    projectId: string,
    body: RunTerminalCommandRequest,
  ): Promise<RunTerminalCommandResponse> {
    return this.request(
      'POST',
      `/api/projects/${encodeURIComponent(projectId)}/terminals/run`,
      body,
    );
  }

  deleteTerminalThread(projectId: string, threadId: string): Promise<{ ok: true }> {
    return this.request(
      'DELETE',
      `/api/projects/${encodeURIComponent(projectId)}/terminals/${encodeURIComponent(threadId)}`,
    );
  }

  /**
   * Send Ctrl+C to the foreground command of an in-flight run.
   * Returns void on success (204); the server idempotently returns
   * 404 if the run already completed — callers can treat that as
   * "nothing to cancel" and continue without surfacing an error.
   */
  async cancelTerminalRun(projectId: string, runId: string): Promise<void> {
    try {
      await this.request(
        'POST',
        `/api/projects/${encodeURIComponent(projectId)}/terminals/runs/${encodeURIComponent(runId)}/cancel`,
      );
    } catch (err) {
      // Swallow 404 (run already complete) — anything else surfaces.
      if (err instanceof Error && /\b404\b/.test(err.message)) return;
      throw err;
    }
  }

  /**
   * Feed text into the in-flight run's stdin (interactive
   * prompts: sudo passwords, Y/N answers, npm-init responses).
   * Server appends the platform-appropriate line terminator.
   * 404 surfaces as a rejected promise — unlike cancel, the
   * caller usually wants to know that the run has ended so they
   * can clear the input UI.
   */
  sendTerminalInput(projectId: string, runId: string, text: string): Promise<void> {
    return this.request(
      'POST',
      `/api/projects/${encodeURIComponent(projectId)}/terminals/runs/${encodeURIComponent(runId)}/input`,
      { text },
    );
  }

  /** SSE URL for terminal events scoped to a project. */
  terminalEventsUrl(projectId: string): string {
    return `${this.baseUrl}/api/projects/${encodeURIComponent(projectId)}/terminals/events`;
  }

  /**
   * Endpoint for the in-app Copilot login SSE stream. Paired with
   * `streamCopilotLogin` from `./sse` — POSTs to start the login
   * subprocess and streams its stdout/stderr back.
   */
  copilotLoginUrl(): string {
    return `${this.baseUrl}/api/system/copilot-login`;
  }

  // ── Legacy per-(gezel, project) chat helpers — resolve to most-recent session ──

  chatHistory(gezelId: string, projectId = 'default'): Promise<ChatHistoryResponse> {
    return this.request(
      'GET',
      `/api/gezels/${encodeURIComponent(gezelId)}/chat?project=${encodeURIComponent(projectId)}`,
    );
  }

  sendChatMessage(
    gezelId: string,
    body: SendChatRequest & { projectId?: string },
  ): Promise<SendChatResponse> {
    return this.request('POST', `/api/gezels/${encodeURIComponent(gezelId)}/chat/send`, body);
  }

  resetChat(gezelId: string, projectId = 'default'): Promise<{ ok: true }> {
    return this.request(
      'POST',
      `/api/gezels/${encodeURIComponent(gezelId)}/chat/reset?project=${encodeURIComponent(projectId)}`,
    );
  }

  chatEventsUrl(gezelId: string, projectId = 'default'): string {
    return `${this.baseUrl}/events/chat?gezel=${encodeURIComponent(gezelId)}&project=${encodeURIComponent(projectId)}`;
  }

  listProjects(opts?: { rollup?: boolean }): Promise<ListProjectsResponse> {
    return this.request('GET', `/api/projects${opts?.rollup ? '?rollup=1' : ''}`);
  }

  // ---- Remote model execution (paired servers, this device as CLIENT) ----

  listRemotes(): Promise<{ remotes: PairedRemoteInfo[] }> {
    return this.request('GET', '/api/remotes');
  }

  pairRemote(body: {
    baseUrl: string;
    displayName?: string;
    expectedIdentityFingerprint: string;
    acceptIdentityChange?: boolean;
    approvalTimeoutSec?: number;
  }): Promise<{ remote: PairedRemoteInfo }> {
    return this.request('POST', '/api/remotes/pair', body);
  }

  inspectRemote(body: { baseUrl: string }): Promise<{
    deviceId: string;
    fingerprint: string;
    existingFingerprint?: string;
    identityChanged: boolean;
  }> {
    return this.request('POST', '/api/remotes/inspect', body);
  }

  unpairRemote(remoteId: string): Promise<{ ok: boolean }> {
    return this.request('DELETE', `/api/remotes/${encodeURIComponent(remoteId)}`);
  }

  listRemoteModels(remoteId: string): Promise<{
    remoteId: string;
    models: Array<{
      id: string;
      name: string;
      contextWindow?: number;
      supportsTools?: boolean;
      supportsReasoning?: boolean;
      parameterSize?: string;
    }>;
  }> {
    return this.request('GET', `/api/remotes/${encodeURIComponent(remoteId)}/models`);
  }

  createProject(body: CreateProjectRequest): Promise<ProjectResponse> {
    return this.request('POST', '/api/projects', body);
  }

  /**
   * Create and fully materialize a catalog-backed project as one server-owned
   * operation. The project is not observable until type application commits.
   */
  createTypedProject(body: CreateTypedProjectRequest): Promise<CreateTypedProjectResponse> {
    return this.request('POST', '/api/projects/typed', body);
  }

  getProject(id: string): Promise<ProjectResponse> {
    return this.request('GET', `/api/projects/${encodeURIComponent(id)}`);
  }

  setProjectWorkingDir(id: string, workingDir?: string): Promise<ProjectResponse> {
    return this.request('PUT', `/api/projects/${encodeURIComponent(id)}/working-dir`, {
      workingDir,
    });
  }

  updateProject(id: string, body: UpdateProjectRequest): Promise<ProjectResponse> {
    return this.request('PUT', `/api/projects/${encodeURIComponent(id)}`, body);
  }

  /**
   * Delete a project. By default only the project record is removed — the
   * user's workspace + artifacts stay on disk. Pass `removeWorkspace: true`
   * to also delete the internal workspace + artifacts; the server honors it
   * only when the workspace is gezel-internal (an external `workingDir` is
   * never removed) and reports back which source it resolved.
   */
  deleteProject(
    id: string,
    opts?: { removeWorkspace?: boolean },
  ): Promise<{
    ok: true;
    name: string;
    removedWorkspace: boolean;
    workspaceSource: 'workingDir' | 'githubCheckout' | 'internal';
  }> {
    const qs = opts?.removeWorkspace ? '?removeWorkspace=1' : '';
    return this.request('DELETE', `/api/projects/${encodeURIComponent(id)}${qs}`);
  }

  /**
   * Apply a custom project type to an existing project — renders its
   * about/mission, creates its gezels (setting the voorman), installs its
   * scripts, seeds its workspace, and stamps provenance. Returns the
   * instantiation report. See docs/project-types.md.
   */
  applyProjectType(id: string, body: ApplyProjectTypeRequest): Promise<AppliedProjectType> {
    return this.request('POST', `/api/projects/${encodeURIComponent(id)}/apply-project-type`, body);
  }

  /**
   * Package a project type (+ referenced gezel templates) into a `.gzl` share
   * bundle written into the project's artifacts. See docs/project-types.md.
   */
  exportProjectType(
    id: string,
    body: { typeId?: string; name?: string; description?: string; creator?: string },
  ): Promise<{ path: string; artifactPath: string; manifest: GzelBundleManifest; bytes: number }> {
    return this.request(
      'POST',
      `/api/projects/${encodeURIComponent(id)}/project-types/export`,
      body,
    );
  }

  /**
   * Import a `.gzl` bundle from a file in the project's artifacts. Without
   * `confirm` returns the review; with `confirm: true` installs the items.
   */
  importProjectType(
    id: string,
    body: { path: string; confirm?: boolean },
  ): Promise<{
    manifest: GzelBundleManifest;
    items: Array<{ kind: string; id: string; version: string }>;
    installed?: Array<{ kind: string; id: string; version: string }>;
  }> {
    return this.request(
      'POST',
      `/api/projects/${encodeURIComponent(id)}/project-types/import`,
      body,
    );
  }

  // ── Mail (email-enabled projects) ─────────────────────────────────
  mailStatus(id: string): Promise<{
    configured: boolean;
    accounts: {
      id: string;
      provider: string;
      address: string;
      syncFolders: string[];
      lastSyncedAt?: string;
      lastError?: string;
    }[];
  }> {
    return this.request('GET', `/api/projects/${encodeURIComponent(id)}/mail/status`);
  }

  /** Link an IMAP mailbox (host/user/pass blob stored in the SecretStore). */
  linkMailbox(
    id: string,
    body: {
      provider: 'imap' | 'gmail' | 'microsoft365' | 'outlook';
      address: string;
      displayName?: string;
      syncFolders?: string[];
      imap?: {
        host: string;
        port?: number;
        secure?: boolean;
        user: string;
        pass: string;
        smtp?: { host: string; port?: number; secure?: boolean; user?: string; pass?: string };
      };
    },
  ): Promise<{ ok: boolean; account: { id: string; provider: string; address: string } }> {
    return this.request('POST', `/api/projects/${encodeURIComponent(id)}/mail/link`, body);
  }

  /** Trigger a manual sync of all linked accounts. */
  syncMail(id: string): Promise<{ ok: boolean; results: unknown[] }> {
    return this.request('POST', `/api/projects/${encodeURIComponent(id)}/mail/sync`, {});
  }

  /** Begin an OAuth mailbox link; returns the URL the shell opens. */
  startMailOAuth(
    id: string,
    body: {
      provider: 'gmail' | 'microsoft365' | 'outlook';
      address: string;
      redirectUri: string;
      tenant?: string;
      syncFolders?: string[];
    },
  ): Promise<{ ok: boolean; authUrl: string; state: string }> {
    return this.request('POST', `/api/projects/${encodeURIComponent(id)}/mail/oauth/start`, body);
  }

  /** Finish an OAuth mailbox link with the captured authorization code. */
  completeMailOAuth(
    id: string,
    body: { state: string; code: string },
  ): Promise<{ ok: boolean; account: { id: string; provider: string; address: string } }> {
    return this.request(
      'POST',
      `/api/projects/${encodeURIComponent(id)}/mail/oauth/complete`,
      body,
    );
  }

  // ── Connectors (external-data sources) ────────────────────────────────────

  /** Browse available connector types (catalog). */
  listConnectorTypes(): Promise<{ items: CatalogItemSummary[] }> {
    return this.listCatalogItems('connector-type');
  }

  /** List a project's bound connectors + their sync status. */
  listConnectors(id: string): Promise<{
    configured: boolean;
    bindings: {
      id: string;
      type: string;
      displayName?: string;
      lastSyncedAt?: string;
      lastError?: string;
      disabled?: boolean;
    }[];
  }> {
    return this.request('GET', `/api/projects/${encodeURIComponent(id)}/connectors`);
  }

  /** Bind a connector (credential stored in the SecretStore, not on the project). */
  bindConnector(
    id: string,
    body: {
      type: string;
      displayName?: string;
      config?: Record<string, unknown>;
      credential?: unknown;
    },
  ): Promise<{ ok: boolean; binding: { id: string; type: string } }> {
    return this.request('POST', `/api/projects/${encodeURIComponent(id)}/connectors/bind`, body);
  }

  /** Trigger a manual sync of one binding. */
  syncConnector(id: string, bindingId: string): Promise<{ ok: boolean; result: unknown }> {
    return this.request(
      'POST',
      `/api/projects/${encodeURIComponent(id)}/connectors/${encodeURIComponent(bindingId)}/sync`,
      {},
    );
  }

  /** Remove a binding + its stored credential. */
  unbindConnector(id: string, bindingId: string): Promise<void> {
    return this.request(
      'DELETE',
      `/api/projects/${encodeURIComponent(id)}/connectors/${encodeURIComponent(bindingId)}`,
    );
  }

  /** Begin an OAuth link for an OAuth-shaped connector type. */
  startConnectorOAuth(
    id: string,
    body: {
      type: string;
      redirectUri: string;
      config?: Record<string, unknown>;
      displayName?: string;
    },
  ): Promise<{ ok: boolean; authUrl: string; state: string }> {
    return this.request(
      'POST',
      `/api/projects/${encodeURIComponent(id)}/connectors/oauth/start`,
      body,
    );
  }

  /** Finish an OAuth connector link with the captured authorization code. */
  completeConnectorOAuth(
    id: string,
    body: { state: string; code: string },
  ): Promise<{ ok: boolean; binding: { id: string; type: string } }> {
    return this.request(
      'POST',
      `/api/projects/${encodeURIComponent(id)}/connectors/oauth/complete`,
      body,
    );
  }

  /** Pending connector write actions (drafted by a gezel, awaiting user commit). */
  listConnectorActions(id: string): Promise<{
    pending: {
      draftId: string;
      bindingId: string;
      connectorType: string;
      action: string;
      status: 'draft' | 'queued';
      input: unknown;
    }[];
  }> {
    return this.request('GET', `/api/projects/${encodeURIComponent(id)}/connectors/actions`);
  }

  /** Commit a drafted action (the live write). Defers during night shift. */
  commitConnectorAction(
    id: string,
    draftId: string,
  ): Promise<{ ok: boolean; status: string; result?: unknown }> {
    return this.request(
      'POST',
      `/api/projects/${encodeURIComponent(id)}/connectors/actions/${encodeURIComponent(draftId)}/commit`,
      {},
    );
  }

  /** Discard a drafted action without committing. */
  discardConnectorAction(id: string, draftId: string): Promise<void> {
    return this.request(
      'DELETE',
      `/api/projects/${encodeURIComponent(id)}/connectors/actions/${encodeURIComponent(draftId)}`,
    );
  }

  /** Read the project's `gezelIds` roster. */
  listProjectGezels(id: string): Promise<{ projectId: string; gezelIds: string[] }> {
    return this.request('GET', `/api/projects/${encodeURIComponent(id)}/gezels`);
  }

  /** Add a gezel to the project's roster (idempotent). */
  addGezelToProject(
    id: string,
    gezelId: string,
  ): Promise<{ projectId: string; gezelIds: string[]; added: boolean }> {
    return this.request('POST', `/api/projects/${encodeURIComponent(id)}/gezels`, { gezelId });
  }

  /** Remove a gezel from the project's roster (idempotent). */
  removeGezelFromProject(
    id: string,
    gezelId: string,
  ): Promise<{ projectId: string; gezelIds: string[]; removed: boolean }> {
    return this.request(
      'DELETE',
      `/api/projects/${encodeURIComponent(id)}/gezels/${encodeURIComponent(gezelId)}`,
    );
  }

  listHistory(filter?: {
    projectId?: string;
    gezelId?: string;
    kind?: string;
    from?: string;
    to?: string;
    q?: string;
    limit?: number;
  }): Promise<ListHistoryResponse> {
    const params = new URLSearchParams();
    if (filter?.projectId) params.set('project', filter.projectId);
    if (filter?.gezelId) params.set('gezel', filter.gezelId);
    if (filter?.kind) params.set('kind', filter.kind);
    if (filter?.from) params.set('from', filter.from);
    if (filter?.to) params.set('to', filter.to);
    if (filter?.q) params.set('q', filter.q);
    if (filter?.limit != null) params.set('limit', String(filter.limit));
    const qs = params.toString() ? `?${params.toString()}` : '';
    return this.request('GET', `/api/history${qs}`);
  }

  /** Full-text search across chat-session transcripts (global index). */
  searchSessions(req: SearchSessionsRequest): Promise<SearchSessionsResponse> {
    const params = new URLSearchParams();
    params.set('q', req.q);
    if (req.gezel) params.set('gezel', req.gezel);
    if (req.project) params.set('project', req.project);
    if (req.maxResults != null) params.set('maxResults', String(req.maxResults));
    return this.request('GET', `/api/sessions/search?${params.toString()}`);
  }

  /** Full-text search over the shared documents library's content (global index). */
  searchDocuments(req: SearchDocumentsRequest): Promise<SearchDocumentsResponse> {
    const params = new URLSearchParams();
    params.set('q', req.q);
    if (req.maxResults != null) params.set('maxResults', String(req.maxResults));
    return this.request('GET', `/api/documents/search?${params.toString()}`);
  }

  revealProject(
    id: string,
    which: 'artifacts' | 'workspace' = 'artifacts',
  ): Promise<{ ok: true; path: string }> {
    return this.request('POST', `/api/projects/${encodeURIComponent(id)}/reveal?which=${which}`);
  }

  resolveReferenceFileLocation(
    projectId: string,
    request: ReferenceFileLocationRequest,
  ): Promise<ReferenceFileLocationResponse> {
    const params = new URLSearchParams({ kind: request.kind, path: request.path });
    return this.request(
      'GET',
      `/api/projects/${encodeURIComponent(projectId)}/reference-file-location?${params.toString()}`,
    );
  }

  /**
   * Classify a References-pane file and prepare any document markdown
   * companion. Binary bytes are never returned through this JSON endpoint.
   */
  previewReference(
    projectId: string,
    request: ReferencePreviewRequest,
  ): Promise<ReferencePreviewResponse> {
    const params = new URLSearchParams({ kind: request.kind, path: request.path });
    return this.request(
      'GET',
      `/api/projects/${encodeURIComponent(projectId)}/reference-preview?${params.toString()}`,
    );
  }

  // ── artifacts (read-write) ──

  listProjectArtifacts(
    id: string,
    subpath?: string,
    recursive?: boolean,
  ): Promise<{
    files: Array<{ name: string; path: string; isDirectory: boolean }>;
    /** Present on recursive listings: true when the walker's entry cap dropped files. */
    truncated?: boolean;
  }> {
    const params = new URLSearchParams();
    if (subpath) params.set('path', subpath);
    if (recursive) params.set('recursive', '1');
    const qs = params.toString() ? `?${params.toString()}` : '';
    return this.request('GET', `/api/projects/${encodeURIComponent(id)}/artifacts${qs}`);
  }

  readProjectArtifact(id: string, filePath: string): Promise<{ path: string; content: string }> {
    return this.request(
      'GET',
      `/api/projects/${encodeURIComponent(id)}/artifacts/read?path=${encodeURIComponent(filePath)}`,
    );
  }

  resolveProjectArtifact(id: string, filePath: string): Promise<ResolveArtifactResponse> {
    return this.request(
      'GET',
      `/api/projects/${encodeURIComponent(id)}/artifacts/resolve?path=${encodeURIComponent(filePath)}`,
    );
  }

  /**
   * Read an artifact with optional line-based slicing. Backwards
   * compatible: omitting all opts returns the full content (the
   * existing v1 behavior). At most one of `lines` / `head` / `tail`
   * — combining is silently ignored in priority order.
   *
   * Used by the `read_artifact` MCP tool to navigate large
   * outboard-storage artifacts without pulling the whole file back
   * into the model's context window.
   */
  readProjectArtifactSlice(
    id: string,
    filePath: string,
    opts?: ReadArtifactSliceOpts,
  ): Promise<ReadArtifactSliceResponse> {
    const params = new URLSearchParams({ path: filePath });
    if (opts?.lines) {
      params.set('lines', `${opts.lines.start},${opts.lines.count}`);
    } else if (typeof opts?.head === 'number') {
      params.set('head', String(opts.head));
    } else if (typeof opts?.tail === 'number') {
      params.set('tail', String(opts.tail));
    }
    return this.request(
      'GET',
      `/api/projects/${encodeURIComponent(id)}/artifacts/slice?${params.toString()}`,
    );
  }

  /**
   * Regex-grep a single artifact. Returns matches with line numbers
   * and optional surrounding context. Caps results at `maxMatches`
   * (default 20) so a runaway `.*` pattern can't dump the whole
   * file. POST because the pattern can include characters awkward to
   * URL-encode.
   */
  grepProjectArtifact(id: string, body: GrepArtifactRequest): Promise<GrepArtifactResponse> {
    return this.request('POST', `/api/projects/${encodeURIComponent(id)}/artifacts/grep`, body);
  }

  runPlaywrightScript(
    projectId: string,
    body: { path: string; mode?: 'test' | 'script' },
  ): Promise<{ ok: boolean; log: string; error?: string }> {
    return this.request(
      'POST',
      `/api/projects/${encodeURIComponent(projectId)}/run-playwright`,
      body,
    );
  }

  getSystemToolsetStatus(): Promise<SystemBootstrapStatus> {
    return this.request('GET', '/api/system-toolsets/status');
  }

  systemToolsetStatusStreamUrl(): string {
    return `${this.baseUrl}/api/system-toolsets/status/stream`;
  }

  /** In-flight (and recently-finished) on-demand system-toolset installs. */
  listSystemToolsetInstalls(): Promise<{ installs: SystemToolsetInstallSnapshot[] }> {
    return this.request('GET', '/api/system-toolsets/installs');
  }

  /**
   * Install — or attach to a running install of — an on-demand system
   * toolset. Only entries flagged `onDemand` in the pinned manifest are
   * installable this way; today that is the GitHub Copilot SDK.
   *
   * The job is server-owned and survives a listener disconnect, so aborting
   * `signal` stops watching without stopping the install. Use
   * {@link cancelSystemToolsetInstall} to actually stop it. Resolves on the
   * terminal `done` or `error` event.
   */
  async installSystemToolset(
    toolsetId: string,
    onEvent: (event: SystemToolsetInstallEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    await consumeApiSseJson({
      ...MODEL_DOWNLOAD_SSE_POLICY,
      url: `${this.baseUrl}/api/system-toolsets/${encodeURIComponent(toolsetId)}/install`,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
      },
      signal,
      fetch: this.fetchImpl,
      schema: SystemToolsetInstallEventSchema,
      onEvent,
      isTerminal: (event) => event.type === 'done' || event.type === 'error',
      label: `System toolset install stream for "${toolsetId}"`,
    });
  }

  cancelSystemToolsetInstall(toolsetId: string): Promise<{ aborted: boolean }> {
    return this.request('DELETE', `/api/system-toolsets/${encodeURIComponent(toolsetId)}/install`);
  }

  /**
   * Whether GitHub Copilot is usable on this device, and via which rung of
   * the resolution ladder (explicit `COPILOT_CLI_PATH`, our managed install,
   * or a CLI the user installed themselves).
   *
   * The gate every "should we offer Copilot?" decision in the UI reads. Note
   * `available: true` with `managed: 'absent'` is a normal state — it means
   * the user brought their own CLI and must not be offered a download.
   * `managed: 'damaged'` means our install is on disk but won't load
   * (`damagedReason` says why); it never satisfies `available` and the
   * Settings card offers a repair for it.
   */
  getCopilotStatus(): Promise<CopilotAvailability> {
    return this.request('GET', '/api/system/copilot-status');
  }

  getMlxRuntimeStatus(): Promise<MlxRuntimeStatus> {
    return this.request('GET', '/api/mlx/runtime/status');
  }

  mlxRuntimeStatusStreamUrl(): string {
    return `${this.baseUrl}/api/mlx/runtime/status/stream`;
  }

  writeProjectArtifact(
    id: string,
    filePath: string,
    content: string,
  ): Promise<{ ok: true; path: string }> {
    return this.request('PUT', `/api/projects/${encodeURIComponent(id)}/artifacts/write`, {
      path: filePath,
      content,
    });
  }

  /**
   * Binary sibling of `writeProjectArtifact`. Writes raw bytes to an
   * arbitrary artifact path. Used by the squisq editor's Files panel
   * to upload images alongside a project-scoped markdown document.
   */
  async writeProjectArtifactBinary(
    projectId: string,
    filePath: string,
    data: Blob | ArrayBuffer | Uint8Array,
    mimeType: string,
  ): Promise<{ ok: true; path: string }> {
    const url = `${this.baseUrl}/api/projects/${encodeURIComponent(projectId)}/artifacts/raw?path=${encodeURIComponent(filePath)}`;
    const body =
      data instanceof Blob
        ? data
        : data instanceof Uint8Array
          ? data
          : new Uint8Array(data as ArrayBuffer);
    const res = await this.fetchImpl(url, {
      method: 'PUT',
      headers: {
        'content-type': mimeType,
        Authorization: `Bearer ${this.token}`,
      },
      body,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`artifact binary write failed (${res.status}): ${text}`);
    }
    return res.json() as Promise<{ ok: true; path: string }>;
  }

  renderImage(req: RenderImageRequest): Promise<RenderImageResponse> {
    return this.request('POST', '/api/render/image', req);
  }

  deleteProjectArtifact(id: string, filePath: string): Promise<{ ok: true }> {
    return this.request(
      'DELETE',
      `/api/projects/${encodeURIComponent(id)}/artifacts/delete?path=${encodeURIComponent(filePath)}`,
    );
  }

  // ── workspace (CRUD — writes gated by project.allowGezelWrites) ──

  listProjectWorkspace(
    id: string,
    subpath?: string,
    recursive?: boolean,
  ): Promise<{
    files: Array<{ name: string; path: string; isDirectory: boolean }>;
    /** Present on recursive listings: true when the walker's entry cap dropped files. */
    truncated?: boolean;
  }> {
    const params = new URLSearchParams();
    if (subpath) params.set('path', subpath);
    if (recursive) params.set('recursive', '1');
    const qs = params.toString() ? `?${params.toString()}` : '';
    return this.request('GET', `/api/projects/${encodeURIComponent(id)}/workspace${qs}`);
  }

  /**
   * List workspace HTML pages eligible for the Output pane. The service uses
   * a shallow, pruned traversal rather than the general recursive file list.
   */
  listProjectWorkspaceHtmlPages(
    id: string,
  ): Promise<{ files: Array<{ name: string; path: string; isDirectory: false }> }> {
    return this.request('GET', `/api/projects/${encodeURIComponent(id)}/workspace/html-pages`);
  }

  readProjectWorkspaceFile(
    id: string,
    filePath: string,
  ): Promise<{ path: string; content: string }> {
    return this.request(
      'GET',
      `/api/projects/${encodeURIComponent(id)}/workspace/read?path=${encodeURIComponent(filePath)}`,
    );
  }

  statProjectWorkspacePath(
    id: string,
    filePath: string,
  ): Promise<{ kind: 'file' | 'dir' | 'missing'; size?: number; mtime?: string }> {
    return this.request(
      'GET',
      `/api/projects/${encodeURIComponent(id)}/workspace/stat?path=${encodeURIComponent(filePath)}`,
    );
  }

  writeProjectWorkspaceFile(
    id: string,
    body: { path: string; content: string; gezelId?: string; sessionId?: string },
  ): Promise<{ ok: true; path: string }> {
    return this.request('PUT', `/api/projects/${encodeURIComponent(id)}/workspace/file`, body);
  }

  copyArtifactToWorkspace(
    id: string,
    body: CopyArtifactToWorkspaceRequest,
  ): Promise<CopyArtifactToWorkspaceResponse> {
    return this.request(
      'POST',
      `/api/projects/${encodeURIComponent(id)}/workspace/copy-from-artifact`,
      body,
    );
  }

  fetchProjectRepo(id: string, body: FetchRepoRequest): Promise<FetchRepoResponse> {
    return this.request(
      'POST',
      `/api/projects/${encodeURIComponent(id)}/workspace/fetch-repo`,
      body,
    );
  }

  fetchProjectDiff(id: string, body: FetchDiffRequest): Promise<FetchDiffResponse> {
    return this.request(
      'POST',
      `/api/projects/${encodeURIComponent(id)}/workspace/fetch-diff`,
      body,
    );
  }

  replaceInProjectWorkspaceFile(
    id: string,
    body: ReplaceInProjectWorkspaceFileRequest,
  ): Promise<WorkspaceEditResponse> {
    return this.request('POST', `/api/projects/${encodeURIComponent(id)}/workspace/replace`, body);
  }

  replaceLinesInProjectWorkspaceFile(
    id: string,
    body: ReplaceLinesInProjectWorkspaceFileRequest,
  ): Promise<WorkspaceEditResponse> {
    return this.request(
      'POST',
      `/api/projects/${encodeURIComponent(id)}/workspace/replace-lines`,
      body,
    );
  }

  applyPatchToProjectWorkspaceFile(
    id: string,
    body: ApplyPatchToProjectWorkspaceFileRequest,
  ): Promise<WorkspaceEditResponse> {
    return this.request('POST', `/api/projects/${encodeURIComponent(id)}/workspace/patch`, body);
  }

  insertAtMarkerInProjectWorkspaceFile(
    id: string,
    body: InsertAtMarkerInProjectWorkspaceFileRequest,
  ): Promise<WorkspaceEditResponse> {
    return this.request(
      'POST',
      `/api/projects/${encodeURIComponent(id)}/workspace/insert-at-marker`,
      body,
    );
  }

  rmProjectWorkspacePath(
    id: string,
    filePath: string,
    opts: { recursive?: boolean; gezelId?: string; sessionId?: string } = {},
  ): Promise<{ ok: true }> {
    const params = new URLSearchParams();
    params.set('path', filePath);
    if (opts.recursive) params.set('recursive', '1');
    if (opts.gezelId) params.set('gezelId', opts.gezelId);
    if (opts.sessionId) params.set('sessionId', opts.sessionId);
    return this.request(
      'DELETE',
      `/api/projects/${encodeURIComponent(id)}/workspace/path?${params.toString()}`,
    );
  }

  mkdirProjectWorkspace(
    id: string,
    body: { path: string; gezelId?: string; sessionId?: string },
  ): Promise<{ ok: true; path: string }> {
    return this.request('POST', `/api/projects/${encodeURIComponent(id)}/workspace/mkdir`, body);
  }

  renameProjectWorkspacePath(
    id: string,
    body: { fromPath: string; toPath: string; gezelId?: string; sessionId?: string },
  ): Promise<{ ok: true; fromPath: string; toPath: string }> {
    return this.request('POST', `/api/projects/${encodeURIComponent(id)}/workspace/rename`, body);
  }

  // ── tool-bridge endpoints (MCP tools delegate to these) ──

  toolFetchUrl(id: string, body: FetchUrlRequest): Promise<FetchUrlResponse> {
    return this.request('POST', `/api/projects/${encodeURIComponent(id)}/tools/fetch-url`, body);
  }

  toolWebSearch(id: string, body: WebSearchRequest): Promise<WebSearchResponse> {
    return this.request('POST', `/api/projects/${encodeURIComponent(id)}/tools/web-search`, body);
  }

  toolWikipediaSearch(id: string, body: WikipediaSearchRequest): Promise<WebSearchResponse> {
    return this.request(
      'POST',
      `/api/projects/${encodeURIComponent(id)}/tools/wikipedia-search`,
      body,
    );
  }

  toolSearchFiles(id: string, body: SearchFilesRequest): Promise<SearchFilesResponse> {
    return this.request('POST', `/api/projects/${encodeURIComponent(id)}/tools/search-files`, body);
  }

  toolFindFiles(id: string, body: FindFilesRequest): Promise<FindFilesResponse> {
    return this.request('POST', `/api/projects/${encodeURIComponent(id)}/tools/find-files`, body);
  }

  toolOutlineFile(id: string, body: OutlineFileRequest): Promise<OutlineFileResponse> {
    return this.request('POST', `/api/projects/${encodeURIComponent(id)}/tools/outline-file`, body);
  }

  toolFileContext(id: string, body: FileContextRequest): Promise<FileContextResponse> {
    return this.request('POST', `/api/projects/${encodeURIComponent(id)}/tools/file-context`, body);
  }

  toolFileReview(id: string, body: FileReviewRequest): Promise<FileReviewResponse> {
    return this.request('POST', `/api/projects/${encodeURIComponent(id)}/tools/file-review`, body);
  }

  toolListFileIssues(
    id: string,
    body: ListFileIssuesRequest = {},
  ): Promise<ListFileIssuesResponse> {
    return this.request(
      'POST',
      `/api/projects/${encodeURIComponent(id)}/tools/list-file-issues`,
      body,
    );
  }

  toolFindSymbol(id: string, body: FindSymbolRequest): Promise<FindSymbolResponse> {
    return this.request('POST', `/api/projects/${encodeURIComponent(id)}/tools/find-symbol`, body);
  }

  toolReadSymbol(id: string, body: ReadSymbolRequest): Promise<ReadSymbolResponse> {
    return this.request('POST', `/api/projects/${encodeURIComponent(id)}/tools/read-symbol`, body);
  }

  toolFindReferences(id: string, body: FindReferencesRequest): Promise<FindReferencesResponse> {
    return this.request(
      'POST',
      `/api/projects/${encodeURIComponent(id)}/tools/find-references`,
      body,
    );
  }

  toolMapRepo(id: string, body: MapRepoRequest): Promise<MapRepoResponse> {
    return this.request('POST', `/api/projects/${encodeURIComponent(id)}/tools/map-repo`, body);
  }

  toolFileMap(id: string, body: FileMapRequest = {}): Promise<FileMapResponse> {
    return this.request('POST', `/api/projects/${encodeURIComponent(id)}/tools/file-map`, body);
  }

  toolSearchDocs(id: string, body: SearchDocsRequest): Promise<SearchDocsResponse> {
    return this.request('POST', `/api/projects/${encodeURIComponent(id)}/tools/search-docs`, body);
  }

  toolSearchCode(id: string, body: SearchCodeRequest): Promise<SearchCodeResponse> {
    return this.request('POST', `/api/projects/${encodeURIComponent(id)}/tools/search-code`, body);
  }

  toolSecurityScan(id: string, body: SecurityScanRequest = {}): Promise<SecurityScanResponse> {
    return this.request(
      'POST',
      `/api/projects/${encodeURIComponent(id)}/tools/security-scan`,
      body,
    );
  }

  toolScanFindings(id: string, body: ScanFindingsRequest = {}): Promise<ScanFindingsResponse> {
    return this.request(
      'POST',
      `/api/projects/${encodeURIComponent(id)}/tools/scan-findings`,
      body,
    );
  }

  resolveSecurityFinding(
    id: string,
    body: ResolveSecurityFindingRequest,
  ): Promise<ResolveSecurityFindingResponse> {
    return this.request(
      'POST',
      `/api/projects/${encodeURIComponent(id)}/tools/resolve-finding`,
      body,
    );
  }

  delegateSecurityFinding(
    id: string,
    body: DelegateSecurityFindingRequest,
  ): Promise<DelegateSecurityFindingResponse> {
    return this.request(
      'POST',
      `/api/projects/${encodeURIComponent(id)}/tools/delegate-finding`,
      body,
    );
  }

  toolMapAttackSurface(id: string): Promise<MapAttackSurfaceResponse> {
    return this.request(
      'POST',
      `/api/projects/${encodeURIComponent(id)}/tools/map-attack-surface`,
      {},
    );
  }

  toolListDependencies(id: string): Promise<ListDependenciesResponse> {
    return this.request(
      'POST',
      `/api/projects/${encodeURIComponent(id)}/tools/list-dependencies`,
      {},
    );
  }

  toolSecurityOverview(id: string): Promise<SecurityOverviewResponse> {
    return this.request(
      'POST',
      `/api/projects/${encodeURIComponent(id)}/tools/security-overview`,
      {},
    );
  }

  toolTraceTaint(id: string, body: TraceTaintRequest): Promise<TraceTaintResponse> {
    return this.request('POST', `/api/projects/${encodeURIComponent(id)}/tools/trace-taint`, body);
  }

  toolSearchImages(id: string, body: SearchImagesRequest): Promise<SearchImagesResponse> {
    return this.request(
      'POST',
      `/api/projects/${encodeURIComponent(id)}/tools/search-images`,
      body,
    );
  }

  toolFindSimilarImages(
    id: string,
    body: FindSimilarImagesRequest,
  ): Promise<FindSimilarImagesResponse> {
    return this.request(
      'POST',
      `/api/projects/${encodeURIComponent(id)}/tools/find-similar-images`,
      body,
    );
  }

  toolDescribeFolder(id: string, body: DescribeFolderRequest): Promise<DescribeFolderResponse> {
    return this.request(
      'POST',
      `/api/projects/${encodeURIComponent(id)}/tools/describe-folder`,
      body,
    );
  }

  toolFindEntity(id: string, body: FindEntityRequest): Promise<FindEntityResponse> {
    return this.request('POST', `/api/projects/${encodeURIComponent(id)}/tools/find-entity`, body);
  }

  toolListEntityMentions(
    id: string,
    body: ListEntityMentionsRequest,
  ): Promise<ListEntityMentionsResponse> {
    return this.request(
      'POST',
      `/api/projects/${encodeURIComponent(id)}/tools/list-entity-mentions`,
      body,
    );
  }

  /** OS-idle heartbeat from the Electron shell (gates background enrichment). */
  reportSystemIdle(idleSeconds: number): Promise<{ ok: boolean }> {
    return this.request('POST', '/api/system/idle', { idleSeconds });
  }

  /**
   * Night-shift power directive for the Electron shell: whether to hold a
   * power-save blocker (`keepAwake`) and when to pre-arm an OS wake
   * (`wakeAtIso`, null = none). Polled on the idle-report cadence.
   */
  getNightShiftPowerIntent(): Promise<{ keepAwake: boolean; wakeAtIso: string | null }> {
    return this.request('GET', '/api/night-shift/power-intent');
  }

  toolReadDocAsMarkdown(
    id: string,
    body: ReadDocAsMarkdownRequest,
  ): Promise<ReadDocAsMarkdownResponse> {
    return this.request(
      'POST',
      `/api/projects/${encodeURIComponent(id)}/tools/read-doc-as-markdown`,
      body,
    );
  }

  toolDiffFiles(id: string, body: DiffFilesRequest): Promise<DiffFilesResponse> {
    return this.request('POST', `/api/projects/${encodeURIComponent(id)}/tools/diff-files`, body);
  }

  toolReadImageBase64(id: string, body: ReadImageBase64Request): Promise<ReadImageBase64Response> {
    return this.request(
      'POST',
      `/api/projects/${encodeURIComponent(id)}/tools/read-image-base64`,
      body,
    );
  }

  toolArchiveList(id: string, body: ArchiveListRequest): Promise<ArchiveListResponse> {
    return this.request('POST', `/api/projects/${encodeURIComponent(id)}/tools/archive/list`, body);
  }

  toolArchiveExtract(id: string, body: ArchiveExtractRequest): Promise<ArchiveExtractResponse> {
    return this.request(
      'POST',
      `/api/projects/${encodeURIComponent(id)}/tools/archive/extract`,
      body,
    );
  }

  toolRunGit(id: string, body: RunGitRequest): Promise<RunGitResponse> {
    return this.request('POST', `/api/projects/${encodeURIComponent(id)}/tools/git`, body);
  }

  npmInstall(
    id: string,
    body: {
      packages: Array<{ package: string; version?: string }>;
      gezelId?: string;
      sessionId?: string;
    },
  ): Promise<{
    results: Array<
      | { kind: 'installed'; package: string; version: string; stdout: string; stderr: string }
      | {
          kind: 'pending-approval';
          questionId: string;
          package: string;
          version: string;
          deduped: boolean;
        }
      | { kind: 'declined'; package: string; version: string; reason: string }
      | {
          kind: 'failed';
          package: string;
          version: string;
          error: string;
          stdout: string;
          stderr: string;
        }
    >;
  }> {
    return this.request('POST', `/api/projects/${encodeURIComponent(id)}/npm-install`, body);
  }

  runNodejsScript(
    id: string,
    body: { path: string; args?: string[]; timeoutMs?: number },
  ): Promise<{
    ok: boolean;
    code: number;
    stdout: string;
    stderr: string;
    stdoutTruncated: boolean;
    stderrTruncated: boolean;
    timedOut: boolean;
    error?: string;
  }> {
    return this.request('POST', `/api/projects/${encodeURIComponent(id)}/run-nodejs-script`, body);
  }

  /**
   * Derive a data file by executing an inline Node script in the project
   * sandbox — the transform-by-execution channel for json/csv outputs
   * computed from other files. The script never persists in the
   * workspace; the produced output is verified (exists, non-empty,
   * parses as a data table for data extensions) before `ok: true`.
   */
  deriveFile(
    id: string,
    body: { script: string; outputPath: string; timeoutMs?: number },
  ): Promise<{
    ok: boolean;
    code: number;
    stdout: string;
    stderr: string;
    stdoutTruncated: boolean;
    stderrTruncated: boolean;
    timedOut: boolean;
    output?: { path: string; bytes: number; headPreview: string };
    verifyError?: string;
    error?: string;
  }> {
    return this.request('POST', `/api/projects/${encodeURIComponent(id)}/derive-file`, body);
  }

  listPackageScripts(
    id: string,
  ): Promise<{ scripts: Record<string, string>; packageManager?: string }> {
    return this.request('GET', `/api/projects/${encodeURIComponent(id)}/package-scripts`);
  }

  runPackageScript(
    id: string,
    body: {
      script: string;
      args?: string[];
      timeoutMs?: number;
      gezelId?: string;
      sessionId?: string;
    },
  ): Promise<RunWorkspaceCommandResult> {
    return this.request('POST', `/api/projects/${encodeURIComponent(id)}/run-package-script`, body);
  }

  runNpx(
    id: string,
    body: {
      bin: string;
      args?: string[];
      timeoutMs?: number;
      gezelId?: string;
      sessionId?: string;
    },
  ): Promise<RunWorkspaceCommandResult & { resolvedBinPath?: string }> {
    return this.request('POST', `/api/projects/${encodeURIComponent(id)}/run-npx`, body);
  }

  listWorkspaceWrites(
    id: string,
    limit?: number,
  ): Promise<{
    entries: Array<{
      at: string;
      op: 'write' | 'delete' | 'mkdir' | 'rename';
      path: string;
      fromPath?: string;
      bytes?: number;
      sha256?: string;
      gezelId?: string;
      sessionId?: string;
    }>;
  }> {
    const qs = limit ? `?limit=${encodeURIComponent(String(limit))}` : '';
    return this.request('GET', `/api/projects/${encodeURIComponent(id)}/workspace/writes${qs}`);
  }

  installPackage(id: string, body: InstallPackageRequest): Promise<InstallPackageResponse> {
    return this.request('POST', `/api/projects/${encodeURIComponent(id)}/install`, body);
  }

  getProjectApprovals(id: string): Promise<ProjectApprovalsResponse> {
    return this.request('GET', `/api/projects/${encodeURIComponent(id)}/approvals`);
  }

  // ── per-project GitHub ────────────────────────────────────────────

  getProjectGitStatus(id: string): Promise<GitStatusResponse> {
    return this.request('GET', `/api/projects/${encodeURIComponent(id)}/git/status`);
  }

  cloneProjectGit(id: string): Promise<GitCloneResponse> {
    return this.request('POST', `/api/projects/${encodeURIComponent(id)}/git/clone`);
  }

  pullProjectGit(id: string): Promise<{ ok: true; branch?: string; updated: boolean }> {
    return this.request('POST', `/api/projects/${encodeURIComponent(id)}/git/pull`);
  }

  setProjectGitBranch(id: string, branch: string): Promise<{ ok: true; branch: string }> {
    return this.request('POST', `/api/projects/${encodeURIComponent(id)}/git/branch`, {
      branch,
    });
  }

  /** Create a new branch off current HEAD and switch to it. */
  createProjectGitBranch(id: string, branch: string): Promise<{ ok: true; branch: string }> {
    return this.request('POST', `/api/projects/${encodeURIComponent(id)}/git/branch`, {
      branch,
      create: true,
    });
  }

  listProjectGitBranches(id: string): Promise<GitBranchesResponse> {
    return this.request('GET', `/api/projects/${encodeURIComponent(id)}/git/branches`);
  }

  fetchProjectGit(id: string): Promise<GitFetchResponse> {
    return this.request('POST', `/api/projects/${encodeURIComponent(id)}/git/fetch`);
  }

  commitProjectGit(id: string, message: string): Promise<GitCommitResponse> {
    return this.request('POST', `/api/projects/${encodeURIComponent(id)}/git/commit`, {
      message,
    });
  }

  pushProjectGit(id: string): Promise<GitPushResponse> {
    return this.request('POST', `/api/projects/${encodeURIComponent(id)}/git/push`);
  }

  // ── GitHub tab: changes / sync / merge ───────────────────────────

  /** Working-tree changes vs the last save, with per-file +/- stats. */
  getProjectGitChanges(id: string): Promise<GitChangesResponse> {
    return this.request('GET', `/api/projects/${encodeURIComponent(id)}/git/changes`);
  }

  /** Unified diff of one changed file vs the last save. */
  getProjectGitFileDiff(id: string, filePath: string): Promise<GitFileDiffResponse> {
    return this.request(
      'GET',
      `/api/projects/${encodeURIComponent(id)}/git/changes/diff?path=${encodeURIComponent(filePath)}`,
    );
  }

  /** Put files back to their last-saved state (or everything, with `all`). */
  discardProjectGitChanges(
    id: string,
    args: { paths?: string[]; all?: boolean },
  ): Promise<GitDiscardResponse> {
    return this.request('POST', `/api/projects/${encodeURIComponent(id)}/git/discard`, args);
  }

  /** Commit history for the Timeline view, newest first. */
  getProjectGitLog(
    id: string,
    opts: { limit?: number; skip?: number } = {},
  ): Promise<GitLogResponse> {
    const params = new URLSearchParams();
    if (opts.limit !== undefined) params.set('limit', String(opts.limit));
    if (opts.skip !== undefined) params.set('skip', String(opts.skip));
    const qs = params.toString();
    return this.request(
      'GET',
      `/api/projects/${encodeURIComponent(id)}/git/log${qs ? `?${qs}` : ''}`,
    );
  }

  /** One commit with per-file stats and its diff. */
  getProjectGitCommit(id: string, sha: string): Promise<GitCommitDetailResponse> {
    return this.request(
      'GET',
      `/api/projects/${encodeURIComponent(id)}/git/log/${encodeURIComponent(sha)}`,
    );
  }

  /** One-verb sync: fetch + integrate + push. Switch on `state`. */
  syncProjectGit(id: string): Promise<GitSyncResponse> {
    return this.request('POST', `/api/projects/${encodeURIComponent(id)}/git/sync`);
  }

  /** Merge-in-progress state + the list of conflicted files. */
  getProjectGitMergeState(id: string): Promise<GitMergeStateResponse> {
    return this.request('GET', `/api/projects/${encodeURIComponent(id)}/git/merge`);
  }

  /** Base/ours/theirs content for one conflicted file. */
  getProjectGitConflictVersions(
    id: string,
    filePath: string,
  ): Promise<GitConflictVersionsResponse> {
    return this.request(
      'GET',
      `/api/projects/${encodeURIComponent(id)}/git/merge/file?path=${encodeURIComponent(filePath)}`,
    );
  }

  /** Settle one conflicted file: keep mine, keep GitHub's, or custom content. */
  resolveProjectGitConflict(
    id: string,
    args: { path: string; choice: 'mine' | 'theirs' | 'custom'; content?: string },
  ): Promise<GitResolveConflictResponse> {
    return this.request('POST', `/api/projects/${encodeURIComponent(id)}/git/merge/resolve`, args);
  }

  /** Commit the merge once every conflict is settled. */
  completeProjectGitMerge(id: string, message?: string): Promise<GitCompleteMergeResponse> {
    return this.request(
      'POST',
      `/api/projects/${encodeURIComponent(id)}/git/merge/complete`,
      message ? { message } : {},
    );
  }

  /** Cancel an in-progress merge, restoring the pre-sync state. */
  abandonProjectGitMerge(id: string): Promise<GitAbandonMergeResponse> {
    return this.request('POST', `/api/projects/${encodeURIComponent(id)}/git/merge/abandon`);
  }

  /** AI-suggested one-line save description from the current changes. */
  suggestProjectGitMessage(id: string): Promise<GitSuggestMessageResponse> {
    return this.request('POST', `/api/projects/${encodeURIComponent(id)}/git/ai/suggest-message`);
  }

  /** AI-proposed merged content for one conflicted file (preview only). */
  aiResolveProjectGitConflict(id: string, filePath: string): Promise<GitAiMergeResponse> {
    return this.request('POST', `/api/projects/${encodeURIComponent(id)}/git/ai/merge`, {
      path: filePath,
    });
  }

  // ── per-project workspace index ──────────────────────────────────

  /** Read the commands manifest + meta. 404 if not yet indexed. */
  getProjectIndex(id: string): Promise<WorkspaceCommandIndex> {
    return this.request('GET', `/api/projects/${encodeURIComponent(id)}/index`);
  }

  /** Lightweight status (state + meta). Cheap to poll. */
  getProjectIndexStatus(id: string): Promise<WorkspaceIndexStatus> {
    return this.request('GET', `/api/projects/${encodeURIComponent(id)}/index/status`);
  }

  /** Force a re-scan. Returns immediately; poll status for completion. */
  refreshProjectIndex(id: string): Promise<{ ok: true; status: WorkspaceIndexStatus }> {
    return this.request('POST', `/api/projects/${encodeURIComponent(id)}/index/refresh`);
  }

  /** One bounded on-demand enrichment pass ("study now") — loop until `drained`. */
  driveIndexEnrichment(
    id: string,
    body: DriveIndexEnrichmentRequest = {},
  ): Promise<DriveIndexEnrichmentResponse> {
    return this.request('POST', `/api/projects/${encodeURIComponent(id)}/index/enrich`, body);
  }

  /** Read the discovered-skills index for a project. */
  getProjectSkills(id: string): Promise<WorkspaceSkillIndex> {
    return this.request('GET', `/api/projects/${encodeURIComponent(id)}/index/skills`);
  }

  listProjectGitFiles(
    id: string,
  ): Promise<{ files: Array<{ name: string; path: string; isDirectory: boolean }> }> {
    return this.request('GET', `/api/projects/${encodeURIComponent(id)}/git/files`);
  }

  readProjectGitFile(id: string, filePath: string): Promise<{ path: string; content: string }> {
    return this.request(
      'GET',
      `/api/projects/${encodeURIComponent(id)}/git/files/read?path=${encodeURIComponent(filePath)}`,
    );
  }

  startProjectCodeReview(
    id: string,
    args: StartCodeReviewRequest,
  ): Promise<StartCodeReviewResponse> {
    return this.request('POST', `/api/projects/${encodeURIComponent(id)}/git/reviews`, args);
  }

  listProjectCodeReviews(id: string): Promise<ListCodeReviewsResponse> {
    return this.request('GET', `/api/projects/${encodeURIComponent(id)}/git/reviews`);
  }

  getProjectCodeReview(id: string, reviewId: string): Promise<CodeReviewResponse> {
    return this.request(
      'GET',
      `/api/projects/${encodeURIComponent(id)}/git/reviews/${encodeURIComponent(reviewId)}`,
    );
  }

  cancelProjectCodeReview(id: string, reviewId: string): Promise<CancelCodeReviewResponse> {
    return this.request(
      'POST',
      `/api/projects/${encodeURIComponent(id)}/git/reviews/${encodeURIComponent(reviewId)}/cancel`,
    );
  }

  listProjectGitHubPulls(id: string): Promise<ListGitHubPullsResponse> {
    return this.request('GET', `/api/projects/${encodeURIComponent(id)}/github/prs`);
  }

  getProjectGitHubPull(id: string, num: number): Promise<GitHubPullDetail> {
    return this.request('GET', `/api/projects/${encodeURIComponent(id)}/github/prs/${num}`);
  }

  listProjectGitHubPullFiles(id: string, num: number): Promise<ListGitHubPullFilesResponse> {
    return this.request('GET', `/api/projects/${encodeURIComponent(id)}/github/prs/${num}/files`);
  }

  listProjectGitHubPullComments(id: string, num: number): Promise<ListGitHubPullCommentsResponse> {
    return this.request(
      'GET',
      `/api/projects/${encodeURIComponent(id)}/github/prs/${num}/comments`,
    );
  }

  getProjectGitHubPullDiff(id: string, num: number): Promise<GitHubPullDiffResponse> {
    return this.request('GET', `/api/projects/${encodeURIComponent(id)}/github/prs/${num}/diff`);
  }

  createProjectGitHubPullComment(
    id: string,
    num: number,
    body: string,
  ): Promise<GitHubCreateCommentResponse> {
    return this.request(
      'POST',
      `/api/projects/${encodeURIComponent(id)}/github/prs/${num}/comments`,
      { body },
    );
  }

  createProjectGitHubPullRequest(
    id: string,
    args: GitHubCreatePullRequest,
  ): Promise<GitHubCreatePullResponse> {
    return this.request('POST', `/api/projects/${encodeURIComponent(id)}/github/prs`, args);
  }

  listProjectGitHubWorkflowRuns(
    id: string,
    branch: string,
    limit?: number,
  ): Promise<ListGitHubWorkflowRunsResponse> {
    const params = new URLSearchParams({ branch });
    if (limit !== undefined) params.set('limit', String(limit));
    return this.request(
      'GET',
      `/api/projects/${encodeURIComponent(id)}/github/workflow-runs?${params.toString()}`,
    );
  }

  getProjectGitHubChecks(id: string, ref: string): Promise<GitHubCheckStatusResponse> {
    return this.request(
      'GET',
      `/api/projects/${encodeURIComponent(id)}/github/checks?ref=${encodeURIComponent(ref)}`,
    );
  }

  // ── documents (shared library, not scoped to project/agent) ──

  /**
   * Unified cross-project search backing the titlebar box. `mode: 'names'`
   * returns the instant quick-open catalog only; `mode: 'full'` (default)
   * adds the content fan-out.
   */
  search(
    query: string,
    opts: { mode?: 'names' | 'full'; maxResults?: number; signal?: AbortSignal } = {},
  ): Promise<UnifiedSearchResponse> {
    const { signal, ...body } = opts;
    return this.request('POST', '/api/search', { query, ...body }, undefined, signal);
  }

  /** Instant name-only quick-open over the search catalog. */
  quickOpen(
    query: string,
    opts: { limit?: number; signal?: AbortSignal } = {},
  ): Promise<UnifiedSearchResponse> {
    const params = new URLSearchParams({ q: query });
    if (opts.limit) params.set('limit', String(opts.limit));
    return this.request(
      'GET',
      `/api/search/quick?${params.toString()}`,
      undefined,
      undefined,
      opts.signal,
    );
  }

  getHandboekToc(): Promise<HandboekToc> {
    return this.request('GET', '/api/handboek/toc');
  }

  getHandboekArticle(
    id: string,
    opts: { mode?: HandboekRenderMode } = {},
  ): Promise<HandboekArticle> {
    const qs = opts.mode ? `?mode=${opts.mode}` : '';
    const encoded = id.split('/').map(encodeURIComponent).join('/');
    return this.request('GET', `/api/handboek/article/${encoded}${qs}`);
  }

  /**
   * Per-block narration manifest for a handboek article. 409s when the
   * TTS engine isn't installed/healthy — gate on `getAudioEngineStatus`
   * first.
   */
  getHandboekNarration(
    id: string,
    opts: { voice?: string } = {},
  ): Promise<HandboekNarrationResponse> {
    const qs = opts.voice ? `?voice=${encodeURIComponent(opts.voice)}` : '';
    const encoded = id.split('/').map(encodeURIComponent).join('/');
    return this.request('GET', `/api/handboek/narration/article/${encoded}${qs}`);
  }

  /** Best-matching handboek articles for a plain-language question, agent-tailored. */
  handboekHowDoI(question: string, opts: { limit?: number } = {}): Promise<HandboekHowDoIResponse> {
    const params = new URLSearchParams({ q: question });
    if (opts.limit) params.set('limit', String(opts.limit));
    return this.request('GET', `/api/handboek/how-do-i?${params.toString()}`);
  }

  /** Narration segment WAV — same bearer-in-fetch pattern as the artifact blobs. */
  async fetchHandboekNarrationAudio(hash: string): Promise<Blob> {
    const url = `${this.baseUrl}/api/handboek/narration/audio/${hash}`;
    const res = await this.fetchImpl(url, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) throw new Error(`narration fetch failed: ${res.status}`);
    return res.blob();
  }

  listDocuments(
    subpath?: string,
    recursive?: boolean,
  ): Promise<{ files: Array<{ name: string; path: string; isDirectory: boolean }> }> {
    const params = new URLSearchParams();
    if (subpath) params.set('path', subpath);
    if (recursive) params.set('recursive', '1');
    const qs = params.toString() ? `?${params.toString()}` : '';
    return this.request('GET', `/api/documents${qs}`);
  }

  readDocument(filePath: string): Promise<{
    path: string;
    content: string;
    /**
     * What the server actually resolved the path to.
     *   - `document`: global shared library
     *   - `project-document`: per-project `documents/` folder
     *   - `artifact`: per-project `artifacts/` folder (fuzzy fallback)
     * Older service responses may omit this field.
     */
    kind?: 'document' | 'project-document' | 'artifact';
    /** Only present when a fuzzy fallback resolved the path. */
    resolvedFrom?: { projectId: string; relativePath: string };
  }> {
    return this.request('GET', `/api/documents/read?path=${encodeURIComponent(filePath)}`);
  }

  writeDocument(filePath: string, content: string): Promise<{ ok: true; path: string }> {
    return this.request('PUT', '/api/documents/write', {
      path: filePath,
      content,
    });
  }

  /**
   * Binary sibling of `writeDocument`. Writes raw bytes to a path under
   * the shared documents library. Used by the squisq editor's Files
   * panel for image uploads and other media-sidecar writes.
   */
  async writeDocumentBinary(
    filePath: string,
    data: Blob | ArrayBuffer | Uint8Array,
    mimeType: string,
  ): Promise<{ ok: true; path: string }> {
    const url = `${this.baseUrl}/api/documents/raw?path=${encodeURIComponent(filePath)}`;
    const body =
      data instanceof Blob
        ? data
        : data instanceof Uint8Array
          ? data
          : new Uint8Array(data as ArrayBuffer);
    const res = await this.fetchImpl(url, {
      method: 'PUT',
      headers: {
        'content-type': mimeType,
        Authorization: `Bearer ${this.token}`,
      },
      body,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`document binary write failed (${res.status}): ${text}`);
    }
    return res.json() as Promise<{ ok: true; path: string }>;
  }

  /**
   * Fetch a document file as a Blob via the `?raw=1` mode of
   * `/api/documents/read`. `<img src>` can't carry a bearer token, so
   * the editor's MediaProvider goes through this and creates a blob URL.
   */
  async fetchDocumentBlob(filePath: string): Promise<Blob> {
    const url = `${this.baseUrl}/api/documents/read?path=${encodeURIComponent(filePath)}&raw=1`;
    const res = await this.fetchImpl(url, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) throw new Error(`document fetch failed: ${res.status}`);
    return res.blob();
  }

  /**
   * Render the current document text to MP4/GIF through gezeld. The daemon
   * uses Squisq's native renderer and an ffmpeg discovered from the host
   * environment; no browser-side ffmpeg.wasm runtime is downloaded.
   */
  async exportDocumentMedia(
    request: DocumentMediaExportRequest,
    signal?: AbortSignal,
  ): Promise<Blob> {
    const url = `${this.baseUrl}/api/document-media-export`;
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify(request),
      signal,
    });
    if (!res.ok) {
      const fallback = `document media export failed (${res.status})`;
      const error = await res
        .json()
        .then((body) =>
          body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
            ? body.error
            : fallback,
        )
        .catch(() => fallback);
      throw new Error(error);
    }
    return res.blob();
  }

  deleteDocument(filePath: string): Promise<{ ok: true }> {
    return this.request('DELETE', `/api/documents/delete?path=${encodeURIComponent(filePath)}`);
  }

  createDocumentFolder(folderPath: string): Promise<{ ok: true; path: string }> {
    return this.request('POST', '/api/documents/mkdir', { path: folderPath });
  }

  renameDocument(
    fromPath: string,
    toPath: string,
  ): Promise<{ ok: true; fromPath: string; toPath: string }> {
    return this.request('POST', '/api/documents/rename', { fromPath, toPath });
  }

  // ── tasks (per-project, stable numeric IDs) ──

  listTasks(filter?: { status?: TaskStatus; assignee?: string }): Promise<ListTasksResponse> {
    const params = new URLSearchParams();
    if (filter?.status) params.set('status', filter.status);
    if (filter?.assignee) params.set('assignee', filter.assignee);
    const qs = params.toString() ? `?${params.toString()}` : '';
    return this.request('GET', `/api/tasks${qs}`);
  }

  listProjectTasks(
    projectId: string,
    filter?: { status?: TaskStatus; assignee?: string },
  ): Promise<ListTasksResponse> {
    const params = new URLSearchParams();
    if (filter?.status) params.set('status', filter.status);
    if (filter?.assignee) params.set('assignee', filter.assignee);
    const qs = params.toString() ? `?${params.toString()}` : '';
    return this.request('GET', `/api/projects/${encodeURIComponent(projectId)}/tasks${qs}`);
  }

  /** `body.dispatchEntry: true` = single-channel kickoff (entry step handed off at create). */
  createTask(projectId: string, body: CreateTaskRequest): Promise<Task> {
    return this.request('POST', `/api/projects/${encodeURIComponent(projectId)}/tasks`, body);
  }

  getTask(projectId: string, num: number): Promise<Task> {
    return this.request('GET', `/api/projects/${encodeURIComponent(projectId)}/tasks/${num}`);
  }

  getTaskByRef(ref: string): Promise<Task> {
    const parsed = parseTaskRef(ref);
    // This method's public contract is promise-based. Returning a rejection
    // keeps malformed or stale persisted refs inside callers' normal
    // `.catch()` / async error paths instead of throwing synchronously from a
    // React effect and unmounting the renderer.
    if (!parsed) return Promise.reject(new Error(`invalid task ref "${ref}"`));
    return this.getTask(parsed.projectId, parsed.num);
  }

  updateTask(projectId: string, num: number, body: UpdateTaskRequest): Promise<Task> {
    return this.request(
      'PATCH',
      `/api/projects/${encodeURIComponent(projectId)}/tasks/${num}`,
      body,
    );
  }

  setTaskStatus(projectId: string, num: number, status: TaskStatus): Promise<Task> {
    return this.request(
      'POST',
      `/api/projects/${encodeURIComponent(projectId)}/tasks/${num}/status`,
      { status },
    );
  }

  /**
   * Activate a draft task (draft → active), kicking off its entry step.
   * `force` bypasses the plan-readiness guardrails (the UI's "Approve anyway").
   */
  activateTask(projectId: string, num: number, force = false): Promise<Task> {
    return this.request(
      'POST',
      `/api/projects/${encodeURIComponent(projectId)}/tasks/${num}/activate`,
      force ? { force: true } : {},
    );
  }

  setTaskAssignee(projectId: string, num: number, assignee: TaskAssignee): Promise<Task> {
    return this.updateTask(projectId, num, { assignee });
  }

  addTaskStep(
    projectId: string,
    num: number,
    step: NewCraftbookStep,
    pos?: StepPosition,
  ): Promise<Task> {
    return this.request(
      'POST',
      `/api/projects/${encodeURIComponent(projectId)}/tasks/${num}/steps`,
      { ...step, ...(pos ?? {}) },
    );
  }

  activateTaskStep(projectId: string, num: number, stepId: string): Promise<Task> {
    return this.request(
      'POST',
      `/api/projects/${encodeURIComponent(projectId)}/tasks/${num}/steps/${encodeURIComponent(stepId)}/activate`,
    );
  }

  completeTaskStep(
    projectId: string,
    num: number,
    stepId: string,
    body: CompleteStepRequest = {},
  ): Promise<CompleteStepResponse> {
    return this.request(
      'POST',
      `/api/projects/${encodeURIComponent(projectId)}/tasks/${num}/steps/${encodeURIComponent(stepId)}/complete`,
      body,
    );
  }

  updateTaskStep(
    projectId: string,
    num: number,
    stepId: string,
    body: UpdateTaskStepRequest,
  ): Promise<UpdateTaskStepResponse> {
    return this.request(
      'PATCH',
      `/api/projects/${encodeURIComponent(projectId)}/tasks/${num}/steps/${encodeURIComponent(stepId)}`,
      body,
    );
  }

  removeTaskStep(projectId: string, num: number, stepId: string): Promise<UpdateTaskStepResponse> {
    return this.request(
      'DELETE',
      `/api/projects/${encodeURIComponent(projectId)}/tasks/${num}/steps/${encodeURIComponent(stepId)}`,
    );
  }

  reorderTaskSteps(
    projectId: string,
    num: number,
    order: string[],
  ): Promise<UpdateTaskStepResponse> {
    return this.request(
      'PATCH',
      `/api/projects/${encodeURIComponent(projectId)}/tasks/${num}/craftbook/steps/order`,
      { order },
    );
  }

  /** Patch the overall metadata (name/description/plan/defaultAssignee/entryStepId) of a task's craftbook. */
  updateTaskCraftbook(
    projectId: string,
    num: number,
    body: UpdateTaskCraftbookRequest,
  ): Promise<UpdateTaskStepResponse> {
    return this.request(
      'PATCH',
      `/api/projects/${encodeURIComponent(projectId)}/tasks/${num}/craftbook`,
      body,
    );
  }

  /** Promote a task's embedded craftbook into a reusable local template. */
  exportTaskCraftbook(
    projectId: string,
    num: number,
    body: { id?: string; name?: string } = {},
  ): Promise<CraftbookResponse> {
    return this.request(
      'POST',
      `/api/projects/${encodeURIComponent(projectId)}/tasks/${num}/export-craftbook`,
      body,
    );
  }

  listTaskNotes(projectId: string, num: number, stepId?: string): Promise<ListTaskNotesResponse> {
    const qs = stepId ? `?step=${encodeURIComponent(stepId)}` : '';
    return this.request(
      'GET',
      `/api/projects/${encodeURIComponent(projectId)}/tasks/${num}/notes${qs}`,
    );
  }

  appendTaskNote(
    projectId: string,
    num: number,
    body: AppendTaskNoteRequest,
    opts: { actorGezelId?: string } = {},
  ): Promise<AppendTaskNoteResponse> {
    return this.request(
      'POST',
      `/api/projects/${encodeURIComponent(projectId)}/tasks/${num}/notes`,
      body,
      opts.actorGezelId ? { 'x-gezel-actor': opts.actorGezelId } : undefined,
    );
  }

  updateTaskNote(
    projectId: string,
    num: number,
    noteId: string,
    body: UpdateTaskNoteRequest,
    opts: { actorGezelId?: string } = {},
  ): Promise<UpdateTaskNoteResponse> {
    return this.request(
      'PATCH',
      `/api/projects/${encodeURIComponent(projectId)}/tasks/${num}/notes/${encodeURIComponent(noteId)}`,
      body,
      opts.actorGezelId ? { 'x-gezel-actor': opts.actorGezelId } : undefined,
    );
  }

  deleteTaskNote(
    projectId: string,
    num: number,
    noteId: string,
    opts: { actorGezelId?: string } = {},
  ): Promise<{ ok: true }> {
    return this.request(
      'DELETE',
      `/api/projects/${encodeURIComponent(projectId)}/tasks/${num}/notes/${encodeURIComponent(noteId)}`,
      undefined,
      opts.actorGezelId ? { 'x-gezel-actor': opts.actorGezelId } : undefined,
    );
  }

  listProjectScripts(projectId: string): Promise<ListScriptsResponse> {
    return this.request('GET', `/api/projects/${encodeURIComponent(projectId)}/scripts`);
  }

  runProjectScript(projectId: string, body: RunScriptRequest): Promise<RunScriptResponse> {
    return this.request('POST', `/api/projects/${encodeURIComponent(projectId)}/scripts/run`, body);
  }

  /**
   * First-party bridge behind interactive type pages: run one of the
   * applied type's declared `pages.tools` (and fire its reaction). Called
   * by the Output pane's postMessage handler on behalf of a served page.
   */
  invokeProjectPageTool(
    projectId: string,
    body: InvokePageToolRequest,
  ): Promise<InvokePageToolResponse> {
    return this.request('POST', `/api/projects/${encodeURIComponent(projectId)}/page-invoke`, body);
  }

  getProjectScriptRun(projectId: string, runId: string): Promise<ScriptRun> {
    return this.request(
      'GET',
      `/api/projects/${encodeURIComponent(projectId)}/script-runs/${encodeURIComponent(runId)}`,
    );
  }

  /** Raw script source for the editor — works even when the meta is broken. */
  getProjectScriptSource(projectId: string, name: string): Promise<GetScriptSourceResponse> {
    return this.request(
      'GET',
      `/api/projects/${encodeURIComponent(projectId)}/scripts/source?name=${encodeURIComponent(name)}`,
    );
  }

  saveProjectScriptSource(
    projectId: string,
    body: SaveScriptSourceRequest,
  ): Promise<SaveScriptSourceResponse> {
    return this.request(
      'PUT',
      `/api/projects/${encodeURIComponent(projectId)}/scripts/source`,
      body,
    );
  }

  createProjectScript(projectId: string, body: CreateScriptRequest): Promise<CreateScriptResponse> {
    return this.request('POST', `/api/projects/${encodeURIComponent(projectId)}/scripts`, body);
  }

  /** AI-draft a script from a plain-language description of what it should do. */
  draftProjectScript(projectId: string, body: DraftScriptRequest): Promise<DraftScriptResponse> {
    return this.request(
      'POST',
      `/api/projects/${encodeURIComponent(projectId)}/scripts/draft`,
      body,
    );
  }

  deleteProjectScript(projectId: string, name: string): Promise<{ ok: true }> {
    return this.request(
      'DELETE',
      `/api/projects/${encodeURIComponent(projectId)}/scripts/source?name=${encodeURIComponent(name)}`,
    );
  }

  /**
   * SDK typings for the script editor's IntelliSense. Served by the
   * daemon so the types always match the SDK it sandbox-vendors.
   */
  getSdkTypes(): Promise<SdkTypesResponse> {
    return this.request('GET', '/api/sdk/types');
  }

  /** The packed-in standard gate-script library (read-only). */
  listStandardScripts(): Promise<ListScriptsResponse> {
    return this.request('GET', '/api/scripts/standard');
  }

  getStandardScriptSource(name: string): Promise<GetScriptSourceResponse> {
    return this.request('GET', `/api/scripts/standard/source?name=${encodeURIComponent(name)}`);
  }

  /** The user's machine-wide script library (~/.gezel/scripts). */
  listUserScripts(): Promise<ListScriptsResponse> {
    return this.request('GET', '/api/scripts/user');
  }

  getUserScriptSource(name: string): Promise<GetScriptSourceResponse> {
    return this.request('GET', `/api/scripts/user/source?name=${encodeURIComponent(name)}`);
  }

  saveUserScriptSource(body: SaveScriptSourceRequest): Promise<SaveScriptSourceResponse> {
    return this.request('PUT', '/api/scripts/user/source', body);
  }

  createUserScript(body: CreateScriptRequest): Promise<CreateScriptResponse> {
    return this.request('POST', '/api/scripts/user', body);
  }

  deleteUserScript(name: string): Promise<{ ok: true }> {
    return this.request('DELETE', `/api/scripts/user/source?name=${encodeURIComponent(name)}`);
  }

  /**
   * List named credentials currently stored in the workspace.
   * `stored: false` entries are known-to-the-schema but no value is
   * saved — the UI should still show them so the user can see what
   * IS available if they configure the provider.
   */
  listAvailableCredentials(): Promise<{
    credentials: Array<{
      name: string;
      label: string;
      stored: boolean;
      /** Effective destinations enforced by script HTTP. */
      allowedOrigins: string[];
      originSource: 'provider' | 'webhook' | 'project';
      /** @deprecated Use `allowedOrigins`. */
      defaultOrigins: string[];
    }>;
  }> {
    return this.request('GET', '/api/credentials/available');
  }

  listTaskSessions(projectId: string, num: number): Promise<ListChatSessionsResponse> {
    return this.request(
      'GET',
      `/api/projects/${encodeURIComponent(projectId)}/tasks/${num}/sessions`,
    );
  }

  listTaskChildren(
    projectId: string,
    num: number,
    filter?: { status?: TaskStatus; limit?: number },
  ): Promise<ListTasksResponse> {
    const params = new URLSearchParams();
    if (filter?.status) params.set('status', filter.status);
    if (filter?.limit) params.set('limit', String(filter.limit));
    const qs = params.toString() ? `?${params.toString()}` : '';
    return this.request(
      'GET',
      `/api/projects/${encodeURIComponent(projectId)}/tasks/${num}/children${qs}`,
    );
  }

  /**
   * Imperative fanout — spawn `count` children from the parent. Omit
   * `count` to materialize the declarative `fanout` config (if any).
   */
  spawnTaskInstances(
    projectId: string,
    num: number,
    body: SpawnTaskInstancesRequest = {},
  ): Promise<{ parent?: Task; children: Task[] }> {
    return this.request(
      'POST',
      `/api/projects/${encodeURIComponent(projectId)}/tasks/${num}/spawn`,
      body,
    );
  }

  /** For the SSE client — callers need the raw bearer header. */
  authHeader(): { Authorization: string } {
    return { Authorization: `Bearer ${this.token}` };
  }

  /**
   * Daemon base URL. Surfaced for code paths that don't go through
   * the typed client — currently the UI's Connected Apps panel,
   * which hits `/v1/apps/*` (the public app surface, deliberately
   * NOT wrapped by the internal client). Returned without a trailing
   * slash.
   */
  getBaseUrl(): string {
    return this.baseUrl;
  }

  /**
   * The (possibly injected) `fetch` this client uses. Surfaced so the
   * SSE helpers and other side-channel callers route through the same
   * transport — critical for the VS Code webview, which swaps in a
   * postMessage-RPC fetch via `window.__GEZEL__.fetch`. Returns the
   * already-bound impl from the constructor (don't re-bind).
   */
  getFetch(): typeof fetch {
    return this.fetchImpl;
  }

  /* ── Craftbooks ─────────────────────────────────────────────────── */

  listCraftbooks(
    opts: { source?: 'bundled' | 'local' | 'project' | 'all'; projectId?: string } = {},
  ): Promise<ListCraftbooksResponse> {
    const params: string[] = [];
    if (opts.source) params.push(`source=${opts.source}`);
    if (opts.projectId) params.push(`projectId=${encodeURIComponent(opts.projectId)}`);
    const qs = params.length ? `?${params.join('&')}` : '';
    return this.request('GET', `/api/craftbooks${qs}`);
  }

  getCraftbook(
    id: string,
    opts: { version?: string; source?: 'bundled' | 'local' | 'project'; projectId?: string } = {},
  ): Promise<CraftbookResponse> {
    const params: string[] = [];
    if (opts.version) params.push(`version=${encodeURIComponent(opts.version)}`);
    if (opts.source) params.push(`source=${opts.source}`);
    if (opts.projectId) params.push(`projectId=${encodeURIComponent(opts.projectId)}`);
    const qs = params.length ? `?${params.join('&')}` : '';
    return this.request('GET', `/api/craftbooks/${encodeURIComponent(id)}${qs}`);
  }

  /**
   * Rank the applicable craftbooks against a free-text task description and
   * return the top-K shortlist. The selection entry point — turns "100s of
   * books" into 3-5 a small-model voorman can choose from, or that the
   * meester pins into a kickoff task.
   */
  suggestCraftbooks(body: {
    query: string;
    projectId?: string;
    topK?: number;
  }): Promise<SuggestCraftbooksResponse> {
    return this.request('POST', '/api/craftbooks/suggest', body);
  }

  /* ── Craftbook documents (whole-book read/write, JSON or markdown) ── */

  getCraftbookDocument(
    id: string,
    opts: {
      format?: 'json' | 'md' | 'markdown';
      version?: string;
      source?: 'bundled' | 'local' | 'project';
      projectId?: string;
    } = {},
  ): Promise<{ format: 'json' | 'markdown'; content: string }> {
    const params: string[] = [];
    if (opts.format) params.push(`format=${opts.format}`);
    if (opts.version) params.push(`version=${encodeURIComponent(opts.version)}`);
    if (opts.source) params.push(`source=${opts.source}`);
    if (opts.projectId) params.push(`projectId=${encodeURIComponent(opts.projectId)}`);
    const qs = params.length ? `?${params.join('&')}` : '';
    return this.request('GET', `/api/craftbooks/${encodeURIComponent(id)}/document${qs}`);
  }

  /** Create a local (or project) craftbook from one whole document. 422 = repair-grade errors. */
  createCraftbookDocument(body: {
    content: string;
    format?: 'json' | 'md' | 'markdown';
    projectId?: string;
  }): Promise<CraftbookDocumentWriteResponse> {
    return this.request('POST', '/api/craftbooks/document', body);
  }

  /** Replace an existing local (or project) craftbook from one whole document. */
  putCraftbookDocument(
    id: string,
    body: { content: string; format?: 'json' | 'md' | 'markdown'; projectId?: string },
  ): Promise<CraftbookDocumentWriteResponse> {
    return this.request('PUT', `/api/craftbooks/${encodeURIComponent(id)}/document`, body);
  }

  /** Whole-document read of a task's embedded craftbook. */
  getTaskCraftbookDocument(
    projectId: string,
    num: number,
    opts: { format?: 'json' | 'md' | 'markdown' } = {},
  ): Promise<{ format: 'json' | 'markdown'; content: string }> {
    const qs = opts.format ? `?format=${opts.format}` : '';
    return this.request(
      'GET',
      `/api/projects/${encodeURIComponent(projectId)}/tasks/${num}/craftbook/document${qs}`,
    );
  }

  /** Whole-document replace of a task's embedded craftbook (lifecycle fields survive by step id). */
  putTaskCraftbookDocument(
    projectId: string,
    num: number,
    body: { content: string; format?: 'json' | 'md' | 'markdown' },
  ): Promise<{ task: Task; format: 'json' | 'markdown'; stepCount: number; gatedSteps: number }> {
    return this.request(
      'PUT',
      `/api/projects/${encodeURIComponent(projectId)}/tasks/${num}/craftbook/document`,
      body,
    );
  }

  /* ─── Project-local gezels + import review ──────────────────────────── */

  /**
   * List the project's OWN gezels — the `@project` gezel + any defined in
   * the workspace `.gezel/` folder. Distinct from {@link listProjectGezels},
   * which returns the project roster (gezelIds of global gezels pulled in).
   */
  listProjectLocalGezels(projectId: string): Promise<ListGezelsResponse> {
    return this.request('GET', `/api/projects/${encodeURIComponent(projectId)}/local-gezels`);
  }

  getProjectLocalGezel(projectId: string, localId: string): Promise<GezelResponse> {
    return this.request(
      'GET',
      `/api/projects/${encodeURIComponent(projectId)}/local-gezels/${encodeURIComponent(localId)}`,
    );
  }

  createProjectLocalGezel(
    projectId: string,
    body: { name: string; localId?: string; description?: string; role?: string; model?: string },
  ): Promise<GezelResponse> {
    return this.request(
      'POST',
      `/api/projects/${encodeURIComponent(projectId)}/local-gezels`,
      body,
    );
  }

  deleteProjectLocalGezel(projectId: string, localId: string): Promise<{ ok: true }> {
    return this.request(
      'DELETE',
      `/api/projects/${encodeURIComponent(projectId)}/local-gezels/${encodeURIComponent(localId)}`,
    );
  }

  copyGezelToProject(
    projectId: string,
    body: { gezelId: string; mode: 'local' | 'agents-md' },
  ): Promise<unknown> {
    return this.request(
      'POST',
      `/api/projects/${encodeURIComponent(projectId)}/local-gezels/copy`,
      body,
    );
  }

  getProjectImportsPending(projectId: string): Promise<PendingImports> {
    return this.request('GET', `/api/projects/${encodeURIComponent(projectId)}/imports/pending`);
  }

  approveProjectImport(
    projectId: string,
    skillSource: string,
  ): Promise<{ ok: true; craftbookId: string }> {
    return this.request('POST', `/api/projects/${encodeURIComponent(projectId)}/imports/approve`, {
      skillSource,
    });
  }

  rejectProjectImport(
    projectId: string,
    skillSource: string,
  ): Promise<{ ok: true; craftbookId: string }> {
    return this.request('POST', `/api/projects/${encodeURIComponent(projectId)}/imports/reject`, {
      skillSource,
    });
  }

  convertProjectImport(
    projectId: string,
    skillSource: string,
    opts?: { allowLlm?: boolean },
  ): Promise<{
    status: 'written' | 'queued' | 'user-edited' | 'not-found' | 'failed';
    craftbookId?: string;
    scripts: number;
    persona?: string;
    notes: string[];
  }> {
    return this.request('POST', `/api/projects/${encodeURIComponent(projectId)}/imports/convert`, {
      skillSource,
      ...(opts?.allowLlm !== undefined ? { allowLlm: opts.allowLlm } : {}),
    });
  }

  createCraftbook(body: CreateCraftbookRequest): Promise<CraftbookResponse> {
    return this.request('POST', '/api/craftbooks', body);
  }

  updateCraftbook(id: string, body: UpdateCraftbookRequest): Promise<CraftbookResponse> {
    return this.request('PATCH', `/api/craftbooks/${encodeURIComponent(id)}`, body);
  }

  deleteCraftbook(id: string): Promise<{ ok: true }> {
    return this.request('DELETE', `/api/craftbooks/${encodeURIComponent(id)}`);
  }

  /* ── Craftbook-bundled scripts ──────────────────────────────────── */

  listCraftbookScripts(id: string): Promise<{ scripts: Array<{ name: string }> }> {
    return this.request('GET', `/api/craftbooks/${encodeURIComponent(id)}/scripts`);
  }

  getCraftbookScriptSource(id: string, name: string): Promise<GetScriptSourceResponse> {
    return this.request(
      'GET',
      `/api/craftbooks/${encodeURIComponent(id)}/scripts/source?name=${encodeURIComponent(name)}`,
    );
  }

  saveCraftbookScriptSource(
    id: string,
    body: SaveScriptSourceRequest,
  ): Promise<SaveScriptSourceResponse> {
    return this.request('PUT', `/api/craftbooks/${encodeURIComponent(id)}/scripts/source`, body);
  }

  createCraftbookScript(
    id: string,
    body: CreateScriptRequest,
  ): Promise<{ name: string; source: string; hash: string }> {
    return this.request('POST', `/api/craftbooks/${encodeURIComponent(id)}/scripts`, body);
  }

  deleteCraftbookScript(id: string, name: string): Promise<{ ok: true }> {
    return this.request(
      'DELETE',
      `/api/craftbooks/${encodeURIComponent(id)}/scripts/source?name=${encodeURIComponent(name)}`,
    );
  }
  // ── Deprecated aliases — Git/GitHub naming realignment ──
  // Local-git methods were renamed *ProjectGithub* → *ProjectGit* (and now
  // call the canonical /git/ routes); GitHub web-service methods gained a
  // capital H. These delegating aliases keep the published surface
  // compiling; removal is a future breaking release.

  /** @deprecated Use {@link GezelClient.getProjectGitStatus}. */
  getProjectGithubStatus(
    ...args: Parameters<GezelClient['getProjectGitStatus']>
  ): ReturnType<GezelClient['getProjectGitStatus']> {
    return this.getProjectGitStatus(...args);
  }

  /** @deprecated Use {@link GezelClient.cloneProjectGit}. */
  cloneProjectGithub(
    ...args: Parameters<GezelClient['cloneProjectGit']>
  ): ReturnType<GezelClient['cloneProjectGit']> {
    return this.cloneProjectGit(...args);
  }

  /** @deprecated Use {@link GezelClient.pullProjectGit}. */
  pullProjectGithub(
    ...args: Parameters<GezelClient['pullProjectGit']>
  ): ReturnType<GezelClient['pullProjectGit']> {
    return this.pullProjectGit(...args);
  }

  /** @deprecated Use {@link GezelClient.setProjectGitBranch}. */
  setProjectGithubBranch(
    ...args: Parameters<GezelClient['setProjectGitBranch']>
  ): ReturnType<GezelClient['setProjectGitBranch']> {
    return this.setProjectGitBranch(...args);
  }

  /** @deprecated Use {@link GezelClient.createProjectGitBranch}. */
  createProjectGithubBranch(
    ...args: Parameters<GezelClient['createProjectGitBranch']>
  ): ReturnType<GezelClient['createProjectGitBranch']> {
    return this.createProjectGitBranch(...args);
  }

  /** @deprecated Use {@link GezelClient.listProjectGitBranches}. */
  listProjectGithubBranches(
    ...args: Parameters<GezelClient['listProjectGitBranches']>
  ): ReturnType<GezelClient['listProjectGitBranches']> {
    return this.listProjectGitBranches(...args);
  }

  /** @deprecated Use {@link GezelClient.fetchProjectGit}. */
  fetchProjectGithub(
    ...args: Parameters<GezelClient['fetchProjectGit']>
  ): ReturnType<GezelClient['fetchProjectGit']> {
    return this.fetchProjectGit(...args);
  }

  /** @deprecated Use {@link GezelClient.commitProjectGit}. */
  commitProjectGithub(
    ...args: Parameters<GezelClient['commitProjectGit']>
  ): ReturnType<GezelClient['commitProjectGit']> {
    return this.commitProjectGit(...args);
  }

  /** @deprecated Use {@link GezelClient.pushProjectGit}. */
  pushProjectGithub(
    ...args: Parameters<GezelClient['pushProjectGit']>
  ): ReturnType<GezelClient['pushProjectGit']> {
    return this.pushProjectGit(...args);
  }

  /** @deprecated Use {@link GezelClient.getProjectGitChanges}. */
  getProjectGithubChanges(
    ...args: Parameters<GezelClient['getProjectGitChanges']>
  ): ReturnType<GezelClient['getProjectGitChanges']> {
    return this.getProjectGitChanges(...args);
  }

  /** @deprecated Use {@link GezelClient.getProjectGitFileDiff}. */
  getProjectGithubFileDiff(
    ...args: Parameters<GezelClient['getProjectGitFileDiff']>
  ): ReturnType<GezelClient['getProjectGitFileDiff']> {
    return this.getProjectGitFileDiff(...args);
  }

  /** @deprecated Use {@link GezelClient.discardProjectGitChanges}. */
  discardProjectGithubChanges(
    ...args: Parameters<GezelClient['discardProjectGitChanges']>
  ): ReturnType<GezelClient['discardProjectGitChanges']> {
    return this.discardProjectGitChanges(...args);
  }

  /** @deprecated Use {@link GezelClient.getProjectGitLog}. */
  getProjectGithubLog(
    ...args: Parameters<GezelClient['getProjectGitLog']>
  ): ReturnType<GezelClient['getProjectGitLog']> {
    return this.getProjectGitLog(...args);
  }

  /** @deprecated Use {@link GezelClient.getProjectGitCommit}. */
  getProjectGithubCommit(
    ...args: Parameters<GezelClient['getProjectGitCommit']>
  ): ReturnType<GezelClient['getProjectGitCommit']> {
    return this.getProjectGitCommit(...args);
  }

  /** @deprecated Use {@link GezelClient.syncProjectGit}. */
  syncProjectGithub(
    ...args: Parameters<GezelClient['syncProjectGit']>
  ): ReturnType<GezelClient['syncProjectGit']> {
    return this.syncProjectGit(...args);
  }

  /** @deprecated Use {@link GezelClient.getProjectGitMergeState}. */
  getProjectGithubMergeState(
    ...args: Parameters<GezelClient['getProjectGitMergeState']>
  ): ReturnType<GezelClient['getProjectGitMergeState']> {
    return this.getProjectGitMergeState(...args);
  }

  /** @deprecated Use {@link GezelClient.getProjectGitConflictVersions}. */
  getProjectGithubConflictVersions(
    ...args: Parameters<GezelClient['getProjectGitConflictVersions']>
  ): ReturnType<GezelClient['getProjectGitConflictVersions']> {
    return this.getProjectGitConflictVersions(...args);
  }

  /** @deprecated Use {@link GezelClient.resolveProjectGitConflict}. */
  resolveProjectGithubConflict(
    ...args: Parameters<GezelClient['resolveProjectGitConflict']>
  ): ReturnType<GezelClient['resolveProjectGitConflict']> {
    return this.resolveProjectGitConflict(...args);
  }

  /** @deprecated Use {@link GezelClient.completeProjectGitMerge}. */
  completeProjectGithubMerge(
    ...args: Parameters<GezelClient['completeProjectGitMerge']>
  ): ReturnType<GezelClient['completeProjectGitMerge']> {
    return this.completeProjectGitMerge(...args);
  }

  /** @deprecated Use {@link GezelClient.abandonProjectGitMerge}. */
  abandonProjectGithubMerge(
    ...args: Parameters<GezelClient['abandonProjectGitMerge']>
  ): ReturnType<GezelClient['abandonProjectGitMerge']> {
    return this.abandonProjectGitMerge(...args);
  }

  /** @deprecated Use {@link GezelClient.suggestProjectGitMessage}. */
  suggestProjectGithubMessage(
    ...args: Parameters<GezelClient['suggestProjectGitMessage']>
  ): ReturnType<GezelClient['suggestProjectGitMessage']> {
    return this.suggestProjectGitMessage(...args);
  }

  /** @deprecated Use {@link GezelClient.aiResolveProjectGitConflict}. */
  aiResolveProjectGithubConflict(
    ...args: Parameters<GezelClient['aiResolveProjectGitConflict']>
  ): ReturnType<GezelClient['aiResolveProjectGitConflict']> {
    return this.aiResolveProjectGitConflict(...args);
  }

  /** @deprecated Use {@link GezelClient.listProjectGitFiles}. */
  listProjectGithubFiles(
    ...args: Parameters<GezelClient['listProjectGitFiles']>
  ): ReturnType<GezelClient['listProjectGitFiles']> {
    return this.listProjectGitFiles(...args);
  }

  /** @deprecated Use {@link GezelClient.readProjectGitFile}. */
  readProjectGithubFile(
    ...args: Parameters<GezelClient['readProjectGitFile']>
  ): ReturnType<GezelClient['readProjectGitFile']> {
    return this.readProjectGitFile(...args);
  }

  /** @deprecated Use {@link GezelClient.listProjectGitHubPulls}. */
  listProjectGithubPulls(
    ...args: Parameters<GezelClient['listProjectGitHubPulls']>
  ): ReturnType<GezelClient['listProjectGitHubPulls']> {
    return this.listProjectGitHubPulls(...args);
  }

  /** @deprecated Use {@link GezelClient.getProjectGitHubPull}. */
  getProjectGithubPull(
    ...args: Parameters<GezelClient['getProjectGitHubPull']>
  ): ReturnType<GezelClient['getProjectGitHubPull']> {
    return this.getProjectGitHubPull(...args);
  }

  /** @deprecated Use {@link GezelClient.listProjectGitHubPullFiles}. */
  listProjectGithubPullFiles(
    ...args: Parameters<GezelClient['listProjectGitHubPullFiles']>
  ): ReturnType<GezelClient['listProjectGitHubPullFiles']> {
    return this.listProjectGitHubPullFiles(...args);
  }

  /** @deprecated Use {@link GezelClient.listProjectGitHubPullComments}. */
  listProjectGithubPullComments(
    ...args: Parameters<GezelClient['listProjectGitHubPullComments']>
  ): ReturnType<GezelClient['listProjectGitHubPullComments']> {
    return this.listProjectGitHubPullComments(...args);
  }

  /** @deprecated Use {@link GezelClient.getProjectGitHubPullDiff}. */
  getProjectGithubPullDiff(
    ...args: Parameters<GezelClient['getProjectGitHubPullDiff']>
  ): ReturnType<GezelClient['getProjectGitHubPullDiff']> {
    return this.getProjectGitHubPullDiff(...args);
  }

  /** @deprecated Use {@link GezelClient.createProjectGitHubPullComment}. */
  createProjectGithubPullComment(
    ...args: Parameters<GezelClient['createProjectGitHubPullComment']>
  ): ReturnType<GezelClient['createProjectGitHubPullComment']> {
    return this.createProjectGitHubPullComment(...args);
  }

  /** @deprecated Use {@link GezelClient.createProjectGitHubPullRequest}. */
  createProjectGithubPullRequest(
    ...args: Parameters<GezelClient['createProjectGitHubPullRequest']>
  ): ReturnType<GezelClient['createProjectGitHubPullRequest']> {
    return this.createProjectGitHubPullRequest(...args);
  }

  /** @deprecated Use {@link GezelClient.listProjectGitHubWorkflowRuns}. */
  listProjectGithubWorkflowRuns(
    ...args: Parameters<GezelClient['listProjectGitHubWorkflowRuns']>
  ): ReturnType<GezelClient['listProjectGitHubWorkflowRuns']> {
    return this.listProjectGitHubWorkflowRuns(...args);
  }

  /** @deprecated Use {@link GezelClient.getProjectGitHubChecks}. */
  getProjectGithubChecks(
    ...args: Parameters<GezelClient['getProjectGitHubChecks']>
  ): ReturnType<GezelClient['getProjectGitHubChecks']> {
    return this.getProjectGitHubChecks(...args);
  }

  /** @deprecated Use {@link GezelClient.startGitHubLogin}. */
  startGithubLogin(
    ...args: Parameters<GezelClient['startGitHubLogin']>
  ): ReturnType<GezelClient['startGitHubLogin']> {
    return this.startGitHubLogin(...args);
  }

  /** @deprecated Use {@link GezelClient.pollGitHubLogin}. */
  pollGithubLogin(
    ...args: Parameters<GezelClient['pollGitHubLogin']>
  ): ReturnType<GezelClient['pollGitHubLogin']> {
    return this.pollGitHubLogin(...args);
  }

  /** @deprecated Use {@link GezelClient.getGitHubIdentity}. */
  getGithubIdentity(
    ...args: Parameters<GezelClient['getGitHubIdentity']>
  ): ReturnType<GezelClient['getGitHubIdentity']> {
    return this.getGitHubIdentity(...args);
  }

  /** @deprecated Use {@link GezelClient.listGitHubRepos}. */
  listGithubRepos(
    ...args: Parameters<GezelClient['listGitHubRepos']>
  ): ReturnType<GezelClient['listGitHubRepos']> {
    return this.listGitHubRepos(...args);
  }

  /** @deprecated Use {@link GezelClient.previewGitHubRepo}. */
  previewGithubRepo(
    ...args: Parameters<GezelClient['previewGitHubRepo']>
  ): ReturnType<GezelClient['previewGitHubRepo']> {
    return this.previewGitHubRepo(...args);
  }

  /** @deprecated Use {@link GezelClient.gitHubLogout}. */
  githubLogout(
    ...args: Parameters<GezelClient['gitHubLogout']>
  ): ReturnType<GezelClient['gitHubLogout']> {
    return this.gitHubLogout(...args);
  }
}

function toolsetsQueryString(scope: ToolsetsScope): string {
  if (scope.kind === 'shared') return 'scope=shared';
  if (scope.kind === 'system') return 'scope=system';
  if (scope.kind === 'project')
    return `scope=project&project=${encodeURIComponent(scope.projectId)}`;
  return `scope=gezel&gezel=${encodeURIComponent(scope.gezelId)}`;
}
