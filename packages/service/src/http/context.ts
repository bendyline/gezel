import type { ProviderName } from '@bendyline/gezel';

import type { AmbientDashboardGenerator } from '../ambient/dashboard-generator.js';
import type { AppServeController } from '../app-serve/controller.js';
import type { ChannelManager } from '../channels/manager.js';
import type { ChatEventBus } from '../chat/events.js';
import type { ChatManager } from '../chat/manager.js';
import type { CodexSetupManager } from '../codex-setup/manager.js';
import type { ConnectorActionManager } from '../connectors/actions.js';
import type { ConnectorManager } from '../connectors/manager.js';

import type { DiffpackManager } from '../diffpack/manager.js';

import type { JobManager } from '../folders/job-manager.js';
import type { Store } from '../fs/store.js';
import type { GildeUpdateManager } from '../gilde-updates/manager.js';
import type { GitManager } from '../git/manager.js';
import type { CodeReviewManager } from '../git/reviews.js';
import type { GitHubPrs } from '../github/prs.js';

import type { GrowthEngine } from '../growth/engine.js';
import type { HandboekEngine } from '../handboek/engine.js';
import type { HistoryManager } from '../history/manager.js';
import type { ContentIndex } from '../index-store/content-index.js';
import type { IndexEnrichmentManager } from '../index-store/enrichment-manager.js';
import type { GlobalIndex } from '../index-store/global-index.js';
import type { IndexingJobControl } from '../index-store/indexing-job.js';
import type { KnowledgeManager } from '../knowledge/manager.js';
import type { MeesterStatusGenerator } from '../meester/status-generator.js';
import type { MemoryManager } from '../memory/manager.js';

import type { DuckRunner } from '../observations/duck.js';
import type { OpenCodeSetupManager } from '../opencode-setup/manager.js';
import type { PiSetupManager } from '../pi-setup/manager.js';
import type { PreviewLogBuffer } from '../preview-log/buffer.js';
import type { PromptDraftManager } from '../prompt-drafts/manager.js';

import type { RemotesRegistry } from '../remotes/registry.js';

import type { ImageRenderer } from '../rendering/image-renderer.js';
import type { ReportActionManager } from '../report-actions/report-action-manager.js';
import type { ScriptRunner } from '../scripts/runner.js';
import type { SearchService } from '../search/search-service.js';
import type { SecretStore } from '../secrets/types.js';
import type { StorageJobManager } from '../storage/job-manager.js';
import type { SystemToolsetInstallRegistry } from '../system-toolsets/install-registry.js';
import type { SystemStatusBus } from '../system-toolsets/status-bus.js';
import type { SystemIdleState } from '../system/idle-state.js';

import type { TaskManager } from '../tasks/manager.js';
import type { NightShiftManager } from '../tasks/night-shift-manager.js';
import type { TaskRunner } from '../tasks/runner.js';
import type { TaskScheduler } from '../tasks/scheduler.js';
import type { TerminalEventBus } from '../terminal/events.js';
import type { TerminalManager } from '../terminal/manager.js';
import type { VSCodeSetupManager } from '../vscode-setup/manager.js';
import type { WorkspaceIndexManager } from '../workspace/index-manager.js';
import type { OllamaEmulationController } from './ollama-emulation.js';

import type { EngineContext } from './engine-context.js';

export interface ServiceContext extends EngineContext {
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
  taskScheduler: TaskScheduler;
  nightShift: NightShiftManager;
  indexEnrichment: IndexEnrichmentManager;
  /**
   * The meester's occasional status report (Home greeting headline +
   * dashboard). In context so `POST /api/meester-status/run` can kick a
   * manual run.
   */
  meesterStatus: MeesterStatusGenerator;
  /**
   * The meester's ambient dashboard (PNG workshop snapshots under
   * `~/.gezel/ambient/`). In context so `/api/ambient-dashboard` can
   * report status and kick manual runs.
   */
  ambientDashboard: AmbientDashboardGenerator;
  scriptRunner: ScriptRunner;
  /**
   * Opt-in live gilde content updates: owns `~/.gezel/gilde/`, the effective
   * catalog content root, and the daily registry check. Backs
   * `/api/gilde-updates` and the config toggle dispatcher.
   */
  gildeUpdates: GildeUpdateManager;
  /**
   * Installed `.gezk` knowledge catalogs: registry, mounts, install jobs,
   * and the SearchService knowledge arm. Absent on the machine-engine role.
   */
  knowledge?: KnowledgeManager;
  /**
   * App-serve sites: per-site visitor listeners serving an applied AI App
   * as a shareable mini-site. Absent on the machine-engine role.
   */
  appServe?: AppServeController;
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
  /** Proposed change sets a gezel drafted for the user to review and apply. */
  diffpacks: DiffpackManager;
  /** Chat prompt drafts the user is writing (artifacts/prompts/). */
  promptDrafts: PromptDraftManager;
  connectors: ConnectorManager;
  connectorActions: ConnectorActionManager;
  /**
   * The bundled DuckDB CLI, used to read observation corpora (the tabular
   * connector shape). Stateless — one short-lived child per statement — so it
   * needs no lifecycle beyond construction, and it stays usable even when no
   * binary is installed: `available()` is false and the query routes return an
   * actionable 409 rather than the daemon failing to boot.
   */
  duck: DuckRunner;
  renderer: ImageRenderer;
  /**
   * Installs `onDemand` system toolsets (today only the GitHub Copilot SDK)
   * when the user asks, with the same background-job + SSE lifecycle as
   * {@link engineBinaries}. Distinct from {@link systemStatus}, which tracks
   * the eager boot install and must not move for a user-triggered one. See
   * [system-toolsets/install-registry.ts](../system-toolsets/install-registry.ts).
   */
  systemToolsetInstalls: SystemToolsetInstallRegistry;
  systemStatus: SystemStatusBus;
  /**
   * Servers this device has paired with (its view as a CLIENT). Empty until
   * the user pairs. See [remotes/registry.ts](../remotes/registry.ts).
   */
  remotes: RemotesRegistry;
  /**
   * Live owner of the opt-in, unauthenticated Ollama-compatible
   * loopback listener (port 11434). See http/ollama-emulation.ts.
   */
  ollamaEmulation: OllamaEmulationController;
  /** Gezel-owned Codex profile, credential, and loopback bridge lifecycle. */
  codexSetup: CodexSetupManager;
  /** Gezel-owned OpenCode config, credential, and loopback bridge lifecycle. */
  opencodeSetup: OpenCodeSetupManager;
  /** Gezel-owned pi extension, model list, credential, and loopback bridge lifecycle. */
  piSetup: PiSetupManager;
  /** VS Code custom endpoint, scoped credential, profile merge, and bridge lifecycle. */
  vscodeSetup: VSCodeSetupManager;
  uiDir?: string;
  /** In-memory job tracker for folder externalization moves. Lives only
   *  for the current service process — moves don't survive a restart
   *  (the worker writes a sentinel file so the next boot can detect a
   *  crashed mid-move). */
  folderJobs: JobManager;
  /** In-memory tracker for the one storage cleanup/backup/restore job that
   *  may run at a time. Same lifetime as `folderJobs`, and mutually
   *  exclusive with it — both rewrite the same directories. */
  storageJobs: StorageJobManager;
  /** Drop the cached model inventory after cleanup deletes model files, so
   *  listings stop advertising models that are no longer on disk. */
  invalidateModelsCache?: (provider?: ProviderName) => void;
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
