/**
 * Where the eval harness lives on this install, and how to launch it.
 *
 * The harness (`evals/`) owns trial orchestration, grading, and scoring; the
 * daemon only launches it as a child process, so a crashing trial can never
 * take down the gezeld it was started from.
 *
 * Two shapes, chosen per launch:
 *
 *   - **source** — a gezel checkout. Runs the live TypeScript through the
 *     same dependency-lease wrapper `pnpm eval:all` uses, so an in-app run and
 *     a terminal run hold the same lease and measure the same code.
 *   - **compiled** — everywhere else (packaged app, npm, CLI). tsup compiles
 *     the harness into `dist/evals/` beside the daemon, and it runs under the
 *     bundled Node. This is what makes in-app evals available on every install
 *     instead of only on a developer's machine.
 *
 * `GEZEL_EVAL_HARNESS=source|compiled` forces a shape (the compiled path is
 * otherwise never exercised from a checkout).
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { EvalHarnessMode } from '@bendyline/gezel/eval';
import { windowsHeadlessSpawnOptions } from '@bendyline/gezel/native';
import { isPathInside } from '../fs/safe-paths.js';
import { findServiceWorkerEntry } from '../utils/service-worker-entry.js';

export const EVAL_HARNESS_MODE_ENV = 'GEZEL_EVAL_HARNESS';

export type EvalHarnessCommand = 'all' | 'catalog';

export interface EvalHarnessLaunch {
  command: string;
  args: string[];
  cwd: string;
  /** Merged over the caller's environment. */
  env: NodeJS.ProcessEnv;
}

export interface EvalHarness {
  mode: EvalHarnessMode;
  launch(command: EvalHarnessCommand, args: readonly string[]): EvalHarnessLaunch;
}

interface SourceHarness {
  repoRoot: string;
  leaseScript: string;
}

/**
 * A gezel checkout's harness, found by walking up from this module. Only a
 * checkout of gezel itself qualifies: the module must live under that root's
 * `packages/service/`. An npm install sits inside someone else's tree, and
 * without this check any `pnpm-workspace.yaml` above it — including a planted
 * one in a shared parent directory — would have its scripts run with the
 * daemon's environment.
 */
export function resolveSourceHarness(modulePath: string): SourceHarness | null {
  let dir = modulePath;
  for (let i = 0; i < 12; i++) {
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
    if (!existsSync(join(dir, 'pnpm-workspace.yaml'))) continue;
    if (!isPathInside(modulePath, join(dir, 'packages', 'service'))) return null;
    const leaseScript = join(dir, 'scripts', 'run-with-dependency-lease.mjs');
    if (!existsSync(leaseScript)) return null;
    if (!existsSync(join(dir, 'evals', 'src', 'bin', 'all.ts'))) return null;
    try {
      createRequire(pathToFileURL(join(dir, 'evals', 'package.json'))).resolve('tsx');
    } catch {
      return null;
    }
    return { repoRoot: dir, leaseScript };
  }
  return null;
}

/** The compiled harness emitted beside the daemon, or null when absent. */
export function resolveCompiledHarness(
  moduleUrl: string,
): Record<EvalHarnessCommand, string> | null {
  const all = findServiceWorkerEntry(moduleUrl, 'eval-harness');
  const catalog = findServiceWorkerEntry(moduleUrl, 'eval-catalog');
  return all && catalog ? { all, catalog } : null;
}

/**
 * The Node that runs a compiled harness: the bundled runtime the supervisor
 * names in `GEZEL_NODE_PATH`, else this process. Under Electron (the embedded
 * daemon) `process.execPath` is the app binary and must be told to act as
 * Node. Trial daemons and graders inherit `process.execPath` from the
 * harness, so this choice reaches all of them.
 */
export function evalNodeRuntime(env: NodeJS.ProcessEnv = process.env): {
  command: string;
  env: NodeJS.ProcessEnv;
} {
  const bundled = env.GEZEL_NODE_PATH?.trim();
  if (bundled && existsSync(bundled)) return { command: bundled, env: {} };
  return {
    command: process.execPath,
    env: process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {},
  };
}

export function resolveEvalHarness(
  opts: { moduleUrl?: string; env?: NodeJS.ProcessEnv } = {},
): EvalHarness | null {
  const moduleUrl = opts.moduleUrl ?? import.meta.url;
  const env = opts.env ?? process.env;
  const forced = env[EVAL_HARNESS_MODE_ENV]?.trim();
  const runtime = evalNodeRuntime(env);

  const source = forced === 'compiled' ? null : resolveSourceHarness(fileURLToPath(moduleUrl));
  if (source) {
    return {
      mode: 'source',
      launch: (command, args) => ({
        command: runtime.command,
        args: [source.leaseScript, '--direct-node', `evals/src/bin/${command}.ts`, ...args],
        cwd: source.repoRoot,
        env: runtime.env,
      }),
    };
  }
  if (forced === 'source') return null;

  const compiled = resolveCompiledHarness(moduleUrl);
  if (!compiled) return null;
  return {
    mode: 'compiled',
    launch: (command, args) => ({
      command: runtime.command,
      args: [compiled[command], ...args],
      cwd: dirname(compiled[command]),
      env: runtime.env,
    }),
  };
}

/**
 * This daemon's own identity, which the harness — and every trial daemon it
 * starts — must not inherit. A leaked `GEZEL_PORT` made trial daemons bind
 * this daemon's port and die; `GEZEL_HOME` would point harness code that
 * resolves a home at the person's real one. Trial homes are set by the
 * harness itself.
 */
const DAEMON_IDENTITY_ENV = [
  'GEZEL_HOME',
  'GEZEL_PORT',
  'GEZEL_SERVICE_ROLE',
  'GEZEL_SYSTEM_SCOPE',
  'GEZEL_WEB',
  'GEZEL_SHUTDOWN_ON_STDIN_EOF',
] as const;

/** The environment a harness child starts from: this process's, minus its identity. */
export function harnessBaseEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const key of DAEMON_IDENTITY_ENV) delete out[key];
  return out;
}

export interface HarnessProcess {
  child: ChildProcess;
  /** Resolves when the child exits; never rejects. */
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: string }>;
}

/**
 * Spawn the harness and deliver its output one line at a time. POSIX
 * children lead their own process group so a forced stop can take the trial
 * daemon and its engines along (`killProcessTree`).
 */
export function spawnHarness(
  launch: EvalHarnessLaunch,
  opts: {
    env: NodeJS.ProcessEnv;
    onLine: (line: string, stream: 'stdout' | 'stderr') => void;
    spawnImpl?: typeof spawn;
  },
): HarnessProcess {
  const child = (opts.spawnImpl ?? spawn)(launch.command, launch.args, {
    cwd: launch.cwd,
    env: { ...opts.env, ...launch.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    ...windowsHeadlessSpawnOptions(),
  });
  const attach = (stream: NodeJS.ReadableStream | null, name: 'stdout' | 'stderr') => {
    if (!stream) return;
    let pending = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      pending += chunk;
      let newline = pending.indexOf('\n');
      while (newline !== -1) {
        const line = pending.slice(0, newline).replace(/\r$/, '');
        pending = pending.slice(newline + 1);
        if (line.length > 0) opts.onLine(line, name);
        newline = pending.indexOf('\n');
      }
    });
    stream.on('end', () => {
      if (pending.length > 0) opts.onLine(pending, name);
      pending = '';
    });
  };
  attach(child.stdout, 'stdout');
  attach(child.stderr, 'stderr');
  const exited = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    error?: string;
  }>((resolveExit) => {
    let settled = false;
    child.once('error', (err) => {
      if (settled) return;
      settled = true;
      resolveExit({ code: null, signal: null, error: err.message });
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      resolveExit({ code, signal });
    });
  });
  return { child, exited };
}
