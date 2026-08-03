import type { CatalogService } from '@bendyline/gezel-catalog';
import type { ChannelManager } from '../channels/manager.js';
import type { ChatEventBus } from '../chat/events.js';
import type { ChatManager } from '../chat/manager.js';
import type { ConnectorActionManager } from '../connectors/actions.js';
import type { ConnectorManager } from '../connectors/manager.js';
import type { DebugFlag } from '../debug/flag.js';
import type { EngineBinaryRegistry } from '../engines/registry.js';
import type { ModelFitnessManager } from '../fitness/manager.js';
import type { JobManager } from '../folders/job-manager.js';
import type { Store } from '../fs/store.js';
import type { GitManager } from '../git/manager.js';
import type { CodeReviewManager } from '../git/reviews.js';
import type { GitHubPrs } from '../github/prs.js';
import type { GrantManager } from '../grants/manager.js';
import type { GrowthEngine } from '../growth/engine.js';
import type { HandboekEngine } from '../handboek/engine.js';
import type { HistoryManager } from '../history/manager.js';
import type { ContentIndex } from '../index-store/content-index.js';
import type { IndexEnrichmentManager } from '../index-store/enrichment-manager.js';
import type { GlobalIndex } from '../index-store/global-index.js';
import type { IndexingJobControl } from '../index-store/indexing-job.js';
import type { MailManager } from '../mail/manager.js';
import type { MeesterStatusGenerator } from '../meester/status-generator.js';
import type { MemoryManager } from '../memory/manager.js';
import type { EnsureModelOrchestrator } from '../models/ensure.js';
import type { ChatModelInstallRegistries } from '../models/install-jobs.js';
import type { PreviewLogBuffer } from '../preview-log/buffer.js';
import type { SpeechToTextProviderManager } from '../providers/audio/stt-manager.js';
import type { TextToSpeechProviderManager } from '../providers/audio/tts-manager.js';
import type { GpuArbiter } from '../providers/gpu-arbiter.js';
import type { ImageProviderManager } from '../providers/image/manager.js';
import type { ImageModelPullRegistry } from '../providers/image/pull-registry.js';
import type { LlamaCppModelManager } from '../providers/llama-cpp/index.js';
import type { MlxModelManager } from '../providers/mlx/index.js';
import type { RecognitionManager } from '../providers/recognition/manager.js';
import type { VideoProviderManager } from '../providers/video/manager.js';
import type { VideoModelPullRegistry } from '../providers/video/pull-registry.js';
import type { MlxRuntimeStatusBus } from '../python/mlx-runtime-status-bus.js';
import type { UvRuntime } from '../python/uv-runtime.js';
import type { DeviceIdentity } from '../remotes/identity.js';
import type { RemotesRegistry } from '../remotes/registry.js';
import type { RemoteServingController } from '../remotes/serving.js';
import type { ImageRenderer } from '../rendering/image-renderer.js';
import type { ReportActionManager } from '../report-actions/report-action-manager.js';
import type { ScriptRunner } from '../scripts/runner.js';
import type { SearchService } from '../search/search-service.js';
import type { SecretStore } from '../secrets/types.js';
import type { SystemToolsetInstallRegistry } from '../system-toolsets/install-registry.js';
import type { SystemStatusBus } from '../system-toolsets/status-bus.js';
import type { SystemIdleState } from '../system/idle-state.js';
import type { SpawnCapability } from '../system/spawn-capability.js';
import type { TaskManager } from '../tasks/manager.js';
import type { NightShiftManager } from '../tasks/night-shift-manager.js';
import type { TaskRunner } from '../tasks/runner.js';
import type { TerminalEventBus } from '../terminal/events.js';
import type { TerminalManager } from '../terminal/manager.js';
import type { WorkspaceIndexManager } from '../workspace/index-manager.js';
import type { OllamaEmulationController } from './ollama-emulation.js';
import type { TokenStore } from './token-store.js';

export interface ServiceContext {
  home: string;
  store: Store;
  chatEvents: ChatEventBus;
  chat: ChatManager;
  /** Iframe-shim runtime errors, looped back into chat preludes. */
  previewLog: PreviewLogBuffer;
  channels: ChannelManager;
  memory: MemoryManager;
  history: HistoryManager;
  growth: GrowthEngine;
  tasks: TaskManager;
  taskRunner: TaskRunner;
  nightShift: NightShiftManager;
  indexEnrichment: IndexEnrichmentManager;
  /**
   * The meester's occasional status report (Home greeting headline +
   * dashboard). In context so `POST /api/meester-status/run` can kick a
   * manual run.
   */
  meesterStatus: MeesterStatusGenerator;
  scriptRunner: ScriptRunner;
  catalog: CatalogService;
  /**
   * The built-in documentation engine (TOC + articles, personalized per
   * render mode). Backs `/api/handboek` and the `how_do_i` MCP tool.
   */
  handboek: HandboekEngine;
  secrets: SecretStore;
  git: GitManager;
  gitHubPrs: GitHubPrs;
  /** Snapshot-driven code reviews (the GitHub tab's Review panel). */
  codeReviews: CodeReviewManager;
  /** Lifecycle of report-embedded action requests (```gezel-action blocks). */
  reportActions: ReportActionManager;
  mail: MailManager;
  connectors: ConnectorManager;
  connectorActions: ConnectorActionManager;
  renderer: ImageRenderer;
  /**
   * Image-generation provider manager. Holds a lazily-built underlying
   * provider (sd-cpp / Google / OpenAI / mock) and rebuilds it on
   * `reset()` when image-related config or credentials change.
   */
  imageProvider: ImageProviderManager;
  /**
   * Tracks in-flight image-model pulls so the UI can re-attach to a
   * pull after navigating away — see
   * [pull-registry.ts](../providers/image/pull-registry.ts).
   */
  imagePulls: ImageModelPullRegistry;
  /**
   * Background chat-model install registries (llama-cpp / ds4 / mlx). The
   * install routes start-or-attach here so a client disconnect no longer
   * abandons a download — see
   * [install-registry.ts](../models/install-registry.ts).
   */
  chatInstalls: ChatModelInstallRegistries;
  /**
   * Video-generation provider manager. Holds a lazily-built underlying
   * provider (bundled diffusers / mock). Same lifecycle pattern as
   * `imageProvider`.
   */
  videoProvider: VideoProviderManager;
  /**
   * Tracks in-flight video-model pulls so the UI can re-attach after
   * navigating away — see
   * [pull-registry.ts](../providers/video/pull-registry.ts).
   */
  videoPulls: VideoModelPullRegistry;
  /**
   * Resolves/downloads native engine binaries (llama-server, …) on demand
   * from the pinned `native-v*` release, verified + cached under
   * `~/.gezel/engines/native-bin/`. Same background-job + SSE lifecycle as
   * {@link imagePulls}. See [engines/registry.ts](../engines/registry.ts).
   */
  engineBinaries: EngineBinaryRegistry;
  /**
   * Installs `onDemand` system toolsets (today only the GitHub Copilot SDK)
   * when the user asks, with the same background-job + SSE lifecycle as
   * {@link engineBinaries}. Distinct from {@link systemStatus}, which tracks
   * the eager boot install and must not move for a user-triggered one. See
   * [system-toolsets/install-registry.ts](../system-toolsets/install-registry.ts).
   */
  systemToolsetInstalls: SystemToolsetInstallRegistry;
  /**
   * Speech-to-text provider manager. Holds a lazily-built underlying
   * provider (whisper.cpp / mock). Same lifecycle pattern as
   * `imageProvider`.
   */
  stt: SpeechToTextProviderManager;
  /**
   * Text-to-speech provider manager. Holds a lazily-built underlying
   * provider (Kokoro / mock).
   */
  tts: TextToSpeechProviderManager;
  /**
   * Image-recognition manager. Owns the local vision engine plus the
   * content-hash result cache. Same lazy-build / reset shape as `stt`.
   */
  recognition: RecognitionManager;
  /**
   * Cross-engine GPU coordinator. Decides whether the local LLM and
   * the local image generator coexist or take turns; surfaces a
   * `setPolicy()` so the config PUT handler can hot-swap the policy
   * when the user flips the toggle in Settings.
   */
  gpuArbiter: GpuArbiter;
  /** llama.cpp model install/list/delete pipeline. */
  llamaCppModels: LlamaCppModelManager;
  /** ds4 (DeepSeek-V4) GGUF install/list/delete pipeline (a LlamaCppModelManager with engine:'ds4'). */
  ds4Models: LlamaCppModelManager;
  /** Per-model fitness records (the proeve) — probe orchestration + persisted reads. */
  modelFitness: ModelFitnessManager;
  /** MLX model install/list/delete pipeline (Apple Silicon only path). */
  mlxModels: MlxModelManager;
  /** Shared Python-runtime bootstrap; backs MLX and future Python features. */
  uvRuntime: UvRuntime;
  /** Lifecycle of the lazy `mlx` venv — published from `buildMlxProvider`
   *  so the UI can show a "MLX warming up" pill while uv installs wheels. */
  mlxRuntimeStatus: MlxRuntimeStatusBus;
  systemStatus: SystemStatusBus;
  /** Process-wide verbose-diagnostics flag; see `GezelConfig.debugMode`. */
  debug: DebugFlag;
  /**
   * Per-launch ephemeral root token — also pre-registered into
   * {@link tokenStore} as `appId='root'` with `scopes=['root']`. Kept as
   * a top-level field for back-compat with internal callers (chat manager,
   * MCP bridge, test harnesses) that read `ctx.token` directly. The
   * middleware always reads through `tokenStore`.
   */
  token: string;
  /**
   * Bearer-token registry consulted by {@link bearerAuth}. Holds the
   * root token (in-memory only) plus any per-app tokens issued via
   * `/v1/apps/register` (persisted to `<home>/tokens.json`).
   */
  tokenStore: TokenStore;
  /**
   * Consent-flow state for `/v1/apps/register`. Tracks pending +
   * decided grants and issues per-app tokens against {@link tokenStore}
   * on approval. Persists to `<home>/pending-grants.json` so headless
   * daemon runs accumulate grants the Electron UI surfaces on next
   * launch.
   */
  grants: GrantManager;
  /**
   * This device's stable identity (Ed25519) for remote model execution.
   * Served at `/v1/identity` and used as the pairing `appId` when this device
   * acts as a client. See [remotes/identity.ts](../remotes/identity.ts).
   */
  deviceIdentity: DeviceIdentity;
  /**
   * Servers this device has paired with (its view as a CLIENT). Empty until
   * the user pairs. See [remotes/registry.ts](../remotes/registry.ts).
   */
  remotes: RemotesRegistry;
  /** Live owner of the optional LAN listener. */
  remoteServing: RemoteServingController;
  /**
   * Live owner of the opt-in, unauthenticated Ollama-compatible
   * loopback listener (port 11434). See http/ollama-emulation.ts.
   */
  ollamaEmulation: OllamaEmulationController;
  /**
   * Hex SHA-256 of the daemon's current TLS cert DER, when serving HTTPS.
   * `/v1/identity` signs this with the device identity key so a paired client
   * can verify continuity across cert rotation. Absent under
   * `GEZEL_INSECURE_TRANSPORT=1`.
   */
  tlsCertSha256?: string;
  /** PEM of the daemon's current TLS cert, when serving HTTPS (for `/v1/identity`). */
  tlsCertPem?: string;
  /**
   * `POST /v1/models/ensure` orchestrator. Wraps the existing
   * `LlamaCppModelManager.install` and `MlxModelManager.install`
   * async-iterables into a uniform job-tracked API so third-party
   * apps don't need to know which backend a model lives on.
   */
  ensureModel: EnsureModelOrchestrator;
  startedAt: string;
  /**
   * Whether this daemon may create child processes, probed once at boot.
   * `null` off Windows, where the write-restricted-service-token failure
   * mode this detects has no equivalent. See
   * [spawn-capability.ts](../system/spawn-capability.ts).
   */
  childProcessSpawn?: SpawnCapability;
  uiDir?: string;
  /** In-memory job tracker for folder externalization moves. Lives only
   *  for the current service process — moves don't survive a restart
   *  (the worker writes a sentinel file so the next boot can detect a
   *  crashed mid-move). */
  folderJobs: JobManager;
  /** Background workspace indexer: commands + files + token index. */
  workspaceIndex: WorkspaceIndexManager;
  /** Content index (code/doc intelligence) backing the code-intel MCP tools. */
  contentIndex: ContentIndex;
  /** Global index (`~/.gezel/index/global.db`): session transcripts, history mirror, documents. */
  globalIndex: GlobalIndex;
  /** The boekwachter job's pause switch — consulted by the on-demand enrich route. */
  indexingJob: IndexingJobControl;
  /** Cross-project unified search (titlebar quick-open + content fan-out). */
  search: SearchService;
  /** Latest OS-idle reading from the Electron shell; gates background enrichment. */
  systemIdle: SystemIdleState;
  /** In-chat terminal: per-(project, workingDir) thread manager. */
  terminals: TerminalManager;
  /** Pub/sub for terminal command + output events; one SSE stream per project. */
  terminalEvents: TerminalEventBus;
  /** Optional callback that asks the supervisor to restart the service.
   *  Wired by the Electron supervisor for embedded + spawned modes;
   *  no-op when the service is run standalone (CLI / dev daemon). The
   *  folders move worker triggers it after a successful config swap so
   *  the renderer can offer "Restart now" to the user. */
  requestRestart?: (reason: string) => void;
}
