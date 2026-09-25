import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { GezelSdkError } from './errors.js';
import type { HostOptions } from './host-types.js';

/**
 * App ids become a directory name, so they are held to the same grammar the
 * consent flow uses for them: lowercase, dots, dashes, underscores.
 */
const APP_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * Where an app's hosted daemon keeps its state.
 *
 * Under the user's Gezel home but in a subtree of its own, so the two never
 * contend for the same runtime files and the user's own workshop never shows
 * projects an app created for itself.
 */
export function hostedGezelHome(appId: string, env: NodeJS.ProcessEnv = process.env): string {
  assertAppId(appId);
  const root = env.GEZEL_HOME?.trim() || join(homedir(), '.gezel');
  return join(root, 'apps', appId);
}

export function assertAppId(appId: string): void {
  if (!APP_ID_RE.test(appId)) {
    throw new GezelSdkError(
      `"${appId}" is not a usable app id: use lowercase letters, digits, dots, dashes or underscores`,
      { code: 'invalid_app_id' },
    );
  }
}

/**
 * The Node a Gezel install keeps for its own daemon, `<Gezel home>/bin/node`,
 * when there is one. Resolved against the user's Gezel home — never an app's
 * hosted home — so callers must pass the environment before `GEZEL_HOME` is
 * repointed.
 */
export function gezelManagedNodePath(
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
): string | null {
  const root = env.GEZEL_HOME?.trim() || join(homedir(), '.gezel');
  const candidate = join(root, 'bin', process.platform === 'win32' ? 'node.exe' : 'node');
  return exists(candidate) ? candidate : null;
}

/**
 * Resolve the Node binary the daemon's child processes will run.
 *
 * Under Electron `process.execPath` is the app binary, which cannot run a
 * script. An Electron host that ships Node says where it is; on a machine with
 * Gezel installed the Node that Gezel keeps for its own daemon serves instead,
 * so hosting works there without shipping one. Otherwise fail here, with that
 * sentence — it beats a tool surface that silently comes up empty because the
 * MCP child could not start.
 */
export function resolveNodePath(
  opts: HostOptions,
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
): string {
  if (opts.nodePath) return opts.nodePath;
  if (env.GEZEL_NODE_PATH) return env.GEZEL_NODE_PATH;
  if (!process.versions.electron) return process.execPath;
  const managed = gezelManagedNodePath(env, exists);
  if (managed) return managed;
  throw new GezelSdkError(
    'hosting Gezel under Electron needs host.nodePath: an absolute path to a node binary the daemon can run for its tool server and scripts (process.execPath is the Electron app, not node, and no Gezel install provides one here)',
    { code: 'node_binary_required' },
  );
}

export interface HostEnvironment {
  home: string;
  /** Undo the process-wide changes; call when the hosted daemon stops. */
  restore(): void;
}

/**
 * Apply the environment a hosted daemon needs, before the service is imported.
 *
 * The daemon and its subsystems read several of these from `process.env`
 * rather than from `startService` options, so setting them here — and only
 * here — keeps one place to look when a hosted daemon behaves unlike a normal
 * one. Everything is undone by `restore()`.
 */
/**
 * The variables a hosted daemon needs, as data.
 *
 * Kept separate from applying them because the two hosting modes need opposite
 * things: an in-process daemon reads `process.env` of this very process, while
 * a spawned child must be handed its own environment and must NOT have the
 * parent's mutated underneath it. One definition of what the daemon needs,
 * two ways to deliver it.
 *
 * `undefined` means "unset this variable", not "leave it alone".
 */
export function computeHostEnvironment(
  appId: string,
  opts: HostOptions,
  env: NodeJS.ProcessEnv = process.env,
): { home: string; variables: Map<string, string | undefined> } {
  const home = opts.home ?? hostedGezelHome(appId, env);
  // Resolve what we may borrow BEFORE GEZEL_HOME is repointed at the app's
  // own home — otherwise the default "the user's Gezel" resolves to us.
  const borrowed = readOnlyModelHomes(opts, env, home);
  const variables = new Map<string, string | undefined>();

  variables.set('GEZEL_HOME', home);
  variables.set('GEZEL_SERVICE_ROLE', 'user');
  // '0' pins an ephemeral port. Unset, gezeld prefers the canonical 6228 —
  // which belongs to the machine broker on a machine install and is the
  // stable /v1 address the user's own Gezel wants — so a private daemon that
  // happened to start first would squat on it. An inherited port is replaced
  // for the same reason, as `userDaemonEnv` does for SDK-started daemons.
  variables.set('GEZEL_PORT', '0');
  // A system scope inherited from a service host or a developer shell is
  // never right for a daemon this app owns.
  variables.set('GEZEL_SYSTEM_SCOPE', undefined);
  if (!opts.systemBootstrap) variables.set('GEZEL_SKIP_SYSTEM_BOOTSTRAP', '1');
  // A store build must refuse runtime code downloads, and the daemon reads
  // that from the environment. Without this a store-packaged consumer has to
  // set the variable by hand before the SDK is imported.
  if (opts.distributionProfile) {
    variables.set('GEZEL_DISTRIBUTION_PROFILE', opts.distributionProfile);
  }

  const nodePath = resolveNodePath(opts, env);
  variables.set('GEZEL_NODE_PATH', nodePath);
  // The daemon resolves some children by name, so the bundled Node has to be
  // findable on PATH as well as by absolute path.
  const nodeDir = dirname(nodePath);
  if (nodeDir && !(env.PATH ?? '').split(delimiter).includes(nodeDir)) {
    variables.set('PATH', env.PATH ? `${nodeDir}${delimiter}${env.PATH}` : nodeDir);
  }
  if (opts.nativeBinDir) variables.set('GEZEL_NATIVE_BIN_DIR', opts.nativeBinDir);

  if (borrowed.length > 0) variables.set('GEZEL_READONLY_MODEL_HOMES', borrowed.join(delimiter));

  return { home, variables };
}

/**
 * Build the environment for a spawned daemon, without touching this process's.
 */
export function childHostEnvironment(
  appId: string,
  opts: HostOptions,
  env: NodeJS.ProcessEnv = process.env,
): { home: string; env: NodeJS.ProcessEnv } {
  const { home, variables } = computeHostEnvironment(appId, opts, env);
  const childEnv: NodeJS.ProcessEnv = { ...env };
  for (const [key, value] of variables) {
    if (value === undefined) delete childEnv[key];
    else childEnv[key] = value;
  }
  return { home, env: childEnv };
}

/**
 * Apply the environment an in-process daemon needs, before the service is
 * imported.
 *
 * The daemon and its subsystems read several of these from `process.env`
 * rather than from `startService` options, so setting them here — and only
 * here — keeps one place to look when a hosted daemon behaves unlike a normal
 * one. Everything is undone by `restore()`.
 */
export function applyHostEnvironment(
  appId: string,
  opts: HostOptions,
  env: NodeJS.ProcessEnv = process.env,
): HostEnvironment {
  const { home, variables } = computeHostEnvironment(appId, opts, env);
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of variables) {
    if (!previous.has(key)) previous.set(key, env[key]);
    if (value === undefined) delete env[key];
    else env[key] = value;
  }

  return {
    home,
    restore: () => {
      for (const [key, value] of previous) {
        if (value === undefined) delete env[key];
        else env[key] = value;
      }
      previous.clear();
    },
  };
}

/**
 * Homes whose models this daemon may read. The user's own Gezel by default —
 * a 2 GB model they already have should not be downloaded again because an
 * app asked for it.
 */
function readOnlyModelHomes(opts: HostOptions, env: NodeJS.ProcessEnv, ownHome: string): string[] {
  const configured = opts.readOnlyModelHomes ?? [
    env.GEZEL_HOME?.trim() || join(homedir(), '.gezel'),
  ];
  const seen = new Set<string>([resolve(ownHome)]);
  const out: string[] = [];
  for (const entry of configured) {
    if (!entry || !isAbsolute(entry)) continue;
    const resolved = resolve(entry);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    out.push(entry);
  }
  return out;
}
