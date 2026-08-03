import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { windowsDetachedSpawnOptions } from '@bendyline/gezel/native';

/**
 * Ambient GitHub credentials — consulted when the github toolset has no
 * stored PAT. Two sources, in order:
 *
 *   1. `GH_TOKEN` / `GITHUB_TOKEN` env vars (the convention every GitHub
 *      tool respects; also how CI injects credentials).
 *   2. A signed-in GitHub CLI: `gh auth token` prints the OAuth token from
 *      `gh auth login`. Octokit and git's `http.extraheader` both accept
 *      it exactly like a PAT.
 *
 * Tokens are resolved at call time and never persisted — the gh token
 * rotates when the user re-auths, and copying it into the secret store
 * would leave a stale shadow that outlives the real credential.
 */

export type AmbientSource = 'env' | 'gh';

export interface AmbientToken {
  token: string;
  source: AmbientSource;
}

/** How long a gh-CLI hit stays fresh before we re-spawn `gh auth token`. */
const TOKEN_TTL_MS = 5 * 60_000;
/**
 * How long a miss (gh absent or signed out) is remembered. Shorter than the
 * hit TTL so a fresh `gh auth login` is picked up within a minute, while the
 * 15s status poll still doesn't spawn a process per tick.
 */
const MISS_TTL_MS = 60_000;

/** `gh auth token` is local keyring I/O — anything slow is wedged, not busy. */
const GH_TIMEOUT_MS = 10_000;

export interface AmbientAuthOptions {
  /** Env to read tokens and install locations from. Default: process.env. */
  env?: Record<string, string | undefined>;
  /** Test seam: replaces the `gh auth token` spawn entirely. */
  ghToken?: () => Promise<string | null>;
  tokenTtlMs?: number;
  missTtlMs?: number;
}

export class AmbientGitHubAuth {
  private readonly env: Record<string, string | undefined>;
  private readonly ghTokenOverride?: () => Promise<string | null>;
  private readonly tokenTtlMs: number;
  private readonly missTtlMs: number;
  private cached: { value: AmbientToken | null; expiresAt: number } | null = null;
  private pending: Promise<AmbientToken | null> | null = null;

  constructor(opts: AmbientAuthOptions = {}) {
    this.env = opts.env ?? process.env;
    if (opts.ghToken) this.ghTokenOverride = opts.ghToken;
    this.tokenTtlMs = opts.tokenTtlMs ?? TOKEN_TTL_MS;
    this.missTtlMs = opts.missTtlMs ?? MISS_TTL_MS;
  }

  /**
   * Best ambient token available right now, or null. Env vars are read
   * fresh on every call (no caching needed); the gh CLI lookup is cached
   * and single-flighted so concurrent callers share one spawn.
   */
  async getToken(): Promise<AmbientToken | null> {
    const envToken = (this.env.GH_TOKEN ?? this.env.GITHUB_TOKEN ?? '').trim();
    if (envToken) return { token: envToken, source: 'env' };
    if (this.cached && Date.now() < this.cached.expiresAt) return this.cached.value;
    if (!this.pending) {
      this.pending = this.lookupGh()
        .then((token) => {
          const value: AmbientToken | null = token ? { token, source: 'gh' } : null;
          this.cached = {
            value,
            expiresAt: Date.now() + (value ? this.tokenTtlMs : this.missTtlMs),
          };
          return value;
        })
        .finally(() => {
          this.pending = null;
        });
    }
    return this.pending;
  }

  /** Drop the cached gh lookup — call after a 401 so the next use re-asks. */
  invalidate(): void {
    this.cached = null;
  }

  private async lookupGh(): Promise<string | null> {
    if (this.ghTokenOverride) {
      return this.ghTokenOverride().catch(() => null);
    }
    for (const bin of ghCandidates(this.env)) {
      try {
        return await runGhAuthToken(bin);
      } catch {
        // Binary missing or unlaunchable — try the next candidate.
      }
    }
    return null;
  }
}

/**
 * Places to look for the gh binary. A bare `gh` resolves via PATH, but a
 * packaged Electron app can launch with a stripped PATH, so the default
 * install locations are tried as fallbacks.
 */
function ghCandidates(env: Record<string, string | undefined>): string[] {
  if (process.platform === 'win32') {
    const candidates = ['gh'];
    candidates.push(join(env.ProgramFiles ?? 'C:\\Program Files', 'GitHub CLI', 'gh.exe'));
    if (env.LOCALAPPDATA) {
      candidates.push(join(env.LOCALAPPDATA, 'Programs', 'GitHub CLI', 'gh.exe'));
    }
    return candidates;
  }
  return ['gh', '/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh'];
}

/**
 * Resolves the token, or null when gh runs but isn't signed in (non-zero
 * exit / empty output). Rejects only when the binary can't be launched,
 * so the caller knows to try the next candidate path.
 */
function runGhAuthToken(bin: string): Promise<string | null> {
  return new Promise<string | null>((resolve, reject) => {
    const child = spawn(bin, ['auth', 'token', '--hostname', 'github.com'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      // `gh` is console-subsystem, and console allocation fails outright in
      // the machine service's Session 0, so start it with DETACHED_PROCESS;
      // `windowsHide` (CREATE_NO_WINDOW) still allocates one.
      ...windowsDetachedSpawnOptions(),
    });
    let stdout = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, GH_TIMEOUT_MS);
    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    // 'close' (not 'exit'): wait for stdout to fully drain before reading
    // the token — 'exit' can fire with the final chunk still buffered,
    // which would intermittently yield an empty token under load.
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut || code !== 0) {
        resolve(null);
        return;
      }
      const token = stdout.trim();
      resolve(token.length > 0 ? token : null);
    });
  });
}
