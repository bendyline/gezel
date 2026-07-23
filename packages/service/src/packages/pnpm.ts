import { type SpawnOptions, spawn } from 'node:child_process';

/**
 * Single entry point for spawning pnpm from the service. Centralizes two
 * concerns:
 *
 *  1. **Binary resolution** — the Electron supervisor sets
 *     `GEZEL_PNPM_PATH` to the bundled pnpm binary on launch. When unset
 *     (dev `pnpm dev` workflow), we fall back to the `pnpm` on PATH.
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

export function resolvePnpmBinary(): string {
  return process.env.GEZEL_PNPM_PATH || 'pnpm';
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
    const binary = resolvePnpmBinary();
    const lifecycle = opts.lifecycle ?? 'ignore';
    const rawArgs = lifecycle === 'ignore' ? ['--ignore-scripts', ...args] : [...args];
    // Windows: pnpm is a `.cmd` shim on PATH. Without `shell: true`,
    // `spawn` can't resolve the shim and fails with ENOENT. When
    // GEZEL_PNPM_PATH points at an absolute `pnpm.exe` this flag is a
    // no-op; the branch matters for the dev fallback. shell:true means
    // cmd.exe parses the args, so quote each one to neutralize injection.
    const useShell = process.platform === 'win32';
    const finalArgs = useShell ? rawArgs.map(quoteWinShellArg) : rawArgs;
    const spawnOpts: SpawnOptions = {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env } as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: useShell,
    };
    if (opts.timeoutMs) spawnOpts.timeout = opts.timeoutMs;
    const child = spawn(binary, finalArgs, spawnOpts);

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
