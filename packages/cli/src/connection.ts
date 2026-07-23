import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { GezelApp } from '@bendyline/gezel-app-sdk';
import {
  GezelClient,
  createTrustingFetch,
  isProcessAlive,
  readRuntime,
} from '@bendyline/gezel-client/node';
import { gezelPaths } from '@bendyline/gezel/paths';
import { ensureDaemon } from './spawn-daemon.js';

/** Global flags shared across commands (defined on the root program). */
export interface CliGlobals {
  /** Connect to a foreign daemon at this URL as a scoped guest. */
  connect?: string;
  /** Bearer token for `--connect` (skips the grant prompt). */
  token?: string;
  /** Gezel home dir override (else $GEZEL_HOME / ~/.gezel). */
  home?: string;
  /** For `run`: a folder to ensure as the project, or `true` for the cwd. */
  project?: string | boolean;
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
 * Must run before `ensureDaemon()` so the daemon spawn env, `readRuntime`,
 * and any in-proc `startService` all resolve the same home.
 */
export function resolveDevHome(globals: CliGlobals): void {
  applyHome(globals);
  if (process.env.GEZEL_HOME) return; // explicit --home or env wins
  if (process.env.GEZEL_DEV === '1') {
    process.env.GEZEL_HOME = join(homedir(), '.gezel-dev');
  }
}

/**
 * Connection for management commands (agent/env/task): requires a daemon
 * you OWN — full `/api` via the root token. Refuses `--connect`, which is a
 * scoped guest connection that can't drive the control plane.
 */
export async function connectOwned(globals: CliGlobals): Promise<GezelClient> {
  if (globals.connect) {
    throw new CliError(
      `This command manages a daemon and isn't available over --connect (a scoped guest connection to ${globals.connect}). Run it on the host that owns the daemon, or drop --connect.`,
    );
  }
  applyHome(globals);
  return ensureDaemon();
}

export type RunConnection =
  | { kind: 'owned'; client: GezelClient; baseUrl: string; stop?: () => Promise<void> }
  | { kind: 'guest'; app: GezelApp; baseUrl: string };

/**
 * Connection for `gezel run`:
 *   - `--connect <url>` → scoped guest via the app-sdk grant flow (`/v1`).
 *   - else adopt a running local daemon (root `/api`),
 *   - else start the service in-process for this single turn (root `/api`),
 *     returning a `stop` to tear it down — a self-cleaning one-shot.
 */
export async function connectForRun(globals: CliGlobals): Promise<RunConnection> {
  applyHome(globals);

  if (globals.connect) {
    const { connect } = await import('@bendyline/gezel-app-sdk');
    const baseUrl = globals.connect;
    const app = await connect({
      appId: 'gezel-cli',
      appName: 'Gezel CLI',
      scopes: ['openai'],
      baseUrl,
      ...(globals.token ? { existingToken: globals.token } : {}),
      tokenStorage: fileTokenStorage(baseUrl),
      approvalTimeoutSec: 120,
    });
    return { kind: 'guest', app, baseUrl };
  }

  // Owned: adopt a live local daemon if one's running.
  const runtime = await readRuntime();
  if (runtime && isProcessAlive(runtime.pid)) {
    const client = new GezelClient({
      baseUrl: runtime.baseUrl,
      token: runtime.token,
      ...(runtime.cert ? { fetch: createTrustingFetch({ cert: runtime.cert }) } : {}),
    });
    return { kind: 'owned', client, baseUrl: runtime.baseUrl };
  }

  // Nothing running → start the service in-process for this single turn, on
  // an ephemeral port. Skip the heavy system bootstrap (Chromium/Playwright)
  // — irrelevant to a chat one-shot. We DO write the runtime files (the
  // spawned MCP tool-bridge children read cert + token + port from disk to
  // call back), then clean them up after `stop()` — see below.
  if (process.env.GEZEL_SKIP_SYSTEM_BOOTSTRAP === undefined) {
    process.env.GEZEL_SKIP_SYSTEM_BOOTSTRAP = '1';
  }
  const { startService } = await import('@bendyline/gezel-service');
  const svc = await startService({ port: 0 });
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

/** Persist scoped grant tokens under `<home>/cli/tokens/<origin>.json`. */
function fileTokenStorage(baseUrl: string): {
  load(appId: string): Promise<string | null>;
  save(appId: string, token: string): Promise<void>;
} {
  const safe = baseUrl.replace(/[^a-zA-Z0-9]+/g, '_');
  const file = join(gezelPaths().root, 'cli', 'tokens', `${safe}.json`);
  const read = async (): Promise<Record<string, string>> => {
    try {
      return JSON.parse(await readFile(file, 'utf8')) as Record<string, string>;
    } catch {
      return {};
    }
  };
  return {
    async load(appId) {
      return (await read())[appId] ?? null;
    },
    async save(appId, token) {
      const data = await read();
      data[appId] = token;
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    },
  };
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
