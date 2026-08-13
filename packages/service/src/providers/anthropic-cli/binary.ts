import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { delimiter, join as pathJoin } from 'node:path';
import { windowsHeadlessSpawnOptions } from '@bendyline/gezel/native';
import { winShellSafe } from '../../packages/win-shell.js';

/**
 * Resolved `claude` binary description.
 * `version` is the raw stdout of `claude --version` minus trailing whitespace
 * (e.g. `1.0.34 (Claude Code)`); we don't parse it because the upstream
 * format isn't a stable API and we only show it back to the user verbatim.
 */
export interface ClaudeBinary {
  path: string;
  version: string;
}

/**
 * Error thrown when the `claude` CLI can't be located. `isActionable: true`
 * is honored by `ChatManager.ensureProvider` so the message reaches the user
 * verbatim instead of getting wrapped in the generic "go to Settings" preface.
 */
export class ClaudeBinaryNotFoundError extends Error {
  readonly isActionable = true;
  constructor(message: string) {
    super(message);
    this.name = 'ClaudeBinaryNotFoundError';
  }
}

/**
 * Non-throwing detection probe for Settings / pre-flight UI. Returns the
 * resolved binary on success, or a `{ installed: false, error }` shape on
 * any failure. Use this when the caller is "is this installed?", not "I'm
 * about to spawn it" — for the latter, `resolveClaudeBinary` (which throws
 * an actionable error) is correct.
 */
export interface ClaudeBinaryDetection {
  installed: boolean;
  path?: string;
  version?: string;
  error?: string;
}

export async function detectClaudeBinary(opts: {
  override?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ClaudeBinaryDetection> {
  try {
    const resolved = await resolveClaudeBinary(opts);
    return { installed: true, path: resolved.path, version: resolved.version };
  } catch (err) {
    return { installed: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Resolve the `claude` binary, preferring the explicit override and falling
 * back to a `$PATH` lookup. Runs `<binary> --version` to confirm the file is
 * actually executable and returns the version string for surface in
 * Settings. Throws `ClaudeBinaryNotFoundError` (actionable) on any failure.
 *
 * No bundling in v1 — packaging the upstream CLI is deferred. Users install
 * the CLI via Anthropic's published distribution channels and either set
 * `config.anthropicCli.binaryPath` or rely on `$PATH`.
 */
export async function resolveClaudeBinary(opts: {
  override?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ClaudeBinary> {
  const env = opts.env ?? process.env;
  const candidates: string[] = [];
  if (opts.override) {
    candidates.push(opts.override);
  } else {
    const onPath = which('claude', env.PATH ?? '', env.PATHEXT);
    if (onPath) candidates.push(onPath);
  }
  if (candidates.length === 0) {
    throw new ClaudeBinaryNotFoundError(
      'Claude CLI not found on PATH. Install Anthropic Claude Code, or set ' +
        '`anthropicCli.binaryPath` in Settings to point at the executable.',
    );
  }
  const last = candidates.length - 1;
  for (let i = 0; i < candidates.length; i++) {
    const path = candidates[i]!;
    try {
      const version = await runVersionProbe(path);
      return { path, version };
    } catch (err) {
      if (i === last) {
        const message = err instanceof Error ? err.message : String(err);
        throw new ClaudeBinaryNotFoundError(
          `Claude CLI at ${path} is not executable: ${message}. Install Anthropic Claude Code or update \`anthropicCli.binaryPath\` in Settings.`,
        );
      }
    }
  }
  // Unreachable — the loop either returns or throws on the last iteration.
  throw new ClaudeBinaryNotFoundError('Claude CLI not found.');
}

/**
 * Run `<path> --version` with a hard timeout. Resolves with trimmed stdout on
 * success, rejects with the stderr / exit reason on failure.
 *
 * Exposed for testing — the test injects a fake binary path that points at a
 * shell script we control.
 */
export async function runVersionProbe(path: string, timeoutMs = 5000): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    // Windows: `.cmd` / `.bat` shims (which is how Anthropic's CLI lands
    // when installed via `npm i -g`) can't be exec'd directly — spawn
    // returns EINVAL without `shell: true`. Plain `.exe` works without
    // and benefits from the more predictable no-shell path-quoting.
    const useShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(path);
    // Under `shell: true` Node concatenates without escaping, so the path
    // has to be quoted here. `npm i -g` writes its shims next to the Node
    // install — `C:\Program Files\nodejs\claude.cmd` for a default
    // Windows Node — and an unquoted path splits at that space, leaving
    // cmd to report `'C:\Program' is not recognized` and the probe to
    // conclude the CLI is absent.
    const target = winShellSafe(path, ['--version'], useShell);
    const child = spawn(target.command, target.args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: useShell,
      ...windowsHeadlessSpawnOptions(),
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`--version timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout.trim() || stderr.trim());
      } else {
        reject(new Error(`exited ${code}: ${stderr.trim() || stdout.trim()}`));
      }
    });
  });
}

/**
 * Walk `$PATH` looking for an executable named `name`. On Windows, also tries
 * each `$PATHEXT` extension. Returns the first absolute path that resolves to
 * an executable, or `null` when nothing matches.
 *
 * Exported for testing. Uses synchronous fs because the lookup is one-shot
 * and infrequent — a 5-element PATH is faster to walk synchronously than to
 * fan out via async I/O.
 */
export function which(name: string, path: string, pathExt?: string): string | null {
  if (!path) return null;
  const exts = process.platform === 'win32' ? (pathExt ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = pathJoin(dir, name + ext);
      try {
        const stats = statSync(candidate);
        if (stats.isFile()) {
          // POSIX `access(X_OK)` would be the conventional executable-bit
          // probe, but adds a syscall per candidate. Mode check is good
          // enough here — `--version` is the real verifier.
          return candidate;
        }
      } catch {
        /* not present, try next */
      }
    }
  }
  return null;
}
