import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureDir } from './fs-utils.js';
import { HttpError, fetchWithRetry } from './http.js';

/**
 * SPDX ids the importer is willing to ship in the catalog. Anything
 * outside this list — including `NOASSERTION`, GPL/AGPL/SSPL/BUSL,
 * Commons Clause variants, or unknown — gets quarantined for human
 * review.
 */
export const PERMISSIVE_LICENSES = new Set<string>([
  'MIT',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'BSD-3-Clause-Clear',
  'ISC',
  '0BSD',
  'MPL-2.0',
  'CC0-1.0',
  'Unlicense',
]);

const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type LicenseLookup =
  | { kind: 'resolved'; spdx: string; source: 'github' | 'npm-fallback' | 'override' }
  | { kind: 'unknown'; reason: string };

/**
 * Outcomes that describe the *moment* rather than the repository —
 * rate limiting, upstream 5xx, a dropped connection.
 *
 * These must never reach the cache. A cached transient failure is
 * indistinguishable from "this repo has no discoverable license", so
 * it silently excludes a perfectly good entry from the catalog for the
 * full 30-day TTL, and every re-run reproduces the exclusion from disk
 * without making a request that could correct it. One rate-limited
 * window poisoned 530 entries this way, all of which resolve 200 with
 * a real license on a live request.
 */
function isTransientFailure(result: LicenseLookup): boolean {
  if (result.kind !== 'unknown') return false;
  return (
    result.reason.startsWith('github 403') ||
    result.reason.startsWith('github 5') ||
    result.reason.startsWith('github error 5') ||
    result.reason.startsWith('github fetch failed')
  );
}

export interface LicenseResolverOptions {
  cacheDir?: string;
  /** GitHub PAT — required for any meaningful volume (60/hr unauth limit). */
  githubToken?: string;
}

interface CacheEntry {
  result: LicenseLookup;
  fetchedAt: number;
}

/**
 * Resolve an SPDX license id for a registry entry. Strategy:
 *
 *   1. If the entry's npm packument carried a license string, prefer
 *      it (caller passes via `npmFallbackLicense`).
 *   2. Otherwise hit GitHub `/repos/{owner}/{repo}/license`. For
 *      monorepos we currently use the repo-level license — per-folder
 *      LICENSE files are vanishingly rare and `repos/.../license`
 *      doesn't take a path argument (would need contents API +
 *      string parsing for marginal accuracy gain).
 *   3. Cache results to disk (30-day TTL) keyed by `owner__repo` or
 *      `npm__packageName`.
 */
export class LicenseResolver {
  constructor(private readonly opts: LicenseResolverOptions = {}) {}

  async resolveForGitHub(repoUrl: string | undefined): Promise<LicenseLookup> {
    const ownerRepo = parseGitHubOwnerRepo(repoUrl);
    if (!ownerRepo) return { kind: 'unknown', reason: 'no GitHub repository url' };
    const key = `gh__${ownerRepo.owner}__${ownerRepo.repo}`;
    const cached = await this.readCache(key);
    if (cached) return cached;

    const url = `https://api.github.com/repos/${ownerRepo.owner}/${ownerRepo.repo}/license`;
    let result: LicenseLookup;
    try {
      const res = await fetchWithRetry(
        url,
        { headers: { accept: 'application/vnd.github+json' } },
        { token: this.opts.githubToken },
      );
      if (res.status === 404) {
        result = { kind: 'unknown', reason: 'github returned 404' };
      } else if (res.status === 403) {
        result = { kind: 'unknown', reason: 'github 403 (rate limited or private)' };
      } else if (!res.ok) {
        result = { kind: 'unknown', reason: `github ${res.status}` };
      } else {
        const body = (await res.json()) as { license?: { spdx_id?: string } };
        const spdx = body.license?.spdx_id?.trim();
        if (!spdx || spdx === 'NOASSERTION') {
          result = { kind: 'unknown', reason: 'github reported NOASSERTION' };
        } else {
          result = { kind: 'resolved', spdx, source: 'github' };
        }
      }
    } catch (err) {
      if (err instanceof HttpError) {
        result = { kind: 'unknown', reason: `github error ${err.status}` };
      } else {
        result = { kind: 'unknown', reason: `github fetch failed: ${(err as Error).message}` };
      }
    }
    if (!isTransientFailure(result)) await this.writeCache(key, result);
    return result;
  }

  /**
   * Convenience: try GitHub first, then fall back to a license value
   * already pulled from npm metadata. Lets callers avoid wiring two
   * resolvers separately.
   */
  async resolve(opts: {
    repoUrl?: string;
    npmFallback?: string | null;
  }): Promise<LicenseLookup> {
    const gh = await this.resolveForGitHub(opts.repoUrl);
    if (gh.kind === 'resolved') return gh;
    if (opts.npmFallback) {
      const cleaned = normalizeSpdx(opts.npmFallback);
      if (cleaned) return { kind: 'resolved', spdx: cleaned, source: 'npm-fallback' };
    }
    return gh;
  }

  private cachePath(key: string): string | null {
    if (!this.opts.cacheDir) return null;
    return join(this.opts.cacheDir, `${key}.json`);
  }

  private async readCache(key: string): Promise<LicenseLookup | null> {
    const path = this.cachePath(key);
    if (!path) return null;
    try {
      const st = await stat(path);
      if (Date.now() - st.mtimeMs > CACHE_TTL_MS) return null;
      const raw = await readFile(path, 'utf8');
      const entry = JSON.parse(raw) as CacheEntry;
      return entry.result;
    } catch {
      return null;
    }
  }

  private async writeCache(key: string, result: LicenseLookup): Promise<void> {
    const path = this.cachePath(key);
    if (!path) return;
    const entry: CacheEntry = { result, fetchedAt: Date.now() };
    await ensureDir(path);
    // Trailing newline + LF — matches the rest of the codebase's
    // formatter convention so a future biome scan that includes the
    // cache (e.g. via `--no-ignore`) doesn't trip on every entry.
    await writeFile(path, `${JSON.stringify(entry, null, 2)}\n`, 'utf8');
  }
}

export function isPermissive(spdx: string): boolean {
  return PERMISSIVE_LICENSES.has(spdx);
}

/** Best-effort SPDX normalization — handles `MIT License`, `mit`, etc. */
export function normalizeSpdx(raw: string): string | null {
  const cleaned = raw.trim();
  if (!cleaned) return null;
  // Common npm license shapes: "MIT", "MIT License", "(MIT OR Apache-2.0)".
  const m = /^\(?([A-Za-z0-9.\-+]+)\b/.exec(cleaned);
  if (!m) return null;
  let spdx = m[1] ?? '';
  // Capitalize known SPDX shapes.
  if (/^mit$/i.test(spdx)) spdx = 'MIT';
  else if (/^isc$/i.test(spdx)) spdx = 'ISC';
  else if (/^apache-2\.0$/i.test(spdx)) spdx = 'Apache-2.0';
  return spdx;
}

export function parseGitHubOwnerRepo(
  url: string | undefined,
): { owner: string; repo: string } | null {
  if (!url) return null;
  const m = /github\.com[/:]([^/]+)\/([^/.\s]+)(?:\.git)?\/?/i.exec(url);
  if (!m) return null;
  const [, owner, repo] = m;
  if (!owner || !repo) return null;
  return { owner, repo };
}
