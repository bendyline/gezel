import { spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';

/**
 * Thin wrapper around the `git` CLI. Lives here (not in a library) so we
 * stay consistent with how the package installer already shells out to npm.
 *
 * Runs git with `GIT_TERMINAL_PROMPT=0` so a missing or invalid PAT fails
 * fast instead of hanging on a stdin prompt — important because we run
 * inside the service with no attached TTY.
 */

export interface RunGitResult {
  stdout: string;
  stderr: string;
  /** Exit code. Only populated for non-zero exits accepted via `acceptExitCodes`. */
  code?: number;
}

export class GitError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
    readonly stderr: string,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

export interface RunGitOptions {
  cwd?: string;
  /** Tokens to redact from any error/log surfaces. */
  redact?: string[];
  /** Extra env vars on top of the always-on safety set. */
  env?: Record<string, string>;
  timeoutMs?: number;
  /**
   * Non-zero exit codes to resolve (with stdout/stderr intact) instead of
   * rejecting. Needed for commands where a non-zero exit is an expected
   * outcome rather than a failure — e.g. `git merge` exits 1 on conflicts
   * and `GitError` doesn't carry stdout.
   */
  acceptExitCodes?: number[];
}

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Relocate any `-c http.extraheader=...` arg (the auth header carrying
 * the PAT) out of argv into env-based git config. Process argv is visible
 * via `ps` / `/proc/<pid>/cmdline`, so a token on the command line leaks
 * to co-located local users during any clone/fetch/push. Env config via
 * GIT_CONFIG_COUNT (git >= 2.31) keeps it off argv.
 */
function relocateSecretGitConfig(args: string[]): {
  cleanedArgs: string[];
  configEnv: Record<string, string>;
} {
  const cleanedArgs: string[] = [];
  const pairs: Array<[string, string]> = [];
  for (let i = 0; i < args.length; i++) {
    const next = args[i + 1];
    if (args[i] === '-c' && next !== undefined && /^http\.extraheader=/i.test(next)) {
      const eq = next.indexOf('=');
      pairs.push([next.slice(0, eq), next.slice(eq + 1)]);
      i++; // consume the value token too
      continue;
    }
    cleanedArgs.push(args[i]!);
  }
  const configEnv: Record<string, string> = {};
  if (pairs.length > 0) {
    configEnv.GIT_CONFIG_COUNT = String(pairs.length);
    pairs.forEach(([k, v], n) => {
      configEnv[`GIT_CONFIG_KEY_${n}`] = k;
      configEnv[`GIT_CONFIG_VALUE_${n}`] = v;
    });
  }
  return { cleanedArgs, configEnv };
}

export async function runGit(args: string[], opts: RunGitOptions = {}): Promise<RunGitResult> {
  const { cleanedArgs, configEnv } = relocateSecretGitConfig(args);
  const env: Record<string, string> = {
    ...filterEnv(process.env),
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '/bin/true',
    ...configEnv,
    ...(opts.env ?? {}),
  };
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // gezel only ever runs git against repos it created and manages,
  // including the bare shared clones under `~/.gezel/git-clones/`. Trust
  // them explicitly so a host whose global config sets
  // `safe.bareRepository=explicit` doesn't make git refuse every
  // bare-repo operation (clone idempotency check, worktree add/remove,
  // remote set-url). Prepended as a `-c` override on each invocation, so
  // it beats global config without mutating the user's gitconfig.
  const gitArgs = ['-c', 'safe.bareRepository=all', ...cleanedArgs];
  return new Promise<RunGitResult>((resolve, reject) => {
    const child = spawn('git', gitArgs, {
      cwd: opts.cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let killedForTimeout = false;
    const timer = setTimeout(() => {
      killedForTimeout = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(redactError(err, opts.redact));
    });
    // Resolve on 'close', NOT 'exit': 'exit' fires when the process
    // terminates but the stdout/stderr pipes may still hold unread,
    // buffered data. 'close' fires only after those streams have fully
    // drained. Under heavy parallel load the final stdout chunk can land
    // after 'exit', so resolving there intermittently captured empty
    // output (e.g. a `git show :3:<path>` returning '').
    child.on('close', (code) => {
      clearTimeout(timer);
      if (killedForTimeout) {
        reject(
          new GitError(
            `git ${redact(args.join(' '), opts.redact)} timed out after ${timeoutMs}ms`,
            null,
            redact(stderr, opts.redact),
          ),
        );
        return;
      }
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      if (code !== null && opts.acceptExitCodes?.includes(code)) {
        resolve({ stdout, stderr, code });
        return;
      }
      reject(
        new GitError(
          `git ${redact(args.join(' '), opts.redact)} exited with code ${code}: ${redact(stderr.trim(), opts.redact)}`,
          code,
          redact(stderr, opts.redact),
        ),
      );
    });
  });
}

/** True iff git is on PATH and runnable. */
export async function isGitInstalled(): Promise<boolean> {
  try {
    await runGit(['--version'], { timeoutMs: 5_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Bare clone of `url` into `dest`. Bare clones hold the `.git/`
 * objects and refs but no working tree — perfect as the storage layer
 * for Phase 3's shared-clone-plus-worktrees design. Multiple projects
 * can `worktreeAdd` their own checkouts off this bare clone, sharing
 * the object database while keeping independent working trees + HEADs.
 *
 * `--filter=blob:none` keeps the initial clone fast (commit graph +
 * trees only); blobs are fetched lazily by `git worktree add` when
 * the working tree actually needs file contents.
 */
export async function cloneBare(
  url: string,
  dest: string,
  opts?: RunGitOptions,
): Promise<RunGitResult> {
  return runGit(['clone', '--bare', '--filter=blob:none', url, dest], opts);
}

/**
 * Create a new git worktree at `worktreePath` off the bare repository
 * at `bareDir`, checked out at `ref` (branch / tag / SHA). The bare
 * repo doesn't have a working tree itself, so this is how we materialize
 * a per-project file tree. Sharing across multiple worktrees: yes —
 * they read from `bareDir/objects/` so the per-tree disk cost is only
 * the working files plus a tiny `.git` pointer file.
 *
 * If `createBranch` is true, `git worktree add -b <ref>` creates a new
 * branch with that name pointed at HEAD. Otherwise the ref must
 * already exist (locally or via the bare clone's `origin` remote).
 */
export async function worktreeAdd(
  bareDir: string,
  worktreePath: string,
  ref: string,
  opts?: RunGitOptions & { createBranch?: boolean },
): Promise<RunGitResult> {
  const args = ['worktree', 'add'];
  if (opts?.createBranch) args.push('-b', ref);
  args.push(worktreePath);
  if (!opts?.createBranch) args.push(ref);
  return runGit(args, { ...opts, cwd: bareDir });
}

/**
 * Remove a worktree previously added via `worktreeAdd`. Cleans up
 * both the working tree on disk AND the bare repo's worktree registry
 * (`.git/worktrees/<id>/`). `force: true` overrides the safety check
 * that refuses to remove a worktree with uncommitted changes — use
 * sparingly; default is the safer non-forced variant.
 */
export async function worktreeRemove(
  bareDir: string,
  worktreePath: string,
  opts?: RunGitOptions & { force?: boolean },
): Promise<RunGitResult> {
  const args = ['worktree', 'remove'];
  if (opts?.force) args.push('--force');
  args.push(worktreePath);
  return runGit(args, { ...opts, cwd: bareDir });
}

/**
 * List the worktrees registered against a bare repo. Used by the
 * reference-counted cleanup to decide whether a shared clone still
 * has any active references. Returns an array of absolute working-tree
 * paths (the bare repo itself is excluded from the result).
 *
 * Parses `git worktree list --porcelain` output. The format is one
 * record per worktree, separated by blank lines, with `worktree <path>`
 * as the first key per record.
 */
export async function worktreeList(bareDir: string): Promise<string[]> {
  const result = await runGit(['worktree', 'list', '--porcelain'], { cwd: bareDir });
  const paths: string[] = [];
  // Git emits forward-slash paths even on Windows, but `bareDir` is built
  // with `path.join` which uses `\` on Windows. On macOS, temp dirs can
  // also appear as `/var/...` to Node and `/private/var/...` to git.
  // Compare canonicalized paths so the bare repo's own entry is correctly
  // excluded before ref-counting project worktrees.
  const normBare = await normalizeWorktreePath(bareDir);
  for (const line of result.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      const raw = line.slice('worktree '.length).trim();
      const norm = await normalizeWorktreePath(raw);
      if (norm !== normBare) paths.push(raw);
    }
  }
  return paths;
}

async function normalizeWorktreePath(path: string): Promise<string> {
  let resolved = path;
  try {
    resolved = await realpath(path);
  } catch {
    // Keep the raw path if the worktree has already been removed.
  }
  return resolved.replace(/\\/g, '/').replace(/\/+$/, '');
}

function redact(s: string, secrets?: string[]): string {
  if (!secrets || secrets.length === 0) return s;
  let out = s;
  for (const secret of secrets) {
    if (!secret) continue;
    out = out.split(secret).join('***');
  }
  return out;
}

function redactError(err: unknown, secrets?: string[]): Error {
  if (err instanceof Error) {
    err.message = redact(err.message, secrets);
    return err;
  }
  return new Error(redact(String(err), secrets));
}

/**
 * Strip env vars that we don't want leaking into git operations (e.g. our
 * own bearer token, OpenAI key). We keep the rest so users' git config,
 * SSH agents, and `GIT_*` overrides keep working.
 */
function filterEnv(src: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(src)) {
    if (v == null) continue;
    if (k === 'GEZEL_TOKEN') continue;
    if (k === 'OPENAI_API_KEY') continue;
    if (k === 'GITHUB_PERSONAL_ACCESS_TOKEN') continue;
    out[k] = v;
  }
  return out;
}
