import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createSecureServer as createSecureHttp2Server } from 'node:http2';
import { setDefaultAutoSelectFamilyAttemptTimeout } from 'node:net';
import { basename, delimiter, dirname, join } from 'node:path';
import {
  type GezelConfig,
  type ServiceRole,
  createLogger,
  formatSuspension,
  isEngagementAllowed,
  normalizeStepGate,
  nowIso,
  onSuspension,
  parseTaskRef,
  projectAllowsAmbientWork,
  startSuspendMonitor,
  stopSuspendMonitor,
} from '@bendyline/gezel';
import { type ExternalFolders, type TaskAssignee, resolveSecurityPolicy } from '@bendyline/gezel';
import { CatalogService } from '@bendyline/gezel-catalog';
import { electronNativeBinCandidates } from '@bendyline/gezel-client/node';
import {
  DeviceHealthGate,
  createSystemDeviceHealthProbe,
  discoverNativeBinaries,
  resolveDeviceSafetyPolicy,
} from '@bendyline/gezel/native';
import { gezelHome, gezelPaths, readConfigRaw } from '@bendyline/gezel/paths';
import { type ServerType, serve } from '@hono/node-server';
import { AmbientDashboardGenerator } from './ambient/dashboard-generator.js';
import { createAppServeController } from './app-serve/controller.js';
import { defaultCacheBudgetMb } from './cache/budget.js';
import { SessionCacheController } from './cache/controller.js';
import { ChannelManager } from './channels/manager.js';
import { ChatEventBus } from './chat/events.js';
import { ChatManager, resolveCatalogReasoningBudget } from './chat/manager.js';
import { createCodexSetupManager } from './codex-setup/manager.js';
import { ConnectorActionManager } from './connectors/actions.js';
import { ProjectLocks } from './connectors/lock.js';
import { ConnectorManager, corpusDirFor } from './connectors/manager.js';
import { registerBlueskyAdapters } from './connectors/natives/bluesky-posts.js';
import { registerCalendarAdapters } from './connectors/natives/calendar-google.js';
import { registerGitHubPullsAdapters } from './connectors/natives/github-pulls.js';
import { registerGitHubReleasesAdapters } from './connectors/natives/github-releases.js';
import { registerGitHubWikiAdapters } from './connectors/natives/github-wiki.js';
import { registerInstagramAdapters } from './connectors/natives/instagram-media.js';
import { registerLinkedInAdapters } from './connectors/natives/linkedin-posts.js';
import { registerXAdapters } from './connectors/natives/x-posts.js';
import { ConnectorSyncManager } from './connectors/sync-manager.js';
import { runConnectorTaskPrep } from './connectors/task-prep.js';
import { listApplicableCraftbooks, projectCraftbookSummaries } from './craftbook/applicable.js';
import { makeCraftbookResolver } from './craftbook/resolve.js';
import {
  clearCraftbookSuggestVectorCache,
  listGlobalCraftbookCandidates,
} from './craftbook/suggest.js';
import { DebugFlag } from './debug/flag.js';
import { DiffpackManager } from './diffpack/manager.js';
import { planNightFixes } from './diffpack/night-fix-planner.js';
import { ProjectDigestGenerator } from './digest/generator.js';
import { reuseVerifiedElectronNativeBinaries } from './engines/electron-native-reuse.js';
import { effectiveEngineRelease } from './engines/native-manifest.js';
import { EngineBinaryRegistry } from './engines/registry.js';
import { ModelFitnessManager } from './fitness/manager.js';
import { type FitnessEngine, runFitnessProbe } from './fitness/probe.js';
import { ActivityTracker } from './fs/activity-tracker.js';
import { ensurePrivateUserHome } from './fs/home-permissions.js';
import { mimeTypeForFilename } from './fs/media-types.js';
import { Store } from './fs/store.js';
import { ensureDefaultBoekwachter, resolveProjectBoekwachter } from './gezels/autonomous-roles.js';
import { GildeUpdateManager } from './gilde-updates/manager.js';
import { GitManager } from './git/manager.js';
import { CodeReviewManager } from './git/reviews.js';
import { GitHubPrs } from './github/prs.js';
import { createGrantManager, parseAutoApproveAppIds } from './grants/manager.js';
import { GrowthEngine } from './growth/engine.js';
import { createDaemonDeviceInfo } from './handboek/daemon-device.js';
import { createHandboekEngine } from './handboek/engine.js';
import { type LoopbackCert, generateLoopbackCert } from './http/cert.js';
import { buildCodexBridgeApp, createCodexBridgeController } from './http/codex-bridge.js';
import type { ServiceContext } from './http/context.js';
import {
  codexBridgePortForHome,
  opencodeBridgePortForHome,
  piBridgePortForHome,
  vscodeBridgePortForHome,
} from './http/local-bridge-port.js';
import {
  buildOllamaEmulationApp,
  createOllamaEmulationController,
} from './http/ollama-emulation.js';
import { buildOpenCodeBridgeApp, createOpenCodeBridgeController } from './http/opencode-bridge.js';
import { buildPiBridgeApp, createPiBridgeController } from './http/pi-bridge.js';
import {
  PreviewCapabilityStore,
  normalizePreviewPath,
  previewCapabilityPath,
} from './http/preview-capability.js';
import { buildRemoteApp } from './http/remote-server.js';
import { invalidateModelsCache } from './http/routes/models.js';
import { type UnexpectedHttpErrorHandler, buildApp, buildPreviewApp } from './http/server.js';
import { createTokenStore } from './http/token-store.js';
import { buildVSCodeBridgeApp, createVSCodeBridgeController } from './http/vscode-bridge.js';
import { ContentIndex } from './index-store/content-index.js';
import { IndexEnrichmentManager } from './index-store/enrichment-manager.js';
import { GlobalIndexManager } from './index-store/global-index-manager.js';
import { GlobalIndex } from './index-store/global-index.js';
import { readImageStaticMeta } from './index-store/image-meta.js';
import { IndexingJobControl, ensureIndexingJobTask } from './index-store/indexing-job.js';
import { ensureIndexFresh } from './index-store/readiness.js';
import { KeurmeesterDigestGenerator } from './keurmeester/digest.js';
import { KeurmeesterManager } from './keurmeester/manager.js';
import { KnowledgeManager } from './knowledge/manager.js';
import { createWorkerCatalogHost } from './knowledge/worker-host.js';
import { createLocalHarnessModelSource } from './local-harness/model-source.js';
import { startMachineEngineBridge } from './machine-engine/bridge.js';
import { registerMailAdapters } from './mail/registry.js';
import { mailCatalogEntries } from './mail/search-catalog.js';
import { ensureNightShiftOversightTask } from './meester/night-shift-oversight.js';
import { MeesterStatusGenerator } from './meester/status-generator.js';
import { MemoryCompactor } from './memory/compaction.js';
import { warmEmbeddings } from './memory/embeddings.js';
import { MemoryHealthMonitor } from './memory/health.js';
import { MemoryManager } from './memory/manager.js';
import { createEnsureModelOrchestrator } from './models/ensure.js';
import { buildChatModelInstallRegistries } from './models/install-jobs.js';
import {
  migrateLegacySystemModels,
  modelStorageRoots,
  reclaimAbandonedModelDownloads,
} from './models/storage-roots.js';
import { createOpenCodeSetupManager } from './opencode-setup/manager.js';
import { discoverManagedScriptRuntimes } from './packages/managed-runtimes.js';
import { normalizeBundledPnpmPath } from './packages/pnpm.js';
import { createPiSetupManager } from './pi-setup/manager.js';
import { PreviewLogBuffer } from './preview-log/buffer.js';
import { recoverTypedProjectCreations } from './project-type/create.js';
import { SpeechToTextProviderManager } from './providers/audio/stt-manager.js';
import { TextToSpeechProviderManager } from './providers/audio/tts-manager.js';
import { GpuArbiter, resolveGpuPolicy } from './providers/gpu-arbiter.js';
import { ImageProviderManager } from './providers/image/manager.js';
import { ImageModelPullRegistry } from './providers/image/pull-registry.js';
import { LlamaCppModelManager } from './providers/llama-cpp/index.js';
import { MLX_VENV_NAME, MlxModelManager, mlxVenvPackages } from './providers/mlx/index.js';
import { RecognitionManager } from './providers/recognition/manager.js';
import { resolveAutoMode } from './providers/recognition/prompts.js';
import type { LLMProvider } from './providers/types.js';
import { VideoProviderManager } from './providers/video/manager.js';
import { VideoModelPullRegistry } from './providers/video/pull-registry.js';
import { MlxRuntimeStatusBus } from './python/mlx-runtime-status-bus.js';
import { UvRuntime } from './python/uv-runtime.js';
import { loadOrCreateDeviceIdentity } from './remotes/identity.js';
import { closePairedRemoteFetches } from './remotes/pinned-fetch.js';
import { createRemotesRegistry } from './remotes/registry.js';
import { createRemoteServingController } from './remotes/serving.js';
import { createTenantLimiter } from './remotes/tenant-limits.js';
import { ImageRenderer } from './rendering/image-renderer.js';
import { ReportActionManager } from './report-actions/report-action-manager.js';
import { type RuntimeLock, acquireSingleInstanceLock } from './runtime-lock.js';
import { ScriptRunner } from './scripts/runner.js';
import {
  CATALOG_RELEVANT_HISTORY_KINDS,
  type ExtraSearchCatalogs,
  SearchService,
} from './search/search-service.js';
import { openSecretStore } from './secrets/index.js';
import { seedSecretsFromEnvFile } from './secrets/seed.js';
import { observeShutdownStep } from './shutdown-progress.js';
import { runSystemBootstrap } from './system-toolsets/bootstrap.js';
import { SystemToolsetInstallRegistry } from './system-toolsets/install-registry.js';
import { SystemStatusBus } from './system-toolsets/status-bus.js';
import { reapOrphanedGezelEngineProcesses } from './system/gezel-process-cleanup.js';
import { SystemIdleState } from './system/idle-state.js';
import { detectMemoryProfile } from './system/memory.js';
import { SPAWN_DENIED_MESSAGE, probeChildProcessSpawn } from './system/spawn-capability.js';
import { dispatchTaskEntry } from './tasks/entry-dispatch.js';
import type { GateWorkspaceReader } from './tasks/gate-eval.js';
import { TaskManager } from './tasks/manager.js';
import { NightShiftQuotaGate } from './tasks/night-quota-gate.js';
import { buildNightShiftReview, nightShiftReportAttachmentPath } from './tasks/night-review.js';
import { NightShiftManager } from './tasks/night-shift-manager.js';
import { TaskRunner } from './tasks/runner.js';
import { TaskScheduler } from './tasks/scheduler.js';
import { evaluateStepGate } from './tasks/step-gate.js';
import { TerminalEventBus } from './terminal/events.js';
import { type CraftbookInvoker, TerminalManager } from './terminal/manager.js';
import { HF_CACHE_DIR_ENV, transformersCacheDir } from './transformers-cache.js';
import { createVSCodeSetupManager } from './vscode-setup/manager.js';
import { WorkspaceIndexManager } from './workspace/index-manager.js';
import { WorkspaceWatchManager } from './workspace/watch-manager.js';

const log = createLogger('service');
const powerLog = createLogger('power');

/**
 * Collapses an editor autosave burst (or a gezel writing several documents in
 * one turn) into a single library re-index. Long enough to batch, short
 * enough that a document is searchable while the user is still looking at it.
 */
const LIBRARY_REFRESH_DEBOUNCE_MS = 3_000;

/**
 * Canonical fixed port for the Gezel daemon. `6228` spells "MAAT" on a
 * phone keypad (M-A-A-T → 6-2-2-8). "Maat" is Dutch for a mate, companion,
 * or fellow worker — a close sibling to "gezel". It sits in the IANA User
 * Port range and below the default ephemeral-allocation windows on Windows,
 * macOS, and Linux.
 *
 * Who holds it depends on the install. On machine installs the INSTALLERS
 * pin the machine-engine broker here (`GEZEL_PORT=6228`), so 6228 answers
 * with the compute broker — not the product `/v1` API — and third-party
 * clients that land on it get an actionable redirect envelope (see
 * http/machine-engine-hints.ts). User-facing daemons (standalone `gezeld`,
 * the embedded desktop service, `gezel start` when no machine service is
 * registered) prefer this port so that on installs WITHOUT a machine
 * service, third-party OpenAI-compatible clients — the ones we don't ship
 * and can't teach to read the runtime files — get a stable
 * `https://127.0.0.1:6228/v1` base URL. It's a strong default, not a
 * guarantee: if the port is taken the daemon falls back to an ephemeral
 * port. The *actual* bound port is always written to
 * `<home>/runtime/port`, which is the only universally-correct discovery;
 * the Ollama-emulation listener (fixed 11434, opt-in) is the stable-port
 * alternative for third-party apps on machine installs. Force an exact
 * port (no fallback) with `--port` / `GEZEL_PORT`.
 */
export const DEFAULT_PORT = 6228;

export interface StartServiceOptions {
  /**
   * Responsibility of this daemon. Installed machine services use
   * `machine-engine`; Electron-owned daemons use `user`. `legacy-full` exists
   * only so a new supervisor can safely coexist with an older installation.
   */
  role?: ServiceRole;
  /** Test seam for a split-service pair; production discovers the OS path. */
  machineEngineHome?: string;
  /**
   * Whether a user daemon should discover and adopt the installed machine
   * engine. Defaults to true in production; the desktop dev supervisor turns
   * it off so `pnpm app` exercises workspace-built native-provider code.
   */
  machineEngineDiscovery?: boolean;
  home?: string;
  /**
   * Bind to this exact port and FAIL if it's already in use (no
   * fallback). Set from `--port` / `GEZEL_PORT`. A named port that
   * silently moved would make the advertised base URL a lie, so an
   * explicit request is honored or it errors. When omitted, the port is
   * chosen per {@link preferCanonicalPort}.
   */
  port?: number;
  /**
   * When `port` is omitted, try to claim the canonical {@link DEFAULT_PORT}
   * (so third-party OpenAI-compatible clients have a stable base URL),
   * falling back to an ephemeral port if it's already taken. The
   * user-facing daemons (standalone `gezeld`, embedded desktop service)
   * set this; tests and library embedders leave it off and get a pure
   * ephemeral port, avoiding contention on one fixed port across parallel
   * suites.
   */
  preferCanonicalPort?: boolean;
  uiDir?: string;
  /**
   * Enable browser web-UI mode: mint a dedicated per-launch token for
   * the browser (written to `runtime/web-ui-token`) so the CLI can print
   * a one-time `?token=` URL without exposing the root token. Defaults to
   * `process.env.GEZEL_WEB === '1'` (how the CLI's `--web` flag turns it
   * on for the spawned daemon). Independent of transport — pair with
   * `GEZEL_INSECURE_TRANSPORT=1` for the recommended HTTP-loopback story.
   */
  webUi?: boolean;
  /**
   * Optional callback the service can invoke to ask the supervisor to
   * restart it (with `reason` for diagnostics). Wired by the Electron
   * supervisor for embedded + spawned modes; absent for standalone
   * launches like the CLI daemon (where restart is the user's concern).
   * Currently used only by the folders move worker after a successful
   * config swap.
   */
  onRestartRequested?: (reason: string) => void;
  /**
   * Observe unexpected errors at the HTTP boundary. Intended for hosts and
   * smoke-test harnesses that must turn daemon-side 5xx responses into a
   * failing health signal instead of relying on log scraping.
   */
  onUnexpectedHttpError?: UnexpectedHttpErrorHandler;
  /**
   * Test seam: bind the opt-in Ollama emulation listener to this port
   * instead of the well-known 11434 (`0` = ephemeral). Production
   * launches leave it unset — emulating Ollama anywhere else defeats
   * the point.
   */
  ollamaEmulationPort?: number;
  /** Test seam for the managed Codex profile root (defaults to `$CODEX_HOME` / `~/.codex`). */
  codexHome?: string;
  /** Exact Codex bridge port override (`0` = ephemeral); production derives one from `home`. */
  codexBridgePort?: number;
  /** Exact OpenCode bridge port override (`0` = ephemeral); production derives one from `home`. */
  opencodeBridgePort?: number;
  /** Override pi's fixed loopback bridge port. Tests bind ephemeral ports. */
  piBridgePort?: number;
  /** Override pi's own agent directory. Tests must never write to a real one. */
  piAgentDir?: string;
  /** Override VS Code's fixed loopback bridge port. Tests bind ephemeral ports. */
  vscodeBridgePort?: number;
  /** Override VS Code's User/profile directory. Tests must never write to a real one. */
  vscodeUserDir?: string;
}

export interface RunningService {
  context: ServiceContext;
  server: ServerType;
  port: number;
  /**
   * First-party client credential written to `runtime/auth-token`. A user
   * daemon hands it to Electron; a machine engine exposes only its narrowly
   * scoped inference/model-management credential to the trusted user-daemon
   * bridge. It is deliberately distinct from `context.token`, which remains
   * process-local.
   */
  clientToken: string;
  /**
   * The per-launch loopback TLS cert. Populated whenever the daemon is
   * serving HTTPS (the default); `null` when downgraded via
   * `GEZEL_INSECURE_TRANSPORT=1`. Embedded-mode supervisors hand the
   * fingerprint straight to Electron's `setCertificateVerifyProc`
   * without round-tripping through disk.
   */
  cert: LoopbackCert | null;
  /**
   * The per-launch web-UI token when web mode is on (see
   * {@link StartServiceOptions.webUi}); `null` otherwise. Mirrors the
   * value written to `runtime/web-ui-token`. Handy for tests and for the
   * CLI to compose the printed browser URL.
   */
  webUiToken: string | null;
  stop: () => Promise<void>;
}

/**
 * Boot the Gezel service. Creates the `.gezel/` layout if missing,
 * generates a fresh auth token, starts the HTTP server (on the canonical
 * port, an explicit port, or an ephemeral port — see
 * {@link StartServiceOptions}), and writes the runtime files so clients
 * can find us.
 */
/**
 * If the daemon was launched with `GEZEL_NODE_PATH` pointing at a
 * bundled Node binary, prepend its directory to `PATH`. Internal code
 * uses `GEZEL_NODE_PATH` directly (e.g. `sandbox/runner.ts`,
 * `resolvePnpmCommand`), so the daemon itself doesn't need this — but
 * spawned child processes that go through shell shims do.
 *
 * Concrete example: `pnpm exec playwright install chromium` invokes
 * `node_modules/.bin/playwright`, a `#!/bin/sh` shim that does
 * `exec node "$DIR/playwright/cli.js"`. The shim resolves `node` via
 * PATH, not via env vars we set. Under the LaunchDaemon on macOS (or
 * the systemd unit on Linux, or NSSM on Windows) the launcher hands
 * the daemon a minimal PATH that doesn't include the .app's bundled
 * binary dir, so without this the shim ENOENTs and surfaces in the UI
 * as "Runtime setup failed: playwright install chromium exited with
 * 127. … exec: node: not found".
 *
 * Idempotent: no-op when GEZEL_NODE_PATH is unset (dev / test) or its
 * directory is already on PATH.
 */
function ensureBundledNodeOnPath(): void {
  const nodePath = process.env.GEZEL_NODE_PATH;
  if (!nodePath || !existsSync(nodePath)) return;
  const dir = dirname(nodePath);
  const current = process.env.PATH ?? '';
  const parts = current.split(delimiter).filter(Boolean);
  if (parts.includes(dir)) return;
  process.env.PATH = current.length === 0 ? dir : `${dir}${delimiter}${current}`;
}

export async function startService(opts: StartServiceOptions = {}): Promise<RunningService> {
  const home = opts.home ?? gezelHome();
  // Sleep-aware clock, started before anything can arm a deadline. Every
  // long-running budget in the daemon — engine turns, one-shots, MCP tool
  // calls, engine idle eviction — is measured in awake time, and a budget
  // built before the monitor runs would silently keep the old wall-clock
  // semantics for its whole life.
  startSuspendMonitor();
  const suspendLogOff = onSuspension((event) => {
    powerLog.warn(
      `host resumed after ${formatSuspension(event.suspendedMs)} suspended — in-flight deadlines were credited that time rather than charged for it`,
    );
  });
  discoverManagedScriptRuntimes(home);
  // Make sure shell-shim child processes can find `node` on PATH (see
  // helper above). Has to run before anything spawns a child — the
  // first-run bootstrap downstream of `startService` is the most
  // common offender, but the same need applies to any post-install
  // hook a system-toolset install runs.
  ensureBundledNodeOnPath();
  // Older signed Windows service-host builds point at the retired
  // bundle-local pnpm.exe. Redirect that legacy path to the ordinary
  // package's JS entrypoint before catalog/bootstrap code reads env.
  normalizeBundledPnpmPath();

  // Node's Happy Eyeballs default of 250ms per address is too short for
  // Windows machines on slow paths to Cloudflare-fronted hosts (Hugging
  // Face downloads, nodejs.org bundles, etc.) — fetch consistently fails
  // with AggregateError ETIMEDOUT in ~550ms even though curl succeeds.
  // 5s gives the v4 connect time to complete; healthy networks aren't
  // affected because the algorithm only waits the full duration when
  // an attempt is genuinely stuck.
  setDefaultAutoSelectFamilyAttemptTimeout(5000);

  const serviceRole = await resolveEffectiveServiceRole(opts.role, process.env, home);
  const privateUserHome = process.env.GEZEL_SYSTEM_SCOPE !== '1';
  // Secure the home before the runtime lock or config probe creates/reads any
  // per-user state. Store.ensureLayout repeats this idempotently so direct
  // Store consumers receive the same invariant.
  if (privateUserHome) await ensurePrivateUserHome(home);
  log.info(`[service] role=${serviceRole}`);
  // Publish the writable transformers.js cache dir so every on-device model
  // consumer pins the same managed location — including the memory embed
  // worker thread, which inherits `process.env` but has no other view of the
  // home. Respect an external override if one is already set.
  process.env[HF_CACHE_DIR_ENV] ??= transformersCacheDir(home);
  // Single-instance lock: refuse to boot a second daemon on the same home,
  // which would race the shared on-disk state (config/sessions/tasks/runtime
  // files). Acquired before any expensive setup so a refused start does
  // minimal work; released in stop(). A hard crash leaves a stale lock the
  // next start reclaims via a pid-liveness check.
  const runtimeDir = join(home, 'runtime');
  const runtimeLock: RuntimeLock = await acquireSingleInstanceLock({
    runtimeDir,
    lockPath: join(runtimeDir, 'lock'),
  });
  // The per-engine supervisor only reaps its own engine family before a
  // launch. Sweep every clearly-Gezel owner-less engine once at service boot
  // so starting a DS4 chat also clears an abandoned MLX/Python server (and
  // vice versa). This is deliberately not home-scoped: app-resource binaries
  // loading machine-shared models may carry no user-home path in argv. Unix
  // proves ownerlessness via PPID 1; Windows proves it when the retained
  // creator pid is absent from the process table. Any engine with a live
  // owner is left untouched.
  try {
    const cleanup = await reapOrphanedGezelEngineProcesses();
    if (cleanup.targetedPids.length > 0) {
      const remaining =
        cleanup.remainingPids.length > 0
          ? `; still present after cleanup: ${cleanup.remainingPids.join(', ')}`
          : '';
      log.info(
        `[engines] startup reaped ${cleanup.targetedPids.length} orphan(s) from prior service sessions: ${cleanup.targetedPids.join(', ')}${remaining}`,
      );
    }
  } catch (err) {
    log.warn(
      `[engines] startup orphan sweep failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const migratedSharedModels = await migrateLegacySystemModels(home);
  if (migratedSharedModels > 0) {
    log.info(
      `[assets] moved ${migratedSharedModels} legacy machine model(s) into the public read-only asset store`,
    );
  }
  // Discover externalFolders from on-disk config before constructing the
  // Store — every other path in the system depends on knowing which
  // scopes are externalized. The config file itself always lives at
  // `<home>/config.json` (never externalized), so this read needs no
  // Store. Returns `{}` on first boot (no config yet).
  const rawConfigForExternal = await readConfigRaw(home);
  const external =
    (rawConfigForExternal.externalFolders as ExternalFolders | undefined) ?? undefined;
  const { HistoryManager } = await import('./history/manager.js');
  const history = new HistoryManager(home);
  const store = new Store({ home, history, external, serviceRole, privateUserHome });
  if (serviceRole !== 'machine-engine') await recoverTypedProjectCreations(store);
  await store.ensureLayout();
  let sharedProject: { id: string; created: boolean } | null = null;
  if (serviceRole !== 'machine-engine') {
    await store.ensureDefaultProject();
    sharedProject = await store.ensureSharedProject();
    await store.ensureDefaultMeester();
    await store.ensureDefaultKlerk();
  }

  const paths = gezelPaths(home);
  // Keep the daemon's root credential process-local. Cross-process clients
  // discover `clientToken` instead, which carries the reserved first-party
  // `ui` scope. A readable runtime file must never be a root-equivalent
  // service credential: on a shared/system-scope install that turns a file
  // ACL mistake into total daemon compromise.
  const token = randomBytes(24).toString('base64url');
  const clientToken = randomBytes(24).toString('base64url');
  // Browser web-UI mode (`gezel start --web`): mint a dedicated
  // per-launch token so the one-time `?token=` URL the CLI prints never
  // carries the root token. Same lifecycle as root (in-memory only, not
  // persisted). `appId: 'web-ui'` keeps it independently identifiable in
  // the Connected Apps roster and revocable.
  const webUiEnabled =
    serviceRole !== 'machine-engine' && (opts.webUi ?? process.env.GEZEL_WEB === '1');
  const webUiToken = webUiEnabled ? randomBytes(24).toString('base64url') : null;
  // Per-app bearer tokens (issued via /v1/apps/register) persist to
  // `<home>/tokens.json`; the per-launch root token above is registered
  // in-memory only since it rotates every boot. The auth middleware
  // consults this store on every request.
  const ephemeralTokens = [
    {
      appId: serviceRole === 'machine-engine' ? 'machine-engine-client' : 'desktop-client',
      appName: serviceRole === 'machine-engine' ? 'Gezel User Daemon' : 'Gezel Desktop',
      // A machine runtime credential is readable across local accounts, so
      // it receives inference and model-lifecycle authority only. The user
      // daemon's credential retains the first-party product API scopes.
      scopes:
        serviceRole === 'machine-engine'
          ? ['remote-inference', 'machine-models', 'machine-knowledge-assets']
          : ['ui', 'openai'],
      token: clientToken,
    },
    ...(webUiToken
      ? [
          {
            appId: 'web-ui',
            appName: 'Gezel Web UI',
            scopes: ['ui'],
            token: webUiToken,
          },
        ]
      : []),
  ];
  const tokenStore = await createTokenStore({
    home,
    rootToken: token,
    ephemeralTokens,
  });
  // GrantManager owns the `/v1/apps/register` consent state machine.
  // GEZEL_AUTOAPPROVE_APPS=appId1,appId2 is a CI/scripting bypass —
  // listed appIds get an immediate `approved` grant + token without
  // a UI prompt. Document this as not-the-default path.
  const grants = await createGrantManager({
    home,
    tokenStore,
    autoApproveAppIds: parseAutoApproveAppIds(process.env.GEZEL_AUTOAPPROVE_APPS),
  });
  // The EnsureModel orchestrator construction happens after the local
  // model managers + catalog are built — see the assignment below the
  // `catalog`/`llamaCppModels`/`ds4Models`/`mlxModels` lines.
  // HTTPS+HTTP/2 is the default loopback transport. The browser/Electron
  // renderer needs it to multiplex our SSE streams over a single TCP
  // connection (Chromium caps HTTP/1.1 at 6 conns/origin and the chat
  // view holds 6+ event-streams open). Operators can downgrade to plain
  // HTTP/1.1 with `GEZEL_INSECURE_TRANSPORT=1` for emergencies — that
  // single conditional is the entire fallback path.
  const httpsEnabled = process.env.GEZEL_INSECURE_TRANSPORT !== '1';
  const cert = httpsEnabled ? await generateLoopbackCert() : null;
  const chatEvents = new ChatEventBus();
  // TaskManager already writes a durable, human-readable History event for
  // every meaningful task transition. Mirror those events onto the existing
  // project SSE stream only after the append succeeds, giving terminal and
  // other lightweight clients live task updates without a parallel task bus.
  // Scheduler ticks are operational heartbeats, not transcript-worthy news.
  history.subscribe((event) => {
    if (
      !event.projectId ||
      event.kind === 'task.tick' ||
      (!event.kind.startsWith('task.') && !event.kind.startsWith('tasknote.'))
    ) {
      return;
    }
    const ref = event.details?.ref;
    chatEvents.publishProjectEvent(event.projectId, {
      type: 'task_event',
      eventId: event.id,
      kind: event.kind,
      summary: event.summary,
      at: event.at,
      ...(typeof ref === 'string' ? { taskRef: ref } : {}),
      ...(event.gezelId ? { gezelId: event.gezelId } : {}),
    });
  });
  // Shared gezels can be recruited from inside a chat (`ensure_gezel`), by
  // workspace imports, or by a direct UI/API create. Bridge the Store's
  // creation choke point onto the global SSE stream so every connected UI
  // refreshes its roster without waiting for a visibility-change poll.
  store.onGezelChange((event) => {
    chatEvents.publishGlobalEvent({
      type: 'gezel_created',
      gezelId: event.gezelId,
      name: event.name,
    });
  });
  const memory = new MemoryManager(store);
  const tasks = new TaskManager(store, history);
  // The gilde update manager must exist before the CatalogService: it owns
  // the effective content root, and the catalog's default sources capture it
  // as a provider closure (re-read on every disk access, so a live content
  // activation flips the whole catalog without a reconstruct).
  const gildeUpdates = await GildeUpdateManager.create({ home, store, history });
  gildeUpdates.onContentChanged(() => {
    invalidateModelsCache();
    clearCraftbookSuggestVectorCache();
  });
  const catalog = new CatalogService(undefined, {
    localRoot: home,
    contentRoot: () => gildeUpdates.contentDataDir(),
  });
  // The Boekwachter is a full, catalog-backed gezel. This runs after catalog
  // construction (unlike the Store-owned Meester/Klerk ensures above) so the
  // canonical gilde about.md and template provenance are preserved.
  if (serviceRole !== 'machine-engine') {
    // The shared library's AI tier (summaries, media shadows) is gated on a
    // Boekwachter being on its roster, so a freshly created library opts in
    // once here. An install that already has the seat filled recruits only
    // this project; nothing else is re-broadened.
    await ensureDefaultBoekwachter(
      store,
      catalog,
      sharedProject?.created ? { recruitProjectIds: [sharedProject.id] } : {},
    );
  }
  const secrets = await openSecretStore(home);
  log.info(`[secrets] backend=${secrets.backend}`);
  // The engine broker needs its device-identity key, but must never ingest
  // cloud/provider credentials from an install-time env file. Those remain
  // exclusively in each account's user daemon.
  if (serviceRole !== 'machine-engine') await seedSecretsFromEnvFile(secrets);
  // Stable device identity (Ed25519) + the registry of servers this device has
  // paired with — both for remote model execution. Identity needs the secret
  // store (private key lives there); the registry is plain 0600 JSON.
  const deviceIdentity = await loadOrCreateDeviceIdentity(home, secrets);
  const remotes = await createRemotesRegistry({ home });
  const systemStatus = new SystemStatusBus();
  const mlxRuntimeStatus = new MlxRuntimeStatusBus();

  // Seed the MLX runtime status from disk so the UI pill reflects
  // reality on a fresh page load — without this it would always boot
  // as 'idle' and only flip to 'ready' after the first MLX chat turn.
  void (async () => {
    try {
      const venvs = await new UvRuntime({ home }).listVenvs();
      const mlxVenv = venvs.find((v) => v.name === 'mlx');
      if (mlxVenv) {
        mlxRuntimeStatus.publish({
          phase: 'ready',
          message: `Python ${mlxVenv.pythonVersion ?? '?'} via ${mlxVenv.source}`,
        });
      }
    } catch {
      /* leave as 'idle' — first chat turn will flip it */
    }
  })();

  // Seed the verbose-diagnostics flag from the on-disk config now so
  // every subsystem we construct below sees the right value at boot.
  // Live flips (via `PUT /api/config`) mutate this object in place.
  const bootConfig = await store.readConfig().catch(() => ({}) as GezelConfig);
  const debug = new DebugFlag(bootConfig.debugMode === true);
  if (debug.isEnabled()) {
    log.info('[debug] verbose diagnostics ON (GezelConfig.debugMode=true)');
  }

  // Debug-only opt-in: rewrite every template-derived gezel's about.md
  // back to its catalog default on each boot, discarding local edits.
  // Runs before the HTTP server binds so the first chat turn already sees
  // the refreshed prompts. Best-effort — a failure here must never block
  // startup. The same sweep is exposed on demand via
  // `POST /api/gezels/reset-templates` (Settings → General button).
  if (bootConfig.resetTemplatesOnStartup === true) {
    try {
      const { resetTemplateGezels } = await import('./gezels/reset-templates.js');
      const res = await resetTemplateGezels({ store, catalog });
      log.info(
        `[reset-templates] startup reset: ${res.reset.length} gezel(s) restored to template defaults`,
      );
    } catch (err) {
      log.warn('[reset-templates] startup reset failed:', err instanceof Error ? err.message : err);
    }
  }

  // System-service launches (Windows GezelService NSSM-wrapped daemon,
  // macOS LaunchDaemon, Linux systemd unit) start gezeld with a clean
  // env — the Electron supervisor's pre-spawn env-stamping never
  // reaches them. Probe the per-host backend and resolve the bundled
  // engine binaries here so the on-device chat path finds them. Idempotent
  // when the supervisor already populated the env (embedded / dev /
  // packaged-spawn launches); the discovery short-circuits per binary.
  // A directly-started user daemon has no Electron supervisor to point it at
  // an installed app payload. Reuse that payload only after the service's own
  // source-pinned per-file manifest, architecture, and platform-signature
  // policy accept it. This is the same gate the standalone CLI uses; metadata
  // beside the installed app is never trusted. An explicit/operator path and
  // mock mode both remain untouched.
  if (!process.env.GEZEL_NATIVE_BIN_DIR && process.env.GEZEL_MOCK_PROVIDER !== '1') {
    const installedCandidates = electronNativeBinCandidates().filter((candidate) =>
      existsSync(candidate),
    );
    if (installedCandidates.length > 0) {
      const reuse = await reuseVerifiedElectronNativeBinaries({ candidates: installedCandidates });
      if (reuse.reused) {
        log.info(`[native] ${reuse.reason}: ${reuse.nativeBinDir}`);
      } else {
        log.warn(`[native] installed Electron payload rejected: ${reuse.reason}`);
      }
    }
  }

  // Bare npm/CLI installs may have neither a supervisor nor an installed app.
  // Make the source-pinned, user-owned download cache the final default while
  // preserving every verified or operator-provided override above. This makes
  // a verified TUI bootstrap install available immediately and on later daemon
  // launches without another download.
  process.env.GEZEL_NATIVE_BIN_DIR ??= join(
    home,
    'engines',
    'native-bin',
    effectiveEngineRelease(),
  );
  const nativeDiscovery = discoverNativeBinaries({
    home,
    ...(bootConfig.llamaCppBackendOverride
      ? { llamaCppBackendOverride: bootConfig.llamaCppBackendOverride }
      : {}),
    logger: { info: (m) => log.info(m), warn: (m) => log.warn(m) },
  });
  if (nativeDiscovery.llamaBackend) {
    const lb = nativeDiscovery.llamaBackend;
    log.info(
      `[native] llama-cpp backend probe: ${lb.backend}${lb.cached ? ' (cached)' : ''} — ${lb.reason}`,
    );
  }

  let boundPort = 0;
  // Tests (and CI) can force a deterministic mock provider that needs no
  // credentials by setting GEZEL_MOCK_PROVIDER=1.
  const mockProviders: Array<['copilot' | 'openai', LLMProvider]> = [];
  if (process.env.GEZEL_MOCK_PROVIDER === '1') {
    const { MockProvider } = await import('./providers/mock.js');
    mockProviders.push(['copilot', new MockProvider({ name: 'copilot' })]);
    mockProviders.push(['openai', new MockProvider({ name: 'openai' })]);
    // Mock mode also skips the on-device first-run bootstrap, so nothing
    // would otherwise write `config.provider` — and an unset provider now
    // resolves to the platform's on-device engine, which a mock-mode home
    // has no model for. Pin the mock so routing reaches it.
    if (!bootConfig.provider) {
      await store.writeConfig({ provider: 'copilot' });
    }
    log.info('[service] GEZEL_MOCK_PROVIDER=1 — LLM calls routed to MockProvider');
  }

  // llama.cpp model storage manager — handles HF GGUF downloads,
  // sha256 verification, GGUF metadata extraction, and the on-disk
  // models/<id>/ tree the supervisor reads from. Constructed before
  // ChatManager so the provider factory inside ensureProvider can
  // resolve a default model path from installed models.
  // Late-bound so the model managers' install hooks can reach the
  // fitness manager, which is constructed after ChatManager (its probe
  // needs the chat layer's pool-admitted provider resolution).
  // biome-ignore lint/style/useConst: forward reference — captured by scheduleInstallProbe below, assigned once modelFitness is constructed further down.
  let modelFitnessRef: ModelFitnessManager | undefined;
  const scheduleInstallProbe = (info: { engine: FitnessEngine; id: string }) => {
    modelFitnessRef?.scheduleProbe(info.engine, info.id, { trigger: 'install' });
  };
  const llamaCppModels = new LlamaCppModelManager({
    home,
    catalog,
    onInstalled: scheduleInstallProbe,
  });
  // ds4 (DwarfStar) GGUF storage. Reuses the llama.cpp model
  // manager (ds4 GGUFs are structurally identical) pointed at `engines/ds4/`
  // and the catalog `ds4` source block. Cheap to construct on any platform;
  // the ds4 provider gates on platform/accelerator before ever using it.
  const ds4Models = new LlamaCppModelManager({
    home,
    catalog,
    engine: 'ds4',
    onInstalled: scheduleInstallProbe,
  });
  // Shared Python-runtime bootstrap. Same pattern — cheap to construct
  // everywhere; only the MLX provider actually asks it for a venv,
  // and only on Apple Silicon. It is constructed before the MLX model
  // manager so every model-install entrypoint can share the warm hook.
  const uvRuntime = new UvRuntime({ home });
  const warmMlxRuntime = (): void => {
    mlxRuntimeStatus.publish({
      phase: 'provisioning',
      message: 'Preparing the MLX Python runtime while the model downloads…',
    });
    void uvRuntime
      .ensureVenv({
        name: MLX_VENV_NAME,
        packages: mlxVenvPackages(bootConfig.mlxPackageSpec),
      })
      .then((venv) => {
        mlxRuntimeStatus.publish({
          phase: 'ready',
          message: `Python ${venv.pythonVersion ?? '?'} via ${venv.source}`,
        });
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        mlxRuntimeStatus.publish({ phase: 'error', error: message });
        // Non-fatal: the lazy first-chat `ensureVenv` will retry and
        // surface the error to the user then.
        log.warn(`[mlx] install-time venv warm failed (will retry on first chat): ${message}`);
      });
  };
  // Put the warm hook on the model manager itself so every install
  // entrypoint — including the in-app Settings downloader — overlaps
  // runtime provisioning with the weights download.
  const mlxModels = new MlxModelManager({
    home,
    catalog,
    onInstallStart: () => warmMlxRuntime(),
    onInstalled: scheduleInstallProbe,
  });
  // Backs `POST /v1/models/ensure` + `GET /v1/models/ensure/:jobId/events`.
  // Wraps the local model managers above into a single uniform
  // "ensure this model is downloaded" primitive so third-party apps
  // don't need to learn either install API.
  const ensureModel = await createEnsureModelOrchestrator({
    llamaCpp: llamaCppModels,
    ds4: ds4Models,
    mlx: mlxModels,
    catalog,
  });

  // Engine-agnostic prompt-cache controller. Local providers (mlx,
  // llama-cpp) register adapters with it as ChatManager constructs
  // them; cloud providers ignore it. The reconcile timer runs in the
  // background and is `unref`ed so it doesn't block shutdown.
  const cacheController = new SessionCacheController({
    logger: { info: (m) => log.info(m), warn: (m) => log.warn(m) },
  });
  // Apply per-engine cache budgets — explicit config overrides win
  // over the RAM-aware default. Read once at boot; runtime config
  // changes flow through `PUT /api/config` which calls back into the
  // controller via `setBudget`. (Wired in the config route as part of
  // the operator-controls UI work below.)
  {
    const { totalmem } = await import('node:os');
    const ramAware = defaultCacheBudgetMb(totalmem());
    const mlxBudgetMb = bootConfig.cacheBudgetMb?.mlx ?? ramAware;
    const llamaCppBudgetMb = bootConfig.cacheBudgetMb?.['llama-cpp'] ?? ramAware;
    // setBudget is a no-op for providers without registered adapters
    // (which is correct here — adapters register lazily via
    // ChatManager.ensureProvider). The controller will apply the
    // budget on first registration via the entry's default + a
    // setBudget call we add below.
    cacheController.setBudget('mlx', mlxBudgetMb * 1024 * 1024);
    cacheController.setBudget('llama-cpp', llamaCppBudgetMb * 1024 * 1024);
  }

  // Cross-engine GPU arbiter. Constructed before ChatManager and
  // ImageProviderManager so both can register their evictors as soon
  // as the underlying providers are built (lazy — first chat turn /
  // first image gen). Policy comes from config; `'auto'` resolves to
  // `'coexist'` on big-memory Apple Silicon and `'swap'` everywhere
  // else. The PUT /api/config handler hot-swaps via `setPolicy`.
  const deviceSafetyPolicy = resolveDeviceSafetyPolicy(bootConfig.deviceSafety);
  const deviceHealthGate = new DeviceHealthGate({
    policy: deviceSafetyPolicy,
    probe: createSystemDeviceHealthProbe({
      helperPath: process.env.GEZEL_DEVICE_HEALTH_BIN,
    }),
    log: (message) => log.info(message),
  });
  const gpuArbiter = new GpuArbiter({
    policy: resolveGpuPolicy(bootConfig.gpuMemoryPolicy),
    healthGate: deviceHealthGate,
  });
  log.info(`[gpu-arbiter] policy=${gpuArbiter.getPolicy()}`);
  log.info(
    `[device-health] mode=${deviceSafetyPolicy.mode} start<=${deviceSafetyPolicy.maxStartTemperatureC}C resume<=${deviceSafetyPolicy.resumeTemperatureC}C margin>=${deviceSafetyPolicy.minThermalMarginC}C telemetryFailure=${deviceSafetyPolicy.onTelemetryFailure}`,
  );

  // Resolves native engine binaries on demand (lazy on-device chat + the
  // manual Settings trigger). Verified download → cache → env-stamp; see
  // engines/resolver.ts. Background-job lifecycle mirrors `imagePulls`.
  // Constructed before ChatManager so the lazy on-device hook can reach it.
  // Signature validation fails closed by default on Windows/macOS. The
  // config remains an explicit operator escape hatch for development.
  const engineBinaries = new EngineBinaryRegistry({
    home,
    ...(bootConfig.engineSignaturePolicy
      ? { signaturePolicy: bootConfig.engineSignaturePolicy }
      : {}),
  });

  // User-triggered installs of `onDemand` system toolsets (the Copilot SDK).
  // Separate from the boot bootstrap below, which only handles eager entries.
  const systemToolsetInstalls = new SystemToolsetInstallRegistry({ home });

  // Preview-shim runtime errors → next-turn chat prelude. Shared between
  // the HTTP intake route and ChatManager's drain-on-send.
  const previewLog = new PreviewLogBuffer();
  // Shared output-pane/browser-preview capability authority. It is created
  // before ChatManager so browser MCP wrappers can mint through a narrow
  // workspace-only callback; the HTTP routers and sidecar bind later.
  const previewCapabilities = new PreviewCapabilityStore();
  const previewBrowser = { origin: null as string | null };

  // Image recognition. Built before ChatManager because the chat turn needs
  // it to describe images for models that can't see them.
  const recognition = new RecognitionManager({
    home,
    ...(bootConfig.defaultRecognitionModel ? { modelId: bootConfig.defaultRecognitionModel } : {}),
  });

  const chat = new ChatManager({
    store,
    events: chatEvents,
    memory,
    previewLog,
    createWorkspacePreviewUrl: async (projectId, relativePath) => {
      const entryPath = normalizePreviewPath(relativePath);
      if (entryPath === null) throw new Error('invalid workspace preview path');
      if (boundPort <= 0) throw new Error('preview server is not ready');
      const minted = previewCapabilities.mint({
        source: 'workspace',
        projectId,
        entryPath,
      });
      const path = previewCapabilityPath({
        token: minted.token,
        source: 'workspace',
        projectId,
        entryPath,
      });
      const mainOrigin = `${cert ? 'https' : 'http'}://127.0.0.1:${boundPort}`;
      return `${previewBrowser.origin ?? mainOrigin}${path}`;
    },
    getWorkspacePreviewOrigin: () => previewBrowser.origin,
    getPort: () => boundPort,
    getToken: () => token,
    getCert: () => cert?.certPem ?? null,
    issueSessionToken: (input) => tokenStore.issueSession(input),
    revokeSessionToken: (appId) => tokenStore.revokeSession(appId),
    cacheController,
    home,
    providers: mockProviders,
    history,
    catalog,
    secrets,
    llamaCppModels,
    ds4Models,
    mlxModels,
    recognition,
    uvRuntime,
    mlxRuntimeStatus,
    debug,
    gpuArbiter,
    engineBinaries,
  });

  // Fitness probes (the proeve). Constructed after `chat` because the
  // probe rides the chat layer's pool-admitted provider resolution;
  // the model managers' install hooks reach it via `modelFitnessRef`.
  const resolveInstalledForFitness = (engine: FitnessEngine, modelId: string) =>
    engine === 'ds4'
      ? ds4Models.resolveModel(modelId)
      : engine === 'mlx'
        ? mlxModels.resolveModel(modelId)
        : llamaCppModels.resolveModel(modelId);
  const modelFitness = new ModelFitnessManager({
    store,
    runProbe: (args) =>
      runFitnessProbe(
        {
          getProviderForModel: (name, modelId) => chat.getProviderForModel(name, modelId),
          resolveInstalled: resolveInstalledForFitness,
          resolveReasoningBudget: (modelId) => resolveCatalogReasoningBudget(catalog, modelId),
          detectMemory: detectMemoryProfile,
          configuredNumCtx: async (engine, modelId) => {
            const cfg = await store.readConfig();
            return (
              cfg.modelContextOverrides?.[`${engine}:${modelId}`] ??
              (engine === 'mlx'
                ? cfg.mlxNumCtx
                : engine === 'ds4'
                  ? cfg.ds4NumCtx
                  : cfg.llamaCppNumCtx)
            );
          },
        },
        args,
      ),
    resolveInstalled: resolveInstalledForFitness,
    engineStatus: () => chat.engineStatus(),
    currentMemory: detectMemoryProfile,
  });
  modelFitnessRef = modelFitness;
  chat.setModelFitness(modelFitness);
  // D3 tier-collapse at handoff dispatch (the setTaskAdvancer circular-dep pattern).
  chat.setTierCollapser((projectId, num, opts) =>
    tasks.collapseCraftbookForTier(projectId, num, opts),
  );

  // Quota reserve for cloud-subscription night work — one verdict source
  // shared by the runner's per-handoff admission gate and the manager's
  // activeness/status classification, so the two can never disagree.
  const nightQuotaGate = new NightShiftQuotaGate({ store, usage: chat.usageTracker, home });

  // NightShiftManager owns the Night Shift ON/OFF state (nightly window +
  // manual shifts). Its `isActive` read gates deferred night-shift work in
  // the scheduler, runner, and enrichment loop below.
  const nightShift = new NightShiftManager({
    store,
    manager: tasks,
    events: chatEvents,
    quotaGate: nightQuotaGate,
    resolveProviderName: (gezelId, opts) => chat.providerForGezel(gezelId, opts),
  });

  // Per-project last-activity stamps, fed by the history + chat buses.
  // The nudge scheduler and the meester status generator both read it
  // instead of recomputing activity from every session on every pass.
  const activityTracker = new ActivityTracker({ store, history, chatEvents });

  // TaskScheduler needs ChatManager (for ambient voorman nudges) so it's
  // constructed after `chat` is ready. Task-cron ticks work without chat,
  // but we route both through the same scheduler to avoid two timers.
  const scheduler = new TaskScheduler({
    manager: tasks,
    chat,
    store,
    debug,
    isNightShiftWindowOpen: () => nightShift.isWindowOpen(),
    currentNightShiftDayKey: () => nightShift.currentDayKey(),
    activity: activityTracker,
  });

  // TaskRunner: paces phase-handoff dispatches so a voorman advancing
  // 50 tasks at once doesn't spawn 50 concurrent LLM requests. Reads
  // provider queue depth for backpressure. `tickIntervalMs` is
  // configurable; defaults to 5s.
  const config = await store.readConfig();
  // Late-bound: IndexEnrichmentManager is constructed after the runner; the
  // closure reads through this ref so night dispatch can hold on catch-up.
  let indexEnrichmentRef: IndexEnrichmentManager | null = null;
  const taskRunner = new TaskRunner({
    store,
    dispatcher: {
      startHandoffSession: (args) => chat.startHandoffSession(args),
      cancelHandoffSession: (sessionId) => chat.cancelInflight(sessionId),
      isHandoffSessionActive: (sessionId) =>
        chat.listInflight().some((entry) => entry.sessionId === sessionId),
      resolveProviderName: (gezelId, opts) => chat.providerForGezel(gezelId, opts),
      getProvider: (name) => chat.getProviderIfReady(name),
      ensureProvider: (name) =>
        name === 'remote' ? Promise.resolve(null) : chat.getProvider(name),
    },
    isNightShiftActive: () => nightShift.isActive(),
    isNightShiftPending: (task) => nightShift.isPendingToday(task),
    isIndexCatchUpActive: () => indexEnrichmentRef?.isCatchUpActive() ?? false,
    nightQuotaHold: (provider) => nightQuotaGate.holdFor(provider),
    ...(config.taskRunner?.tickIntervalMs
      ? { tickIntervalMs: config.taskRunner.tickIntervalMs }
      : {}),
  });
  nightShift.setOnActivated(async () => {
    // Index first, tasks second: the catch-up flag is raised synchronously,
    // so the runner's night dispatch holds until static + AI indexing is
    // current across projects, then the queued shift work proceeds. Not
    // awaited — a manual start must respond immediately, and a full drain
    // can take a while on a big repo.
    void indexEnrichmentRef?.catchUpAll();
    await taskRunner.rehydrateFromStore({ nightShiftOnly: true });
    await taskRunner.wake();
  });
  nightShift.setOnDeactivated(async () => {
    // Queued night tasks stop themselves — the runner re-reads `isActive()`
    // at admission. The catch-up sweep cannot: it is a loop the activation
    // callback started, so the window closing has to reach it explicitly or
    // it keeps enqueuing night-model one-shots long past `endHour`.
    indexEnrichmentRef?.cancelCatchUp();
  });
  // A model-owned completion-gate loop keeps repairing inside its existing
  // turn; TaskManager therefore does not enqueue a replacement handoff. Move
  // TaskRunner's live dispatch to the new activation timestamp immediately so
  // its stale-dispatch pruning does not cancel that same recovery turn.
  tasks.setCurrentTurnStepReactivatedHook(({ task, newStep }) => {
    const gezelId =
      newStep.assignee?.kind === 'gezel' ? newStep.assignee.gezelId : newStep.suggestedGezelId;
    if (!gezelId || !newStep.lastActivatedAt) return;
    taskRunner.adoptActiveDispatchActivation({
      taskRef: task.ref,
      stepId: newStep.id,
      gezelId,
      activationAt: newStep.lastActivatedAt,
    });
  });

  // Script runner: executes project-scoped TypeScript scripts in the
  // sandbox with fd-3 RPC back to the service. Wired into TaskManager
  // below so phases can attach `onEnter` / `onExit` hooks. The
  // `secrets` store flows in so the runner's dispatcher can resolve
  // `credential:<name>` capabilities via a DefaultCredentialRegistry
  // — credentials stay server-side, scripts only ever name them.
  const scriptRunner = new ScriptRunner({ store, chat, memory, tasks, secrets, catalog });
  tasks.setScriptRunner(scriptRunner);
  // Hook scripts go through the same runner. Wired post-construction
  // so ChatManager and ScriptRunner can each reference the other
  // without a constructor-time cycle.
  chat.setScriptRunner(scriptRunner);
  // Keurmeester supervision: consults a frontier model when a small
  // local model exhausts its recovery budget. Off unless enabled via
  // config.keurmeester or the supervision.keurmeester behavior. Wired
  // post-construction (the manager calls back into oneShotCompletion) —
  // same cycle-avoidance pattern as the runner above.
  const keurmeester = new KeurmeesterManager({
    store,
    history,
    events: chatEvents,
    home,
    oneShot: (prompt, timeoutMs, opts) => chat.oneShotCompletion(prompt, timeoutMs, opts),
  });
  chat.setKeurmeester(keurmeester);
  // Task-side supervision ports: the Keurmeester rewrites task
  // craftbooks + re-drives assignees (tasks/chat ports below), and the
  // completion gate + stuck-step sweep consult it before pausing.
  keurmeester.setTasks(tasks);
  keurmeester.setChat({
    messageGezel: (args) => chat.messageGezel(args),
    ensureOrCreateSession: (args) => chat.ensureOrCreateSession(args),
    send: (sessionId, text, opts) => chat.send(sessionId, text, opts),
  });
  tasks.setKeurmeester(keurmeester);
  scheduler.setKeurmeester(keurmeester);
  // Remote model execution: let ChatManager resolve per-server chat providers
  // for `remote:<remoteId>/<model>` ids against the paired-servers registry.
  // The multimodal managers get the same wiring after they're constructed.
  chat.setRemotesRegistry(remotes);
  // Observable-progress auto-advance: ChatManager advances a craftbook step
  // (when its `advanceWhen` deliverable appears) by calling back into the
  // TaskManager's normal completion path. Injected, not a direct handle, to
  // avoid the construction-time cycle — same pattern as the runner above.
  chat.setTaskAdvancer(async (projectId, num, stepId, goto) => {
    const outcome = await tasks.completeStepChecked(projectId, num, stepId, goto, {
      cause: 'auto',
    });
    if (outcome.status === 'held') {
      return {
        status: 'held',
        message: outcome.gate.message,
        messageFingerprint: outcome.gate.messageFingerprint,
        attempt: outcome.gate.attempt,
        ...(outcome.gate.paused ? { paused: true } : {}),
        ...(outcome.gate.infrastructureError ? { infrastructureError: true } : {}),
        ...(outcome.gate.unsatisfiable ? { unsatisfiable: true } : {}),
        ...(outcome.gate.scriptRuns ? { scriptRuns: outcome.gate.scriptRuns } : {}),
        ...(outcome.gate.escalationStage !== undefined
          ? { escalationStage: outcome.gate.escalationStage }
          : {}),
      };
    }
    return { status: 'advanced' };
  });

  // Fail-fast per-task budget (Theme F, F3.1): when a task exhausts its
  // cumulative unattended-spend budget, ChatManager routes here to the same
  // pause-for-help path the scheduler/gate escalations use — a diagnostic
  // note plus `status: 'paused'`, which is RESUMABLE. Injected callback, not a
  // direct handle — same construction-cycle reason as `setTaskAdvancer`.
  chat.setTaskBudgetHandler(async (taskRef, info) => {
    const parsed = parseTaskRef(taskRef);
    if (!parsed) return;
    const { projectId, num } = parsed;
    const spent =
      info.reason === 'turns'
        ? `${info.snapshot.turns} turns`
        : `${info.snapshot.outputTokens} generated tokens`;
    const noteText = [
      `# Task budget exhausted — paused for help\n\nThis task crossed its fail-fast budget (${spent}, model tier \`${info.tier}\`)`,
      'without completing, while making no attended progress. Pausing it so you can look —',
      'narrow the scope, clarify the goal, or resume it manually once unblocked.',
      'Tune or disable this via the `taskBudget` config.',
    ].join(' ');
    await tasks
      .appendNote(projectId, num, { text: noteText, author: { kind: 'user' } })
      .catch(() => {});
    await tasks.setStatus(projectId, num, 'paused').catch(() => {});
    const budgetTask = await tasks.get(projectId, num).catch(() => null);
    if (budgetTask) {
      await tasks.emitNeedsHelp({
        projectId,
        task: budgetTask,
        reason: 'budget_exhausted',
        detail: `The task crossed its fail-fast budget (${spent}, model tier ${info.tier}) without completing.`,
      });
    }
  });

  // Role auto-assignment: a craftbook step's `suggestedRole` resolves
  // to a concrete gezel id (roster match → gilde template → bespoke)
  // at step-activation time. Without this a /review craftbook
  // assigned to a Developer-template gezel keeps that Developer; with
  // it, the entry step pulls the Reviewer onto the project and hands
  // off cleanly. Errors are swallowed inside TaskManager — a
  // misconfigured wiring falls back to the task-level assignee.
  const { ensureGezel } = await import('./gezels/ensure.js');
  // Named so the craftbook command launcher (below) can reuse the exact
  // same role→gezel resolution the step-activation path uses.
  const roleResolverClosure = async (
    role: string,
    projectId: string,
  ): Promise<{ gezelId: string } | null> => {
    try {
      const res = await ensureGezel({
        opts: { jobTitle: role },
        store,
        catalog,
        chat,
        // Role resolution runs inside advance_task_step's HTTP/MCP request.
        // Never synchronously invoke the local model that is waiting for this
        // tool result; curated Gilde templates still win above this fallback.
        bespokeMode: 'static',
      });
      // Pull the resolved gezel onto the project roster so the step
      // assignee is actually a project member — without this the
      // handoff fires but the project sidebar doesn't show the
      // gezel, and `list_project_gezels` misses them.
      await store.addGezelToProject(projectId, res.gezelId, { source: 'task' }).catch(() => {
        /* roster add is best-effort */
      });
      return { gezelId: res.gezelId };
    } catch (err) {
      log.warn(
        `[tasks] ensureGezel failed for role="${role}":`,
        err instanceof Error ? err.message : err,
      );
      return null;
    }
  };
  tasks.setRoleResolver(roleResolverClosure);

  // Install a craftbook's bundled scripts into the project's scripts/
  // folder the first time a task is created from it. Idempotent — the
  // provenance marker comment makes re-installs no-ops when the
  // catalog version matches what's on disk. Without this hook the
  // bundledScripts list goes nowhere and onExit script refs error at
  // first call ("script not found").
  const { installCraftbookScripts, installLocalCraftbookScripts } = await import(
    './scripts/install.js'
  );
  tasks.setTaskCreatedHook(async ({ projectId, sources }) => {
    for (const src of sources) {
      // Local craftbooks (editor-authored) carry their scripts on disk —
      // copy from the local template dir rather than the bundled catalog.
      if (src.sourceId === 'local') {
        await installLocalCraftbookScripts(
          home,
          projectId,
          src.catalogId,
          src.version ?? '1.0.0',
        ).catch((err) => {
          log.warn(
            `[tasks] failed to install local craftbook scripts for ${src.catalogId}: ${err instanceof Error ? err.message : err}`,
          );
        });
        continue;
      }
      const detail = await catalog
        .get('craftbook-template', src.catalogId, src.sourceId, src.version)
        .catch(() => null);
      if (!detail || detail.manifest.kind !== 'craftbook-template') continue;
      await installCraftbookScripts(home, projectId, detail.manifest, catalog).catch((err) => {
        log.warn(
          `[tasks] failed to install craftbook scripts for ${src.catalogId}: ${err instanceof Error ? err.message : err}`,
        );
      });
    }
  });

  // Wire the craftbook resolver: project-local books shadow local
  // templates, which shadow the bundled catalog. Shared with the
  // project-type install path (craftbook/resolve.ts) and the command
  // launcher below so all three resolve through the exact same chain.
  const craftbookResolver = makeCraftbookResolver(store, catalog);
  tasks.setCraftbookResolver(craftbookResolver);

  const channels = new ChannelManager({ store, secrets, history, debug });

  const git = new GitManager(home, store, secrets);
  const gitHubPrs = new GitHubPrs(git);
  const renderer = new ImageRenderer({ home });

  // Image-generation provider manager. Lazy-builds the underlying
  // provider on first use via `providers/image/factory.ts` selection
  // rules. The cloud branches (`google-ai`, `openai`) read API keys
  // from the SecretStore; `reset()` is invoked from the config PUT
  // handler whenever image-related config or credentials change.
  const imageProvider = new ImageProviderManager({
    home,
    store,
    secrets,
    arbiter: gpuArbiter,
    localOnly: serviceRole === 'machine-engine',
  });
  // Pull registry — owns the lifecycle of in-flight image-model pulls
  // so the download keeps running when the user navigates away from the
  // Settings → Image generation page. The HTTP routes are just consumers
  // that subscribe to its event fan-out + snapshot list.
  const imagePulls = new ImageModelPullRegistry({ imageProvider, catalog });
  // Chat-model install registries — same design for llama-cpp / ds4 / mlx:
  // the install runs as a background job owned by the registry, HTTP
  // requests are subscribers, and a client disconnect no longer abandons a
  // multi-GB download. Cache busting happens on `done` BEFORE the event
  // reaches subscribers, so a UI observing `done` re-fetches fresh state.
  const chatInstalls = buildChatModelInstallRegistries({
    home,
    readConfig: () => store.readConfig().catch(() => null),
    llamaCppModels,
    ds4Models,
    mlxModels,
    recognition,
    onDone: (engine) => invalidateModelsCache(engine),
  });
  // Video-generation provider + pull registry. Same lazy-build / reset
  // shape as `imageProvider`; the bundled diffusers engine shares the
  // `uvRuntime` (Python venv) and `gpuArbiter` (VRAM tenancy).
  const videoProvider = new VideoProviderManager({
    home,
    store,
    catalog,
    uvRuntime,
    arbiter: gpuArbiter,
  });
  const videoPulls = new VideoModelPullRegistry({ videoProvider, catalog });
  // Audio (STT + TTS) provider managers. Same lazy-build / reset
  // shape as `imageProvider`; lifecycle hangs off this same scope so
  // shutdown() is awaited below alongside the other managers.
  const stt = new SpeechToTextProviderManager({ home });
  const tts = new TextToSpeechProviderManager({ home });
  // Remote model execution: route `remote:<id>/…` multimodal models to the
  // hosting paired server (GPU-heavy generation runs there; the artifact still
  // persists into A's project via the existing routes).
  imageProvider.setRemotes(remotes);
  videoProvider.setRemotes(remotes);
  stt.setRemotes(remotes);
  tts.setRemotes(remotes);
  const resolveMachineEngineRemoteId = () =>
    remotes.list().find((remote) => remote.managed === 'machine-engine')?.remoteId ?? null;
  if (serviceRole === 'user') {
    imageProvider.setMachineEngineRemoteResolver(resolveMachineEngineRemoteId);
    videoProvider.setMachineEngineRemoteResolver(resolveMachineEngineRemoteId);
    stt.setMachineEngineRemoteResolver(resolveMachineEngineRemoteId);
    tts.setMachineEngineRemoteResolver(resolveMachineEngineRemoteId);
  }
  // Start discovery only after every native provider manager is wired. The
  // bridge publishes the verified remote before invoking this single drain,
  // so new work routes machine-wide while existing local work finishes.
  const machineEngineDiscovery =
    opts.machineEngineDiscovery ?? process.env.GEZEL_DISABLE_MACHINE_ENGINE !== '1';
  if (serviceRole === 'user' && !machineEngineDiscovery) {
    log.info('[machine-engine] discovery disabled; native inference stays in this user daemon');
  }
  const machineEngine =
    serviceRole === 'user' && machineEngineDiscovery
      ? await startMachineEngineBridge({
          home,
          remotes,
          chat,
          retireLocalEnginesForMachineBroker: async () => {
            await Promise.all([
              chat.retireLocalEnginesForMachineBroker(),
              imageProvider.retireLocalForMachineBroker(),
              videoProvider.retireLocalForMachineBroker(),
              stt.retireLocalForMachineBroker(),
              tts.retireLocalForMachineBroker(),
            ]);
          },
          ...(opts.machineEngineHome ? { machineHome: opts.machineEngineHome } : {}),
        })
      : undefined;

  // Wire the phase-activation hook: when a phase advances and the new
  // step has a gezel assignee (or suggestedGezelId), auto-start a session
  // for them so the handoff actually kicks off instead of just flipping
  // state. Kept out of the `TaskManager` constructor to avoid a circular
  // dep — and kept here (not inline in chat/) so the wiring is visible
  // alongside the other cross-manager plumbing.
  // Parse a spawn-host's `overFile` JSON into the item array that drives a
  // declarative fanout. `itemsPath` (dotted) navigates to a nested array;
  // absent → the parsed value must itself be the array. Returns [] on any
  // parse/shape problem so a malformed run degrades to "no fanout", never a
  // throw. Only plain-object items are kept (each becomes a child's context).
  const extractSpawnItems = (raw: string, itemsPath?: string): Record<string, unknown>[] => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
    let node: unknown = parsed;
    if (itemsPath) {
      for (const key of itemsPath.split('.')) {
        if (node && typeof node === 'object' && key in (node as Record<string, unknown>)) {
          node = (node as Record<string, unknown>)[key];
        } else {
          return [];
        }
      }
    }
    if (!Array.isArray(node)) return [];
    return node.filter(
      (it): it is Record<string, unknown> => !!it && typeof it === 'object' && !Array.isArray(it),
    );
  };

  tasks.setStepActivatedHook(async ({ projectId, task, newStep, completedStep }) => {
    // ── Automated ACTIVATION gate ───────────────────────────────────────
    // When the newly-activated step declares an activation-moment gate
    // (legacy GateSpec, or a StepGate with `at: 'activation'`), the
    // RUNTIME evaluates it against the workspace and routes the task —
    // with NO model turn. This is what carries a small model through the
    // loop: it only ever has to `write_file`; the runtime judges + routes
    // + loops. Completion-moment gates are NOT handled here — they fire
    // inside TaskManager.completeStep as a guard.
    if (newStep.gate) {
      const gate = normalizeStepGate(newStep.gate);
      if (gate.at === 'activation') {
        const gateProject = await store.getProject(projectId).catch(() => null);
        if (gateProject && !projectAllowsAmbientWork(gateProject)) return;
        const attempt = newStep.attemptCount ?? 1;
        const onFail = gate.onReject ?? task.craftbook.entryStepId;
        const reader: GateWorkspaceReader = {
          read: (f) => store.readProjectWorkspaceFile(projectId, f).catch(() => null),
          list: async () =>
            (await store.listProjectWorkspaceRecursive(projectId).catch(() => []))
              .filter((e) => !e.isDirectory)
              .map((e) => e.path),
          readArtifact: (f) => store.readProjectArtifact(projectId, f).catch(() => null),
          listArtifacts: async () =>
            (await store.listProjectArtifactsRecursive(projectId).catch(() => []))
              .filter((e) => !e.isDirectory)
              .map((e) => e.path),
        };
        const outcome = await evaluateStepGate({
          gate,
          ws: reader,
          // Activation gates run with no session in flight; standard-scope
          // scripts are trusted, everything else respects engagement mode.
          runScript: async (ref) => {
            if (ref.scope !== 'standard') {
              const config = await store.readConfig();
              if (!isEngagementAllowed(config)) return 'skipped';
            }
            return scriptRunner.run({
              projectId,
              scriptName: ref.name,
              ...(ref.scope ? { scope: ref.scope } : {}),
              inputs: ref.inputs,
              trigger: { kind: 'step', taskRef: task.ref, stepId: newStep.id, moment: 'gate' },
            });
          },
        });

        // Mirror of TaskManager.logStepGated for the legacy activation
        // moment — without this the per-book gate stats silently miss
        // every activation-gated (legacy GateSpec) book.
        const logActivationGated = (decision: 'approve' | 'reject', paused: boolean) => {
          const failedKinds = (outcome.checkResults ?? [])
            .filter((c) => !c.ok)
            .map((c) => c.kind as string);
          const book = task.sourceCraftbookIds?.find((s) => s.role === 'main');
          const gezelId =
            newStep.assignee?.kind === 'gezel'
              ? newStep.assignee.gezelId
              : (newStep.suggestedGezelId ??
                (task.assignee.kind === 'gezel' ? task.assignee.gezelId : undefined));
          return history
            .log({
              kind: 'task.step.gated',
              projectId,
              ...(gezelId ? { gezelId } : {}),
              summary:
                decision === 'approve'
                  ? `Gate approved ${task.ref} step "${newStep.name}"`
                  : `Gate rejected ${task.ref} step "${newStep.name}" (attempt ${attempt}/${gate.maxAttempts})`,
              details: {
                ref: task.ref,
                stepId: newStep.id,
                decision,
                gateAt: 'activation',
                attempt,
                maxAttempts: gate.maxAttempts,
                paused,
                bookCatalogId: book?.catalogId ?? task.craftbook.id,
                ...(book?.version ? { bookVersion: book.version } : {}),
                ...(decision === 'reject' && failedKinds.length > 0
                  ? { firstFailKind: failedKinds[0], failedKinds }
                  : {}),
                ...(outcome.skipped.length > 0 ? { skippedScripts: outcome.skipped } : {}),
              },
            })
            .catch(() => {});
        };

        if (outcome.decision === 'approve' && !gate.reviewer) {
          // Floor cleared and no dynamic reviewer to consult → advance.
          await logActivationGated('approve', false);
          const onPass = outcome.goto ?? gate.onApprove ?? newStep.next;
          if (onPass) {
            await tasks
              .completeStep(projectId, task.num, newStep.id, onPass, { cause: 'gate' })
              .catch((err) => log.error('[gate] pass-advance failed:', err));
          }
          return;
        }
        if (outcome.decision === 'reject') {
          // Write the concrete gaps so the builder fixes THOSE, then loop
          // back — unless we've looped too many times, then pause + surface.
          await tasks
            .appendNote(projectId, task.num, {
              text: `# Evaluation gate — not yet met (attempt ${attempt})\n\n${outcome.message ?? ''}\n\nAddress these, then the gate re-checks automatically.`,
              author: { kind: 'user' },
              stepId: outcome.goto ?? onFail,
            })
            .catch(() => {});
          if (attempt >= gate.maxAttempts) {
            await tasks.setStatus(projectId, task.num, 'paused').catch(() => {});
            log.warn(
              `[gate] ${task.ref} step "${newStep.id}" not met after ${attempt} attempts — pausing for help`,
            );
            await logActivationGated('reject', true);
            return;
          }
          await logActivationGated('reject', false);
          await tasks
            .completeStep(projectId, task.num, newStep.id, outcome.goto ?? onFail, {
              cause: 'gate',
            })
            .catch((err) => log.error('[gate] fail-loop failed:', err));
          return;
        }
        // approve && gate.reviewer → fall through to start a session for
        // the reviewer role (Layer 2): the dynamic Playwright pass.
      }
    }

    // ── Declarative per-item fanout ─────────────────────────────────────
    // A step marked `spawnFanout` on a spawn-host task (one carrying a
    // `spawnsCraftbook`) fans out one child task per item in the parent
    // craftbook's `spawn.overFile` JSON array on its declared surface — the runtime does
    // the spawning, with NO model tool call. Each child inherits the item's
    // fields as `variation.context` (string-substituted into its step
    // prompt + gate paths) and dispatches through its own entry-step binding
    // (the existing spawnChild → onStepActivated path). Placed BEFORE the
    // single-gezel dispatch: after fanning out we stamp the step's
    // advanceWhen deliverable and advance to the next (collect) step, then
    // return — the crew (children) ARE the work, so no redundant parent
    // worker turn is started. The collect step's fileCount gate is the
    // barrier that waits on the children's files. Fail-safe: every
    // read/parse/spawn error is logged and swallowed so a malformed run
    // never throws into the lifecycle. Idempotent: we skip spawning when the
    // parent already has children (a loop-back re-activation must not
    // double-spawn).
    const spawn = task.craftbook.spawn;
    if (newStep.spawnFanout && task.spawnsCraftbook && spawn) {
      // Ambient-work guard, same as the single-gezel dispatch below: a
      // read-only / inactive / stable project pauses all autonomous work,
      // and a fanout spawns child turns, so honor it here too.
      const fanoutProject = await store.getProject(projectId).catch(() => null);
      if (fanoutProject && !projectAllowsAmbientWork(fanoutProject)) return;
      try {
        const existing = await tasks.listChildren(task.ref).catch(() => []);
        if (existing.length === 0) {
          const raw = await (spawn.overArtifact
            ? store.readProjectArtifact(projectId, spawn.overFile)
            : store.readProjectWorkspaceFile(projectId, spawn.overFile)
          ).catch(() => null);
          const items = raw ? extractSpawnItems(raw, spawn.itemsPath) : [];
          if (items.length === 0) {
            log.warn(
              `[fanout] ${task.ref} step "${newStep.id}": no items in ${spawn.overFile} — skipping fanout`,
            );
          } else {
            for (const item of items) {
              const context: Record<string, string> = {};
              for (const [k, v] of Object.entries(item)) {
                // Scalars substitute as themselves; anything structural is
                // JSON so the child can parse it. `String(['a','b'])` gives
                // `a,b` — readable in a prompt, but a child whose slice of
                // work IS that array (a batch's `paths`) then has no way to
                // recover the items, and any path built from it is junk.
                context[k] =
                  v == null
                    ? ''
                    : typeof v === 'string'
                      ? v
                      : typeof v === 'object'
                        ? JSON.stringify(v)
                        : String(v);
              }
              const title =
                context.number && context.client
                  ? `Invoice ${context.number} — ${context.client}`
                  : (context.client ?? context.number ?? undefined);
              await tasks
                .spawnChild(task.ref, { context, ...(title ? { title } : {}) })
                .catch((err) =>
                  log.error(`[fanout] ${task.ref}: spawnChild failed for one item:`, err),
                );
            }
            log.info(
              `[fanout] ${task.ref} step "${newStep.id}": spawned ${items.length} child(ren) from ${spawn.overFile}`,
            );
          }
        }
        // Stamp the step's advanceWhen deliverable (a machine manifest of the
        // fanned-out items) so the produced-deliverable record exists, then
        // advance to the next step. The children draft in parallel; the
        // collect step's fileCount gate waits on their files.
        const advanceFile = newStep.advanceWhen?.file;
        if (advanceFile) {
          const kids = await tasks.listChildren(task.ref).catch(() => []);
          const manifest = `# Fanned out ${kids.length} draft(s)\n\n${kids
            .map((k) => `- ${k.ref}: ${k.title}`)
            .join('\n')}\n`;
          await (newStep.advanceWhen?.artifact
            ? store.writeProjectArtifact(projectId, advanceFile, manifest)
            : store.writeProjectWorkspaceFile(projectId, advanceFile, manifest)
          ).catch((err) => log.warn(`[fanout] ${task.ref}: could not write ${advanceFile}:`, err));
        }
        const nextStep = newStep.advanceWhen?.goto ?? newStep.next;
        if (nextStep) {
          await tasks
            .completeStep(projectId, task.num, newStep.id, nextStep, { cause: 'gate' })
            .catch((err) => log.error(`[fanout] ${task.ref}: advance after fanout failed:`, err));
        }
      } catch (err) {
        log.error(`[fanout] ${task.ref} step "${newStep.id}" fanout crashed (non-fatal):`, err);
      }
      return;
    }

    const assigneeGezelId =
      newStep.assignee?.kind === 'gezel' ? newStep.assignee.gezelId : newStep.suggestedGezelId;
    if (!assigneeGezelId) return;
    const prevGezelId =
      completedStep.assignee?.kind === 'gezel'
        ? completedStep.assignee.gezelId
        : completedStep.suggestedGezelId;
    // Self-handoff: normally we don't start a new session when the same
    // gezel owned both steps. But a craftbook step CHANGE means a new
    // procedure (and, in a crew, different role tools) — so when the new
    // step carries its own `prompt`, start a fresh, clean, task-scoped
    // session even for the same gezel. This is what lets a solo-collapsed
    // multi-step craftbook (every step = the one specialist) actually
    // advance through its phases: without it, no transition ever
    // re-engages the worker with the next step's instructions. A
    // procedure-less step keeps the old skip (a redundant session would
    // just confuse them).
    if (prevGezelId === assigneeGezelId && !newStep.prompt) return;
    // If the project is read-only or inactive, don't dispatch the
    // handoff. The step-advance tool call itself still mutates task
    // state (that's a user-initiated action if it got here), but we
    // stop short of starting a gezel turn.
    const project = await store.getProject(projectId).catch(() => null);
    if (project && !projectAllowsAmbientWork(project)) return;
    // Route through the TaskRunner instead of dispatching directly.
    // The runner paces handoffs via the provider queue so 50
    // simultaneous step-advances don't all fire at once.
    const fromGezel = prevGezelId ? await store.getGezel(prevGezelId).catch(() => null) : null;
    taskRunner.enqueueHandoff({
      gezelId: assigneeGezelId,
      projectId,
      taskRef: task.ref,
      stepId: newStep.id,
      ...(task.nightShift?.enabled === true ? { nightShift: true } : {}),
      ...(newStep.lastActivatedAt ? { activationAt: newStep.lastActivatedAt } : {}),
      ...(fromGezel?.name ? { fromGezelName: fromGezel.name } : {}),
      ...(prevGezelId ? { fromGezelId: prevGezelId } : {}),
    });
  });

  // Craftbook command launcher: the in-chat terminal recognizes a
  // craftbook command (e.g. `code-review security high`) and dispatches
  // it here. We create a task from the craftbook with the supplied
  // params, assign the role-matched gezel for the entry step, and start
  // it. Kept alongside the other cross-manager wiring; injected into the
  // TerminalManager below. NOTE: `tasks.create` fires only
  // `onTaskCreated` (not `onStepActivated`), so it does NOT auto-start
  // the entry step — the explicit `dispatchTaskEntry` call is the
  // single kickoff. Its OTHER call site is the create route's
  // `dispatchEntry` flag (routes/project-tasks.ts, the meester macros'
  // path). If a future change auto-starts the entry step on create,
  // drop both call sites to avoid a double start.
  const craftbookInvoker: CraftbookInvoker = async ({ projectId, craftbookId, params }) => {
    // Resolve through the task resolver's chain, not the catalog alone: a
    // project-local book (`.gezel/craftbooks/`, usually converted from a
    // repo SKILL.md) is offered by the launcher rail, so a catalog-only
    // lookup here rejected exactly the books this project defined itself.
    const resolved = await craftbookResolver.resolve(craftbookId, { projectId }).catch(() => null);
    if (!resolved) {
      throw new Error(`unknown craftbook "${craftbookId}"`);
    }
    const m = resolved.craftbook;

    const paramSummary = Object.entries(params)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ');
    const withClause = paramSummary ? ` with ${paramSummary}.` : '.';
    const tail = m.description ? ` ${m.description}` : '';
    const description =
      `Run the "${m.name}" craftbook against this project${withClause}${tail}`.slice(0, 2000);

    // Assignee = role-matched gezel for the entry step, not the user.
    const entryRole = m.steps.find((s) => s.id === m.entryStepId)?.suggestedRole;
    let assignee: TaskAssignee = { kind: 'user' };
    if (entryRole) {
      const owner = await roleResolverClosure(entryRole, projectId).catch(() => null);
      if (owner?.gezelId) assignee = { kind: 'gezel', gezelId: owner.gezelId };
    }
    if (assignee.kind === 'user') {
      // A book whose entry step names no role — every SKILL.md conversion
      // that carried no persona — would otherwise launch owned by the user
      // and never dispatch: created, active, and inert, which reads to the
      // user as "I ran it and nothing happened". The voorman is the
      // project's standing answer to "who picks this up?", and can route it
      // onward. Falls through to the user only when the project has none.
      const voormanGezelId = (await store.getProject(projectId).catch(() => null))?.voormanGezelId;
      if (voormanGezelId) assignee = { kind: 'gezel', gezelId: voormanGezelId };
    }

    const task = await tasks.create(projectId, {
      title: `${m.name} — ${new Date().toLocaleString()}`,
      description,
      craftbookId,
      assignee,
      ...(Object.keys(params).length > 0 ? { craftbookParams: params } : {}),
      // A craftbook with a declarative `spawn` block becomes a spawn host:
      // its child template rides in as `spawnsCraftbook`, and the runtime
      // fans out one child per item when the `spawnFanout` step activates
      // (see the onStepActivated fanout branch). No cron/fanout needed —
      // the fanout trigger is the spawn-host mechanism for this book.
      ...(m.spawn
        ? {
            spawnsSteps: m.spawn.steps,
            ...(m.spawn.entryStepId ? { spawnsEntryStepId: m.spawn.entryStepId } : {}),
          }
        : {}),
      createdBy: { kind: 'user' },
    });

    // Stamp invocation params as an entry-step note so the gezel reads
    // them via `read_task_notes` (mirrors spawnChild's instance context).
    if (Object.keys(params).length > 0 && task.activeStepId) {
      const lines = ['# Invocation parameters', ''];
      for (const [k, v] of Object.entries(params)) lines.push(`- **${k}**: ${v}`);
      await tasks
        .appendNote(task.projectId, task.num, {
          text: lines.join('\n'),
          author: { kind: 'user' },
          stepId: task.activeStepId,
        })
        .catch(() => {
          /* note is best-effort */
        });
    }

    // Entry-gezel resolution + ambient-work guard + enqueue live in the
    // shared helper so this launcher and the create-route `dispatchEntry`
    // flag (the meester macros' path) cannot drift.
    const dispatch = await dispatchTaskEntry({ store, taskRunner, history }, task);

    return {
      taskRef: task.ref,
      craftbookName: m.name,
      ...(dispatch.assigneeName ? { assigneeName: dispatch.assigneeName } : {}),
      started: dispatch.enqueued,
    };
  };

  const { JobManager: FolderJobManager } = await import('./folders/job-manager.js');
  const folderJobs = new FolderJobManager();
  const { StorageJobManager } = await import('./storage/job-manager.js');
  const storageJobs = new StorageJobManager();
  const { detectInterruptedMove } = await import('./folders/recovery.js');
  void detectInterruptedMove(home);

  // WorkspaceIndexManager is referenced by the index HTTP routes so it
  // must be constructed before the context is built. Started later
  // (after the HTTP server is listening) alongside the other periodic
  // sweeps so initial scans don't fight with boot-time work.
  // Content index (code/doc intelligence) — backs the code-intel MCP tools and
  // is refreshed by the workspace indexer's tick.
  const contentIndex = new ContentIndex(store, home);
  // Post-construction injection (ChatManager is built ~500 lines earlier):
  // powers the workspace-gestalt prompt block and index-enriched recall.
  chat.setContentIndex(contentIndex);
  const workspaceIndex = new WorkspaceIndexManager({
    home,
    store,
    chat,
    catalog,
    contentIndex,
    events: chatEvents,
  });
  // Same post-construction injection as the content index above: the
  // indexer takes `chat` as a dependency, so the reference parser can only
  // reach the workspace listing from this side.
  chat.setWorkspaceIndex(workspaceIndex);
  // Code reviews: snapshot-driven review tasks kicked off from the GitHub
  // tab's Review panel; records live in per-project code-reviews.json.
  const codeReviews = new CodeReviewManager({
    home,
    store,
    git,
    tasks,
    taskRunner,
    history,
    catalog,
    chat,
    contentIndex,
    workspaceIndex,
  });
  // Report actions: the ```gezel-action blocks night reports embed —
  // durable fired/dismissed lifecycle in per-project report-actions.json.
  const reportActions = new ReportActionManager({
    home,
    store,
    tasks,
    taskRunner,
    history,
    catalog,
    chat,
  });
  // Diffpacks: change sets a gezel drafted into artifacts for the user to
  // review and apply. The workspace is never written by the drafting side.
  const diffpacks = new DiffpackManager({ home, store, tasks, history });
  // Morning review question: once per settled night window (deduped on
  // the window key against the question store, so restarts and
  // slept-through-window-end catch-ups never double-ask), summarize what
  // the shift accomplished as a needs-input card with report links.
  nightShift.setOnWindowSettled(async (windowKey) => {
    const existing = await store.listProjectQuestions('default').catch(() => []);
    if (
      existing.some(
        (q) => q.intent?.kind === 'night-shift-review' && q.intent.windowKey === windowKey,
      )
    ) {
      return;
    }
    const review = await buildNightShiftReview(
      { store, tasks, reportActions, diffpacks },
      nightShift.currentWindow(),
      new Date(),
    );
    if (review.windowKey !== windowKey) return;
    if (review.tasksCompleted.length === 0 && review.reports.length === 0) return;
    const config = await store.readConfig().catch(() => ({}) as GezelConfig);
    const actionTotal = review.reports.reduce((n, r) => n + r.actionCounts.total, 0);
    await store.writeQuestion({
      id: randomUUID(),
      projectId: 'default',
      gezelId: config.meesterGezelId ?? '',
      // No live session — the answer route early-returns for this intent.
      sessionId: '',
      prompt: `The night shift finished: ${review.tasksCompleted.length} task(s) completed, ${review.reports.length} report(s) written${actionTotal > 0 ? `, ${actionTotal} suggested action(s) to review` : ''}.`,
      choices: ['Dismiss'],
      allowWriteIn: false,
      multiSelect: false,
      ...(review.reports[0]
        ? { documentPath: nightShiftReportAttachmentPath(review.reports[0]) }
        : {}),
      intent: {
        kind: 'night-shift-review',
        windowKey: review.windowKey,
        tasksCompleted: review.tasksCompleted.length,
        reports: review.reports.map((r) => ({
          projectId: r.projectId,
          path: r.path,
          title: r.title,
          actionCount: r.actionCounts.total,
        })),
      },
      createdAt: new Date().toISOString(),
    });
  });
  // Paused-for-help fan-in: every pause-for-help path (gate exhausted /
  // plateau / unsatisfiable / infrastructure, stalled step, spent budget)
  // files ONE needs-input card so the pause is pushed to the user instead
  // of discovered by opening the Tasks view. Deduped on an unanswered
  // card for the same task; a task that pauses again after the card was
  // answered files a fresh one. No live session — answering collapses
  // the card; the `taskRef` attachment gives the UI its "Open task" link.
  tasks.setTaskNeedsHelpHook(async ({ projectId, task, stepId, reason, detail }) => {
    const existing = await store.listProjectQuestions(projectId).catch(() => []);
    if (
      existing.some(
        (q) => q.intent?.kind === 'task-paused' && q.intent.taskRef === task.ref && !q.answer,
      )
    ) {
      return;
    }
    const config = await store.readConfig().catch(() => ({}) as GezelConfig);
    const stepPart = stepId ? ` at step \`${stepId}\`` : '';
    await store.writeQuestion({
      id: randomUUID(),
      projectId,
      gezelId: config.meesterGezelId ?? '',
      sessionId: '',
      prompt: `Task ${task.ref} ("${task.title}") paused for help${stepPart}: ${detail}`,
      choices: ['Dismiss'],
      allowWriteIn: false,
      multiSelect: false,
      taskRef: task.ref,
      intent: {
        kind: 'task-paused',
        taskRef: task.ref,
        ...(stepId ? { stepId } : {}),
        reason,
      },
      createdAt: new Date().toISOString(),
    });
  });
  // Terminal-task fan-out, one callee per feature, each isolated so a
  // failing settle never starves the others: finding delegation closes
  // the linked finding (cancel reopens it); code reviews flip their
  // record to complete/canceled.
  tasks.setTaskSettledHook(async ({ projectId, task, outcome }) => {
    await contentIndex
      .settleFindingsForTask(projectId, task.ref, outcome)
      .catch((err) => log.warn(`[service] finding settle failed for ${task.ref}: ${String(err)}`));
    await contentIndex
      .settleBoekwachterIssuesForTask(projectId, task.ref, outcome)
      .catch((err) =>
        log.warn(`[service] Boekwachter issue settle failed for ${task.ref}: ${String(err)}`),
      );
    await codeReviews
      .settleForTask(projectId, task.ref, outcome)
      .catch((err) => log.warn(`[service] review settle failed for ${task.ref}: ${String(err)}`));
    // A completed drafting task seals its pack; a canceled one discards the
    // draft tree, because a half-finished proposal is worse than none — the
    // user cannot tell which parts the gezel stood behind.
    await diffpacks
      .settleForTask(projectId, task.ref, outcome)
      .catch((err) => log.warn(`[service] diffpack settle failed for ${task.ref}: ${String(err)}`));
    // Report actions can live in a different project than their fired
    // task (the oversight report delegates cross-project), so this settle
    // scans records by taskRef rather than trusting projectId.
    await reportActions
      .settleForTask(task.ref, outcome)
      .catch((err) =>
        log.warn(`[service] report-action settle failed for ${task.ref}: ${String(err)}`),
      );
  });
  // Global search index (session transcripts + history mirror + documents):
  // change hooks enqueue into the single-writer manager; the read facade is
  // consulted by routes, the unified search, and (for `q` queries)
  // HistoryManager itself.
  const globalIndex = new GlobalIndex(home);
  const globalIndexManager = new GlobalIndexManager({ store, history });

  let libraryRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleLibraryRefresh = (): void => {
    if (!sharedProject) return;
    if (libraryRefreshTimer) clearTimeout(libraryRefreshTimer);
    libraryRefreshTimer = setTimeout(() => {
      libraryRefreshTimer = null;
      void workspaceIndex
        .refresh(sharedProject!.id)
        .catch((err) =>
          log.warn(`[library] refresh failed: ${err instanceof Error ? err.message : err}`),
        );
    }, LIBRARY_REFRESH_DEBOUNCE_MS);
    libraryRefreshTimer.unref?.();
  };

  store.onSessionChange((ev) => globalIndexManager.enqueueSession(ev));
  store.onDocumentChange((ev) => {
    globalIndexManager.enqueueDocument(ev);
    // An in-app document write is the one library change we learn about
    // immediately; the watcher covers edits made outside. Debounced so an
    // editor autosave burst collapses into one pass.
    scheduleLibraryRefresh();
  });
  history.subscribe((event) => globalIndexManager.enqueueHistory(event));
  history.setQueryBackend((f) => globalIndex.searchHistory(f));
  history.setRewriteBackend(() => globalIndexManager.rebuildHistoryMirror());
  // Cross-project unified search (titlebar quick-open + content fan-out).
  const search = new SearchService(store, contentIndex, memory, workspaceIndex, globalIndex);
  chat.setSearchService(search);
  // Knowledge catalogs: registry + mounts + install jobs + the search arm.
  // SQLite work lives on the knowledge worker thread (in-process fallback).
  // User daemons only — the machine broker installs shared bytes but never
  // mounts, searches, or holds a per-user registry.
  const knowledge =
    serviceRole === 'machine-engine'
      ? undefined
      : new KnowledgeManager({
          home,
          host: createWorkerCatalogHost(),
          projectPolicy: async (projectId) => {
            const project = await store.getProject(projectId);
            return project?.knowledgeCatalogs ?? null;
          },
        });
  if (knowledge) {
    await knowledge.start();
    search.setKnowledgeSearch({
      search: (query, opts) => knowledge.searchUnified(query, opts),
    });
  }
  // Drop the cached name catalog when a project/gezel/document is
  // created/renamed/deleted, so a just-created entity is quick-openable
  // immediately instead of after the catalog's TTL. The audit log is the
  // single chokepoint these mutations funnel through.
  history.subscribe((event) => {
    if (CATALOG_RELEVANT_HISTORY_KINDS.has(event.kind)) search.invalidateCatalog();
  });
  // The indexing job's control surface: a system task whose pause status
  // gates the AI indexing loops (enrichment, deep passes, digests).
  const indexingJob = new IndexingJobControl(store, tasks);
  // Background "boekwachter" enrichment: summaries + embeddings when idle,
  // bulk during night shift, folder/architecture rollups once files drain.
  const systemIdle = new SystemIdleState();
  const indexEnrichment = new IndexEnrichmentManager({
    store,
    chat,
    contentIndex,
    idle: systemIdle,
    isNightShiftActive: () => nightShift.isActive(),
    isPaused: () => indexingJob.isPaused(),
    events: chatEvents,
    history,
    refreshStatic: (projectId) => workspaceIndex.refreshAndWait(projectId),
    // AI-shadow producers: availability is probed per call (cheap health
    // checks; a missing vision/STT model degrades to null, and the shadow
    // gate's attempt cap stops per-file retries).
    shadowProducers: {
      describeImage: async (absPath) => {
        try {
          if (!(await recognition.isAvailable())) return null;
          const bytes = await readFile(absPath);
          const meta = readImageStaticMeta(bytes);
          const result = await recognition.recognize({
            bytes,
            mimeType: mimeTypeForFilename(absPath),
            mode: resolveAutoMode(meta, basename(absPath)),
          });
          if (result.status !== 'ok' && result.status !== 'partial') return null;
          const parts = [
            result.description,
            result.ocrText ? `Text in the image:\n\n${result.ocrText}` : null,
          ].filter((s): s is string => Boolean(s?.trim()));
          if (parts.length === 0) return null;
          // The recognition stack is llama.cpp mtmd in every non-test
          // configuration (local supervised or a pointed-at server).
          return { body: parts.join('\n\n'), model: result.modelId, provider: 'llama-cpp' };
        } catch {
          return null;
        }
      },
      transcribeAudio: async (absPath) => {
        try {
          const provider = await stt.providerForModel();
          if ((await provider.health()).status !== 'ok') return null;
          const bytes = await readFile(absPath);
          const out = await provider.transcribe({
            audio: { data: bytes, mimeType: mimeTypeForFilename(absPath) },
          });
          const text = out.text.trim();
          return text
            ? {
                body: text,
                ...(out.model ? { model: out.model } : {}),
                provider: 'whisper-cpp',
              }
            : null;
        } catch {
          return null;
        }
      },
    },
  });
  indexEnrichmentRef = indexEnrichment;
  // Night bug fixing: once the shift's index sweep drains, hand every
  // qualifying project's open Boekwachter issues to its developer, who drafts
  // change proposals into artifacts. Runs here rather than on activation so
  // it plans against tonight's findings, not last night's. The gate is crew
  // composition — a Boekwachter and a developer on the roster — and nothing
  // it produces touches the workspace.
  indexEnrichment.setOnCatchUpDrained(async () => {
    if (!nightShift.isActive()) return;
    await planNightFixes({
      store,
      tasks,
      taskRunner,
      contentIndex,
      catalog,
      diffpacks,
      history,
      nightShiftWindow: () => nightShift.currentWindow(),
    }).catch((err) => log.warn(`[diffpack] night fix planning failed: ${String(err)}`));
  });
  // Scan-complete → immediate embed drain: the moment a workspace scan
  // enrolls files, the always-on local embed tiers start filling vectors —
  // no 3-minute OS-idle wait, no Boekwachter. This is what makes semantic
  // search real minutes after a fresh install points gezel at a folder.
  workspaceIndex.setOnScanComplete((projectId) => {
    indexEnrichment.drainEmbedOnly(projectId);
  });
  // `gezel.index.*` for sandboxed scripts: the readiness surface craftbook
  // hooks use to make "this review depends on a current index" real. Wired
  // here (not at runner construction) because both index managers come up
  // after the runner in boot order — same late-binding shape as setMcpCall.
  scriptRunner.setIndexAccess({
    status: (projectId) => workspaceIndex.statusForUi(projectId),
    ensureFresh: (projectId, opts) =>
      ensureIndexFresh(
        {
          workspaceIndex: {
            statusForUi: (id) => workspaceIndex.statusForUi(id),
            refreshAndWait: (id) => workspaceIndex.refreshAndWait(id),
          },
          enrichment: {
            drive: (id, driveOpts) => indexEnrichment.drive(id, driveOpts),
            awaitDrive: (id) => indexEnrichment.awaitDrive(id),
            driveMode: (id) => indexEnrichment.driveMode(id),
          },
          resolveBoekwachter: (id) => resolveProjectBoekwachter(store, id).catch(() => null),
          isPaused: () => indexingJob.isPaused(),
        },
        projectId,
        opts,
      ),
  });
  // FS watcher for the MRU-top workspaces — turns an on-disk change into a
  // near-immediate refresh instead of waiting for the polling tick.
  const workspaceWatch = new WorkspaceWatchManager({
    store,
    indexManager: workspaceIndex,
    onProjectMcpConfigChanged: (projectId) => chat.resetProjectToolsets(projectId),
    // The library never opens as a project tab, so it can never earn an MRU
    // watcher slot — yet it is the one workspace that routinely changes from
    // outside the app (a sync client landing a file from another device).
    pinnedProjects: () => (sharedProject ? [sharedProject.id] : []),
  });

  // Connectors: mail, calendar, and wiki natives plus the generic drivers,
  // all behind ONE idle/posture-gated sync loop over `project.connectors`.
  // Mail accounts are ordinary `mail-*` bindings — the legacy `project.mail`
  // stack (MailManager + its routes) was retired in the connector overhaul.
  registerMailAdapters();
  registerCalendarAdapters();
  registerBlueskyAdapters();
  registerXAdapters();
  registerInstagramAdapters();
  registerLinkedInAdapters();
  registerGitHubReleasesAdapters();
  registerGitHubWikiAdapters();
  const connectorLocks = new ProjectLocks();
  const connectors = new ConnectorManager({
    store,
    secrets,
    catalog,
    contentIndex,
    scriptRunner,
    locks: connectorLocks,
  });
  const connectorActions = new ConnectorActionManager({
    store,
    secrets,
    catalog,
    contentIndex,
    scriptRunner,
    isNightShiftActive: () => nightShift.isActive(),
    locks: connectorLocks,
  });
  const connectorSync = new ConnectorSyncManager({
    store,
    chat,
    idle: systemIdle,
    isNightShiftActive: () => nightShift.isActive(),
    source: {
      label: 'connectors',
      listBindings: (p) => p.connectors ?? [],
      posture: (pol) => pol.allowExternalServices,
      syncProject: (p) => connectors.syncProject(p),
    },
  });

  // A craftbook that reads a connector corpus gets it pulled down at
  // LAUNCH, before its first step's prompt is built — the gezel then
  // reviews local artifact files instead of needing live API tools mid-turn.
  // Registered here (rather than as a TaskManager dependency) so the task
  // layer stays free of the connector subsystem.
  registerGitHubPullsAdapters({
    prs: gitHubPrs,
    project: async (projectId) => {
      const project = await store.getProject(projectId);
      if (!project) throw new Error(`project ${projectId} not found`);
      return project;
    },
    // Degrades to the link's pinned branch rather than failing the launch
    // when the checkout is missing or git is unreadable.
    currentBranch: async (project) => (await git.status(project).catch(() => null))?.branch,
  });
  tasks.setConnectorPrepHook(
    async ({ projectId, craftbookId, connectors: needs, params }) => {
      const prep = await runConnectorTaskPrep(
        {
          getProject: (id) => store.getProject(id),
          sync: (project, bindingId, opts) => connectors.syncBinding(project, bindingId, opts),
          allowConnectorData: async () =>
            resolveSecurityPolicy(await store.readConfig()).allowConnectorData,
          ensureBinding: async (project, need) => {
            if (need.typeId !== 'github-pulls') return null;
            if (!project.github?.url) return null;
            return connectors.bind(project, {
              type: 'github-pulls',
              displayName: 'GitHub Pull Requests',
              config: {},
            });
          },
        },
        { projectId, craftbookId, connectors: needs, params },
      );
      return { params: prep.params, ...(prep.note ? { note: prep.note } : {}) };
    },
    { autoPreparedTypes: ['github-pulls'] },
  );

  // In-chat terminal: per-(project, workingDir) thread manager + its
  // own pub/sub bus. Separate from `chatEvents` because the chat
  // envelope requires sessionId/gezelId, which terminal threads
  // don't carry. One SSE per project for terminal events; the UI
  // opens it alongside the chat project stream when terminal mode
  // is engaged.
  const terminalEvents = new TerminalEventBus();
  const terminals = new TerminalManager({
    store,
    workspaceIndex,
    events: terminalEvents,
    history,
    // Only craftbooks applicable to THIS project (requirements met) are
    // recognized as terminal commands — so e.g. `pull-request-review`
    // isn't a command in a non-GitHub project. Project-local books are
    // merged in (shadowing same-id catalog entries) to match what the
    // launcher rail offers: without them, clicking a book this repo
    // defined itself staged a line the terminal then tried to run as a
    // shell command.
    listCraftbookCommands: async (projectId) => {
      const projectItems = await projectCraftbookSummaries(store, projectId, { git });
      const projectIds = new Set(projectItems.map((it) => it.manifest.id));
      const catalogItems = await listApplicableCraftbooks(catalog, store, projectId, { git });
      const items = [
        ...projectItems,
        ...catalogItems.filter((it) => !projectIds.has(it.manifest.id)),
      ];
      return items.flatMap((it) =>
        it.manifest.kind === 'craftbook-template'
          ? [
              {
                id: it.manifest.id,
                command: it.manifest.command ?? it.manifest.id,
                ...(it.manifest.paramSchema ? { paramSchema: it.manifest.paramSchema } : {}),
              },
            ]
          : [],
      );
    },
    craftbookInvoker,
    // Project-wide MCP tools recognized as terminal commands + their run path,
    // both backed by the project-scoped (non-role-filtered) tool bridge.
    listMcpTools: async (projectId) => {
      const tools = await chat.listProjectTools(projectId);
      return tools.map((t) => ({ name: t.name }));
    },
    mcpToolInvoker: async ({ projectId, name, args }) =>
      chat.invokeProjectTool(projectId, name, args),
  });

  // Growth engine — XP/level refresh + level-up proposal generation.
  // Ambient refreshes ride the memory compactor's sweep (wired below);
  // the HTTP growth routes call it directly for user-initiated refresh.
  const growth = new GrowthEngine({
    store,
    memory,
    history,
    oneShot: (prompt, timeoutMs, opts) => chat.oneShotCompletion(prompt, timeoutMs, opts),
    announce: (gezelId, toLevel) => chat.announceGrowth(gezelId, toLevel),
  });

  const remoteFetchRef: { value?: Parameters<typeof serve>[0]['fetch'] } = {};
  const remoteServing = createRemoteServingController({
    cert,
    deviceFingerprint: deviceIdentity.fingerprint,
    fetch: () => {
      if (!remoteFetchRef.value) {
        throw new Error('remote serving cannot start before the HTTP app is ready');
      }
      return remoteFetchRef.value;
    },
  });
  const remoteTenantLimits = createTenantLimiter(config.remoteServing?.limits);

  // Opt-in unauthenticated Ollama-compat listener (port 11434). Same
  // deferred-fetch shape as remote serving: the controller is created
  // before the context literal (config route needs it), the app after.
  const ollamaEmulationFetchRef: { value?: Parameters<typeof serve>[0]['fetch'] } = {};
  const ollamaEmulation = createOllamaEmulationController({
    fetch: () => {
      if (!ollamaEmulationFetchRef.value) {
        throw new Error('ollama emulation cannot start before the HTTP app is ready');
      }
      return ollamaEmulationFetchRef.value;
    },
    ...(opts.ollamaEmulationPort !== undefined ? { port: opts.ollamaEmulationPort } : {}),
  });

  // Codex needs a stable plain-HTTP origin because the product daemon's port
  // and self-signed certificate rotate. Unlike Ollama emulation this listener
  // remains bearer-authenticated and exposes only inference. Its profile/file
  // manager decides whether it should be running.
  const codexBridgeFetchRef: { value?: Parameters<typeof serve>[0]['fetch'] } = {};
  const codexBridge = createCodexBridgeController({
    fetch: () => {
      if (!codexBridgeFetchRef.value) {
        throw new Error('Codex bridge cannot start before the HTTP app is ready');
      }
      return codexBridgeFetchRef.value;
    },
    port: opts.codexBridgePort ?? codexBridgePortForHome(home),
  });
  const listCodexSetupModels = createLocalHarnessModelSource({
    catalog,
    listModels: (provider, signal) => chat.listModelsForProvider(provider, signal),
    resolveNativeContextWindow: async (provider, modelId, signal) => {
      if (resolveMachineEngineRemoteId()) {
        const remoteProvider = await chat.getProviderForModel(provider, modelId);
        return (
          (await remoteProvider.prepareContextWindow?.(modelId, signal)) ??
          remoteProvider.getContextWindow?.()
        );
      }
      // Standalone, because this number is published to a Codex profile on
      // disk and read back on every launch for days. Live pricing charged the
      // model for whatever else was resident at setup time, so every entry
      // came out at the 64K floor even on a host admitting 128K+ — Codex then
      // compacted at 90% of the wrong figure, repeatedly, mid-task.
      return chat.previewContextWindowForModel(provider, modelId, { standalone: true });
    },
  });
  const codexSetup = createCodexSetupManager({
    home,
    ...(opts.codexHome !== undefined ? { codexHome: opts.codexHome } : {}),
    tokenStore,
    bridge: codexBridge,
    readConfig: () => store.readConfig(),
    listGezels: () => store.listGezels(),
    providerForGezel: (gezelId) => chat.providerForGezel(gezelId),
    listModels: listCodexSetupModels,
  });

  // OpenCode needs the same stable plain-HTTP origin as Codex, on its own port
  // so neither integration's lifecycle can take the other's listener down. Its
  // provider speaks chat completions rather than the Responses API, hence a
  // separate app over the same authenticated route stack.
  const opencodeBridgeFetchRef: { value?: Parameters<typeof serve>[0]['fetch'] } = {};
  const opencodeBridge = createOpenCodeBridgeController({
    fetch: () => {
      if (!opencodeBridgeFetchRef.value) {
        throw new Error('OpenCode bridge cannot start before the HTTP app is ready');
      }
      return opencodeBridgeFetchRef.value;
    },
    port: opts.opencodeBridgePort ?? opencodeBridgePortForHome(home),
  });
  const opencodeSetup = createOpenCodeSetupManager({
    home,
    tokenStore,
    bridge: opencodeBridge,
    readConfig: () => store.readConfig(),
    listGezels: () => store.listGezels(),
    providerForGezel: (gezelId) => chat.providerForGezel(gezelId),
    // The same proven-capability model source Codex uses: a coding harness
    // cannot fall back gracefully from a model that turns out not to do tools.
    listModels: listCodexSetupModels,
  });

  // pi speaks the same chat-completions dialect as OpenCode, on its own port
  // and credential so revoking one harness never disturbs the others.
  const piBridgeFetchRef: { value?: Parameters<typeof serve>[0]['fetch'] } = {};
  const piBridge = createPiBridgeController({
    fetch: () => {
      if (!piBridgeFetchRef.value) {
        throw new Error('pi bridge cannot start before the HTTP app is ready');
      }
      return piBridgeFetchRef.value;
    },
    port: opts.piBridgePort ?? piBridgePortForHome(home),
  });
  const piSetup = createPiSetupManager({
    home,
    ...(opts.piAgentDir !== undefined ? { piAgentDir: opts.piAgentDir } : {}),
    tokenStore,
    bridge: piBridge,
    readConfig: () => store.readConfig(),
    listGezels: () => store.listGezels(),
    providerForGezel: (gezelId) => chat.providerForGezel(gezelId),
    listModels: listCodexSetupModels,
  });

  // VS Code's built-in custom-endpoint provider uses chat completions too.
  // It gets an independent port and credential so its plaintext profile token
  // can be revoked without disturbing any other connected app.
  const vscodeBridgeFetchRef: { value?: Parameters<typeof serve>[0]['fetch'] } = {};
  const vscodeBridge = createVSCodeBridgeController({
    fetch: () => {
      if (!vscodeBridgeFetchRef.value) {
        throw new Error('VS Code bridge cannot start before the HTTP app is ready');
      }
      return vscodeBridgeFetchRef.value;
    },
    port: opts.vscodeBridgePort ?? vscodeBridgePortForHome(home),
  });
  const vscodeSetup = createVSCodeSetupManager({
    home,
    ...(opts.vscodeUserDir !== undefined ? { vscodeUserDir: opts.vscodeUserDir } : {}),
    tokenStore,
    bridge: vscodeBridge,
    readConfig: () => store.readConfig(),
    listGezels: () => store.listGezels(),
    providerForGezel: (gezelId) => chat.providerForGezel(gezelId),
    listModels: listCodexSetupModels,
  });

  // The meester's occasional status report — dynamic Home greeting +
  // dashboard + follow-up draft tasks. Constructed before the context
  // literal so the run-now HTTP route can reach it; started with the
  // other generators below.
  const meesterStatus = new MeesterStatusGenerator({
    store,
    history,
    tasks,
    activity: activityTracker,
    oneShot: (prompt, timeoutMs, opts) => chat.oneShotCompletion(prompt, timeoutMs, opts),
    isNightShiftActive: () => nightShift.isActive(),
    isChatActive: () => chat.isAnyActive(),
    osIdleSeconds: () => systemIdle.osIdleSeconds(),
    events: chatEvents,
  });

  // The ambient dashboard — PNG workshop snapshots for the OS
  // wallpaper integration. Scheduled passes are ambient/background; a
  // user-clicked Generate now pass carries interactive priority instead.
  const ambientDashboard = new AmbientDashboardGenerator({
    home,
    store,
    history,
    activity: activityTracker,
    oneShot: (prompt, timeoutMs, opts) => chat.oneShotCompletion(prompt, timeoutMs, opts),
    isNightShiftActive: () => nightShift.isActive(),
    isChatActive: () => chat.isAnyActive(),
    events: chatEvents,
  });

  const handboek = createHandboekEngine({
    catalog,
    device: createDaemonDeviceInfo({ store, chat }),
  });
  // Late-boot name-catalog arms for the titlebar search: Handboek articles
  // (previously the least findable content in the app) plus globally
  // invokable craftbooks. Tasks ride the Store directly inside SearchService.
  search.setExtraCatalogs({
    handboekEntries: async () => {
      const toc = await handboek.toc();
      return toc.areas.flatMap((area) =>
        area.entries.map((entry) => ({
          id: entry.id,
          title: entry.title,
          keywords: [area.title, ...(entry.summary ? [entry.summary] : [])],
        })),
      );
    },
    craftbookEntries: async () =>
      (await listGlobalCraftbookCandidates({ catalog, store, git })).map((c) => ({
        id: c.id,
        name: c.name,
        source: c.source,
      })),
    // Mail messages by subject/sender: derived entirely from the connector
    // corpus paths in the artifacts index — zero file reads. Bodies are
    // already searchable through the artifacts content arm; this is the
    // mail-shaped quick-open layer on top.
    mailEntries: async () => {
      const projects = await store.listProjects().catch(() => []);
      const all: Awaited<ReturnType<NonNullable<ExtraSearchCatalogs['mailEntries']>>> = [];
      for (const summary of projects) {
        const project = await store.getProject(summary.id).catch(() => null);
        const bindings = project?.connectors ?? [];
        const corpusDirs = bindings
          .filter((b) => b.type.startsWith('mail-'))
          .map((b) => corpusDirFor(bindings, b));
        if (corpusDirs.length === 0) continue;
        const paths = await contentIndex.listArtifactIndexFiles(summary.id).catch(() => []);
        all.push(...mailCatalogEntries(summary.id, corpusDirs, paths));
      }
      return all;
    },
  });

  // Ask once, at boot, whether this process may create children at all —
  // before any feature discovers the answer the expensive way. A denied
  // token is not a chat bug, an engine bug, or a GPU bug, but it presents as
  // all three at once, each at a different call site. See spawn-capability.ts.
  const childProcessSpawn = await probeChildProcessSpawn();
  if (childProcessSpawn === 'denied') log.error(`[spawn] ${SPAWN_DENIED_MESSAGE}`);

  // App-serve sites — per-site visitor listeners for shared AI App
  // mini-sites. A product feature: the machine-engine role never serves.
  const appServe =
    serviceRole === 'machine-engine'
      ? undefined
      : createAppServeController({ store, catalog, chat, chatEvents, history, scriptRunner });

  const context: ServiceContext = {
    serviceRole,
    home,
    store,
    chatEvents,
    chat,
    previewLog,
    channels,
    memory,
    history,
    growth,
    tasks,
    taskRunner,
    taskScheduler: scheduler,
    nightShift,
    indexEnrichment,
    meesterStatus,
    ambientDashboard,
    scriptRunner,
    catalog,
    gildeUpdates,
    ...(knowledge ? { knowledge } : {}),
    ...(appServe ? { appServe } : {}),
    handboek,
    secrets,
    git,
    gitHubPrs,
    codeReviews,
    reportActions,
    diffpacks,
    connectors,
    connectorActions,
    renderer,
    imageProvider,
    imagePulls,
    chatInstalls,
    videoProvider,
    videoPulls,
    engineBinaries,
    systemToolsetInstalls,
    stt,
    recognition,
    tts,
    llamaCppModels,
    ds4Models,
    modelFitness,
    mlxModels,
    uvRuntime,
    mlxRuntimeStatus,
    systemStatus,
    debug,
    gpuArbiter,
    token,
    tokenStore,
    grants,
    deviceIdentity,
    remotes,
    ...(machineEngine ? { machineEngine } : {}),
    remoteServing,
    remoteTenantLimits,
    ollamaEmulation,
    codexSetup,
    opencodeSetup,
    piSetup,
    vscodeSetup,
    ...(cert ? { tlsCertSha256: cert.sha256Hex, tlsCertPem: cert.certPem } : {}),
    ensureModel,
    startedAt: nowIso(),
    childProcessSpawn,
    uiDir: serviceRole === 'machine-engine' ? undefined : opts.uiDir,
    folderJobs,
    storageJobs,
    invalidateModelsCache,
    workspaceIndex,
    contentIndex,
    globalIndex,
    indexingJob,
    search,
    systemIdle,
    terminals,
    terminalEvents,
    requestRestart: opts.onRestartRequested,
  };

  // Serve capability-authenticated previews on a separate plain-HTTP origin.
  // Besides avoiding the self-signed main-listener certificate in external
  // browsers, the dedicated origin is the only network destination admitted
  // by local-preview-only Playwright sessions. The mint endpoint reads its
  // origin lazily because the sidecar binds after the main app is built.
  const app = buildApp(context, {
    onUnexpectedHttpError: opts.onUnexpectedHttpError,
    previewCapabilities,
    previewBrowserOrigin: () => previewBrowser.origin,
  });
  const remoteApp = buildRemoteApp(context);
  remoteFetchRef.value = remoteApp.fetch.bind(remoteApp);
  const ollamaEmulationApp = buildOllamaEmulationApp(context);
  ollamaEmulationFetchRef.value = ollamaEmulationApp.fetch.bind(ollamaEmulationApp);
  const codexBridgeApp = buildCodexBridgeApp(context, {
    models: () => codexSetup.codexModelCatalog(),
  });
  codexBridgeFetchRef.value = codexBridgeApp.fetch.bind(codexBridgeApp);
  const opencodeBridgeApp = buildOpenCodeBridgeApp(context);
  opencodeBridgeFetchRef.value = opencodeBridgeApp.fetch.bind(opencodeBridgeApp);
  const piBridgeApp = buildPiBridgeApp(context);
  piBridgeFetchRef.value = piBridgeApp.fetch.bind(piBridgeApp);
  const vscodeBridgeApp = buildVSCodeBridgeApp(context);
  vscodeBridgeFetchRef.value = vscodeBridgeApp.fetch.bind(vscodeBridgeApp);

  // Port selection, by caller intent:
  //   - explicit `opts.port` (from `--port` / `GEZEL_PORT`): bind exactly
  //     that and FAIL on collision — a silently-relocated named port makes
  //     the advertised base URL a lie.
  //   - `preferCanonicalPort` (standalone daemon + embedded desktop): try
  //     the canonical DEFAULT_PORT so third-party OpenAI-compatible clients
  //     get a stable base URL, but fall back to an ephemeral port if it's
  //     taken so we never fail to boot.
  //   - neither (tests, library embedders): pure ephemeral — no contention
  //     on a single fixed port across parallel suites.
  let requestedPort = 0;
  let allowEphemeralFallback = false;
  if (opts.port !== undefined) {
    requestedPort = opts.port;
  } else if (opts.preferCanonicalPort) {
    requestedPort = DEFAULT_PORT;
    allowEphemeralFallback = true;
  }

  // Classify what answers on the canonical port when we lose the bind.
  // A 200 with the health body or a 401 on exactly `/api/health` over
  // loopback TLS is another gezeld (health sits behind bearerAuth, so an
  // unauthenticated probe of a live daemon yields 401). TLS/socket
  // failures and non-HTTP listeners classify as unknown/other. Never
  // throws; bounded by a short timeout.
  const identifyCanonicalPortOccupant = async (
    occupiedPort: number,
  ): Promise<'machine-engine' | 'gezeld' | 'other-http' | 'unknown'> => {
    const { request: httpsRequest } = await import('node:https');
    return new Promise((resolve) => {
      const req = httpsRequest(
        {
          host: '127.0.0.1',
          port: occupiedPort,
          path: '/api/health',
          method: 'GET',
          timeout: 3_000,
          // The occupant's loopback cert is self-signed by a different
          // daemon; identification, not trust, is the goal here.
          rejectUnauthorized: false,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => {
            if (chunks.reduce((n, b) => n + b.length, 0) < 4096) chunks.push(c);
          });
          res.on('end', () => {
            if (res.statusCode === 401) return resolve('gezeld');
            const body = Buffer.concat(chunks).toString('utf8');
            if (res.statusCode === 200 && body.includes('"ok":true')) {
              if (body.includes('"serviceRole":"machine-engine"')) {
                return resolve('machine-engine');
              }
              return resolve('gezeld');
            }
            resolve('other-http');
          });
          res.on('error', () => resolve('other-http'));
        },
      );
      req.on('timeout', () => {
        req.destroy();
        resolve('unknown');
      });
      req.on('error', () => resolve('unknown'));
      req.end();
    });
  };

  // ALPN order matters: list `h2` first so browsers/Electron pick it (the
  // whole point of this exercise — multiplex SSE streams over one
  // connection and dodge Chromium's 6-conn-per-origin cap). Keep
  // `http/1.1` in the list so curl + the existing CLI keep working.
  // `allowHTTP1: true` is what lets the secure server dual-stack.
  const bindOnce = (bindPort: number): Promise<{ server: ServerType; port: number }> =>
    new Promise((resolve, reject) => {
      const serveOpts = cert
        ? {
            fetch: app.fetch,
            port: bindPort,
            hostname: '127.0.0.1',
            createServer: createSecureHttp2Server,
            serverOptions: {
              key: cert.keyPem,
              cert: cert.certPem,
              allowHTTP1: true,
              minVersion: 'TLSv1.3' as const,
              ALPNProtocols: ['h2', 'http/1.1'],
            },
          }
        : {
            fetch: app.fetch,
            port: bindPort,
            hostname: '127.0.0.1',
          };
      const s = serve(serveOpts, (info) => resolve({ server: s, port: info.port }));
      s.on('error', reject);
    });

  let server!: ServerType;
  let port!: number;
  try {
    ({ server, port } = await bindOnce(requestedPort));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    if (allowEphemeralFallback && code === 'EADDRINUSE') {
      log.warn(
        `[service] canonical port ${requestedPort} is in use; falling back to an ephemeral port. Third-party clients should read the bound port from ~/.gezel/runtime/port.`,
      );
      // Identify the occupant in the background. A machine-engine broker plus
      // one per-user product daemon is the intended split: the former owns the
      // canonical port and GPU, the latter uses its runtime-discovered port.
      // Two FULL product daemons remain the dangerous case (duplicate
      // schedulers + engine ownership), so keep the old tripwire for legacy
      // occupants. Fire-and-forget so a slow listener cannot delay our boot.
      void identifyCanonicalPortOccupant(requestedPort).then((occupant) => {
        if (occupant === 'machine-engine') {
          log.info(
            `[service] the machine engine owns canonical port ${requestedPort}; this user daemon is using its runtime-discovered port as expected`,
          );
        } else if (occupant === 'gezeld') {
          log.error(
            `[service] another full gezeld daemon is already serving canonical port ${requestedPort}. Two product daemons may duplicate background work and contend for local engines. Upgrade the installed machine service to an engine-only build, or stop the stale service before continuing.`,
          );
        } else if (occupant === 'other-http') {
          log.warn(
            `[service] port ${requestedPort} is held by a non-Gezel local HTTP server; leaving it alone`,
          );
        }
      });
      ({ server, port } = await bindOnce(0));
    } else {
      throw err;
    }
  }
  if (cert) {
    log.info(`[service] serving HTTPS+HTTP/2 on 127.0.0.1:${port} (TLS 1.3)`);
  } else {
    log.info(`[service] serving HTTP/1.1 on 127.0.0.1:${port}`);
  }

  // Connection-level failure visibility. Every renderer SSE stream and
  // poll multiplexes over ONE h2 connection (that's the point of the ALPN
  // order above), so a single session-level error drops them all at once
  // — the UI sees a burst of "network error" with no server-side trace.
  // These handlers are the trace. `sessionError` is the h2 death that
  // matters; `tlsClientError`/`clientError` are handshake noise (port
  // scanners, curl without -k) kept at debug.
  const describeSocketError = (err: unknown): string => {
    if (!(err instanceof Error)) return String(err);
    const code = (err as NodeJS.ErrnoException).code;
    return code && !err.message.includes(code) ? `${err.message} (${code})` : err.message;
  };
  const rawServer = server as unknown as NodeJS.EventEmitter;
  if (cert) {
    rawServer.on('sessionError', (err: unknown) => {
      log.warn(
        `[http] h2 session error — every stream multiplexed on that connection drops: ${describeSocketError(err)}`,
      );
    });
    rawServer.on('tlsClientError', (err: unknown) => {
      log.debug(`[http] TLS client error: ${describeSocketError(err)}`);
    });
  } else {
    // Registering 'clientError' suppresses Node's default 400-and-destroy,
    // so the listener must tear the socket down itself or bad connections
    // leak.
    rawServer.on('clientError', (err: unknown, socket: { destroy: () => void }) => {
      log.debug(`[http] client connection error: ${describeSocketError(err)}`);
      socket.destroy();
    });
  }

  // Plain-HTTP preview sidecar. It always gets a dedicated loopback origin,
  // even when the main transport is already HTTP: local-preview-only browser
  // sessions use this listener as a deliberately non-forwarding Chromium
  // proxy, keeping every request away from both the public web and the
  // daemon's bearer-gated API surface.
  let previewServer: ServerType | null = null;
  if (serviceRole !== 'machine-engine') {
    const previewApp = buildPreviewApp(context, previewCapabilities, {
      onUnexpectedHttpError: opts.onUnexpectedHttpError,
    });
    try {
      const bound = await new Promise<{ server: ServerType; port: number }>((resolve, reject) => {
        const s = serve({ fetch: previewApp.fetch, port: 0, hostname: '127.0.0.1' }, (info) =>
          resolve({ server: s, port: info.port }),
        );
        s.on('error', reject);
      });
      previewServer = bound.server;
      previewBrowser.origin = `http://127.0.0.1:${bound.port}`;
      // HTTPS and WebSocket proxy attempts never reach Hono's request path.
      // Explicitly destroy both upgrade forms so this listener can never
      // become a tunnel even if Node's default behavior changes.
      const rawPreviewServer = previewServer as unknown as NodeJS.EventEmitter;
      rawPreviewServer.on('connect', (_request: unknown, socket: { destroy: () => void }) =>
        socket.destroy(),
      );
      rawPreviewServer.on('upgrade', (_request: unknown, socket: { destroy: () => void }) =>
        socket.destroy(),
      );
      log.info(`[service] serving preview (HTTP) on 127.0.0.1:${bound.port}`);
    } catch (err) {
      // Non-fatal for the product shell: previews still work in-app over the
      // main listener. The constrained MCP browser fails closed because no
      // dedicated preview/proxy origin is published to ChatManager.
      log.warn(
        `[service] preview HTTP listener failed to bind; open-in-browser will use the main URL and local-preview browser tools will stay unavailable: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  boundPort = port;
  await writeRuntime({
    paths,
    port,
    token: clientToken,
    pid: process.pid,
    cert,
    webUiToken,
    serviceRole,
  });

  // One live controller owns the LAN socket for startup, Settings changes,
  // rebinds, and shutdown. Persisted state can no longer drift from reality.
  //
  // On machine installs the BROKER owns LAN serving: it holds the engines,
  // outlives logins (headless serving), and reads its own system-home config
  // via the /v1/remote/manage/serving surface. A user daemon that has adopted
  // a broker defers so 6229 isn't double-bound and peers don't pay a second
  // streaming hop. A broker that is installed-but-down at this boot leaves
  // the user daemon serving until its next restart — logged, accepted.
  const lanServingDelegatedToBroker =
    serviceRole === 'user' && machineEngine?.isRequired() === true;
  if (!lanServingDelegatedToBroker) {
    await remoteServing.reconfigure(config.remoteServing).catch((err) => {
      log.error(
        `[service] failed to start remote serving: ${err instanceof Error ? err.message : err}`,
      );
    });
  } else if (config.remoteServing?.enabled) {
    log.info(
      '[service] LAN model serving is owned by the machine engine broker; per-user listener not started',
    );
  }
  // Same contract for the Ollama emulation: non-fatal at boot (usually
  // means real Ollama grabbed 11434 since the toggle was set) — the
  // daemon still serves everything else; the toggle stays set and binds
  // on the next launch/config change once the port frees up.
  if (serviceRole !== 'machine-engine') {
    await ollamaEmulation.reconfigure(config.openaiEndpoints).catch((err) => {
      log.warn(
        `[service] ollama emulation not started: ${err instanceof Error ? err.message : err}`,
      );
    });
    await codexSetup.reconcile().catch((err) => {
      log.warn(
        `[service] Codex local-model bridge not started: ${err instanceof Error ? err.message : err}`,
      );
    });
    await opencodeSetup.reconcile().catch((err) => {
      log.warn(
        `[service] OpenCode local-model bridge not started: ${err instanceof Error ? err.message : err}`,
      );
    });
    await piSetup.reconcile().catch((err) => {
      log.warn(
        `[service] pi local-model bridge not started: ${err instanceof Error ? err.message : err}`,
      );
    });
    await vscodeSetup.reconcile().catch((err) => {
      log.warn(
        `[service] VS Code local-model bridge not started: ${err instanceof Error ? err.message : err}`,
      );
    });
  }

  if (serviceRole !== 'machine-engine') {
    scheduler.start();
    nightShift.start();
  }
  // Install the always-bundled daily meester oversight task before runner
  // rehydration so a first-run install queues it in the same boot.
  if (serviceRole !== 'machine-engine') {
    await ensureNightShiftOversightTask(store, tasks).catch((err) => {
      log.warn('[night-shift] oversight ensure failed:', err instanceof Error ? err.message : err);
    });
  }
  // Rehydrate pending handoffs from disk (any active task whose
  // current phase has an effective assignee) before starting the runner's
  // tick loop. Ensures work dropped by a prior process gets picked up.
  if (serviceRole !== 'machine-engine') {
    await taskRunner.rehydrateFromStore().catch((err) => {
      log.warn('[task-runner] rehydrate failed:', err instanceof Error ? err.message : err);
    });
    taskRunner.start();
  }
  // Install the boekwachter indexing job task (idempotent) — the visible,
  // pausable control surface for the background indexing loops.
  if (serviceRole !== 'machine-engine') {
    await ensureIndexingJobTask(store, tasks).catch((err) => {
      log.warn('[indexing-job] ensure failed:', err instanceof Error ? err.message : err);
    });
    await channels.start();
  }

  // System-toolset bootstrap — installs pinned packages (e.g. @playwright/mcp)
  // and downloads Chromium in the background. Status progress is emitted on
  // `systemStatus`; the Home screen's HealthPanel subscribes via SSE.
  // Fire-and-forget — the service stays fully responsive while this runs.
  //
  // Tests opt out: `GEZEL_SKIP_SYSTEM_BOOTSTRAP=1` (dedicated flag) or the
  // pre-existing `GEZEL_MOCK_PROVIDER=1` (implies mocked environment where
  // real tarball downloads would only add teardown-time `EBUSY` races on
  // temp dirs).
  const skipBootstrap =
    serviceRole === 'machine-engine' ||
    process.env.GEZEL_SKIP_SYSTEM_BOOTSTRAP === '1' ||
    process.env.GEZEL_MOCK_PROVIDER === '1';
  if (skipBootstrap) {
    systemStatus.publish({ phase: 'ready' });
  } else {
    void runSystemBootstrap({ home, store, statusBus: systemStatus, debug }).catch((err) => {
      log.error('[system-toolsets] bootstrap crashed:', err);
      systemStatus.publish({
        phase: 'error',
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  // Reclaim abandoned chat-model downloads: directories with `.partial`
  // files, no manifest.json, and no writes for 7 days. These are invisible
  // to every listing surface (no manifest → hidden) yet can hold tens of
  // GB. Runs once per boot, in the background, before any install this
  // boot could start; a directory younger than the TTL is left alone
  // because its `.partial` files are resume credit for a retried install.
  void (async () => {
    for (const { engine, manager } of [
      { engine: 'llama-cpp', manager: llamaCppModels },
      { engine: 'ds4', manager: ds4Models },
      { engine: 'mlx', manager: mlxModels },
    ] as const) {
      const activeIds = new Set(manager.getActiveInstalls().map((i) => i.catalogId));
      const reclaimed = await reclaimAbandonedModelDownloads({
        writableRoot: modelStorageRoots({ home, engine }).writableRoot,
        activeIds,
      }).catch(() => []);
      for (const item of reclaimed) {
        log.info(
          `[models] reclaimed abandoned ${engine} download "${item.id}" (${Math.round(item.bytes / 1024 ** 2)} MB of stale .partial data)`,
        );
      }
    }
  })();

  // On-device first-run recommendation: if the user hasn't picked a
  // provider, default to the best-fitting local catalog model. This only
  // pins the choice; the desktop or TUI asks before starting a download.
  // No-op on subsequent boots (`firstRunCompleted` is the guard).
  // Gated off during mock/skip modes so tests don't try to hit
  // Hugging Face. See `bootstrapOnDeviceFirstRun` for the decision
  // tree.
  if (!skipBootstrap) {
    const { bootstrapOnDeviceFirstRun } = await import('./first-run/on-device-bootstrap.js');
    void bootstrapOnDeviceFirstRun({ store, llamaCppModels, mlxModels, catalog }).catch((err) => {
      log.error('[first-run] on-device bootstrap crashed:', err);
    });
  }

  // Periodic memory-index health sweep — re-syncs the vector cache from the
  // markdown source-of-truth. Catches drift from direct file edits AND
  // self-heals any indexes left empty by the previously-broken vector
  // wrapper. No-op if embeddings are disabled.
  const memoryHealth = new MemoryHealthMonitor({ memory, store });
  if (serviceRole !== 'machine-engine') memoryHealth.start();

  // Periodic Klerk-driven memory compaction — dedups/merges aged daily
  // memory files (and refreshes each gezel's lessons.md) so the corpus
  // recall searches stays clean. Gated inside sweep() on
  // config.memory.maintenance.enabled + proactive engagement mode.
  const memoryCompactor = new MemoryCompactor({
    memory,
    store,
    history,
    growth,
    oneShot: (prompt, timeoutMs, opts) => chat.oneShotCompletion(prompt, timeoutMs, opts),
  });
  if (serviceRole !== 'machine-engine') memoryCompactor.start();

  // Weekly "what changed" digests per project — commits + history + sessions
  // distilled by the Klerk into reports/digest-YYYY-Www.md. Same gating
  // discipline as the compactor (config.digest.enabled + proactive mode),
  // plus the indexing job's pause switch.
  const digestGenerator = new ProjectDigestGenerator({
    store,
    history,
    oneShot: (prompt, timeoutMs, opts) => chat.oneShotCompletion(prompt, timeoutMs, opts),
    isPaused: () => indexingJob.isPaused(),
    isChatActive: () => chat.isAnyActive(),
    events: chatEvents,
    onSweep: (r) => {
      void indexingJob.note(
        `Weekly digest sweep: ${r.generated} generated, ${r.skipped} skipped across ${r.projects} projects.`,
      );
    },
  });
  if (serviceRole !== 'machine-engine') digestGenerator.start();
  if (serviceRole !== 'machine-engine') gildeUpdates.startScheduler();

  // Meester status report: idle-gated, budgeted, change-gated sweep.
  // The activity tracker starts with it — its stamps feed the change
  // gate and the nudge scheduler's cadence.
  if (serviceRole !== 'machine-engine') {
    activityTracker.start();
    meesterStatus.start();
    ambientDashboard.start();
  }

  // Keurmeester harvest digest: aggregates supervision case records into
  // daily findings + proposed systemic improvements. Self-throttled
  // (only runs when new cases exist) and gated on keurmeester.enabled
  // OR debugMode — the dual runtime/debug purpose of the feature.
  const keurmeesterDigest = new KeurmeesterDigestGenerator({
    store,
    history,
    home,
    oneShot: (prompt, timeoutMs, opts) => chat.oneShotCompletion(prompt, timeoutMs, opts),
  });
  if (serviceRole !== 'machine-engine') keurmeesterDigest.start();

  // Start the workspace indexer's sweep loop now that the service is
  // bound + booted. (The manager itself was constructed before
  // `context` so the HTTP routes can call into it.)
  if (serviceRole !== 'machine-engine') {
    workspaceIndex.start();
    workspaceWatch.start();
  }
  // Benchmarks (evals) disable the background tick and drive enrichment
  // explicitly via POST /:id/index/enrich, so tick-vs-drive contention can't
  // double-pay summarizer calls or skew cost measurements.
  if (serviceRole !== 'machine-engine' && process.env.GEZEL_DISABLE_BACKGROUND_ENRICH !== '1') {
    indexEnrichment.start();
  }
  if (serviceRole !== 'machine-engine') {
    globalIndexManager.start();
    connectorSync.start();
  }

  // Idle-session summarization sweep: every hour, distill any non-archived
  // session that's been quiet for `config.summarization.idleHours` (default
  // 24h) into project memory. First pass runs ~60s after boot so a fresh
  // process doesn't block startup.
  const idleSummarizerTimer =
    serviceRole === 'machine-engine'
      ? null
      : setInterval(
          () => {
            chat.runIdleSummarizationSweep().catch((err) => {
              log.warn('[summarize] idle sweep crashed:', err instanceof Error ? err.message : err);
            });
          },
          60 * 60 * 1000,
        );
  idleSummarizerTimer?.unref();
  if (serviceRole !== 'machine-engine') {
    setTimeout(() => {
      chat.runIdleSummarizationSweep().catch(() => {
        /* swallow */
      });
    }, 60_000).unref();
    // Load the embedding pipeline before an interactive caller needs it. The
    // titlebar search fans out over content on every query, so without this
    // the model's one-time load lands on somebody's first keystroke. Deferred
    // so it never competes with boot or the first-run model download.
    setTimeout(() => {
      void warmEmbeddings().then((warmed) => {
        if (warmed) log.debug('[memory] embedding pipeline warmed');
      });
    }, 20_000).unref();
  }

  return {
    context,
    server,
    port,
    clientToken,
    cert,
    webUiToken,
    async stop() {
      const shutdownStep = <T>(name: string, action: () => T | Promise<T>) =>
        observeShutdownStep(name, action, { warn: (message) => log.warn(message) });
      log.info('[service] shutdown started');
      suspendLogOff();
      stopSuspendMonitor();
      scheduler.stop();
      nightShift.stop();
      // Quiesce chat before tearing down any callback dependencies. In
      // particular, keep the HTTP listener alive while MCP subprocesses and
      // active provider turns unwind; otherwise their service callbacks fail
      // as the misleading transport error "fetch failed".
      await shutdownStep('chat begin', () => chat.beginShutdown());
      await shutdownStep('task runner', () => taskRunner.stop());
      memoryHealth.stop();
      memoryCompactor.stop();
      digestGenerator.stop();
      gildeUpdates.stop();
      await shutdownStep('knowledge workers', async () => knowledge?.stop());
      keurmeesterDigest.stop();
      meesterStatus.stop();
      ambientDashboard.stop();
      await shutdownStep('activity tracker', () => activityTracker.stop());
      if (libraryRefreshTimer) {
        clearTimeout(libraryRefreshTimer);
        libraryRefreshTimer = null;
      }
      await shutdownStep('workspace index', () => workspaceIndex.stop());
      workspaceWatch.stop();
      await shutdownStep('index enrichment', () => indexEnrichment.stop());
      globalIndexManager.stop();
      // An open document-edit window would otherwise lose its audit event.
      await shutdownStep('document audit flush', () => store.flushDocumentAudit().catch(() => {}));
      connectorSync.stop();
      cacheController.stop();
      imagePulls.clear();
      chatInstalls.llamaCpp.clear();
      chatInstalls.ds4.clear();
      chatInstalls.mlx.clear();
      videoPulls.clear();
      engineBinaries.clear();
      systemToolsetInstalls.clear();
      await shutdownStep('image provider', () => imageProvider.shutdown());
      await shutdownStep('video provider', () => videoProvider.shutdown());
      await shutdownStep('speech recognition', () => stt.shutdown());
      await shutdownStep('speech synthesis', () => tts.shutdown());
      if (idleSummarizerTimer) clearInterval(idleSummarizerTimer);
      await shutdownStep('channels', () => channels.stop());
      await shutdownStep('app serve', async () => appServe?.stopAll());
      await shutdownStep('remote serving', () => remoteServing.stop());
      await shutdownStep('Ollama emulation', () => ollamaEmulation.stop());
      await shutdownStep('Codex setup', () => codexSetup.stop());
      await shutdownStep('OpenCode setup', () => opencodeSetup.stop());
      await shutdownStep('pi setup', () => piSetup.stop());
      await shutdownStep('VS Code setup', () => vscodeSetup.stop());
      await shutdownStep('machine engine', async () => machineEngine?.stop());
      await shutdownStep('paired remote fetches', () => closePairedRemoteFetches(remotes));
      if (previewServer) {
        await shutdownStep(
          'preview server',
          () =>
            new Promise<void>((resolve) => {
              let settled = false;
              const finish = () => {
                if (settled) return;
                settled = true;
                resolve();
              };
              previewServer?.close(() => finish());
              const s = previewServer as unknown as { closeAllConnections?: () => void };
              s.closeAllConnections?.();
              setTimeout(finish, 2_000).unref();
            }),
        );
      }
      // ChatManager.shutdown owns the one bounded background drain. Calling
      // drainBackground separately here used to spend the same 15-second
      // budget twice when one fire-and-forget task never settled, consuming
      // Electron's complete 30-second graceful-quit window.
      await shutdownStep('chat manager', () => chat.shutdown().catch(() => {}));
      // Initiate graceful close, but don't block forever waiting for
      // SSE streams to wind down. Active streams hold the server open
      // until each handler's keepalive loop notices the disconnect —
      // under load (full test suite with 150+ files) the cumulative
      // settle time can exceed Vitest's `afterAll` hook budget. Force
      // the issue: tell active HTTP/1 connections to close, destroy
      // any active HTTP/2 sessions, and cap the wait.
      await shutdownStep(
        'HTTP server',
        () =>
          new Promise<void>((resolve) => {
            let settled = false;
            const finish = () => {
              if (settled) return;
              settled = true;
              resolve();
            };
            server.close(() => finish());
            const s = server as unknown as {
              closeAllConnections?: () => void;
              closeIdleConnections?: () => void;
            };
            s.closeIdleConnections?.();
            s.closeAllConnections?.();
            // http2: there's no closeAllConnections; iterate active sessions.
            const http2Server = server as unknown as { _sessions?: Set<{ destroy?: () => void }> };
            for (const sess of http2Server._sessions ?? []) {
              try {
                sess.destroy?.();
              } catch {
                /* ignore */
              }
            }
            // Hard cap — sockets will be released by GC / OS when the
            // process exits or the next test starts.
            setTimeout(finish, 2_000).unref();
          }),
      );
      // Kill all persistent terminal shells. Without this, the bash
      // (or PowerShell) children spawned by the per-thread pool stay
      // resident past the daemon's exit until their idle timers
      // fire — same orphan pattern as the chat MlxProvider above.
      await shutdownStep('terminal sessions', () => terminals.shutdown().catch(() => {}));
      await shutdownStep('image renderer', () => renderer.stop());
      await shutdownStep('runtime lock', () => runtimeLock.release());
      log.info('[service] shutdown complete');
    },
  };
}

async function writeRuntime(args: {
  paths: ReturnType<typeof gezelPaths>;
  port: number;
  token: string;
  pid: number;
  cert: LoopbackCert | null;
  webUiToken: string | null;
  serviceRole: ServiceRole;
}): Promise<void> {
  const isSystemScope = process.env.GEZEL_SYSTEM_SCOPE === '1';
  const discoveryMode = isSystemScope ? 0o644 : 0o600;
  // Do not rely on the service manager's umask for discovery metadata.
  // Machine-wide brokers run with umask 0077 so all non-runtime state stays
  // private, while user daemons still need the discovery files to adopt the
  // loopback engine. Per-user daemons keep them owner-only.
  await writeFile(args.paths.runtime.port, `${args.port}\n`, {
    encoding: 'utf8',
    mode: discoveryMode,
  });
  await writeFile(args.paths.runtime.pid, `${args.pid}\n`, {
    encoding: 'utf8',
    mode: discoveryMode,
  });
  try {
    await chmod(args.paths.runtime.port, discoveryMode);
    await chmod(args.paths.runtime.pid, discoveryMode);
  } catch {
    /* windows, or a filesystem that doesn't care */
  }
  const rolePath = join(dirname(args.paths.runtime.port), 'service-role');
  await writeFile(rolePath, `${args.serviceRole}\n`, {
    encoding: 'utf8',
    mode: discoveryMode,
  });
  try {
    await chmod(rolePath, discoveryMode);
  } catch {
    /* windows, or a filesystem that doesn't care */
  }
  // This is the first-party client credential, never the daemon root
  // credential. Per-user installs lock it to 0600. System-scope installs
  // use 0644 on POSIX because user daemons run as different accounts; the
  // engine broker itself is deliberately unprivileged in that mode.
  // Unlink before exclusive creation. On Windows, overwriting a file keeps
  // its existing DACL and owner; a planted runtime credential could
  // otherwise retain permissions inherited before installer hardening.
  // `wx` also fails closed if another process races us with a file/symlink.
  await rm(args.paths.runtime.token, { force: true });
  await writeFile(args.paths.runtime.token, args.token, {
    encoding: 'utf8',
    mode: discoveryMode,
    flag: 'wx',
  });
  try {
    await chmod(args.paths.runtime.token, discoveryMode);
  } catch {
    /* windows, or a filesystem that doesn't care */
  }
  // Web-UI token: write it with the same first-party credential handling
  // when web mode is on, and proactively clear
  // any stale file from a prior web launch when it's off, so the runtime
  // dir never advertises a token that isn't live.
  if (args.webUiToken) {
    await rm(args.paths.runtime.webUiToken, { force: true });
    await writeFile(args.paths.runtime.webUiToken, args.webUiToken, {
      encoding: 'utf8',
      mode: discoveryMode,
      flag: 'wx',
    });
    try {
      await chmod(args.paths.runtime.webUiToken, discoveryMode);
    } catch {
      /* windows tolerance, as above */
    }
  } else {
    await rm(args.paths.runtime.webUiToken, { force: true }).catch(() => {});
  }
  if (args.cert) {
    // Public cert PEM is always world-readable — it's the trust anchor
    // any local CLI / curl needs to talk to us. The private key never
    // touches disk; it lives in process memory only and rotates with
    // the daemon. Fingerprint is what the supervisor pins in Electron.
    await writeFile(args.paths.runtime.cert, args.cert.certPem, 'utf8');
    await writeFile(args.paths.runtime.fingerprint, `${args.cert.sha256Hex}\n`, 'utf8');
    try {
      await chmod(args.paths.runtime.cert, 0o644);
      await chmod(args.paths.runtime.fingerprint, 0o644);
    } catch {
      /* same windows tolerance as above */
    }
  } else {
    // A daemon may be restarted with GEZEL_INSECURE_TRANSPORT=1 after an
    // HTTPS launch. Discovery treats cert presence as the transport signal,
    // so stale public material would make clients attempt HTTPS against the
    // new HTTP listener.
    await Promise.all([
      rm(args.paths.runtime.cert, { force: true }),
      rm(args.paths.runtime.fingerprint, { force: true }),
    ]);
  }
}

export async function resolveEffectiveServiceRole(
  explicit: ServiceRole | undefined,
  env: NodeJS.ProcessEnv,
  home: string,
): Promise<ServiceRole> {
  const configured = env.GEZEL_SERVICE_ROLE;
  const systemScope = env.GEZEL_SYSTEM_SCOPE === '1';
  const requested =
    explicit ??
    (configured === 'user' || configured === 'machine-engine' || configured === 'legacy-full'
      ? configured
      : // A system-scope launch whose host named no role is a misconfigured
        // host, not a pre-split one, and the two are indistinguishable from
        // here. Resolve to the LEAST authority and let the established-state
        // check below promote it back to legacy-full only on the evidence a
        // real pre-split home leaves behind.
        //
        // This defaulted to `legacy-full` and that failed open. v1.26217.38
        // shipped a Windows service host compiled before GEZEL_SERVICE_ROLE
        // existed (the native pin was not bumped for the release that added
        // it), so every Windows machine service silently took this branch,
        // served the full product API, and published its `ui`-scoped token at
        // the cross-account permissions the runtime directory grants — a
        // credential every local account can read. Nothing failed; the split
        // simply never engaged. Least authority is the only safe default when
        // the role is unstated.
        systemScope
        ? 'machine-engine'
        : 'user');

  if (requested !== 'machine-engine' || !systemScope) return requested;

  // If an older full-product system service already has a product layout,
  // never relabel it as engine-only: the next Electron launch would otherwise
  // show an empty per-user home while established machine-home projects remain
  // hidden behind the broker boundary.
  if (await hasEstablishedMachineProductState(home)) {
    log.warn(
      '[service] established machine-home product state detected; preserving legacy-full compatibility until an explicit per-user migration is completed',
    );
    return 'legacy-full';
  }
  return requested;
}

/**
 * Does this system home still hold pre-split product data that a broker would
 * strand?
 *
 * Directory presence alone is NOT the signal, because `legacy-full` itself
 * creates the `default` project and the system crew on every boot. Keying on
 * presence made the compatibility mode self-perpetuating: one boot in
 * legacy-full manufactured the exact evidence that pinned every later boot to
 * legacy-full, so a home could never return to the broker role even once its
 * real data had been migrated out.
 *
 * The signals are the two things only a human produces: a project beyond the
 * auto-created `default`, or a gezel with a persisted session. That is the
 * same "was this home ever actually used" question the supervisor answers in
 * `readHomeUsageSignals`, and deliberately the same answer shape.
 *
 * Deliberately NOT keyed on the machine-shared marker. The marker resolves
 * from platform convention rather than from `home`, so it reports on whatever
 * machine-wide install happens to exist rather than on the home being
 * inspected — wrong for a per-user daemon, and wrong for any home that is not
 * the conventional system one. The usage signals already answer correctly
 * after a migration, because what migration leaves behind is exactly baseline.
 */
async function hasEstablishedMachineProductState(home: string): Promise<boolean> {
  const projects = await listSubdirectories(join(home, 'projects'));
  if (projects.some((name) => name !== 'default')) return true;

  for (const gezelId of await listSubdirectories(join(home, 'gezels'))) {
    const sessions = await listFileNames(join(home, 'gezels', gezelId, 'sessions'));
    if (sessions.some((name) => name.endsWith('.json'))) return true;
  }
  return false;
}

async function listSubdirectories(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

async function listFileNames(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  } catch {
    return [];
  }
}
