import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { type HealthResponse, type ServiceRole, pickRandomNameWithGender } from '@bendyline/gezel';
import {
  GezelSdkError,
  type LocalAuthorizedConnection,
  type LocalDaemonOptions,
  authorizeLocal,
  authorizeLocalOwner,
} from '@bendyline/gezel-app-sdk';
import {
  GezelApiError,
  GezelClient,
  createTrustingFetch,
  discoverOrSpawn,
  electronNativeBinCandidates,
  isProcessAlive,
  readRuntime,
  readSystemServiceEndpoint,
  resolveDaemonEntry,
  stopOwnedDaemon,
  systemSharedAssetsDir,
} from '@bendyline/gezel-client/node';
import { gezelPaths } from '@bendyline/gezel/paths';

/** Global flags shared across commands (defined on the root program). */
export interface CliGlobals {
  /** Connect to a Gezel service at this URL using an approved CLI grant. */
  connect?: string;
  /** Bearer token for `--connect` (skips the grant prompt). */
  token?: string;
  /** Gezel home dir override (else $GEZEL_HOME / ~/.gezel). */
  home?: string;
  /** A folder to ensure as the command project, or `true` for the cwd. */
  project?: string | boolean;
  /** Skip legacy full-product system-service compatibility and use the per-user daemon. */
  standalone?: boolean;
}

/** A user-facing CLI failure — printed without a stack trace. */
export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliError';
  }
}

/** Apply `--home` to the env so gezelHome()/readRuntime()/startService see it. */
export function applyHome(globals: CliGlobals): void {
  if (globals.home) process.env.GEZEL_HOME = resolve(globals.home);
  // A standalone CLI may read immutable, service-published model bundles,
  // but still writes downloads/caches only beneath its own GEZEL_HOME.
  if (!process.env.GEZEL_SHARED_ASSETS_DIR) {
    const sharedAssets = systemSharedAssetsDir();
    if (sharedAssets) process.env.GEZEL_SHARED_ASSETS_DIR = sharedAssets;
  }
}

/** Reject global flag combinations before any command performs work. */
export function validateGlobals(globals: CliGlobals): void {
  if (globals.connect && globals.standalone) {
    throw new CliError('--connect and --standalone cannot be used together.');
  }
  if (globals.token && !globals.connect) {
    throw new CliError('--token requires --connect <url>.');
  }
  if (globals.connect) normalizeServiceUrl(globals.connect);
}

/** Normalize and validate a service URL used by `--connect`. */
export function normalizeServiceUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CliError(`Invalid --connect URL: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new CliError('--connect must use an http:// or https:// URL.');
  }
  if (url.username || url.password) {
    throw new CliError('--connect must not contain credentials; use --token instead.');
  }
  if (url.search || url.hash) {
    throw new CliError('--connect must not contain a query string or fragment.');
  }
  return url.toString().replace(/\/+$/, '');
}

/**
 * Resolve the Gezel home for the interactive TUI, honoring developer mode.
 *
 * Precedence (highest first): `--home` → `$GEZEL_HOME` → dev default
 * (`~/.gezel-dev` when `GEZEL_DEV=1`, set by the monorepo `pnpm cli`/`dev`
 * scripts that run the CLI from source) → packaged default (`~/.gezel`,
 * left to `gezelHome()`). This mirrors the app's `!app.isPackaged →
 * .gezel-dev` split (packages/app/src/main.ts) without an Electron dep.
 *
 * Must run before the app SDK resolves/spawns a daemon so runtime discovery
 * and any in-proc `startService` fallback use the same home.
 */
export function resolveDevHome(globals: CliGlobals): void {
  applyHome(globals);
  if (process.env.GEZEL_HOME) return; // explicit --home or env wins
  if (process.env.GEZEL_DEV === '1') {
    process.env.GEZEL_HOME = join(homedir(), '.gezel-dev');
  }
}

/**
 * Connection for management commands (agent/env/task): use an explicitly
 * approved service when configured, otherwise a legacy full-product system
 * service, otherwise connect as a first-party same-user owner through the app
 * SDK. The SDK owns dynamic-port discovery, pinned TLS, and a safe optional
 * user-daemon spawn. A machine-engine system service is
 * compute-only and is discovered by the user daemon, never used directly as
 * the CLI's product API.
 */
export async function connectOwned(globals: CliGlobals): Promise<GezelClient> {
  applyHome(globals);
  const preferred = await connectPreferredService(globals);
  if (preferred) return preferred.client;
  const runtime = await readRuntime();
  if (!runtime || !isProcessAlive(runtime.pid)) {
    await prepareStandaloneAssets();
  }
  const authorized = await authorizeLocalOwner({
    daemon: {
      daemonEntry: resolveDaemonEntry(import.meta.url),
      spawnIfMissing: true,
      timeoutMs: 20_000,
      preferCanonicalPort: await shouldPreferCanonicalPort(),
      ...(process.env.GEZEL_HOME ? { home: process.env.GEZEL_HOME } : {}),
    },
  });
  const connected = await connectionFromAuthorization(
    authorized,
    'The local Gezel owner authorization',
  );
  return connected.client;
}

export type TuiConnection = {
  client: GezelClient;
  /** Present only when this TUI launched the daemon it is using. */
  stop?: () => Promise<void>;
};

/**
 * Connect the interactive CLI while retaining ownership of a daemon that it
 * had to launch. Unlike short management commands, the TUI has a real host
 * lifetime: an attached stdin pipe lets gezeld run its full shutdown sequence
 * when the TUI exits, receives Ctrl+C, or crashes. An already-running local,
 * configured, or legacy system daemon remains caller-external and is never
 * stopped here.
 */
export async function connectForTui(globals: CliGlobals): Promise<TuiConnection> {
  applyHome(globals);
  const preferred = await connectPreferredService(globals);
  if (preferred) return { client: preferred.client };

  const runtime = await readRuntime();
  if (!runtime || !isProcessAlive(runtime.pid)) {
    await prepareStandaloneAssets();
  }

  const result = await discoverOrSpawn({
    daemonEntry: resolveDaemonEntry(import.meta.url),
    detached: false,
    stdio: 'pipe',
    env: cliUserDaemonEnv(process.env.GEZEL_HOME, await shouldPreferCanonicalPort()),
    ...(process.env.GEZEL_HOME ? { home: process.env.GEZEL_HOME } : {}),
    timeoutMs: 20_000,
  });

  // stdout/stderr are piped only so stdin can remain a dedicated ownership
  // channel. Drain them to prevent a chatty daemon from filling the pipe and
  // blocking while the TUI owns the terminal display.
  result.child?.stdout?.resume();
  result.child?.stderr?.resume();

  if (result.outcome !== 'spawned') return { client: result.client };

  let stopPromise: Promise<void> | undefined;
  return {
    client: result.client,
    stop: () => {
      stopPromise ??= stopOwnedDaemon(result.child);
      return stopPromise;
    },
  };
}

/** Sanitize inherited service-host variables for a CLI-owned user daemon. */
export function cliUserDaemonEnv(
  home: string | undefined,
  preferCanonicalPort: boolean,
  inherited: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const {
    GEZEL_PORT: _inheritedPort,
    GEZEL_SERVICE_ROLE: _inheritedRole,
    GEZEL_SYSTEM_SCOPE: _inheritedSystemScope,
    ...rest
  } = inherited;
  return {
    ...rest,
    ...(home ? { GEZEL_HOME: home } : {}),
    ...(preferCanonicalPort ? {} : { GEZEL_PORT: '0' }),
    GEZEL_SERVICE_ROLE: 'user',
  };
}

/**
 * Whether a CLI-spawned user daemon should try to claim the canonical port
 * 6228 (with ephemeral fallback). True only when this host has no registered
 * machine service — the installers pin the broker to exactly 6228, so a
 * per-user daemon must never race it (note: even a stopped-but-installed
 * service keeps its runtime files, which reads as "present" here — the
 * conservative answer). Dev-scoped launches (`GEZEL_HOME`, `GEZEL_DEV`)
 * always stay ephemeral so a scratch home can't squat the real port.
 */
export async function shouldPreferCanonicalPort(): Promise<boolean> {
  if (process.env.GEZEL_HOME || process.env.GEZEL_DEV === '1') return false;
  try {
    return (await readSystemServiceEndpoint()) === null;
  } catch {
    return false;
  }
}

/**
 * GEZEL_PORT value for a CLI-spawned daemon, or undefined to omit the
 * variable entirely. Explicit `--port` hard-binds (fail on collision);
 * `'0'` pins an ephemeral port; omitted → gezeld's canonical-port
 * preference (6228 with ephemeral fallback) — the stable third-party
 * `/v1` base URL on installs without a machine service.
 */
export function resolveStartPortEnv(
  portFlag: number | undefined,
  preferCanonical: boolean,
): string | undefined {
  if (portFlag !== undefined) return String(portFlag);
  return preferCanonical ? undefined : '0';
}

export type RunConnection = {
  kind: 'owned';
  client: GezelClient;
  baseUrl: string;
  stop?: () => Promise<void>;
};

/**
 * Connection for `gezel run`:
 *   - `--connect <url>` → explicitly authorized full CLI connection.
 *   - else use a healthy legacy full-product machine service when available.
 *   - else authorize against a running user-local daemon through the app SDK,
 *   - else start the service in-process for this single turn (`/api`),
 *     returning a `stop` to tear it down — a self-cleaning one-shot.
 *
 * Only an absent/dead user daemon permits the in-process fallback. A live but
 * unhealthy daemon, denied grant, expired grant, or other authorization error
 * remains loud; none of those conditions may silently bypass consent or open
 * a second writer against the same home.
 */
export async function connectForRun(globals: CliGlobals): Promise<RunConnection> {
  applyHome(globals);
  const preferred = await connectPreferredService(globals);
  if (preferred) return { kind: 'owned', ...preferred };

  // Ask the SDK to discover + authorize the ordinary local product daemon.
  // Discovery-only mode never starts one: a missing/dead daemon is the one
  // condition where `run` intentionally owns an ephemeral in-proc fallback.
  try {
    const connected = await requestCliGrant({
      storageKey: localTokenStorageKey(),
      daemon: {
        spawnIfMissing: false,
        ...(process.env.GEZEL_HOME ? { home: process.env.GEZEL_HOME } : {}),
      },
    });
    const authorized = await connectionFromAuthorization(
      connected,
      'The approved Gezel CLI authorization',
    );
    return { kind: 'owned', ...authorized };
  } catch (error) {
    if (!(error instanceof GezelSdkError) || error.code !== 'daemon_not_running') {
      throw cliGrantError(error, 'the local Gezel daemon');
    }

    // `authorizeLocal` reports an unreachable runtime as not running. Check
    // PID liveness before accepting that as absence: a live process that has
    // stopped answering must fail loudly instead of racing a second writer.
    const runtime = await readRuntime();
    if (runtime && isProcessAlive(runtime.pid)) {
      throw new CliError(
        `The local Gezel daemon (pid ${runtime.pid}) is running but did not answer at ${runtime.baseUrl}. Stop or repair it before retrying.`,
      );
    }
  }
  await prepareStandaloneAssets();

  // Nothing running → start the service in-process for this single turn, on
  // an ephemeral port. Skip the heavy system bootstrap (Chromium/Playwright)
  // — irrelevant to a chat one-shot. We DO write the runtime files (the
  // spawned MCP tool-bridge children read cert + token + port from disk to
  // call back), then clean them up after `stop()` — see below.
  if (process.env.GEZEL_SKIP_SYSTEM_BOOTSTRAP === undefined) {
    process.env.GEZEL_SKIP_SYSTEM_BOOTSTRAP = '1';
  }
  const { startService } = await import('@bendyline/gezel-service');
  const svc = await startService({ port: 0, role: 'user' });
  const scheme = svc.cert ? 'https' : 'http';
  const baseUrl = `${scheme}://127.0.0.1:${svc.port}`;
  const client = new GezelClient({
    baseUrl,
    // Use the same scoped first-party credential written to runtime. The
    // process-local daemon root is an implementation credential, not a
    // client connection token.
    token: svc.clientToken,
    ...(svc.cert ? { fetch: createTrustingFetch({ cert: svc.cert.certPem }) } : {}),
  });
  let stopPromise: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopPromise ??= (async () => {
      await svc.stop();
      // Remove the runtime files this one-shot wrote — but only if they're
      // still ours (pid === this process), so we never clobber a real daemon
      // that happened to start during the run. (We only reach in-proc because
      // adopt found nothing live, so the common case is ours to clean.)
      try {
        const paths = gezelPaths();
        const pid = (await readFile(paths.runtime.pid, 'utf8')).trim();
        if (pid === String(process.pid)) {
          await rm(paths.runtime.dir, { recursive: true, force: true });
        }
      } catch {
        /* nothing to clean up */
      }
    })();
    return stopPromise;
  };
  return { kind: 'owned', client, baseUrl, stop };
}

const CLI_APP_ID_PREFIX = 'gezel-cli';
const CLI_APPROVAL_TIMEOUT_SEC = 300;

export interface HealthySystemService {
  baseUrl: string;
  fetch: typeof fetch;
  port: number;
  home: string;
}

interface SystemServiceDiscoveryDeps {
  readEndpoint?: typeof readSystemServiceEndpoint;
  probeHealth?: (input: {
    endpoint: NonNullable<Awaited<ReturnType<typeof readSystemServiceEndpoint>>>;
    fetch: typeof fetch;
    signal: AbortSignal;
  }) => Promise<HealthResponse>;
}

/**
 * Only pre-split services are product endpoints. Missing role is deliberately
 * legacy-full compatibility for releases that predate role publication.
 */
export function isSystemProductServiceRole(role: ServiceRole | undefined): boolean {
  return role === undefined || role === 'legacy-full';
}

/**
 * Explicit connection/home choices always win over system-service discovery.
 * An explicit home is necessarily standalone: a machine service owns its home
 * and cannot be retargeted by a client flag.
 */
export function shouldTrySystemService(
  globals: CliGlobals,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    !globals.connect &&
    !globals.standalone &&
    !globals.home &&
    !env.GEZEL_HOME &&
    env.GEZEL_DEV !== '1'
  );
}

/** Find and health-check the Electron-installed machine service. */
export async function findHealthySystemService(
  globals: CliGlobals,
  deps: SystemServiceDiscoveryDeps = {},
): Promise<HealthySystemService | null> {
  if (!shouldTrySystemService(globals)) return null;
  const endpoint = await (deps.readEndpoint ?? readSystemServiceEndpoint)();
  if (!endpoint) return null;
  const fetchImpl = endpoint.cert ? createTrustingFetch({ cert: endpoint.cert }) : globalThis.fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1_500);
  timeout.unref?.();
  try {
    const health = deps.probeHealth
      ? await deps.probeHealth({ endpoint, fetch: fetchImpl, signal: controller.signal })
      : await new GezelClient({
          baseUrl: endpoint.baseUrl,
          token: '',
          fetch: fetchImpl,
        }).health(controller.signal);
    // The fixed system port now normally hosts the engine boundary. Falling
    // through makes connectOwned/connectForRun adopt or spawn ~/.gezel's
    // dynamic per-user daemon, which then brokers native work to this engine.
    if (!isSystemProductServiceRole(health.serviceRole)) return null;
    return {
      baseUrl: endpoint.baseUrl,
      fetch: fetchImpl,
      port: endpoint.port,
      home: endpoint.home,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export interface MachineEngineBrokerStatus {
  present: boolean;
  healthy?: boolean;
  baseUrl?: string;
  port?: number;
  serviceRole?: ServiceRole;
  version?: string;
  startedAt?: string;
}

/**
 * Reporting-only view of the machine service for `gezel doctor`/`status`.
 * Deliberately separate from {@link findHealthySystemService}, whose
 * legacy-full filter is correct for CONNECTION selection but reads a
 * healthy post-split broker as "unavailable" — the exact blind spot this
 * fixes. Never used to pick a connection target.
 */
export async function describeMachineEngineBroker(
  deps: SystemServiceDiscoveryDeps = {},
): Promise<MachineEngineBrokerStatus> {
  let endpoint: Awaited<ReturnType<typeof readSystemServiceEndpoint>> = null;
  try {
    endpoint = await (deps.readEndpoint ?? readSystemServiceEndpoint)();
  } catch {
    endpoint = null;
  }
  if (!endpoint) return { present: false };
  const fetchImpl = endpoint.cert ? createTrustingFetch({ cert: endpoint.cert }) : globalThis.fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1_500);
  timeout.unref?.();
  try {
    const health = deps.probeHealth
      ? await deps.probeHealth({ endpoint, fetch: fetchImpl, signal: controller.signal })
      : await new GezelClient({
          baseUrl: endpoint.baseUrl,
          token: '',
          fetch: fetchImpl,
        }).health(controller.signal);
    return {
      present: true,
      healthy: true,
      baseUrl: endpoint.baseUrl,
      port: endpoint.port,
      ...(health.serviceRole !== undefined ? { serviceRole: health.serviceRole } : {}),
      version: health.version,
      ...(health.startedAt !== undefined ? { startedAt: health.startedAt } : {}),
    };
  } catch {
    return { present: true, healthy: false, baseUrl: endpoint.baseUrl, port: endpoint.port };
  } finally {
    clearTimeout(timeout);
  }
}

async function connectPreferredService(
  globals: CliGlobals,
): Promise<{ client: GezelClient; baseUrl: string } | null> {
  validateGlobals(globals);

  if (globals.connect) {
    const baseUrl = normalizeServiceUrl(globals.connect);
    return connectWithCliGrant({
      baseUrl,
      fetch: globalThis.fetch,
      // Preserve the historical per-origin key for existing remote grants.
      storageKey: baseUrl,
      ...(globals.token ? { token: globals.token } : {}),
    });
  }

  const system = await findHealthySystemService(globals);
  if (!system) return null;
  return connectWithCliGrant({
    baseUrl: system.baseUrl,
    fetch: system.fetch,
    storageKey: system.baseUrl,
  });
}

/**
 * A local fallback may borrow the Electron install's native tree, but only
 * after the service package has checked every loadable file against the
 * source-pinned release manifest and platform signature policy.
 */
async function prepareStandaloneAssets(): Promise<void> {
  // Mock mode replaces every local inference provider and is explicitly used
  // by tests/CI to avoid native-engine work. Scanning an installed Electron
  // payload here is therefore both unnecessary and harmful: signature checks
  // can consume most of the daemon-start budget and may write warnings to an
  // otherwise clean CLI stderr stream.
  if (process.env.GEZEL_MOCK_PROVIDER === '1' || process.env.GEZEL_NATIVE_BIN_DIR) return;
  const candidates = electronNativeBinCandidates();
  if (candidates.length === 0) return;
  const { reuseVerifiedElectronNativeBinaries } = await import('@bendyline/gezel-service');
  await reuseVerifiedElectronNativeBinaries({ candidates });
}

interface CliGrantInput {
  storageKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  token?: string;
  daemon?: LocalDaemonOptions;
}

async function connectWithCliGrant(
  input: CliGrantInput,
): Promise<{ client: GezelClient; baseUrl: string }> {
  if (input.token) {
    if (!input.baseUrl) throw new CliError('--token requires an explicit service URL.');
    const client = buildCliClient(input.baseUrl, input.token, input.fetch ?? globalThis.fetch);
    await validateCliClient(client, 'The supplied --token');
    return { client, baseUrl: input.baseUrl };
  }

  try {
    const authorized = await requestCliGrant(input);
    return await connectionFromAuthorization(authorized, 'The approved Gezel CLI authorization');
  } catch (error) {
    throw cliGrantError(error, input.baseUrl ?? 'the local Gezel daemon');
  }
}

/**
 * The app SDK is the CLI's connection waist: it discovers the current local
 * origin, pins loopback TLS, validates/replaces saved scoped grants, and owns
 * the consent handshake. It never returns the daemon runtime credential.
 */
async function requestCliGrant(input: CliGrantInput): Promise<LocalAuthorizedConnection> {
  const appId = await resolveCliAppId();
  return authorizeLocal({
    appId,
    appName: 'Gezel CLI',
    scopes: ['cli'],
    ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
    ...(input.fetch ? { fetch: input.fetch } : {}),
    ...(input.daemon ? { daemon: input.daemon } : {}),
    approvalTimeoutSec: CLI_APPROVAL_TIMEOUT_SEC,
    tokenStorage: fileTokenStorage(input.storageKey),
    onVerificationCode: (code) => {
      console.error(
        `Connecting Gezel CLI.\nOpen the Gezel app and enter code ${code} to approve this connection. Waiting for approval…`,
      );
    },
  });
}

async function connectionFromAuthorization(
  authorized: LocalAuthorizedConnection,
  label: string,
): Promise<{ client: GezelClient; baseUrl: string }> {
  const client = clientFromAuthorization(authorized);
  await validateCliClient(client, label);
  return { client, baseUrl: authorized.baseUrl };
}

function clientFromAuthorization(authorized: LocalAuthorizedConnection): GezelClient {
  return buildCliClient(authorized.baseUrl, authorized.token, authorized.fetch);
}

function cliGrantError(error: unknown, target: string): CliError {
  if (error instanceof CliError) return error;
  if (error instanceof GezelSdkError) {
    if (error.code === 'already_connected') {
      return new CliError(
        'Gezel already has a CLI authorization, but this terminal no longer has its token. Revoke “Gezel CLI” in Settings → Connected Apps, then run this command again.',
      );
    }
    if (error.code === 'user_denied') {
      return new CliError('Gezel CLI access was denied in the Gezel app.');
    }
    if (error.code === 'approval_timeout') {
      return new CliError(
        `Timed out after ${CLI_APPROVAL_TIMEOUT_SEC / 60} minutes waiting for Gezel CLI approval.`,
      );
    }
    if (error.code === 'grant_expired') {
      return new CliError(
        'The Gezel CLI approval request expired. Run the command again to get a new code.',
      );
    }
    if (error.code === 'daemon_not_running') {
      return new CliError(
        'No local Gezel daemon is running. Start the Gezel app or run `gezel start`, then try again.',
      );
    }
  }
  return new CliError(
    `Could not authorize Gezel CLI against ${target}: ${error instanceof Error ? error.message : String(error)}`,
  );
}

/**
 * Return a stable, non-identifying app id for this CLI installation. A unique
 * id lets each OS user and remote machine receive its own revocable grant.
 */
export async function resolveCliAppId(): Promise<string> {
  const dir = join(gezelPaths().root, 'cli');
  const file = join(dir, 'client-id');
  const readId = async (): Promise<string | null> => {
    try {
      const id = (await readFile(file, 'utf8')).trim();
      return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
        ? id.toLowerCase()
        : null;
    } catch {
      return null;
    }
  };

  const existing = await readId();
  if (existing) return `${CLI_APP_ID_PREFIX}.${existing}`;

  const created = randomUUID();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    await writeFile(file, `${created}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
  } catch (error) {
    const raced = await readId();
    if (raced) return `${CLI_APP_ID_PREFIX}.${raced}`;
    throw error;
  }
  await chmod(file, 0o600).catch(() => {});
  return `${CLI_APP_ID_PREFIX}.${created}`;
}

function buildCliClient(baseUrl: string, token: string, fetchImpl: typeof fetch): GezelClient {
  return new GezelClient({ baseUrl, token, fetch: fetchImpl });
}

async function validateCliClient(client: GezelClient, label: string): Promise<void> {
  try {
    await client.getConfig();
  } catch (error) {
    if (error instanceof GezelApiError && (error.status === 401 || error.status === 403)) {
      throw new CliError(
        `${label} does not have CLI access. Revoke “Gezel CLI” in Settings → Connected Apps and authorize it again.`,
      );
    }
    throw error;
  }
}

/**
 * Persist scoped grant tokens under `<home>/cli/tokens/<target>.json`.
 *
 * The local target deliberately uses a logical key rather than its base URL:
 * a per-user daemon gets a new dynamic port and certificate on restart, while
 * its durable app grant remains valid. Explicit remote/legacy targets key by
 * their configured origin.
 */
export function fileTokenStorage(storageKey: string): {
  load(appId: string): Promise<string | null>;
  save(appId: string, token: string): Promise<void>;
  delete(appId: string): Promise<void>;
} {
  const targetKey = createHash('sha256').update(storageKey).digest('hex');
  const file = join(gezelPaths().root, 'cli', 'tokens', `${targetKey}.json`);
  const read = async (): Promise<Record<string, string>> => {
    try {
      return JSON.parse(await readFile(file, 'utf8')) as Record<string, string>;
    } catch {
      return {};
    }
  };
  const deleteToken = async (appId: string): Promise<void> => {
    const data = await read();
    delete data[appId];
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, `${JSON.stringify(data, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await chmod(file, 0o600).catch(() => {});
  };
  return {
    async load(appId) {
      return (await read())[appId] ?? null;
    },
    async save(appId, token) {
      const data = await read();
      data[appId] = token;
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      await writeFile(file, `${JSON.stringify(data, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      await chmod(file, 0o600).catch(() => {});
    },
    delete: deleteToken,
  };
}

/** Stable across the per-user daemon's dynamic port and certificate rotation. */
function localTokenStorageKey(): string {
  return 'local-user-daemon';
}

/**
 * Ensure a project bound to `folderPath` exists; return its id. Mirrors the
 * VS Code extension's `ensureProjectForWorkspace`: exact `workingDir` match
 * → adopt an orphan project by name → else create + bind.
 */
export async function ensureProjectForFolder(
  client: GezelClient,
  folderPath: string,
): Promise<string> {
  const wd = resolve(folderPath);
  const eq = (a: string | undefined, b: string): boolean =>
    !!a && (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

  const { projects } = await client.listProjects();
  const exact = projects.find((p) => eq(p.workingDir, wd));
  if (exact) return exact.id;

  const name = basename(wd) || 'workspace';
  const orphan = projects.find((p) => !p.workingDir && p.name === name);
  if (orphan) {
    await client.setProjectWorkingDir(orphan.id, wd);
    return orphan.id;
  }

  const created = await client.createProject({
    name,
    description: `CLI workspace at ${wd}`,
    about: `${name} — working directory ${wd}. Fill in who this project is for, what's in scope, and what's explicitly out of scope.`,
    missionObjectives: `${name} — fill in concrete success criteria for this project.`,
    mode: 'solo',
    workingDir: wd,
  });
  return created.id;
}

/**
 * Resolve (and, for an old/incomplete project record, repair) the lead the
 * CLI should open on. The terminal is a project workspace, so its front door
 * is the project's lead rather than the install-wide Meester.
 *
 * New folder projects already get a Builder synchronously in the service. The
 * recovery path here covers older projects and interrupted first-time setup
 * without ever falling back to the Meester and silently regaining the
 * cross-project `start_project` surface.
 */
export async function ensureCliProjectLead(
  client: GezelClient,
  projectId: string,
): Promise<string> {
  const project = await client.getProject(projectId);
  if (project.voormanGezelId) return project.voormanGezelId;

  // Solo projects intentionally have no separate voorman: their one gezel is
  // the lead. This also keeps an explicit `/project` switch to a game/chat
  // project from recruiting a confusing second character.
  if (project.mode === 'solo') {
    if (project.gezelIds?.[0]) return project.gezelIds[0];

    // Folder projects created by older/partially-upgraded services may be solo
    // without their Builder. Repair that state here so CLI boot still lands on
    // a working lead instead of falling through to Voorman recruitment.
    if (project.workingDir) {
      const { gezels } = await client.listGezels();
      let builder = gezels.find(
        (gezel) => gezel.templateId === 'builder' || gezel.role?.trim().toLowerCase() === 'builder',
      );
      if (!builder) {
        const { name, gender } = pickRandomNameWithGender();
        builder = await client.createGezelFromTemplate('builder', { name, gender });
      }
      const updated = await client.updateProject(projectId, { voormanGezelId: builder.id });
      if (!updated.voormanGezelId) {
        throw new CliError(`project "${updated.name}" has no Builder`);
      }
      return updated.voormanGezelId;
    }
  }

  const { gezels } = await client.listGezels();
  let voorman = gezels.find(
    (gezel) => gezel.templateId === 'voorman' || gezel.role?.trim().toLowerCase() === 'voorman',
  );
  if (!voorman) {
    const { name, gender } = pickRandomNameWithGender();
    voorman = await client.createGezelFromTemplate('voorman', { name, gender });
  }
  const updated = await client.updateProject(projectId, { voormanGezelId: voorman.id });
  if (!updated.voormanGezelId) {
    throw new CliError(`project "${updated.name}" has no voorman`);
  }
  return updated.voormanGezelId;
}

/** Resolve the command project: the current directory unless explicitly overridden. */
export async function resolveRunProject(client: GezelClient, globals: CliGlobals): Promise<string> {
  const p = globals.project;
  const folder = p === undefined || p === true || p === false ? process.cwd() : p;
  return ensureProjectForFolder(client, folder);
}

/**
 * Resolve the project id for the interactive TUI. Unlike `run` (which falls
 * back to the shared `default` project), the TUI is folder-centric: when
 * `--project` is omitted entirely it ensures a project for the *current
 * working directory*. An explicit `--project <folder>` (or bare flag = cwd)
 * is honored as-is.
 */
export async function resolveTuiProject(client: GezelClient, globals: CliGlobals): Promise<string> {
  const p = globals.project;
  const folder = p === undefined || p === true || p === false ? process.cwd() : p;
  return ensureProjectForFolder(client, folder);
}
