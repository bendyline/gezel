/**
 * Spawns the connectors-spectral `run-action.js` entry in the sandbox with a
 * DISTINCT posture: network ON, workspace OFF, env scrubbed, the connection
 * (with its secret) arriving over stdin. The untrusted Prismatic component gets
 * network but cannot read the corpus or exfiltrate files; the trusted parent
 * (here) normalizes the returned `{ data }`. The service never imports spectral
 * — it only resolves the entry path and spawns it.
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { gezelHome } from '@bendyline/gezel/paths';
import { runInSandbox } from '../../sandbox/runner.js';

const require = createRequire(import.meta.url);

export interface SpectralJob {
  component: string;
  action: string;
  connectionInput: string;
  connection: unknown;
  inputs: Record<string, unknown>;
}

/** Where the runner lives and what the sandbox must let it read. */
export interface SpectralRuntime {
  /** `run-action.js` (vendored slices), real path. */
  entry: string;
  /** `run.js` (published components, runner v2), real path. */
  runEntry: string;
  /** The runner's package plus every folder holding the SDK and its dependencies. */
  readRoots: string[];
}

const MAX_SDK_ROOTS = 4;
let runtimeCache: SpectralRuntime | undefined;

/** `<dir>/<name>/package.json` along Node's lookup paths from `from`, real path. */
function findPackageJson(from: NodeJS.Require, name: string): string | undefined {
  for (const dir of from.resolve.paths(name) ?? []) {
    const candidate = join(dir, name, 'package.json');
    if (existsSync(candidate)) return realpathSync(candidate);
  }
  return undefined;
}

/**
 * The folder to grant for a package: the pnpm store it lives in, or the
 * `node_modules` that holds it in a flat (npm or bundled) install.
 */
function storeRoot(packageDir: string): string {
  const pnpm = `${sep}node_modules${sep}.pnpm${sep}`;
  const at = packageDir.indexOf(pnpm);
  if (at >= 0) return packageDir.slice(0, at + pnpm.length - 1);
  const flat = packageDir.lastIndexOf(`${sep}node_modules${sep}`);
  return flat >= 0 ? packageDir.slice(0, flat + `${sep}node_modules`.length) : packageDir;
}

function contains(root: string, path: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/** The folders in `roots` that no other one contains. */
function outermost(roots: string[]): string[] {
  return [...new Set(roots)]
    .sort((a, b) => a.length - b.length)
    .filter((root, i, all) => !all.slice(0, i).some((outer) => contains(outer, root)));
}

/**
 * What the sandbox grants: the runner's package and the SDK's folders, each
 * once. In a flat install (npm, the shipped bundle) the folder holding the
 * SDK also holds the runner, and it must win: keeping only the runner's
 * package left the SDK unreadable there, while the pnpm layout tests use
 * never noticed.
 */
export function spectralReadRoots(pkgRoot: string, sdkRoots: string[]): string[] {
  return outermost([pkgRoot, ...sdkRoots]);
}

/**
 * Resolve the runner and the read roots its sandbox needs. The runner
 * `require`s `@prismatic-io/spectral`, which never sits inside the runner's
 * own package: pnpm links it from its store, npm and the shipped bundle hoist
 * it beside the package. Granting only the package folder made every
 * Spectral sync fail with ERR_ACCESS_DENIED before it reached the network.
 */
export function resolveSpectralRuntime(): SpectralRuntime {
  if (runtimeCache) return runtimeCache;
  const entry = realpathSync(require.resolve('@bendyline/gezel-connectors-spectral/run-action'));
  const pkgRoot = dirname(dirname(entry));
  const sdk = findPackageJson(createRequire(entry), '@prismatic-io/spectral');
  if (!sdk) throw new Error('The Spectral SDK is not installed beside the connector runner.');

  // Every package the SDK loads, transitively.
  const seen = new Set<string>();
  const queue = [sdk];
  const roots = new Set<string>();
  while (queue.length > 0) {
    const pkgJson = queue.pop()!;
    const dir = dirname(pkgJson);
    if (seen.has(dir)) continue;
    seen.add(dir);
    roots.add(storeRoot(dir));
    const manifest = JSON.parse(readFileSync(pkgJson, 'utf8')) as {
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    const from = createRequire(pkgJson);
    for (const name of Object.keys({
      ...manifest.dependencies,
      ...manifest.optionalDependencies,
    })) {
      const dep = findPackageJson(from, name);
      if (dep) queue.push(dep);
    }
  }

  const kept = outermost([...roots]);
  const forbidden = [homedir(), gezelHome()].map((p) => realpathOr(p));
  for (const root of kept) {
    if (dirname(root) === root || forbidden.some((p) => contains(root, p))) {
      throw new Error(
        `The Spectral SDK resolves to ${root}, which the sandbox will not grant whole. Reinstall Gezel.`,
      );
    }
  }
  if (kept.length > MAX_SDK_ROOTS) {
    throw new Error(`The Spectral SDK is spread over ${kept.length} folders; reinstall Gezel.`);
  }
  const runEntry = realpathSync(require.resolve('@bendyline/gezel-connectors-spectral/run'));
  runtimeCache = { entry, runEntry, readRoots: spectralReadRoots(pkgRoot, kept) };
  return runtimeCache;
}

function realpathOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * Run one job through the real sandbox and report whether the runner and its
 * SDK load. Used by the installed-package smoke test, so it exercises the
 * same read roots and flags a sync would.
 */
export async function runSpectralSelfTest(): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const { data } = await runSpectralAction({
      component: 'echo',
      action: 'list',
      connectionInput: 'connection',
      connection: null,
      inputs: { records: [{ id: 'self-test' }] },
    });
    const ok = Array.isArray(data) && (data[0] as { id?: unknown })?.id === 'self-test';
    if (!ok) return { ok: false, error: `unexpected result: ${JSON.stringify(data)}` };
    // Runner v2, which published components run in, loads the same SDK.
    const run = await runSpectralComponent({ v: 2, op: 'ping' });
    await run.dispose();
    return run.result.ok && run.result.op === 'ping'
      ? { ok: true }
      : { ok: false, error: `runner v2: ${JSON.stringify(run.result)}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function runSpectralAction(job: SpectralJob): Promise<{ data: unknown }> {
  const { entry, readRoots } = resolveSpectralRuntime();
  const cwd = await mkdtemp(join(tmpdir(), 'gezel-spectral-'));
  try {
    const res = await runInSandbox({
      entry,
      cwd,
      input: JSON.stringify(job),
      denyNet: false, // network ON — the reason for the separate posture
      extraReadPaths: readRoots,
      // The sandbox passes every NODE_* variable through; none belongs in a
      // network-enabled child running third-party code.
      extraEnv: { NODE_OPTIONS: '', NODE_PATH: '', NODE_AUTH_TOKEN: '' },
      timeoutMs: 60_000,
      maxOldSpaceMb: 1024,
    });
    if (res.exitCode !== 0) {
      throw new Error(`spectral action failed: ${res.stderr.trim() || `exit ${res.exitCode}`}`);
    }
    const out = JSON.parse(res.stdout.trim() || '{}') as { data?: unknown };
    return { data: out.data };
  } finally {
    await rm(cwd, { recursive: true, force: true }).catch(() => {});
  }
}

// ── Runner v2: published components ─────────────────────────────────────────

/** The runner's job, as `connectors-spectral/src/v2/protocol.ts` defines it. */
export interface ComponentJob {
  v: 2;
  op: 'ping' | 'describe' | 'call' | 'poll' | 'list';
  component?: { dir: string; entry: string; entrySha256: string };
  key?: string;
  connection?: { input: string; value: unknown };
  inputs?: Record<string, unknown>;
  items?: { paths?: string[]; resolver?: boolean };
  state?: unknown;
  resume?: unknown;
  page?: { input: string; from: string };
  origins?: string[];
  replay?: { request: { method?: string; url: string }; response: Record<string, unknown> }[];
  limits?: { maxPages?: number; maxItems?: number; maxBytes?: number; budgetMs?: number };
}

export type ComponentFailureKind =
  | 'throttled'
  | 'auth'
  | 'forbidden'
  | 'not-found'
  | 'upstream'
  | 'network'
  | 'origin'
  | 'replay-miss'
  | 'input'
  | 'component';

export type ComponentResult = ComponentOutcome & { replayed?: number[] };

export type ComponentOutcome =
  | { ok: true; op: 'ping'; sdk: string; node: string }
  | { ok: true; op: 'describe'; component: Record<string, unknown> }
  | { ok: true; op: 'call'; data: unknown; logs: string[] }
  | {
      ok: true;
      op: 'poll';
      items: number;
      pages: number;
      drained: boolean;
      state: unknown;
      resume?: unknown;
      stoppedBy?: string;
      logs: string[];
    }
  | {
      ok: true;
      op: 'list';
      items: number;
      pages: number;
      complete: boolean;
      stoppedBy?: string;
      logs: string[];
    }
  | {
      ok: false;
      op: string;
      error: {
        kind: ComponentFailureKind;
        message: string;
        status?: number;
        retryAfterMs?: number;
      };
      logs: string[];
    };

export interface ComponentRun {
  result: ComponentResult;
  /** `out/items.ndjson`, until `dispose()`. */
  itemsFile: string;
  dispose(): Promise<void>;
}

const MAX_RESULT_BYTES = 8 * 1024 * 1024;

/**
 * Run one job through runner v2 in the sandbox: network on (the runner keeps
 * the component to its declared origins), or off when the job replays
 * recordings, so a contract test proves it opened no socket. The component's
 * package folder is the only part of the Gezel home the run may read.
 */
export async function runSpectralComponent(
  request: ComponentJob,
  opts: { timeoutMs?: number; signal?: AbortSignal; secrets?: readonly string[] } = {},
): Promise<ComponentRun> {
  const { runEntry, readRoots } = resolveSpectralRuntime();
  // The runner checks paths inside what it was granted and cannot resolve
  // links above them (the sandbox refuses their parents), so it gets real ones.
  const job: ComponentJob = request.component
    ? { ...request, component: { ...request.component, dir: realpathSync(request.component.dir) } }
    : request;
  const cwd = await mkdtemp(join(tmpdir(), 'gezel-spectral-'));
  const dispose = () => rm(cwd, { recursive: true, force: true }).catch(() => {});
  try {
    const replay = job.replay !== undefined;
    const res = await runInSandbox({
      entry: runEntry,
      cwd,
      input: JSON.stringify(job),
      denyNet: replay,
      // The component's bytes are hash-pinned and the runner answers every
      // request itself in replay; where the platform has no OS network
      // fence, its own guard still opens no socket.
      ...(replay ? { allowMissingNetBoundary: true } : {}),
      extraReadPaths: [...readRoots, ...(job.component ? [job.component.dir] : [])],
      extraEnv: { NODE_OPTIONS: '', NODE_PATH: '', NODE_AUTH_TOKEN: '' },
      timeoutMs: opts.timeoutMs ?? 5 * 60_000,
      maxOldSpaceMb: 1024,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    const resultPath = join(cwd, 'out', 'result.json');
    const size = (await stat(resultPath).catch(() => undefined))?.size;
    if (size === undefined) {
      const why = res.timedOut
        ? 'ran out of time'
        : `stopped (exit ${res.exitCode})${res.stderr.trim() ? `: ${res.stderr.trim().slice(-500)}` : ''}`;
      throw new Error(scrubSecrets(`The connector component ${why}.`, opts.secrets ?? []));
    }
    if (size > MAX_RESULT_BYTES) throw new Error('The connector component returned too much.');
    const result = JSON.parse(await readFile(resultPath, 'utf8')) as ComponentResult;
    return { result, itemsFile: join(cwd, 'out', 'items.ndjson'), dispose };
  } catch (err) {
    await dispose();
    throw err;
  }
}

export function scrubSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length >= 8 && out.includes(secret)) out = out.split(secret).join('[secret]');
  }
  return out;
}
