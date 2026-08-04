import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { HealthResponse, ServiceRole } from '@bendyline/gezel';
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
  electronNativeBinCandidates,
  isProcessAlive,
  readRuntime,
  readSystemServiceEndpoint,
  resolveDaemonEntry,
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
  /** For `run`: a folder to ensure as the project, or `true` for the cwd. */
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
      ...(process.env.GEZEL_HOME ? { home: process.env.GEZEL_HOME } : {}),
    },
  });
  const connected = await connectionFromAuthorization(
    authorized,
    'The local Gezel owner authorization',
  );
  return connected.client;
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
  const stop = async (): Promise<void> => {
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
  if (process.env.GEZEL_NATIVE_BIN_DIR) return;
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
  });
  await client.setProjectWorkingDir(created.id, wd);
  return created.id;
}

/** Resolve the project id for a `run`: `--project` folder/cwd ensured, else `default`. */
export async function resolveRunProject(client: GezelClient, globals: CliGlobals): Promise<string> {
  const p = globals.project;
  if (p === undefined || p === false) return 'default';
  const folder = p === true ? process.cwd() : p;
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
