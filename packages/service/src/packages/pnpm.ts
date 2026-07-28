import { type SpawnOptions, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { type PnpmInvocation, resolvePnpmInvocation } from '@bendyline/gezel';

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
 * Quote an argument for cmd.exe when spawning pnpm with `shell: true`
 * (the `.cmd` shim path on Windows). Inside double quotes cmd treats
 * &, |, <, >, ^, (, ) as literal — so a package spec's semver caret
 * survives — and embedded quotes are doubled. `%` (variable expansion)
 * fires even inside quotes, and control chars are never valid in a pnpm
 * arg, so reject those outright rather than try to escape them. Without
 * this, shell:true lets a spec like `foo & calc.exe` inject a command.
 */
function quoteWinShellArg(arg: string): string {
  for (let i = 0; i < arg.length; i++) {
    if (arg.charCodeAt(i) < 0x20 || arg[i] === '%') {
      throw new Error(`unsafe pnpm argument for the Windows shell: ${JSON.stringify(arg)}`);
    }
  }
  return `"${arg.replace(/"/g, '""')}"`;
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
    const finalArgs = invocation.shell ? invocation.args.map(quoteWinShellArg) : invocation.args;
    const spawnOpts: SpawnOptions = {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env } as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: invocation.shell,
    };
    if (opts.timeoutMs) spawnOpts.timeout = opts.timeoutMs;
    const child = spawn(invocation.command, finalArgs, spawnOpts);

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
