import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { delimiter, join as pathJoin } from 'node:path';
import { winShellSafe } from '../../packages/win-shell.js';

/**
 * Resolved `codex` binary description. `version` is the raw stdout of
 * `codex --version` minus trailing whitespace (e.g. `codex 0.125.0`); we
 * surface it back to the user verbatim and don't parse it.
 */
export interface CodexBinary {
  path: string;
  version: string;
}

/**
 * Error thrown when the `codex` CLI can't be located. `isActionable: true`
 * is honored by `ChatManager.ensureProvider` so the message reaches the
 * user verbatim rather than getting wrapped in the generic preface.
 */
export class CodexBinaryNotFoundError extends Error {
  readonly isActionable = true;
  constructor(message: string) {
    super(message);
    this.name = 'CodexBinaryNotFoundError';
  }
}

/**
 * Non-throwing detection probe for Settings / pre-flight UI. Mirrors
 * `detectClaudeBinary`. Use when the caller wants to know "is this
 * installed?" rather than to spawn — `resolveCodexBinary` is correct
 * for the latter (it throws actionable errors).
 */
export interface CodexBinaryDetection {
  installed: boolean;
  path?: string;
  version?: string;
  error?: string;
}

export async function detectCodexBinary(opts: {
  override?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<CodexBinaryDetection> {
  try {
    const resolved = await resolveCodexBinary(opts);
    return { installed: true, path: resolved.path, version: resolved.version };
  } catch (err) {
    return { installed: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Resolve the `codex` binary, preferring the explicit override and falling
 * back to a `$PATH` lookup. Runs `<binary> --version` to confirm the file
 * is actually executable and returns the version string for surface in
 * Settings. Throws `CodexBinaryNotFoundError` (actionable) on any failure.
 *
 * No bundling — packaging the upstream CLI is deferred. Users install
 * `@openai/codex` (`npm i -g`) or the platform binary themselves and
 * either set `config.codexCli.binaryPath` or rely on `$PATH`.
 */
export async function resolveCodexBinary(opts: {
  override?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<CodexBinary> {
  const env = opts.env ?? process.env;
  const candidates: string[] = [];
  if (opts.override) {
    candidates.push(opts.override);
  } else {
    const onPath = which('codex', env.PATH ?? '', env.PATHEXT);
    if (onPath) candidates.push(onPath);
  }
  if (candidates.length === 0) {
    throw new CodexBinaryNotFoundError(
      'Codex CLI not found on PATH. Install OpenAI Codex (`npm i -g @openai/codex`), ' +
        'or set `codexCli.binaryPath` in Settings to point at the executable.',
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
        throw new CodexBinaryNotFoundError(
          `Codex CLI at ${path} is not executable: ${message}. Install OpenAI Codex (\`npm i -g @openai/codex\`) or update \`codexCli.binaryPath\` in Settings.`,
        );
      }
    }
  }
  throw new CodexBinaryNotFoundError('Codex CLI not found.');
}

/**
 * Run `<path> --version` with a hard timeout. Resolves with trimmed stdout
 * on success, rejects with the stderr / exit reason on failure.
 *
 * Exposed for testing.
 */
export async function runVersionProbe(path: string, timeoutMs = 5000): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    // Windows: `.cmd` / `.bat` shims (which is how OpenAI's CLI lands
    // when installed via `npm i -g @openai/codex`) can't be exec'd
    // directly — spawn returns EINVAL since the Node 18.20+ CVE
    // mitigation. Plain `.exe` works without and benefits from the
    // more predictable no-shell path-quoting. Mirrors the same gate
    // in `anthropic-cli/binary.ts`.
    const useShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(path);
    // Quote the path when a shell is involved — see the matching note in
    // `anthropic-cli/binary.ts`. `npm i -g @openai/codex` lands its shim
    // beside Node, so on a default Windows install the path contains a
    // space and an unquoted spawn makes the probe report the CLI as
    // missing rather than reading its version.
    const target = winShellSafe(path, ['--version'], useShell);
    const child = spawn(target.command, target.args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: useShell,
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
 * Walk `$PATH` looking for an executable named `name`. On Windows, also
 * tries each `$PATHEXT` extension. Returns the first absolute path that
 * resolves to a regular file, or `null` when nothing matches.
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
          return candidate;
        }
      } catch {
        /* not present, try next */
      }
    }
  }
  return null;
}
