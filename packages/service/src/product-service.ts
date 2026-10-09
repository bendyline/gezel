import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  migrateInstalledModelIds,
  reclaimStaleModelDownloads,
} from './models/startup-maintenance.js';
import { recoverInterruptedScriptRuns } from './scripts/runs.js';

import { setDefaultAutoSelectFamilyAttemptTimeout } from 'node:net';
import { basename, join } from 'node:path';
import {
  GENERALIST_TEMPLATE_ID,
  type GezelConfig,
  type ProviderName,
  createLogger,
  effectiveGeneralistModeSetting,
  formatSuspension,
  isSharedLibraryProject,
  isTaskWorkAllowed,
  lastNightShiftWindow,
  nightShiftDayKey,
  nowIso,
  onSuspension,
  parseTaskRef,
  projectAllowsAmbientWork,
  projectLeadGezelId,
  projectNightWorkEnabled,
  resolveSocialMode,
  resolveTaskExecutionMode,
  startSuspendMonitor,
  stopSuspendMonitor,
} from '@bendyline/gezel';
import {
  type ExternalFolders,
  KeyedLock,
  type Task,
  type TaskAssignee,
  type TaskCraftbookStep,
  resolveDistributionProfile,
} from '@bendyline/gezel';
import { CatalogService } from '@bendyline/gezel-catalog';

import { gezelHome, gezelPaths, readConfigRaw } from '@bendyline/gezel/paths';
import { type ServerType, serve } from '@hono/node-server';
import { AmbientDashboardGenerator } from './ambient/dashboard-generator.js';
import { createAppServeController } from './app-serve/controller.js';
import { AppToolRelayRegistry } from './app-tools/relay-registry.js';

import { ChannelManager } from './channels/manager.js';
import { ChatEventBus } from './chat/events.js';
import { ChatManager, resolveCatalogReasoningBudget } from './chat/manager.js';
import { ConnectorActionManager } from './connectors/actions.js';
import { ConnectorManager, corpusDirFor } from './connectors/manager.js';
import {
  registerProductConnectorAdapters,
  wireProductConnectorTaskPreparation,
} from './connectors/product-wiring.js';
import { ConnectorSyncManager } from './connectors/sync-manager.js';
import { listApplicableCraftbooks, projectCraftbookSummaries } from './craftbook/applicable.js';
import { makeCraftbookResolver } from './craftbook/resolve.js';
import {
  clearCraftbookSuggestVectorCache,
  listGlobalCraftbookCandidates,
} from './craftbook/suggest.js';
import { DebugFlag } from './debug/flag.js';
import {
  reopenIssuesForDismissedPack,
  resolveIssuesForAppliedFiles,
  settleIssuesForDraftingTask,
} from './diffpack/issue-lifecycle.js';
import { DiffpackManager } from './diffpack/manager.js';
import { planProjectNightFixes, releasePausedNightFixes } from './diffpack/night-fix-planner.js';
import { ProjectDigestGenerator } from './digest/generator.js';
import { createEngineComponents } from './engine-components.js';
import { prepareNativeEngines } from './engine-discovery.js';
import { startMemoryDiagnostics } from './perf/memory-diagnostics.js';
import { startResponsivenessMonitor, syncPerfProfiling } from './perf/responsiveness.js';

import { deferBootWork } from './boot-work.js';
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
import { createFirstPartyAppTokens } from './grants/first-party-apps.js';
import { createGrantManager, parseAutoApproveAppIds } from './grants/manager.js';
import { GrowthEngine } from './growth/engine.js';
import { createXpRefresher } from './growth/xp-refresher.js';
import { stepCreditedGezelId } from './growth/xp.js';
import { createDaemonDeviceInfo } from './handboek/daemon-device.js';
import { createHandboekEngine } from './handboek/engine.js';
import { generateLoopbackCert } from './http/cert.js';
import type { ServiceContext } from './http/context.js';
import { bindMainListener } from './http/main-listener.js';
import {
  buildOllamaEmulationApp,
  createOllamaEmulationController,
} from './http/ollama-emulation.js';
import {
  PreviewCapabilityStore,
  normalizePreviewPath,
  previewCapabilityPath,
} from './http/preview-capability.js';
import { buildRemoteApp } from './http/remote-server.js';
import { invalidateModelsCache } from './http/routes/models.js';
import { buildApp, buildPreviewApp } from './http/server.js';
import { createTokenStore } from './http/token-store.js';
import { VISION_RASTER_FORMATS } from './index-store/ai-shadow.js';
import { writeNightlyCodebaseReport } from './index-store/codebase-report.js';
import { ContentIndex } from './index-store/content-index.js';
import { writeNightlyDocumentsReport } from './index-store/documents-report.js';
import { IndexEnrichmentManager } from './index-store/enrichment-manager.js';
import { GlobalIndexManager } from './index-store/global-index-manager.js';
import { GlobalIndex } from './index-store/global-index.js';
import { readImageStaticMeta } from './index-store/image-meta.js';
import { migrateWorkspaceIndexes } from './index-store/index-placement.js';
import { IndexingJobControl, ensureIndexingJobTask } from './index-store/indexing-job.js';
import { albumMediaDeps, storeAllAlbumPhotos } from './index-store/photo-albums.js';
import { writeNightlyPhotoReport } from './index-store/photo-report.js';
import { toDecodableRaster } from './index-store/raster-normalize.js';
import { ensureIndexFresh } from './index-store/readiness.js';
import { KeurmeesterDigestGenerator } from './keurmeester/digest.js';
import { KeurmeesterManager } from './keurmeester/manager.js';
import { KnowledgeManager } from './knowledge/manager.js';
import { createSharedKnowledgeInstaller } from './knowledge/shared-install.js';
import { createWorkerCatalogHost } from './knowledge/worker-host.js';
import { createLocalHarnessIntegrations } from './local-harness/integrations.js';
import { startMachineEngineBridge } from './machine-engine/bridge.js';
import { mailCatalogEntries } from './mail/search-catalog.js';
import {
  ensureNightShiftOversightTask,
  isNightShiftOversightTask,
  prepareReviewForNight,
} from './meester/night-shift-oversight.js';
import { MeesterStatusGenerator } from './meester/status-generator.js';
import { MemoryCompactor } from './memory/compaction.js';
import { warmEmbeddings } from './memory/embeddings.js';
import { MemoryHealthMonitor } from './memory/health.js';
import { MemoryManager } from './memory/manager.js';
import { openModelWorkers, shutdownModelWorkers } from './model-workers.js';

import { buildChatModelInstallRegistries } from './models/install-jobs.js';

import { migrateLegacySystemModels } from './models/storage-roots.js';
import { DuckRunner } from './observations/duck.js';
import { runProjectObservationNightly } from './observations/nightly.js';
import {
  discoverManagedScriptRuntimes,
  ensureBundledNodeOnPath,
} from './packages/managed-runtimes.js';
import { normalizeBundledPnpmPath } from './packages/pnpm.js';
import { PreviewLogBuffer } from './preview-log/buffer.js';
import { recoverTypedProjectCreations } from './project-type/create.js';
import { PromptDraftManager } from './prompt-drafts/manager.js';
import { PromptDraftSweeper } from './prompt-drafts/sweeper.js';
import { SpeechToTextProviderManager } from './providers/audio/stt-manager.js';
import { TextToSpeechProviderManager } from './providers/audio/tts-manager.js';
import { InputStagingManager } from './tasks/inputs/staging.js';

import { ImageProviderManager } from './providers/image/manager.js';
import { ImageModelPullRegistry } from './providers/image/pull-registry.js';

import { MediaSearchManager, backgroundDownloadsAllowed } from './media-search/manager.js';
import { createOfficeIntegrations } from './office-host/integrations.js';
import { resolveDefaultProviderName } from './providers/default-provider.js';
import { ensureLlamaEngineStatus } from './providers/llama-cpp/build-provider.js';
import { RecognitionManager } from './providers/recognition/manager.js';
import { resolveAutoMode } from './providers/recognition/prompts.js';
import type { LLMProvider } from './providers/types.js';
import { VideoProviderManager } from './providers/video/manager.js';
import { VideoModelPullRegistry } from './providers/video/pull-registry.js';
import { MlxRuntimeStatusBus } from './python/mlx-runtime-status-bus.js';
import { UvRuntime } from './python/uv-runtime.js';
import { RelevanceModelManager } from './relevance/manager.js';
import { loadOrCreateDeviceIdentity, signCertFingerprint } from './remotes/identity.js';
import { closePairedRemoteFetches } from './remotes/pinned-fetch.js';
import { createRemotesRegistry } from './remotes/registry.js';
import { createRemoteServingController } from './remotes/serving.js';
import { createTenantLimiter } from './remotes/tenant-limits.js';
import { ImageRenderer } from './rendering/image-renderer.js';
import { ReportActionManager } from './report-actions/report-action-manager.js';
import { writeRuntime } from './runtime-discovery.js';
import { type RuntimeLock, acquireSingleInstanceLock } from './runtime-lock.js';
import { ScriptRunner } from './scripts/runner.js';
import {
  CATALOG_RELEVANT_HISTORY_KINDS,
  type ExtraSearchCatalogs,
  SearchService,
} from './search/search-service.js';
import { MemorySecretStore, openSecretStore } from './secrets/index.js';
import { seedSecretsFromEnvFile } from './secrets/seed.js';
import type { RunningService, StartServiceOptions } from './service-options.js';
import { observeShutdownStep } from './shutdown-progress.js';
import { runSystemBootstrap, stopSystemBootstraps } from './system-toolsets/bootstrap.js';
import { SystemToolsetInstallRegistry } from './system-toolsets/install-registry.js';
import { SystemStatusBus } from './system-toolsets/status-bus.js';
import { reapOrphanedGezelEngineProcesses } from './system/gezel-process-cleanup.js';
import { SystemIdleState } from './system/idle-state.js';
import { detectMemoryProfile, detectMemoryProfileCached } from './system/memory.js';
import { SPAWN_DENIED_MESSAGE, probeChildProcessSpawn } from './system/spawn-capability.js';
import { loadTaskOutputs } from './tasks/completion-wrapup.js';
import { dispatchTaskEntry } from './tasks/entry-dispatch.js';
import { reviewTaskFigures } from './tasks/figure-review.js';
import { TaskLauncher } from './tasks/launcher.js';
import { TaskManager, stepOwnerGezelId } from './tasks/manager.js';
import { NightShiftQuotaGate } from './tasks/night-quota-gate.js';
import { postNightShiftReviewCard } from './tasks/night-review-card.js';
import { NightShiftManager } from './tasks/night-shift-manager.js';
import { ownerStepQuestion } from './tasks/owner-step.js';
import { gatherTaskReferences } from './tasks/references.js';
import { TaskRunner } from './tasks/runner.js';
import { runActivationGate, runSpawnFanout } from './tasks/runtime-activation.js';
import { TaskScheduler } from './tasks/scheduler.js';
import {
  type TaskStepRef,
  pauseTaskAfterFailedHandoff as pauseAfterFailedHandoff,
} from './tasks/step-pause.js';
import { isOwnerStep } from './tasks/step-runtime.js';
import { TerminalEventBus } from './terminal/events.js';
import { type CraftbookInvoker, TerminalManager } from './terminal/manager.js';
import { HF_CACHE_DIR_ENV, transformersCacheDir } from './transformers-cache.js';
import { WorkspaceIndexManager } from './workspace/index-manager.js';
import { ensureCommandApprovalQuestions } from './workspace/scripts.js';
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
 * Boot the Gezel service. Creates the `.gezel/` layout if missing,
 * generates a fresh auth token, starts the HTTP server (on the canonical
 * port, an explicit port, or an ephemeral port — see
 * {@link StartServiceOptions}), and writes the runtime files so clients
 * can find us.
 */
export async function startProductService(
  opts: StartServiceOptions & { role: 'user' | 'legacy-full' },
): Promise<RunningService> {
  const home = opts.home ?? gezelHome();
  const embeddedInferenceOnly = opts.embeddedInferenceOnly === true;
  // A previous service in this process (an embedded host restarting) closed
  // the shared model workers on its way out.
  openModelWorkers();
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
  // Started as early as the suspend clock so a block during boot is caught
  // too. The CPU profile that explains a block follows debug mode, read live.
  let perfDebug: DebugFlag | null = null;
  const stopResponsivenessMonitor = startResponsivenessMonitor({
    logsDir: gezelPaths(home).logs,
    profileWhen: () => process.env.GEZEL_PERF_PROFILE === '1' || perfDebug?.isEnabled() === true,
  });
  discoverManagedScriptRuntimes(home);
  // Publish the accelerator probe as early as possible. `computeCapacityBudget()`
  // with no arguments is a synchronous read of a module-level figure that stays
  // `null` until this runs, and the callers that cannot await it — slot ceilings,
  // KV caps — then size a discrete-GPU host off system RAM alone. Deliberately
  // not awaited: it shells out to `nvidia-smi` and must not sit in front of the
  // listener. Async admission paths measure for themselves (measured-budget.ts),
  // so this closes the gap for the synchronous ones rather than being relied on.
  void detectMemoryProfileCached().catch(() => {});
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

  const serviceRole = opts.role;
  // Resolved once and passed down, never re-read from env at the enforcement
  // seams — the same discipline `resolveSecurityPolicy` follows, and what
  // keeps one subsystem from disagreeing with another about what this build
  // is allowed to do.
  const distribution = resolveDistributionProfile(process.env);
  if (distribution.profile !== 'standard') {
    log.info(`[service] distribution=${distribution.profile}`);
  }
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
  await recoverTypedProjectCreations(store);
  await store.ensureLayout();
  // Settle the runs a dead daemon left `running`, found by in-flight marker
  // alone (never a history scan), before any new run can start; never replay.
  await recoverInterruptedScriptRuns(
    home,
    (await store.listProjects()).map((p) => p.id),
  ).catch((err: unknown) =>
    log.warn(`[scripts] run recovery skipped: ${err instanceof Error ? err.message : String(err)}`),
  );
  let sharedProject: { id: string; created: boolean } | null = null;
  await store.ensureDefaultProject();
  sharedProject = await store.ensureSharedProject();
  await store.ensureDefaultMeester();
  await store.ensureDefaultKlerk();
  // Before anything opens a content index: earlier builds kept it inside the
  // person's folder.
  await migrateWorkspaceIndexes({ store, home }).catch((err: unknown) =>
    log.warn(
      `[index] placement migration skipped: ${err instanceof Error ? err.message : String(err)}`,
    ),
  );

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
  const webUiEnabled = opts.webUi ?? process.env.GEZEL_WEB === '1';
  const webUiToken = webUiEnabled ? randomBytes(24).toString('base64url') : null;
  // Per-app bearer tokens (issued via /v1/apps/register) persist to
  // `<home>/tokens.json`; the per-launch root token above is registered
  // in-memory only since it rotates every boot. The auth middleware
  // consults this store on every request.
  const ephemeralTokens = [
    {
      appId: 'desktop-client',
      appName: 'Gezel Desktop',
      // A machine runtime credential is readable across local accounts, so
      // it receives inference and model-lifecycle authority only. The user
      // daemon's credential retains the first-party product API scopes.
      scopes: ['ui', 'openai', 'knowledge'],
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
  // Gezel's own Office, LibreOffice and VS Code add-ins connect without a
  // code once they prove they run as this user; see grants/first-party-apps.ts.
  const firstPartyApps = createFirstPartyAppTokens(tokenStore);
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
  // The shared library's AI tier (summaries, media shadows) is gated on a
  // Boekwachter being on its roster, so a freshly created library opts in
  // once here. An install that already has the seat filled recruits only
  // this project; nothing else is re-broadened.
  await ensureDefaultBoekwachter(
    store,
    catalog,
    sharedProject?.created ? { recruitProjectIds: [sharedProject.id] } : {},
  );
  // An app embedding Gezel for its own model calls keeps no credentials: the
  // embedded inference profile never opens the OS keychain, never writes a
  // secrets file into the app's home, and never ingests an env file of
  // provider keys.
  const secrets = embeddedInferenceOnly ? new MemorySecretStore() : await openSecretStore(home);
  log.info(`[secrets] backend=${secrets.backend}`);
  // The engine broker needs its device-identity key, but must never ingest
  // cloud/provider credentials from an install-time env file. Those remain
  // exclusively in each account's user daemon.
  if (!embeddedInferenceOnly) await seedSecretsFromEnvFile(secrets);
  // Stable device identity (Ed25519) + the registry of servers this device has
  // paired with — both for remote model execution. Identity needs the secret
  // store (private key lives there); the registry is plain 0600 JSON. The
  // embedded profile offers no remote connectivity, so it has no identity.
  const deviceIdentity = embeddedInferenceOnly
    ? null
    : await loadOrCreateDeviceIdentity(home, secrets);
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
  perfDebug = debug;
  syncPerfProfiling();
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
  await prepareNativeEngines(home, bootConfig);

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
  const {
    llamaCppModels,
    ds4Models,
    mlxModels,
    uvRuntime,
    ensureModel,
    cacheController,
    gpuArbiter,
    engineBinaries,
  } = await createEngineComponents({
    home,
    catalog,
    bootConfig,
    mlxRuntimeStatus,
    scheduleInstallProbe,
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
    // Describing photos needs llama.cpp even where chat runs on MLX; fetch
    // the pinned engine the same verified way the on-device chat path does.
    ensureEngine: async () => ensureLlamaEngineStatus(engineBinaries, await store.readConfig()),
  });

  const appToolRelays = new AppToolRelayRegistry();

  const chat = new ChatManager({
    store,
    events: chatEvents,
    memory,
    appToolRelays,
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
  // A folder of the person's own (or a linked repository) that tonight's
  // index sweep would cover. Cheap: reads project records, opens no index.
  const hasNightSweepProject = async (): Promise<boolean> => {
    const projects = await store.listProjects().catch(() => []);
    return projects.some(
      (p) =>
        Boolean(p.workingDir || p.github) &&
        p.indexingEnabled !== false &&
        projectAllowsAmbientWork(p) &&
        projectNightWorkEnabled(p) &&
        !isSharedLibraryProject(p),
    );
  };
  // The desktop app's OS-idle and power reports; read by enrichment and the
  // night shift.
  const systemIdle = new SystemIdleState();
  const nightShift = new NightShiftManager({
    store,
    manager: tasks,
    events: chatEvents,
    ...(opts.nightShiftNow ? { now: opts.nightShiftNow } : {}),
    quotaGate: nightQuotaGate,
    resolveProviderName: (gezelId, opts) => chat.providerForGezel(gezelId, opts),
    // A person's folders are owed a nightly sweep whether or not any task
    // is waiting. Without this the shift ran only for tasks, and a paused
    // oversight task meant no index catch-up or fix planning at all.
    ambientWork: {
      hasEligibleProject: () => hasNightSweepProject(),
      isRunning: () => indexEnrichmentRef?.isNightWorkRunning() ?? false,
    },
    power: systemIdle,
  });

  // Per-project last-activity stamps, fed by the history + chat buses.
  // The nudge scheduler and the meester status generator both read it
  // instead of recomputing activity from every session on every pass.
  const activityTracker = new ActivityTracker({ store, history, chatEvents });

  // TaskScheduler needs ChatManager (for ambient voorman nudges) so it's
  // constructed after `chat` is ready. Task-cron ticks work without chat,
  // but we route both through the same scheduler to avoid two timers.
  // The runner is constructed below; the scheduler reads it lazily so the
  // stuck-step sweep can tell a queued handoff from a stall.
  const schedulerRunner: { current: TaskRunner | undefined } = { current: undefined };
  const scheduler = new TaskScheduler({
    manager: tasks,
    chat,
    store,
    runner: () => schedulerRunner.current,
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
  // Set first thing in `stop()`; see pauseTaskAfterFailedHandoff.
  let stopping = false;
  const pauseTaskAfterFailedHandoff = (args: TaskStepRef & { detail: string }) =>
    pauseAfterFailedHandoff(tasks, args, () => stopping);
  chat.setHandoffExhaustedHandler(async ({ taskRef, stepId, detail }) => {
    const [projectId, numText] = taskRef.split('/');
    const num = Number(numText);
    if (!projectId || !Number.isFinite(num)) return;
    await pauseTaskAfterFailedHandoff({ projectId, num, stepId, taskRef, detail });
  });
  const taskRunner = new TaskRunner({
    store,
    prepareActiveStep: (projectId, num) => tasks.ensureActiveStepEntered(projectId, num),
    noteRestartResume: (projectId, num, stepId) => tasks.noteRestartResume(projectId, num, stepId),
    pauseAfterFailedDispatch: pauseTaskAfterFailedHandoff,
    dispatcher: {
      startHandoffSession: (args) => chat.startHandoffSession(args),
      cancelHandoffSession: (sessionId) => chat.cancelInflight(sessionId, 'task-superseded'),
      isHandoffSessionActive: (sessionId) => chat.isSessionTurnPending(sessionId),
      resolveProviderName: (gezelId, opts) => chat.providerForGezel(gezelId, opts),
      getProvider: (name) => chat.getProviderIfReady(name),
      ensureProvider: (name) =>
        name === 'remote' ? Promise.resolve(null) : chat.getProvider(name),
      getPooledProviderQueueSummary: (name) => {
        if (name !== 'llama-cpp' && name !== 'mlx' && name !== 'ds4') return null;
        return chat.localEngineQueueSummaries().get(name) ?? null;
      },
    },
    isNightShiftActive: () => nightShift.isActive(),
    isNightShiftPending: (task) => nightShift.isPendingToday(task),
    isIndexCatchUpActive: () => indexEnrichmentRef?.isCatchUpActive() ?? false,
    nightQuotaHold: (provider) => nightQuotaGate.holdFor(provider),
    ...(config.taskRunner?.tickIntervalMs
      ? { tickIntervalMs: config.taskRunner.tickIntervalMs }
      : {}),
  });
  schedulerRunner.current = taskRunner;
  // A parent's lifecycle is a runtime gate for its whole descendant tree.
  // Reconcile immediately on every durable status transition: inactive
  // ancestors prune queued/running child turns, while a resumed ancestor
  // rehydrates only descendants whose own stored status is still active.
  tasks.setTaskStatusChangedHook(({ task }) => taskRunner.reconcileStatusChange(task));
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
  tasks.setCurrentTurnStepReactivatedHook(({ task, newStep, gatedStep, previousActivationAt }) => {
    // The turn's session follows too. Only a self-loop stays with this turn;
    // a route to another step gets its own dispatch, which binds its session.
    if (newStep.id === gatedStep.id && newStep.lastActivatedAt) {
      chat.adoptStepActivation({
        taskRef: task.ref,
        stepId: newStep.id,
        previousActivationAt,
        activationAt: newStep.lastActivatedAt,
      });
    }
    const gezelId = isOwnerStep(newStep)
      ? undefined
      : newStep.assignee?.kind === 'gezel'
        ? newStep.assignee.gezelId
        : newStep.suggestedGezelId;
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
  const scriptRunner = new ScriptRunner({
    store,
    chat,
    memory,
    tasks,
    secrets,
    catalog,
    remindersChanged: (projectId) =>
      chatEvents.publishGlobalEvent({ type: 'reminders_updated', projectId }),
  });
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
        ...(outcome.gate.hook ? { hook: outcome.gate.hook } : {}),
        ...(outcome.gate.unsatisfiable ? { unsatisfiable: true } : {}),
        ...(outcome.gate.scriptRuns ? { scriptRuns: outcome.gate.scriptRuns } : {}),
        ...(outcome.gate.escalationStage !== undefined
          ? { escalationStage: outcome.gate.escalationStage }
          : {}),
        ...(outcome.task.activeStepId ? { activeStepId: outcome.task.activeStepId } : {}),
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
  // Gezels the resolver hired (not reused) wait here until their first step
  // starts, when the owner's thread introduces them.
  const freshHires = new Set<string>();
  const introduceFreshHire = (task: Task, step: TaskCraftbookStep | undefined): void => {
    const gezelId = step ? stepOwnerGezelId(task, step) : undefined;
    if (!step || !gezelId || !freshHires.delete(gezelId)) return;
    void chat
      .postCrewIntroduction(task, gezelId, step)
      .catch((err) =>
        log.warn(`[service] crew introduction failed for ${task.ref}: ${String(err)}`),
      );
  };
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
      if (res.action !== 'reused') freshHires.add(res.gezelId);
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

  // Execution mode (generalist v2): decided once per task from the install
  // setting and the provider that will actually run it, then stamped on
  // the task. An auto-assigned generalist task gets the Generalist gezel
  // (one per install, reused by template id) pulled onto the project;
  // a task whose caller pinned an owner keeps that owner. Errors fall back
  // to stepwise inside TaskManager, the behavior every task had before.
  tasks.setExecutionModeResolver(async ({ projectId, assigneeGezelId, nightShift, requested }) => {
    const config = await store.readConfig();
    const setting = effectiveGeneralistModeSetting(config);
    let providerName: ProviderName | undefined;
    let tier: string | undefined;
    let mode: 'generalist' | 'stepwise';
    if (requested === 'generalist' || requested === 'stepwise') {
      mode = requested;
    } else {
      providerName = assigneeGezelId
        ? await chat.providerForGezel(assigneeGezelId, { nightShift: Boolean(nightShift) })
        : resolveDefaultProviderName(config);
      tier = await chat.classifyExecutionTier(providerName, assigneeGezelId);
      mode = resolveTaskExecutionMode(setting, providerName, tier);
    }
    const base = {
      ...(setting ? { setting } : {}),
      ...(providerName ? { providerName } : {}),
      ...(tier ? { tier } : {}),
    };
    if (mode !== 'generalist' || assigneeGezelId) return { mode, ...base };
    const generalist = await ensureGezel({
      opts: { jobTitle: 'Generalist', templateId: GENERALIST_TEMPLATE_ID },
      store,
      catalog,
      chat,
      bespokeMode: 'static',
    });
    await store.addGezelToProject(projectId, generalist.gezelId, { source: 'task' }).catch(() => {
      /* roster add is best-effort */
    });
    // The Generalist may carry its own provider pin (a user parked it on a
    // local model). Under `auto` that pin decides, not the install default:
    // a single-session run on a model the rule says is not ready for it is
    // exactly what `auto` exists to avoid.
    if (requested === 'auto') {
      const ownerProvider = await chat.providerForGezel(generalist.gezelId, {
        nightShift: Boolean(nightShift),
      });
      if (ownerProvider !== providerName) {
        const ownerTier = await chat.classifyExecutionTier(ownerProvider, generalist.gezelId);
        if (resolveTaskExecutionMode(setting, ownerProvider, ownerTier) !== 'generalist') {
          log.info(
            `[tasks] generalist ${generalist.gezelId} is pinned to ${ownerProvider} (${ownerTier}); running stepwise under auto`,
          );
          return { mode: 'stepwise', ...base, providerName: ownerProvider, tier: ownerTier };
        }
      }
    }
    return { mode: 'generalist', ownerGezelId: generalist.gezelId, ...base };
  });

  // Install a craftbook's bundled scripts into the project's scripts/
  // folder the first time a task is created from it. Idempotent — the
  // provenance marker comment makes re-installs no-ops when the
  // catalog version matches what's on disk. Without this hook the
  // bundledScripts list goes nowhere and onExit script refs error at
  // first call ("script not found").
  const { installCraftbookScripts, installLocalCraftbookScripts } = await import(
    './scripts/install.js'
  );
  // Owner-step card: one unanswered card per (task, step), attributed to the
  // gezel whose work is under review so the card reads as their hand-over.
  const fileOwnerStepCard = async (
    task: Task,
    step: TaskCraftbookStep,
    reviewed: TaskCraftbookStep | undefined,
  ): Promise<void> => {
    const existing = await store.listProjectQuestions(task.projectId).catch(() => []);
    if (
      existing.some(
        (q) =>
          q.intent?.kind === 'step-awaits-owner' &&
          q.intent.taskRef === task.ref &&
          q.intent.stepId === step.id &&
          !q.answer,
      )
    ) {
      return;
    }
    const returnTo = reviewed && reviewed.id !== step.id ? reviewed : undefined;
    const config = await store.readConfig().catch(() => ({}) as GezelConfig);
    const asker =
      (returnTo ? stepOwnerGezelId(task, returnTo) : undefined) ?? config.meesterGezelId ?? '';
    const outputs = await loadTaskOutputs(store, task);
    const question = ownerStepQuestion({
      task,
      step,
      ...(returnTo ? { returnTo } : {}),
      askerGezelId: asker,
      outputs,
      figures: await reviewTaskFigures(store, task, outputs).catch(() => null),
    });
    await store.writeQuestion(question);
    chatEvents.publishProjectEvent(task.projectId, { type: 'question_asked', question });
    log.info(`[tasks] ${task.ref} step "${step.id}" waits for the owner; filed a card`);
  };
  tasks.setTaskCreatedHook(async ({ projectId, task, sources }) => {
    // A task that opens on an owner step (approve the plan first) never
    // passes through the activation hook, so its card is filed here.
    const entry = task.craftbook.steps.find((s) => s.id === task.activeStepId);
    if (task.status === 'active' && entry && isOwnerStep(entry)) {
      await fileOwnerStepCard(task, entry, undefined).catch((err) =>
        log.warn(`[service] owner-step card failed for ${task.ref}: ${String(err)}`),
      );
    }
    if (task.status === 'active') introduceFreshHire(task, entry);
    // A book that verifies its work by running project commands
    // (`commandEvidence` gates) declares them as `commands` needs; raise
    // their first-use approval questions NOW so the user answers at
    // launch instead of the run stalling steps later. Fire-and-forget —
    // an unanswered question just means the mid-task path asks again.
    if (task.craftbook.commands && task.craftbook.commands.length > 0) {
      await ensureCommandApprovalQuestions({
        store,
        home,
        projectId,
        needs: task.craftbook.commands,
        requestedBy: `The "${task.craftbook.name}" craftbook (task ${task.ref})`,
      }).catch((err) => {
        log.warn(`[tasks] kickoff command approvals for ${task.ref} failed: ${String(err)}`);
      });
    }
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
    localOnly: false,
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
  const stt = new SpeechToTextProviderManager({ home, store });
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
    !embeddedInferenceOnly &&
    (opts.machineEngineDiscovery ?? process.env.GEZEL_DISABLE_MACHINE_ENGINE !== '1');
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
  // XP follows finished work (growth/xp-refresher.ts). The growth engine is
  // built further down, so the refresher reaches it through this ref.
  const growthRef: { engine?: GrowthEngine } = {};
  const xpRefresher = createXpRefresher({
    refresh: async (gezelId) => {
      if (!growthRef.engine) throw new Error('growth engine not ready');
      return growthRef.engine.refresh(gezelId, { allowKlerk: false, createPending: false });
    },
    onRefreshed: (gezelId, xp) =>
      chatEvents.publishGlobalEvent({ type: 'growth_updated', gezelId, xp }),
  });
  const runtimeActivation = { store, tasks, scriptRunner, history };
  tasks.setStepActivatedHook(async ({ projectId, task, newStep, completedStep, kind }) => {
    if (kind !== 'entry' && kind !== 'redispatch' && completedStep.completedAt) {
      xpRefresher.note(stepCreditedGezelId(completedStep));
    }
    introduceFreshHire(task, newStep);
    if (await runActivationGate(runtimeActivation, { projectId, task, newStep })) return;
    if (await runSpawnFanout(runtimeActivation, { projectId, task, newStep })) return;

    // ── Fanout barrier ──────────────────────────────────────────────────
    // The step after a fanout is a barrier: its gate waits on shards the
    // children have not written yet. Dispatching a worker turn into it
    // while children are still active cannot possibly satisfy the gate —
    // the model turn runs, the gate rejects, the attempt budget burns, and
    // on a local engine every one of those cycles is engine time the
    // children themselves are queued behind.
    //
    // Wild-caught on gezel/49: `collect` activated 0.5s after 24 children
    // were spawned, none of which had produced a coverage shard. The gate
    // (correctly) rejected an empty ledger, and the parent's assignee spent
    // 62 minutes trying to hand-write 580 paths to close a gap only the
    // children could close.
    //
    // The barrier lifts in the settle hook, which re-dispatches this step
    // once the last active child settles. Held only while children are
    // genuinely outstanding, so a re-activation after they finish proceeds
    // normally, and a task whose children all failed still gets its turn.
    if (task.spawnsCraftbook && !newStep.spawnFanout) {
      const activeChildren = await tasks
        .listChildren(task.ref, { status: 'active' })
        .catch(() => []);
      if (activeChildren.length > 0) {
        log.info(
          `[fanout] ${task.ref} step "${newStep.id}": holding dispatch — ${activeChildren.length} child(ren) still active; will re-dispatch when the last one settles`,
        );
        return;
      }
    }

    // An owner step waits for the owner: nobody is dispatched, and a card
    // tells them it is their turn.
    if (isOwnerStep(newStep)) {
      await fileOwnerStepCard(task, newStep, completedStep).catch((err) =>
        log.warn(`[service] owner-step card failed for ${task.ref}: ${String(err)}`),
      );
      return;
    }

    // The same three-level resolution entry dispatch uses. A task created
    // with a task-level assignee and unbound steps (a create-time fanout
    // host, an ad-hoc task with plain steps) has no step binding at all in
    // stepwise mode; reading only the step here made every such barrier
    // release a silent no-op, and the host sat idle until the eight-minute
    // stall sweep messaged it (every stepwise fanout cell of the 2026-09
    // campaign; Opus: 63s generalist vs 536s stepwise on identical work).
    const assigneeGezelId = stepOwnerGezelId(task, newStep);
    if (!assigneeGezelId) return;
    const prevGezelId = stepOwnerGezelId(task, completedStep);
    // Self-handoff: when the same gezel owns both steps and the new step
    // carries its own `prompt`, still enqueue a handoff — the runner then
    // re-engages the SAME task session (`ChatManager.startHandoffSession`
    // reuses it for adjacent same-gezel steps and for every step of a
    // generalist task), rebuilding the step prompt and exact tool surface
    // once the prior turn is idle. Without this, no transition would ever
    // put the next step's instructions in front of the worker. A
    // procedure-less step keeps the old skip: its activation already
    // reached the model inside the `advance_task_step` result it is
    // reading, and a redundant turn would only confuse it.
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
      ...(kind === 'entry' ? { kind: 'entry' as const } : {}),
    });
  });

  // Craftbook command launcher: the in-chat terminal recognizes a
  // craftbook command (e.g. `code-review security high`) and dispatches
  // it here. We create a task from the craftbook with the supplied
  // params, assign the role-matched gezel for the entry step, and start
  // it. Kept alongside the other cross-manager wiring; injected into the
  // TerminalManager below. NOTE: an ordinary entry step is NOT sent
  // through `onStepActivated`, so `dispatchTaskEntry` is its single
  // kickoff. Deterministic entry setup may auto-advance; that later phase
  // uses `onStepActivated`, and the entry helper refuses to dispatch it a
  // second time. Its OTHER call site is the create route's `dispatchEntry`
  // flag (routes/project-tasks.ts, the meester macros' path).
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
      // user as "I ran it and nothing happened". The project lead (voorman,
      // or the Meester in Default) is the standing answer to "who picks
      // this up?". Falls through to the user only when there is none.
      const project = await store.getProject(projectId).catch(() => null);
      const config = await store.readConfig().catch(() => null);
      const leadGezelId = project ? projectLeadGezelId(project, config?.meesterGezelId) : undefined;
      if (leadGezelId) assignee = { kind: 'gezel', gezelId: leadGezelId };
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
  // In-app evals: the compiled harness beside this daemon (or a checkout's
  // live source), queued jobs under <home>/eval-runs/, and the trial index.
  const { EvalService } = await import('./eval/service.js');
  const evals = new EvalService({
    home,
    readConfig: () => store.readConfig(),
    secrets,
    engineBinaries,
    llamaCppModels,
    mlxModels,
    ds4Models,
    history,
  });
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
  // Issues follow the proposal that would fix them: applied → resolved,
  // dismissed or never proposed → open again.
  const proposalIssueDeps = {
    store,
    diffpacks: { list: (id: string) => diffpacks.listRecords(id) },
    tasks,
  };
  const diffpacks: DiffpackManager = new DiffpackManager({
    home,
    store,
    tasks,
    history,
    onApplied: (projectId, pack, paths) =>
      resolveIssuesForAppliedFiles(proposalIssueDeps, projectId, pack, paths),
    onDismissed: (projectId, pack) =>
      reopenIssuesForDismissedPack(proposalIssueDeps, projectId, pack),
  });
  // Gates, activation gates, and the advanceWhen watcher judge a drafting
  // task against the draft overlay (proposed tree), not the real workspace.
  tasks.setDraftReader(diffpacks.drafts);
  chat.setDraftReader(diffpacks.drafts);
  // Prompt drafts: the messages the user is writing, kept on disk so they
  // survive a restart. The chat manager needs it only to stamp a sent draft
  // and to clean up after a deleted thread.
  const promptDrafts = new PromptDraftManager({ store, events: chatEvents });
  chat.setPromptDrafts(promptDrafts);
  const inputStaging = new InputStagingManager(store);
  tasks.setInputStaging(inputStaging);
  // The nightly oversight task is ensured at boot; ensure it again as each
  // window opens, so a task deleted, renamed or stuck on an old prompt since
  // boot is repaired in time to run tonight.
  nightShift.setOnWindowOpened(async (windowKey) => {
    await ensureNightShiftOversightTask(store, tasks);
    await prepareReviewForNight(
      { store, archiveSession: (id) => chat.archiveSession(id, { summarize: false }) },
      windowKey,
    ).catch((err) =>
      log.warn(`[night-shift] could not prepare the nightly review: ${String(err)}`),
    );
    const windowStart = lastNightShiftWindow(
      opts.nightShiftNow?.() ?? new Date(),
      nightShift.currentWindow(),
    ).start;
    await releasePausedNightFixes({ store, tasks }, windowStart.getTime()).catch((err) =>
      log.warn(`[night-shift] could not release paused night fixes: ${String(err)}`),
    );
  });
  // The morning review card; see tasks/night-review-card.ts.
  nightShift.setOnWindowSettled((windowKey) =>
    postNightShiftReviewCard(
      {
        store,
        tasks,
        history,
        contentIndex,
        reportActions,
        diffpacks,
        chatEvents,
        nightShift,
        hasNightSweepProject,
        ...(opts.nightShiftNow ? { nightShiftNow: opts.nightShiftNow } : {}),
      },
      windowKey,
    ),
  );
  // Paused-for-help fan-in: every pause-for-help path (gate exhausted /
  // plateau / unsatisfiable / infrastructure, stalled step, spent budget)
  // files ONE needs-input card so the pause is pushed to the user instead
  // of discovered by opening the Tasks view. Deduped on an unanswered
  // card for the same task; a task that pauses again after the card was
  // answered files a fresh one. No live session — answering collapses
  // the card; the `taskRef` attachment gives the UI its "Open task" link.
  tasks.setTaskNeedsHelpHook(async ({ projectId, task, stepId, reason, detail }) => {
    // The nightly review is the runtime's own work: it resumes itself when the
    // next window opens and the morning card says so.
    if (isNightShiftOversightTask(task)) return;
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
      // "Try again" is a real choice, not only the desktop card's button, so
      // every client can restart the task. The eval harness and plain-choice
      // clients saw only "Dismiss": 213 paused trials dead-ended there and
      // ran on for ~70 GPU-hours (2026-10-06 review).
      choices: ['Dismiss', 'Try again'],
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
    // The terminal step activates nothing, so its XP (and the task's) is
    // noted here rather than in the step hook.
    if (outcome === 'complete') {
      if (task.assignee.kind === 'gezel') xpRefresher.note(task.assignee.gezelId);
      for (const step of task.craftbook.steps) {
        if (step.completedAt) xpRefresher.note(stepCreditedGezelId(step));
      }
    }
    // The owner's wrap-up. Detached: this hook runs inside the worker's
    // final `advance_task_step` call, and the wrap-up reads every session
    // the task used — the worker's tool result must not wait on that.
    void chat
      .postTaskWrapUp(task, outcome)
      .catch((err) => log.warn(`[service] task wrap-up failed for ${task.ref}: ${String(err)}`));
    await contentIndex
      .settleFindingsForTask(projectId, task.ref, outcome)
      .catch((err) => log.warn(`[service] finding settle failed for ${task.ref}: ${String(err)}`));
    // A drafting task that finished proposed a fix rather than making one:
    // its issues settle against the proposal once it is sealed, below.
    const draftedFix = outcome === 'complete' && Boolean(task.diffpackId);
    if (!draftedFix) {
      await contentIndex
        .settleBoekwachterIssuesForTask(projectId, task.ref, outcome)
        .catch((err) =>
          log.warn(`[service] Boekwachter issue settle failed for ${task.ref}: ${String(err)}`),
        );
    }
    await codeReviews
      .settleForTask(projectId, task.ref, outcome)
      .catch((err) => log.warn(`[service] review settle failed for ${task.ref}: ${String(err)}`));
    // A completed drafting task seals its pack; a canceled one discards the
    // draft tree, because a half-finished proposal is worse than none — the
    // user cannot tell which parts the gezel stood behind.
    await diffpacks
      .settleForTask(projectId, task.ref, outcome)
      .catch((err) => log.warn(`[service] diffpack settle failed for ${task.ref}: ${String(err)}`));
    if (draftedFix) {
      await settleIssuesForDraftingTask(proposalIssueDeps, projectId, task.ref).catch((err) =>
        log.warn(`[service] proposal issue settle failed for ${task.ref}: ${String(err)}`),
      );
    }
    // Report actions can live in a different project than their fired
    // task (the oversight report delegates cross-project), so this settle
    // scans records by taskRef rather than trusting projectId.
    await reportActions
      .settleForTask(task.ref, outcome)
      .catch((err) =>
        log.warn(`[service] report-action settle failed for ${task.ref}: ${String(err)}`),
      );
    // Fanout barrier release. `onStepActivated` declines to dispatch a
    // worker turn into a post-fanout step while children are still
    // active, because that step's gate waits on files only the children
    // can write. This is the other half: when the LAST active child
    // settles, the gate has become satisfiable, so poke the parent's
    // active step. Without it the hold would be permanent — nothing else
    // notifies a spawn host that its crew finished.
    if (task.parentTaskRef) {
      const parsedParent = parseTaskRef(task.parentTaskRef);
      if (parsedParent) {
        const stillActive = await tasks
          .listChildren(task.parentTaskRef, { status: 'active' })
          .catch(() => []);
        if (stillActive.length === 0) {
          await tasks
            .redispatchActiveStep(
              parsedParent.projectId,
              parsedParent.num,
              `last fanout child ${task.ref} settled (${outcome})`,
            )
            .catch((err) =>
              log.warn(
                `[service] fanout barrier release failed for ${task.parentTaskRef}: ${String(err)}`,
              ),
            );
        }
      }
    }
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
  const knowledge = new KnowledgeManager({
    home,
    host: createWorkerCatalogHost(),
    catalog,
    history,
    readConfig: () => store.readConfig(),
    ...(machineEngine ? { sharedInstaller: createSharedKnowledgeInstaller(machineEngine) } : {}),
    projectPolicy: async (projectId) => {
      const project = await store.getProject(projectId);
      return project?.knowledgeCatalogs ?? null;
    },
  });
  // The on-device relevance model (cross-encoder). Off by default; a turn
  // never waits for its load, so construction is free.
  const relevance = new RelevanceModelManager({ home, readConfig: () => store.readConfig() });
  search.setRelevanceProvider(relevance);
  // Media search (EmbeddingGemma 2): the gate the media embed tier reads and
  // the model download, which waits for the deferred boot step below.
  const mediaSearch = new MediaSearchManager({
    home,
    readConfig: () => store.readConfig(),
    backgroundDownloads: backgroundDownloadsAllowed(),
  });
  if (knowledge) {
    await knowledge.start();
    search.setKnowledgeSearch({
      search: (query, opts) => knowledge.searchUnified(query, opts),
    });
    tasks.setKnowledgeCitationResolver(async (uri) => (await knowledge.resolveCitation(uri)).ok);
    knowledge.startAutoUpdateTimer();
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
    ensureAudioVideo: () => mediaSearch.ensureAudio(),
    // AI-shadow producers. Availability is checked once per batch: with no
    // image-recognition or STT model set up, the files wait rather than spend
    // their attempts, so they are described once a model is chosen. A failure
    // on one file still counts against that file's attempt cap.
    shadowProducers: {
      describeAvailable: () => recognition.isAvailable(),
      transcribeAvailable: async () =>
        (await (await stt.providerForModel()).health()).status === 'ok',
      describeImage: async (absPath) => {
        // HEIC and RAW reach the model as a temporary JPEG, released below.
        const raster = await toDecodableRaster(absPath, VISION_RASTER_FORMATS).catch(() => null);
        if (!raster) return null;
        try {
          if (!(await recognition.isAvailable())) return null;
          const bytes = await readFile(raster.path);
          const meta = readImageStaticMeta(bytes);
          const result = await recognition.recognize({
            bytes,
            mimeType: raster.path === absPath ? mimeTypeForFilename(absPath) : raster.mimeType,
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
        } finally {
          await raster.release().catch(() => {});
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
  // Stateless: one short-lived child per statement, so there is nothing to
  // start or stop. Constructing it when no binary is installed is deliberate —
  // the query routes then return an actionable "engine not installed" rather
  // than the daemon refusing to boot over a feature most projects never use.
  const duck = new DuckRunner({ home });
  {
    // Log which rung of the discovery ladder answered. A support case that
    // starts "the query returned the wrong thing" needs to know whether this
    // is the pinned build the sandbox matrix was measured against or a system
    // DuckDB of unknown vintage; without this the answer takes a repro.
    const resolved = duck.resolvedBinaryProvenance();
    if (!resolved) {
      log.info('[duckdb] no query engine resolved — data features will report it as unavailable');
    } else if (resolved.pinned) {
      log.info(`[duckdb] using pinned build (${resolved.source}): ${resolved.path}`);
    } else {
      log.warn(
        `[duckdb] using an unverified DuckDB (${resolved.source}): ${resolved.path} — sandbox behaviour is only measured against the pinned build`,
      );
    }
  }
  // The index's derived-table drain needs the engine, but the index is
  // constructed far earlier in boot order — hand it over once both exist.
  contentIndex.setDuckRunner(duck);

  // Night bug fixing: as each project's slice of the night's index sweep
  // finishes, hand its open Boekwachter issues to its developer, who drafts
  // change proposals into artifacts. Runs off the sweep rather than on
  // activation so it plans against tonight's findings, not last night's, and
  // per project so a big photo library still indexing doesn't hold back the
  // code project next to it. The gate is crew composition — a Boekwachter and
  // a developer on the roster — and nothing it produces touches the workspace.
  const nightFixDeps = {
    store,
    tasks,
    taskRunner,
    contentIndex,
    catalog,
    diffpacks,
    history,
    nightShiftWindow: () => nightShift.currentWindow(),
  };
  // Observation-corpus maintenance rides the same edge: compact the NDJSON
  // that daytime syncs left sealed, materialize declared rollups for the
  // partitions that changed, then apply retention. Deliberately NOT done
  // inline at sync time — compaction is minutes of CPU on a large pass, and
  // the rows are already queryable before it runs.
  const observationDeps = {
    store,
    duck,
    // Picks up tabular workspace files the interactive index pass deferred
    // for being too large to convert while a user was waiting.
    drainWorkspaceTables: (projectId: string) =>
      contentIndex.drainWorkspaceTablesAtNight(projectId),
    nightShiftWindow: () => nightShift.currentWindow(),
  };
  const runProjectNightWork = async (projectId: string): Promise<void> => {
    const plan = await planProjectNightFixes(nightFixDeps, projectId).catch((err) => {
      log.warn(`[diffpack] night fix planning failed for ${projectId}: ${String(err)}`);
      return null;
    });
    if (plan?.taskRef) {
      log.info(`[diffpack] night fixing planned for ${projectId} (${plan.issueCount} issue(s))`);
    }
    await runProjectObservationNightly(observationDeps, projectId).catch((err) =>
      log.warn(`[observations] nightly maintenance failed for ${projectId}: ${String(err)}`),
    );
    // Keyed to the night, not the clock: a night crossing midnight wrote
    // photos-10-07 and codebase-10-08 for the same run (2026-10-08).
    const now = opts.nightShiftNow?.() ?? new Date();
    const night = nightShiftDayKey(now, nightShift.currentWindow());
    // Model-free, so it runs on any machine; writes nothing for a folder
    // without photos.
    await writeNightlyPhotoReport({ store, contentIndex }, projectId, now, night).catch((err) =>
      log.warn(`[index] photo report failed for ${projectId}: ${String(err)}`),
    );
    // Albums the night's craftbook wrote link workspace photos; store the
    // copies now so they play and export in the morning.
    await storeAllAlbumPhotos(albumMediaDeps(store), projectId).catch((err) =>
      log.warn(`[index] storing album photos failed for ${projectId}: ${String(err)}`),
    );
    await writeNightlyDocumentsReport({ store, contentIndex }, projectId, now, night).catch((err) =>
      log.warn(`[index] documents report failed for ${projectId}: ${String(err)}`),
    );
    await writeNightlyCodebaseReport({ store, contentIndex }, projectId, now, night).catch((err) =>
      log.warn(`[index] codebase report failed for ${projectId}: ${String(err)}`),
    );
  };
  indexEnrichment.setOnProjectCaughtUp(async (projectId) => {
    if (!nightShift.isActive()) return;
    await runProjectNightWork(projectId);
  });
  // The sweep covers only indexing-enabled projects. Observation upkeep for
  // the rest runs once the whole sweep is done.
  indexEnrichment.setOnCatchUpDrained(async () => {
    if (!nightShift.isActive()) return;
    const projects = await store.listProjects().catch(() => []);
    for (const project of projects) {
      if (project.indexingEnabled !== false) continue;
      await runProjectObservationNightly(observationDeps, project.id).catch((err) =>
        log.warn(`[observations] nightly maintenance failed for ${project.id}: ${String(err)}`),
      );
    }
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
          aiTiersAllowed: async () => isTaskWorkAllowed(await store.readConfig().catch(() => ({}))),
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
  registerProductConnectorAdapters();
  // Sync passes, binding mutations, and action commits all read-modify-write
  // the same project state (project.json bindings, the corpus, the `_actions`
  // staging dirs), so the sync manager and the action manager share ONE lock —
  // a commit can't race a sync or a concurrent discard on the same project.
  const connectorLocks = new KeyedLock();
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
  wireProductConnectorTaskPreparation({ store, connectors, tasks, git, gitHubPrs });

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
    // Growth is on display only in social mode: off, the level-up waits in
    // the Growth tab for whenever the person turns it on.
    announce: async (gezelId, toLevel) => {
      if (resolveSocialMode(await store.readConfig(), 'desktop'))
        await chat.announceGrowth(gezelId, toLevel);
    },
  });
  growthRef.engine = growth;

  const remoteFetchRef: { value?: Parameters<typeof serve>[0]['fetch'] } = {};
  const remoteServing = createRemoteServingController({
    cert,
    deviceFingerprint: deviceIdentity?.fingerprint ?? null,
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
    allowListener: distribution.allowOllamaEmulation,
  });

  // Codex, OpenCode, pi and VS Code; see local-harness/integrations.ts.
  const localHarnesses = createLocalHarnessIntegrations({
    home,
    opts,
    store,
    chat,
    catalog,
    tokenStore,
    resolveMachineEngineRemoteId,
  });
  const { codexSetup, opencodeSetup, piSetup, vscodeSetup } = localHarnesses;
  // Word / Excel / PowerPoint and LibreOffice; see office-host/integrations.ts.
  const officeIntegrations = createOfficeIntegrations(home, opts, firstPartyApps);

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
  const appServe = createAppServeController({
    store,
    catalog,
    chat,
    chatEvents,
    history,
    scriptRunner,
  });

  const context: ServiceContext = {
    serviceRole,
    distribution,
    home,
    store,
    chatEvents,
    chat,
    appToolRelays,
    previewLog,
    channels,
    memory,
    history,
    growth,
    tasks,
    taskLauncher: new TaskLauncher({
      tasks,
      store,
      taskRunner,
      history,
      gatherReferences: ({ projectId, subject, craftbookName }) =>
        gatherTaskReferences({ search, projectId, subject, craftbookName }),
    }),
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
    promptDrafts,
    inputStaging,
    connectors,
    connectorActions,
    duck,
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
    firstPartyApps,
    deviceIdentity,
    signIdentityCertificate: () =>
      cert && deviceIdentity
        ? signCertFingerprint(secrets, home, cert.sha256Hex)
        : Promise.resolve(null),
    remotes,
    ...(machineEngine ? { machineEngine } : {}),
    remoteServing,
    remoteTenantLimits,
    ollamaEmulation,
    codexSetup,
    opencodeSetup,
    piSetup,
    vscodeSetup,
    ...officeIntegrations.contextFields(),
    ...(cert ? { tlsCertSha256: cert.sha256Hex, tlsCertPem: cert.certPem } : {}),
    ensureModel,
    startedAt: nowIso(),
    childProcessSpawn,
    uiDir: opts.uiDir,
    folderJobs,
    storageJobs,
    evals,
    invalidateModelsCache,
    workspaceIndex,
    contentIndex,
    globalIndex,
    indexingJob,
    search,
    relevance,
    mediaSearch,
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
    embeddedInferenceOnly,
  });
  const remoteApp = buildRemoteApp(context);
  remoteFetchRef.value = remoteApp.fetch.bind(remoteApp);
  const ollamaEmulationApp = buildOllamaEmulationApp(context);
  ollamaEmulationFetchRef.value = ollamaEmulationApp.fetch.bind(ollamaEmulationApp);
  localHarnesses.bindApps(context);
  officeIntegrations.bindFetch(app.fetch.bind(app));

  const { server, port } = await bindMainListener(app.fetch, cert, opts);

  // Plain-HTTP preview sidecar. It always gets a dedicated loopback origin,
  // even when the main transport is already HTTP: local-preview-only browser
  // sessions use this listener as a deliberately non-forwarding Chromium
  // proxy, keeping every request away from both the public web and the
  // daemon's bearer-gated API surface.
  let previewServer: ServerType | null = null;
  {
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
  if (!embeddedInferenceOnly) {
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
    await officeIntegrations.reconcile();
    scheduler.start();
    nightShift.start();
    await ensureNightShiftOversightTask(store, tasks).catch((err) => {
      log.warn('[night-shift] oversight ensure failed:', err instanceof Error ? err.message : err);
    });
    // `afterRestart` is what charges each resumed step to its restart
    // budget; the night-shift and per-project rehydrations below/elsewhere
    // are a running process re-reading its own queue and must not count.
    await taskRunner.rehydrateFromStore({ afterRestart: true }).catch((err) => {
      log.warn('[task-runner] rehydrate failed:', err instanceof Error ? err.message : err);
    });
    taskRunner.start();
    // Chat's half of the same recovery, and deliberately after the runner's:
    // a task session is rehydrated from its task record, and
    // `resumeInterruptedTurns` skips those so the two never drive one
    // session at once. Handoffs replay first — a message still parked when
    // the process stopped has no session-side trace for the resume pass to
    // find, so it has to be re-issued rather than resumed.
    await chat.replayPendingHandoffs().catch((err) => {
      log.warn('[chat] handoff replay failed:', err instanceof Error ? err.message : err);
    });
    // Detached: the resume pass reads every session summary to find the
    // stamps, and boot readiness is the splash screen the user is watching.
    // The turns it starts are background-lane anyway.
    void chat.resumeInterruptedTurns().catch((err) => {
      log.warn('[chat] interrupted-turn resume failed:', err instanceof Error ? err.message : err);
    });
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
  // A store build skips it for a different reason than the two below: not
  // "this environment doesn't want the download" but "this build may not
  // download executable code at all". The published phase is still `ready` —
  // nothing is pending, and the toolsets are simply absent.
  const skipBootstrap =
    embeddedInferenceOnly ||
    !distribution.allowRuntimeCodeDownloads ||
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

  // Give pre-convention installs the quantization in their name. The model
  // table prints the install id, so `gemma4-e4b` (Q8_0) sat one row below
  // `gemma4-e4b-q4` with nothing on either row to tell them apart. Awaited
  // rather than backgrounded: it is a handful of directory renames, and a
  // listing that raced it would show a model under neither name.
  await migrateInstalledModelIds(home, store);
  void reclaimStaleModelDownloads(home, { llamaCppModels, ds4Models, mlxModels });

  // On-device first-run recommendation: if the user hasn't picked a
  // provider, default to the best-fitting local catalog model. This only
  // pins the choice; the desktop or TUI asks before starting a download.
  // No-op on subsequent boots (`firstRunCompleted` is the guard).
  // Gated off during mock/skip modes so tests don't try to hit
  // Hugging Face. See `bootstrapOnDeviceFirstRun` for the decision
  // tree.
  if (!skipBootstrap) {
    const { bootstrapOnDeviceFirstRun } = await import('./first-run/on-device-bootstrap.js');
    void bootstrapOnDeviceFirstRun({
      store,
      llamaCppModels,
      mlxModels,
      catalog,
      ...(machineEngine ? { machineEngine } : {}),
    }).catch((err) => {
      log.error('[first-run] on-device bootstrap crashed:', err);
    });
  }

  // Periodic memory-index health sweep — re-syncs the vector cache from the
  // markdown source-of-truth. Catches drift from direct file edits AND
  // self-heals any indexes left empty by the previously-broken vector
  // wrapper. No-op if embeddings are disabled.
  const memoryHealth = new MemoryHealthMonitor({ memory, store });
  if (!embeddedInferenceOnly) memoryHealth.start();

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
  if (!embeddedInferenceOnly) memoryCompactor.start();

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
  const promptDraftSweeper = new PromptDraftSweeper({ store, drafts: promptDrafts });
  if (!embeddedInferenceOnly) {
    promptDraftSweeper.start();
    inputStaging.startSweeping(store);
    digestGenerator.start();
    gildeUpdates.startScheduler();
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
  if (!embeddedInferenceOnly) {
    keurmeesterDigest.start();
    workspaceIndex.start();
    workspaceWatch.start();
  }
  // Benchmarks (evals) disable the background tick and drive enrichment
  // explicitly via POST /:id/index/enrich, so tick-vs-drive contention can't
  // double-pay summarizer calls or skew cost measurements.
  if (!embeddedInferenceOnly && process.env.GEZEL_DISABLE_BACKGROUND_ENRICH !== '1') {
    indexEnrichment.start();
  }
  if (!embeddedInferenceOnly) {
    globalIndexManager.start();
    connectorSync.start();
  }

  // Idle-session summarization sweep: every hour, distill any non-archived
  // session that's been quiet for `config.summarization.idleHours` (default
  // 24h) into project memory. First pass runs ~60s after boot so a fresh
  // process doesn't block startup.
  const idleSummarizerTimer = embeddedInferenceOnly
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
  // Give back the provider sessions and MCP subprocesses of quiet sessions;
  // finished task sessions otherwise hold theirs until the daemon stops.
  const idleSessionTimer = setInterval(
    () => {
      chat.releaseIdleSessions().catch((err) => {
        log.warn('[chat] idle session release failed:', err instanceof Error ? err.message : err);
      });
    },
    5 * 60 * 1000,
  );
  idleSessionTimer.unref();
  const stopMemoryDiagnostics = startMemoryDiagnostics();
  // Cancelled by stop(): deferred work that starts during shutdown can load a
  // model worker that process.exit then aborts mid-load (see boot-work.ts).
  const cancelBootWork: Array<() => void> = [];
  if (!embeddedInferenceOnly) {
    cancelBootWork.push(
      deferBootWork(
        60_000,
        () => {
          chat.runIdleSummarizationSweep().catch(() => {
            /* swallow */
          });
        },
        () => stopping,
      ),
    );
  }
  // Load the embedding pipeline before an interactive caller needs it. The
  // titlebar search fans out over content on every query, so without this
  // the model's one-time load lands on somebody's first keystroke. Deferred
  // so it never competes with boot or the first-run model download.
  if (!embeddedInferenceOnly) {
    cancelBootWork.push(
      deferBootWork(
        20_000,
        () => {
          void warmEmbeddings().then((warmed) => {
            if (warmed) log.debug('[memory] embedding pipeline warmed');
          });
          void relevance.bootWarm().catch(() => {});
          void mediaSearch.bootWarm().catch(() => {});
        },
        () => stopping,
      ),
    );
  }

  if (embeddedInferenceOnly) log.info('[service] embedded inference ready');
  return {
    context,
    server,
    port,
    clientToken,
    cert,
    webUiToken,
    profile: embeddedInferenceOnly ? 'embedded-inference' : 'full',
    ...(embeddedInferenceOnly
      ? {
          fetch: ((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
            app.fetch(new Request(input, init))) as typeof fetch,
        }
      : {}),
    async stop() {
      stopping = true;
      for (const cancel of cancelBootWork) cancel();
      // Model workers refuse new work from here and drain while the rest
      // shuts down; each is terminated once idle, never mid-run, because
      // process.exit tearing one down inside onnxruntime aborts the process.
      const modelWorkersStopped = shutdownModelWorkers();
      const shutdownStep = <T>(name: string, action: () => T | Promise<T>) =>
        observeShutdownStep(name, action, { warn: (message) => log.warn(message) });
      log.info('[service] shutdown started');
      suspendLogOff();
      stopSuspendMonitor();
      void stopResponsivenessMonitor();
      scheduler.stop();
      nightShift.stop();
      // Issued first: an owning supervisor force-stops this process a few
      // seconds into shutdown, and a first-run Chromium download must not
      // outlive it as an orphan.
      const systemBootstrapsStopped = stopSystemBootstraps();
      // Quiesce chat before tearing down any callback dependencies. In
      // particular, keep the HTTP listener alive while MCP subprocesses and
      // active provider turns unwind; otherwise their service callbacks fail
      // as the misleading transport error "fetch failed".
      await shutdownStep('chat begin', () => chat.beginShutdown());
      await shutdownStep('task runner', () => taskRunner.stop());
      memoryHealth.stop();
      memoryCompactor.stop();
      xpRefresher.dispose();
      digestGenerator.stop();
      promptDraftSweeper.stop();
      inputStaging.stopSweeping();
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
      // First: a running eval harness owns a trial daemon and its engines.
      await shutdownStep('eval jobs', () => evals.shutdown());
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
      await shutdownStep('system toolsets', () => systemBootstrapsStopped);
      await shutdownStep('image provider', () => imageProvider.shutdown());
      await shutdownStep('video provider', () => videoProvider.shutdown());
      await shutdownStep('speech recognition', () => stt.shutdown());
      await shutdownStep('speech synthesis', () => tts.shutdown());
      if (idleSummarizerTimer) clearInterval(idleSummarizerTimer);
      clearInterval(idleSessionTimer);
      stopMemoryDiagnostics();
      await shutdownStep('channels', () => channels.stop());
      await shutdownStep('app serve', async () => appServe?.stopAll());
      await shutdownStep('remote serving', () => remoteServing.stop());
      await shutdownStep('Ollama emulation', () => ollamaEmulation.stop());
      await shutdownStep('Codex setup', () => codexSetup.stop());
      await shutdownStep('OpenCode setup', () => opencodeSetup.stop());
      await shutdownStep('pi setup', () => piSetup.stop());
      await shutdownStep('VS Code setup', () => vscodeSetup.stop());
      await shutdownStep('Office host', () => officeIntegrations.stop());
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
      await shutdownStep('model workers', () => modelWorkersStopped);
      await shutdownStep('runtime lock', () => runtimeLock.release());
      log.info('[service] shutdown complete');
    },
  };
}
