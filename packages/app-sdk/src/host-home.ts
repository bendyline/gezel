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
  return join(resolve(root), 'apps', appId);
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
 * Resolve the Node binary the daemon's child processes will run.
 *
 * Under Electron `process.execPath` is the app binary, which cannot run a
 * script — so an Electron host must ship a real Node and say where it is.
 * Failing here, with that sentence, beats a tool surface that silently comes
 * up empty because the MCP child could not start.
 */
export function resolveNodePath(opts: HostOptions, env: NodeJS.ProcessEnv = process.env): string {
  if (opts.nodePath) return opts.nodePath;
  if (env.GEZEL_NODE_PATH) return env.GEZEL_NODE_PATH;
  if (!process.versions.electron) return process.execPath;
  throw new GezelSdkError(
    'hosting Gezel under Electron needs host.nodePath: an absolute path to a node binary the daemon can run for its tool server and scripts (process.execPath is the Electron app, not node)',
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
export function applyHostEnvironment(
  appId: string,
  opts: HostOptions,
  env: NodeJS.ProcessEnv = process.env,
): HostEnvironment {
  const home = opts.home ?? hostedGezelHome(appId, env);
  // Resolve what we may borrow BEFORE GEZEL_HOME is repointed at the app's
  // own home — otherwise the default "the user's Gezel" resolves to us.
  const borrowed = readOnlyModelHomes(opts, env, home);
  const previous = new Map<string, string | undefined>();
  const set = (key: string, value: string | undefined): void => {
    if (!previous.has(key)) previous.set(key, env[key]);
    if (value === undefined) delete env[key];
    else env[key] = value;
  };

  set('GEZEL_HOME', home);
  set('GEZEL_SERVICE_ROLE', 'user');
  // A port or system scope inherited from a service host or a developer shell
  // is never right for a daemon this app owns.
  set('GEZEL_PORT', undefined);
  set('GEZEL_SYSTEM_SCOPE', undefined);
  if (!opts.systemBootstrap) set('GEZEL_SKIP_SYSTEM_BOOTSTRAP', '1');

  const nodePath = resolveNodePath(opts, env);
  set('GEZEL_NODE_PATH', nodePath);
  // The daemon resolves some children by name, so the bundled Node has to be
  // findable on PATH as well as by absolute path.
  const nodeDir = dirname(nodePath);
  if (nodeDir && !(env.PATH ?? '').split(delimiter).includes(nodeDir)) {
    set('PATH', env.PATH ? `${nodeDir}${delimiter}${env.PATH}` : nodeDir);
  }
  if (opts.nativeBinDir) set('GEZEL_NATIVE_BIN_DIR', opts.nativeBinDir);

  if (borrowed.length > 0) set('GEZEL_READONLY_MODEL_HOMES', borrowed.join(delimiter));

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
    out.push(resolved);
  }
  return out;
}
