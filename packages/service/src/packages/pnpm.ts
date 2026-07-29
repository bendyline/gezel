import { type SpawnOptions, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { type PnpmInvocation, resolvePnpmInvocation } from '@bendyline/gezel';
import { winShellSafe } from './win-shell.js';

/**
 * Single entry point for spawning pnpm from the service. Centralizes two
 * concerns:
 *
 *  1. **Invocation resolution** — packaged Gezel points
 *     `GEZEL_PNPM_PATH` at pnpm's JavaScript entrypoint and
 *     `GEZEL_NODE_PATH` at bundled Node. Development can still use a
 *     configured executable or `pnpm` on PATH.
 *  2. **`--ignore-scripts` everywhere** — post-install hooks are the
 *     exact supply-chain vector we're eliminating. Any legitimate
 *     post-install work (e.g. Playwright's chromium download) is invoked
 *     explicitly by the service in its own dedicated step.
 */

/** Buffered result of a pnpm run. */
export interface PnpmResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  /** Combined stdout+stderr in the order the chunks arrived. */
  log: string;
}

export interface RunPnpmOptions {
  cwd: string;
  env?: Record<string, string | undefined>;
  /** Forwarded to `child_process.spawn`. */
  timeoutMs?: number;
  /** Called with each chunk of combined output as it streams in. */
  onLine?: (chunk: string) => void;
  /**
   * Lifecycle-script policy:
   *   - `'ignore'` (default): prepend `--ignore-scripts`, blocking
   *     post-install hooks — the supply-chain vector install paths
   *     should never trip.
   *   - `'allow'`: run pnpm without the flag. Only `run_package_script`
   *     passes this, and only because `pnpm run <script>` is itself a
   *     lifecycle-script invocation — forcing `--ignore-scripts` would
   *     silently turn `pnpm run build` into a no-op.
   */
  lifecycle?: 'ignore' | 'allow';
}

export function resolvePnpmCommand(args: string[] = []): PnpmInvocation {
  return resolvePnpmInvocation(args, {
    pnpmPath: process.env.GEZEL_PNPM_PATH,
    nodePath: process.env.GEZEL_NODE_PATH,
    processExecPath: process.execPath,
    platform: process.platform,
  });
}

/**
 * Native service-host releases before the script-runtime migration wrote a
 * bundle-local `pnpm[.exe]` path. Redirect that legacy value to the ordinary
 * package's adjacent JS entrypoint so an existing signed helper can launch a
 * newly packaged service without a coordinated native release. Prefer the
 * script even if an upgrade left the old standalone file behind.
 */
export function normalizeBundledPnpmPath(): string | undefined {
  const configured = process.env.GEZEL_PNPM_PATH;
  if (!configured) return configured;

  const legacyName = basename(configured).toLowerCase();
  if (legacyName !== 'pnpm' && legacyName !== 'pnpm.exe') return configured;

  const entryPath = join(dirname(configured), 'bin', 'pnpm.mjs');
  if (!existsSync(entryPath)) return configured;
  process.env.GEZEL_PNPM_PATH = entryPath;
  return entryPath;
}

/**
 * Spawn-ready `{ command, args }` for a resolved pnpm invocation.
 *
 * Every site that calls `spawn(pnpm.command, pnpm.args, { shell:
 * pnpm.shell })` must route through this instead. Node escapes nothing
 * under `shell: true`, so an unquoted command or argument containing a
 * space is split by cmd.exe — the failure mode being
 * `'C:\Program' is not recognized`. Callers keep their own env/stdio;
 * only the command and argv are rewritten, and only when a shell is
 * actually in play.
 */
export function pnpmSpawnTarget(invocation: PnpmInvocation): {
  command: string;
  args: string[];
} {
  return winShellSafe(invocation.command, invocation.args, invocation.shell);
}

/**
 * Spawn pnpm. With `lifecycle: 'ignore'` (default) `--ignore-scripts` is
 * prepended — callers MUST NOT include that flag themselves. Pass
 * `lifecycle: 'allow'` only for `pnpm run`-style script invocations.
 */
export function runPnpm(args: string[], opts: RunPnpmOptions): Promise<PnpmResult> {
  return new Promise((resolve) => {
    const lifecycle = opts.lifecycle ?? 'ignore';
    const rawArgs = lifecycle === 'ignore' ? ['--ignore-scripts', ...args] : [...args];
    const invocation = resolvePnpmCommand(rawArgs);
    // Only the Windows PATH/.cmd fallback needs cmd.exe. The bundled JS
    // route invokes Node directly and never passes through a shell.
    // Command AND args both go through the quoter — this used to quote
    // only the args, which leaves a `.cmd` shim under a spaced path
    // (C:\Program Files\...) to be split by cmd.exe.
    const target = pnpmSpawnTarget(invocation);
    const spawnOpts: SpawnOptions = {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env } as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: invocation.shell,
    };
    if (opts.timeoutMs) spawnOpts.timeout = opts.timeoutMs;
    const child = spawn(target.command, target.args, spawnOpts);

    let stdout = '';
    let stderr = '';
    let log = '';
    child.stdout?.on('data', (c: Buffer) => {
      const s = c.toString('utf8');
      stdout += s;
      log += s;
      opts.onLine?.(s);
    });
    child.stderr?.on('data', (c: Buffer) => {
      const s = c.toString('utf8');
      stderr += s;
      log += s;
      opts.onLine?.(s);
    });

    child.on('error', (err) => {
      resolve({ ok: false, code: null, stdout, stderr: `${stderr}\n${err.message}`, log });
    });
    child.on('close', (code) => {
      resolve({ ok: code === 0, code, stdout, stderr, log });
    });
  });
}
