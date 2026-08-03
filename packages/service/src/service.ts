import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, rm, writeFile } from 'node:fs/promises';
import { createSecureServer as createSecureHttp2Server } from 'node:http2';
import { setDefaultAutoSelectFamilyAttemptTimeout } from 'node:net';
import { delimiter, dirname, join } from 'node:path';
import {
  type GezelConfig,
  createLogger,
  isEngagementAllowed,
  normalizeStepGate,
  nowIso,
  parseTaskRef,
  projectAllowsAmbientWork,
} from '@bendyline/gezel';
import type { ExternalFolders, TaskAssignee } from '@bendyline/gezel';
import { CatalogService } from '@bendyline/gezel-catalog';
import {
  DeviceHealthGate,
  createSystemDeviceHealthProbe,
  discoverNativeBinaries,
  resolveDeviceSafetyPolicy,
} from '@bendyline/gezel/native';
import { gezelHome, gezelPaths, readConfigRaw } from '@bendyline/gezel/paths';
import { type ServerType, serve } from '@hono/node-server';
import { defaultCacheBudgetMb } from './cache/budget.js';
import { SessionCacheController } from './cache/controller.js';
import { ChannelManager } from './channels/manager.js';
import { ChatEventBus } from './chat/events.js';
import { ChatManager, resolveCatalogReasoningBudget } from './chat/manager.js';
import { ConnectorActionManager } from './connectors/actions.js';
import { ConnectorManager } from './connectors/manager.js';
import { registerCalendarAdapters } from './connectors/natives/calendar-google.js';
import { registerGitHubWikiAdapters } from './connectors/natives/github-wiki.js';
import { ConnectorSyncManager } from './connectors/sync-manager.js';
import { listApplicableCraftbooks } from './craftbook/applicable.js';
import { makeCraftbookResolver } from './craftbook/resolve.js';
import { DebugFlag } from './debug/flag.js';
import { ProjectDigestGenerator } from './digest/generator.js';
import { effectiveEngineRelease } from './engines/native-manifest.js';
import { EngineBinaryRegistry } from './engines/registry.js';
import { ModelFitnessManager } from './fitness/manager.js';
import { type FitnessEngine, runFitnessProbe } from './fitness/probe.js';
import { ActivityTracker } from './fs/activity-tracker.js';
import { Store } from './fs/store.js';
import { ensureDefaultBoekwachter } from './gezels/autonomous-roles.js';
import { GitManager } from './git/manager.js';
import { CodeReviewManager } from './git/reviews.js';
import { GitHubPrs } from './github/prs.js';
import { createGrantManager, parseAutoApproveAppIds } from './grants/manager.js';
import { GrowthEngine } from './growth/engine.js';
import { createDaemonDeviceInfo } from './handboek/daemon-device.js';
import { createHandboekEngine } from './handboek/engine.js';
import { type LoopbackCert, generateLoopbackCert } from './http/cert.js';
import type { ServiceContext } from './http/context.js';
import {
  buildOllamaEmulationApp,
  createOllamaEmulationController,
} from './http/ollama-emulation.js';
import { PreviewCapabilityStore } from './http/preview-capability.js';
import { buildRemoteApp } from './http/remote-server.js';
import { invalidateModelsCache } from './http/routes/models.js';
import { type UnexpectedHttpErrorHandler, buildApp, buildPreviewApp } from './http/server.js';
import { createTokenStore } from './http/token-store.js';
import { ContentIndex } from './index-store/content-index.js';
import { IndexEnrichmentManager } from './index-store/enrichment-manager.js';
import { GlobalIndexManager } from './index-store/global-index-manager.js';
import { GlobalIndex } from './index-store/global-index.js';
import { IndexingJobControl, ensureIndexingJobTask } from './index-store/indexing-job.js';
import { KeurmeesterDigestGenerator } from './keurmeester/digest.js';
import { KeurmeesterManager } from './keurmeester/manager.js';
import { MailManager } from './mail/manager.js';
import { registerMailAdapters } from './mail/registry.js';
import { ensureNightShiftOversightTask } from './meester/night-shift-oversight.js';
import { MeesterStatusGenerator } from './meester/status-generator.js';
import { MemoryCompactor } from './memory/compaction.js';
import { MemoryHealthMonitor } from './memory/health.js';
import { MemoryManager } from './memory/manager.js';
import { createEnsureModelOrchestrator } from './models/ensure.js';
import { buildChatModelInstallRegistries } from './models/install-jobs.js';
import {
  migrateLegacySystemModels,
  modelStorageRoots,
  reclaimAbandonedModelDownloads,
} from './models/storage-roots.js';
import { normalizeBundledPnpmPath } from './packages/pnpm.js';
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
import type { LLMProvider } from './providers/types.js';
import { VideoProviderManager } from './providers/video/manager.js';
import { VideoModelPullRegistry } from './providers/video/pull-registry.js';
import { MlxRuntimeStatusBus } from './python/mlx-runtime-status-bus.js';
import { UvRuntime } from './python/uv-runtime.js';
import { loadOrCreateDeviceIdentity } from './remotes/identity.js';
import { closePairedRemoteFetches } from './remotes/pinned-fetch.js';
import { createRemotesRegistry } from './remotes/registry.js';
import { createRemoteServingController } from './remotes/serving.js';
import { ImageRenderer } from './rendering/image-renderer.js';
import { ReportActionManager } from './report-actions/report-action-manager.js';
import { type RuntimeLock, acquireSingleInstanceLock } from './runtime-lock.js';
import { ScriptRunner } from './scripts/runner.js';
import { CATALOG_RELEVANT_HISTORY_KINDS, SearchService } from './search/search-service.js';
import { openSecretStore } from './secrets/index.js';
import { seedSecretsFromEnvFile } from './secrets/seed.js';
import { runSystemBootstrap } from './system-toolsets/bootstrap.js';
import { SystemToolsetInstallRegistry } from './system-toolsets/install-registry.js';
import { SystemStatusBus } from './system-toolsets/status-bus.js';
import { reapOrphanedGezelEngineProcesses } from './system/gezel-process-cleanup.js';
import { SystemIdleState } from './system/idle-state.js';
import { detectMemoryProfile } from './system/memory.js';
import { dispatchTaskEntry } from './tasks/entry-dispatch.js';
import type { GateWorkspaceReader } from './tasks/gate-eval.js';
import { TaskManager } from './tasks/manager.js';
import { buildNightShiftReview } from './tasks/night-review.js';
import { NightShiftManager } from './tasks/night-shift-manager.js';
import { TaskRunner } from './tasks/runner.js';
import { TaskScheduler } from './tasks/scheduler.js';
import { evaluateStepGate } from './tasks/step-gate.js';
import { TerminalEventBus } from './terminal/events.js';
import { type CraftbookInvoker, TerminalManager } from './terminal/manager.js';
import { HF_CACHE_DIR_ENV, transformersCacheDir } from './transformers-cache.js';
import { WorkspaceIndexManager } from './workspace/index-manager.js';
import { WorkspaceWatchManager } from './workspace/watch-manager.js';

const log = createLogger('service');

/**
 * Canonical fixed port for the Gezel daemon's public surface (the
 * OpenAI-compatible `/v1/*` API and everything else served alongside it).
 * `6228` spells "MAAT" on a phone keypad (M-A-A-T → 6-2-2-8). "Maat" is
 * Dutch for a mate, companion, or fellow worker — a close sibling to
 * "gezel". It sits in the IANA User Port range and below the default
 * ephemeral-allocation windows on Windows, macOS, and Linux.
 *
 * The user-facing daemons (standalone `gezeld` and the embedded desktop
 * service) try to claim this so third-party OpenAI-compatible clients —
 * the ones we don't ship and can't teach to read the runtime files — get
 * a stable `https://127.0.0.1:6228/v1` base URL. It's a strong default,
 * not a guarantee: if the port is taken the daemon falls back to an
 * ephemeral port, and the *actual* bound port is always written to
 * `~/.gezel/runtime/port` for first-party discovery. Force an exact port
 * (no fallback) with `--port` / `GEZEL_PORT`.
 */
export const DEFAULT_PORT = 6228;

export interface StartServiceOptions {
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
}

export interface RunningService {
  context: ServiceContext;
  server: ServerType;
  port: number;
  /**
   * First-party client credential written to `runtime/auth-token` and
   * handed to the Electron renderer. It is deliberately distinct from
   * `context.token`: the daemon root credential stays in process memory
   * and is never used as the cross-process discovery credential.
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

  const home = opts.home ?? gezelHome();
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
  // launch. Sweep all clearly-Gezel, same-home PPID-1 engines once at service
  // boot so starting a DS4 chat also clears an abandoned MLX/Python server
  // (and vice versa). Acquiring the home lock first proves no live same-home
  // daemon can be racing this cleanup.
  try {
    const cleanup = await reapOrphanedGezelEngineProcesses({ home });
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
  const store = new Store({ home, history, external });
  await recoverTypedProjectCreations(store);
  await store.ensureLayout();
  await store.ensureDefaultProject();
  await store.ensureDefaultMeester();
  await store.ensureDefaultKlerk();

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
      // The desktop/CLI discovery token needs the internal UI surface and
      // the local OpenAI-compatible facade, but never the root scope.
      scopes: ['ui', 'openai'],
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
  // `catalog`/`llamaCppModels`/`mlxModels` lines.
  // HTTPS+HTTP/2 is the default loopback transport. The browser/Electron
  // renderer needs it to multiplex our SSE streams over a single TCP
  // connection (Chromium caps HTTP/1.1 at 6 conns/origin and the chat
  // view holds 6+ event-streams open). Operators can downgrade to plain
  // HTTP/1.1 with `GEZEL_INSECURE_TRANSPORT=1` for emergencies — that
  // single conditional is the entire fallback path.
  const httpsEnabled = process.env.GEZEL_INSECURE_TRANSPORT !== '1';
  const cert = httpsEnabled ? await generateLoopbackCert() : null;
  const chatEvents = new ChatEventBus();
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
  const catalog = new CatalogService(undefined, { localRoot: home });
  // The Boekwachter is a full, catalog-backed gezel. This runs after catalog
  // construction (unlike the Store-owned Meester/Klerk ensures above) so the
  // canonical gilde about.md and template provenance are preserved.
  await ensureDefaultBoekwachter(store, catalog);
  const secrets = await openSecretStore(home);
  log.info(`[secrets] backend=${secrets.backend}`);
  await seedSecretsFromEnvFile(secrets);
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
  // Bare npm/CLI installs have no Electron supervisor to point discovery at
  // the runtime-downloaded cache. Make the source-pinned cache the default
  // native-bin root while preserving a packaged/operator override. This makes
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
  // Wraps the two local model managers above into a single uniform
  // "ensure this model is downloaded" primitive so third-party apps
  // don't need to learn either install API.
  const ensureModel = await createEnsureModelOrchestrator({
    llamaCpp: llamaCppModels,
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
          configuredNumCtx: async (engine) => {
            const cfg = await store.readConfig();
            return engine === 'mlx' ? cfg.mlxNumCtx : cfg.llamaCppNumCtx;
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

  // NightShiftManager owns the Night Shift ON/OFF state (nightly window +
  // manual shifts). Its `isActive` read gates deferred night-shift work in
  // the scheduler, runner, and enrichment loop below.
  const nightShift = new NightShiftManager({ store, manager: tasks, events: chatEvents });

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
  const taskRunner = new TaskRunner({
    store,
    dispatcher: {
      startHandoffSession: (args) => chat.startHandoffSession(args),
      cancelHandoffSession: (sessionId) => chat.cancelInflight(sessionId),
      isHandoffSessionActive: (sessionId) =>
        chat.listInflight().some((entry) => entry.sessionId === sessionId),
      resolveProviderName: (gezelId, opts) => chat.providerForGezel(gezelId, opts),
      getProvider: (name) => chat.getProviderIfReady(name),
    },
    isNightShiftActive: () => nightShift.isActive(),
    isNightShiftPending: (task) => nightShift.isPendingToday(task),
    ...(config.taskRunner?.tickIntervalMs
      ? { tickIntervalMs: config.taskRunner.tickIntervalMs }
      : {}),
  });
  nightShift.setOnActivated(async () => {
    await taskRunner.rehydrateFromStore({ nightShiftOnly: true });
    await taskRunner.wake();
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
  // project-type install path (craftbook/resolve.ts) so both resolve
  // through the exact same chain.
  tasks.setCraftbookResolver(makeCraftbookResolver(store, catalog));

  const channels = new ChannelManager({ store, secrets, history, debug });

  const git = new GitManager(home, store, secrets);
  const gitHubPrs = new GitHubPrs(git);
  const renderer = new ImageRenderer({ home });

  // Image-generation provider manager. Lazy-builds the underlying
  // provider on first use via `providers/image/factory.ts` selection
  // rules. The cloud branches (`google-ai`, `openai`) read API keys
  // from the SecretStore; `reset()` is invoked from the config PUT
  // handler whenever image-related config or credentials change.
  const imageProvider = new ImageProviderManager({ home, store, secrets, arbiter: gpuArbiter });
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
    // craftbook's `spawn.overFile` workspace JSON array — the runtime does
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
          const raw = await store
            .readProjectWorkspaceFile(projectId, spawn.overFile)
            .catch(() => null);
          const items = raw ? extractSpawnItems(raw, spawn.itemsPath) : [];
          if (items.length === 0) {
            log.warn(
              `[fanout] ${task.ref} step "${newStep.id}": no items in ${spawn.overFile} — skipping fanout`,
            );
          } else {
            for (const item of items) {
              const context: Record<string, string> = {};
              for (const [k, v] of Object.entries(item)) {
                context[k] = typeof v === 'string' ? v : v == null ? '' : String(v);
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
          await store
            .writeProjectWorkspaceFile(projectId, advanceFile, manifest)
            .catch((err) => log.warn(`[fanout] ${task.ref}: could not write ${advanceFile}:`, err));
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
    const detail = await catalog.get('craftbook-template', craftbookId).catch(() => null);
    if (!detail || detail.manifest.kind !== 'craftbook-template') {
      throw new Error(`unknown craftbook "${craftbookId}"`);
    }
    const m = detail.manifest;

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
      const resolved = await roleResolverClosure(entryRole, projectId).catch(() => null);
      if (resolved?.gezelId) assignee = { kind: 'gezel', gezelId: resolved.gezelId };
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
      { store, tasks, reportActions },
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
      ...(review.reports[0] ? { documentPath: review.reports[0].path } : {}),
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
    await codeReviews
      .settleForTask(projectId, task.ref, outcome)
      .catch((err) => log.warn(`[service] review settle failed for ${task.ref}: ${String(err)}`));
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
  store.onSessionChange((ev) => globalIndexManager.enqueueSession(ev));
  store.onDocumentChange((ev) => globalIndexManager.enqueueDocument(ev));
  history.subscribe((event) => globalIndexManager.enqueueHistory(event));
  history.setQueryBackend((f) => globalIndex.searchHistory(f));
  history.setRewriteBackend(() => globalIndexManager.rebuildHistoryMirror());
  // Cross-project unified search (titlebar quick-open + content fan-out).
  const search = new SearchService(store, contentIndex, memory, workspaceIndex, globalIndex);
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
  });
  // FS watcher for the MRU-top workspaces — turns an on-disk change into a
  // near-immediate refresh instead of waiting for the polling tick.
  const workspaceWatch = new WorkspaceWatchManager({
    store,
    indexManager: workspaceIndex,
    onProjectMcpConfigChanged: (projectId) => chat.resetProjectToolsets(projectId),
  });

  // Email sync engine. Drives mailbox linking + sync passes + outbound send.
  const mail = new MailManager({
    store,
    secrets,
    contentIndex,
    isNightShiftActive: () => nightShift.isActive(),
  });
  // Generic connectors: register native adapters, then ONE idle/posture-gated
  // sync loop covering both `project.connectors` bindings and legacy
  // `project.mail` accounts (mail delegates to MailManager). This retires the
  // separate MailSyncManager loop; fully moving mail accounts into
  // `project.connectors` is a follow-up with a wider blast radius (the
  // GEZEL_MAIL_ENABLED gate, chat env, and UI mail-tab detection key off
  // `project.mail.accounts`).
  registerMailAdapters();
  registerCalendarAdapters();
  registerGitHubWikiAdapters();
  const connectors = new ConnectorManager({ store, secrets, catalog, contentIndex, scriptRunner });
  const connectorActions = new ConnectorActionManager({
    store,
    secrets,
    catalog,
    contentIndex,
    scriptRunner,
    isNightShiftActive: () => nightShift.isActive(),
  });
  const connectorSync = new ConnectorSyncManager({
    store,
    chat,
    idle: systemIdle,
    isNightShiftActive: () => nightShift.isActive(),
    source: {
      label: 'connectors',
      listBindings: (p) => [...(p.connectors ?? []), ...(p.mail?.accounts ?? [])],
      posture: (pol) => pol.allowExternalServices,
      syncProject: async (p) => [
        ...(await connectors.syncProject(p)),
        ...(await mail.syncProject(p)),
      ],
    },
  });

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
    // isn't a command in a non-GitHub project.
    listCraftbookCommands: async (projectId) => {
      const items = await listApplicableCraftbooks(catalog, store, projectId);
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

  const handboek = createHandboekEngine({
    catalog,
    device: createDaemonDeviceInfo({ store, chat }),
  });

  const context: ServiceContext = {
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
    nightShift,
    indexEnrichment,
    meesterStatus,
    scriptRunner,
    catalog,
    handboek,
    secrets,
    git,
    gitHubPrs,
    codeReviews,
    reportActions,
    mail,
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
    remoteServing,
    ollamaEmulation,
    ...(cert ? { tlsCertSha256: cert.sha256Hex, tlsCertPem: cert.certPem } : {}),
    ensureModel,
    startedAt: nowIso(),
    uiDir: opts.uiDir,
    folderJobs,
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

  // When the main transport is HTTPS (the default), a self-signed loopback
  // cert makes external browsers reject preview URLs. We serve the same
  // capability-authenticated `/preview` route on a separate plain-HTTP
  // listener so "open in browser" gets a clean, warning-free URL. The mint
  // endpoint reads the listener's origin lazily (it binds below, after the
  // main app is built). No second listener when the whole transport is
  // already plain HTTP — the existing same-origin URL works there.
  const previewCapabilities = new PreviewCapabilityStore();
  const previewBrowser = { origin: null as string | null };
  const app = buildApp(context, {
    onUnexpectedHttpError: opts.onUnexpectedHttpError,
    previewCapabilities,
    previewBrowserOrigin: () => previewBrowser.origin,
  });
  const remoteApp = buildRemoteApp(context);
  remoteFetchRef.value = remoteApp.fetch.bind(remoteApp);
  const ollamaEmulationApp = buildOllamaEmulationApp(context);
  ollamaEmulationFetchRef.value = ollamaEmulationApp.fetch.bind(ollamaEmulationApp);

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

  // Plain-HTTP preview sidecar (only when the main transport is TLS). Serves
  // the capability-gated `/preview` route on its own ephemeral loopback port
  // so external browsers open previews without the self-signed-cert warning.
  let previewServer: ServerType | null = null;
  if (cert) {
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
      log.info(`[service] serving preview (HTTP) on 127.0.0.1:${bound.port}`);
    } catch (err) {
      // Non-fatal: previews still work in-app over the pinned-cert HTTPS
      // iframe; only the external-browser convenience is lost.
      log.warn(
        `[service] preview HTTP listener failed to bind; open-in-browser will use the TLS URL: ${
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
  });

  // One live controller owns the LAN socket for startup, Settings changes,
  // rebinds, and shutdown. Persisted state can no longer drift from reality.
  await remoteServing.reconfigure(config.remoteServing).catch((err) => {
    log.error(
      `[service] failed to start remote serving: ${err instanceof Error ? err.message : err}`,
    );
  });
  // Same contract for the Ollama emulation: non-fatal at boot (usually
  // means real Ollama grabbed 11434 since the toggle was set) — the
  // daemon still serves everything else; the toggle stays set and binds
  // on the next launch/config change once the port frees up.
  await ollamaEmulation.reconfigure(config.openaiEndpoints).catch((err) => {
    log.warn(`[service] ollama emulation not started: ${err instanceof Error ? err.message : err}`);
  });

  scheduler.start();
  nightShift.start();
  // Install the always-bundled daily meester oversight task before runner
  // rehydration so a first-run install queues it in the same boot.
  await ensureNightShiftOversightTask(store, tasks).catch((err) => {
    log.warn('[night-shift] oversight ensure failed:', err instanceof Error ? err.message : err);
  });
  // Rehydrate pending handoffs from disk (any active task whose
  // current phase has an effective assignee) before starting the runner's
  // tick loop. Ensures work dropped by a prior process gets picked up.
  await taskRunner.rehydrateFromStore().catch((err) => {
    log.warn('[task-runner] rehydrate failed:', err instanceof Error ? err.message : err);
  });
  taskRunner.start();
  // Install the boekwachter indexing job task (idempotent) — the visible,
  // pausable control surface for the background indexing loops.
  await ensureIndexingJobTask(store, tasks).catch((err) => {
    log.warn('[indexing-job] ensure failed:', err instanceof Error ? err.message : err);
  });
  await channels.start();

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
    process.env.GEZEL_SKIP_SYSTEM_BOOTSTRAP === '1' || process.env.GEZEL_MOCK_PROVIDER === '1';
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
  memoryHealth.start();

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
  memoryCompactor.start();

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
  digestGenerator.start();

  // Meester status report: idle-gated, budgeted, change-gated sweep.
  // The activity tracker starts with it — its stamps feed the change
  // gate and the nudge scheduler's cadence.
  activityTracker.start();
  meesterStatus.start();

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
  keurmeesterDigest.start();

  // Start the workspace indexer's sweep loop now that the service is
  // bound + booted. (The manager itself was constructed before
  // `context` so the HTTP routes can call into it.)
  workspaceIndex.start();
  workspaceWatch.start();
  // Benchmarks (evals) disable the background tick and drive enrichment
  // explicitly via POST /:id/index/enrich, so tick-vs-drive contention can't
  // double-pay summarizer calls or skew cost measurements.
  if (process.env.GEZEL_DISABLE_BACKGROUND_ENRICH !== '1') {
    indexEnrichment.start();
  }
  globalIndexManager.start();
  connectorSync.start();

  // Idle-session summarization sweep: every hour, distill any non-archived
  // session that's been quiet for `config.summarization.idleHours` (default
  // 24h) into project memory. First pass runs ~60s after boot so a fresh
  // process doesn't block startup.
  const idleSummarizerTimer = setInterval(
    () => {
      chat.runIdleSummarizationSweep().catch((err) => {
        log.warn('[summarize] idle sweep crashed:', err instanceof Error ? err.message : err);
      });
    },
    60 * 60 * 1000,
  );
  idleSummarizerTimer.unref();
  setTimeout(() => {
    chat.runIdleSummarizationSweep().catch(() => {
      /* swallow */
    });
  }, 60_000).unref();

  return {
    context,
    server,
    port,
    clientToken,
    cert,
    webUiToken,
    async stop() {
      scheduler.stop();
      nightShift.stop();
      // Quiesce chat before tearing down any callback dependencies. In
      // particular, keep the HTTP listener alive while MCP subprocesses and
      // active provider turns unwind; otherwise their service callbacks fail
      // as the misleading transport error "fetch failed".
      await chat.beginShutdown();
      await taskRunner.stop();
      memoryHealth.stop();
      memoryCompactor.stop();
      digestGenerator.stop();
      keurmeesterDigest.stop();
      meesterStatus.stop();
      await activityTracker.stop();
      workspaceIndex.stop();
      workspaceWatch.stop();
      indexEnrichment.stop();
      globalIndexManager.stop();
      connectorSync.stop();
      cacheController.stop();
      imagePulls.clear();
      chatInstalls.llamaCpp.clear();
      chatInstalls.ds4.clear();
      chatInstalls.mlx.clear();
      videoPulls.clear();
      engineBinaries.clear();
      systemToolsetInstalls.clear();
      await imageProvider.shutdown();
      await videoProvider.shutdown();
      await stt.shutdown();
      await tts.shutdown();
      clearInterval(idleSummarizerTimer);
      await channels.stop();
      await remoteServing.stop();
      await ollamaEmulation.stop();
      await closePairedRemoteFetches(remotes);
      if (previewServer) {
        await new Promise<void>((resolve) => {
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
        });
      }
      await chat.drainBackground();
      // Shut providers down while the service backchannel is still alive.
      await chat.shutdown().catch(() => {});
      // Initiate graceful close, but don't block forever waiting for
      // SSE streams to wind down. Active streams hold the server open
      // until each handler's keepalive loop notices the disconnect —
      // under load (full test suite with 150+ files) the cumulative
      // settle time can exceed Vitest's `afterAll` hook budget. Force
      // the issue: tell active HTTP/1 connections to close, destroy
      // any active HTTP/2 sessions, and cap the wait.
      await new Promise<void>((resolve) => {
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
      });
      // Kill all persistent terminal shells. Without this, the bash
      // (or PowerShell) children spawned by the per-thread pool stay
      // resident past the daemon's exit until their idle timers
      // fire — same orphan pattern as the chat MlxProvider above.
      await terminals.shutdown().catch(() => {});
      await renderer.stop();
      await runtimeLock.release();
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
}): Promise<void> {
  const isSystemScope = process.env.GEZEL_SYSTEM_SCOPE === '1';
  const discoveryMode = isSystemScope ? 0o644 : 0o600;
  // Do not rely on the service manager's umask for discovery metadata.
  // Machine-wide daemons run with umask 0077 so all non-runtime state stays
  // private, while desktop clients still need these two files to adopt the
  // loopback service. Per-user daemons keep them owner-only.
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
  // This is the first-party client credential, never the daemon root
  // credential. Per-user installs lock it to 0600. System-scope installs
  // use 0644 on POSIX because desktop clients run as a different account;
  // the service itself is deliberately unprivileged in that mode.
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
