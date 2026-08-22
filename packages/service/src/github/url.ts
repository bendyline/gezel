/**
 * Parse and normalize GitHub repo URLs. Accepts the three common forms:
 *   - https://github.com/owner/repo[.git][/...]
 *   - git@github.com:owner/repo[.git]
 *   - github.com/owner/repo
 *
 * Returns null if the URL clearly isn't a GitHub repo. We deliberately
 * keep this narrow — enterprise GitHub hosts (host !== github.com) are
 * supported but flagged via `host` so callers can decide what to do.
 */

export interface ParsedGitHubUrl {
  host: string;
  owner: string;
  repo: string;
  /** Canonical https URL with `.git` stripped, no trailing slash. */
  canonical: string;
  /** Form suitable for `git clone` (with `.git`). */
  cloneUrl: string;
}

const SSH_RE = /^git@([^:]+):([^/]+)\/(.+?)(?:\.git)?\/?$/i;
const HTTPS_RE = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?\/?(?:[?#].*)?$/i;
const SCHEMELESS_RE = /^([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/;

export function parseGitHubUrl(input: string): ParsedGitHubUrl | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  let host: string | null = null;
  let owner: string | null = null;
  let repo: string | null = null;
  const ssh = SSH_RE.exec(trimmed);
  if (ssh) {
    host = ssh[1]!;
    owner = ssh[2]!;
    repo = ssh[3]!;
  } else {
    const https = HTTPS_RE.exec(trimmed);
    if (https) {
      // Userinfo is never part of repository identity. Normalize it away
      // so a pasted credential-bearing URL cannot reach git argv or be
      // persisted as origin by callers that use the canonical clone URL.
      const authority = https[1]!;
      host = authority.slice(authority.lastIndexOf('@') + 1);
      owner = https[2]!;
      repo = https[3]!;
    } else {
      const bare = SCHEMELESS_RE.exec(trimmed);
      if (bare && bare[1]!.includes('.')) {
        host = bare[1]!;
        owner = bare[2]!;
        repo = bare[3]!;
      }
    }
  }
  if (!host || !owner || !repo) return null;
  // Reject obviously wrong owner/repo shapes (path segments can't have dots in
  // the host position only).
  if (!/^[A-Za-z0-9._-]+$/.test(owner) || !/^[A-Za-z0-9._-]+$/.test(repo)) return null;
  const canonical = `https://${host}/${owner}/${repo}`;
  const cloneUrl = `${canonical}.git`;
  return { host, owner, repo, canonical, cloneUrl };
}

/**
 * Compare two URLs as if normalized via parseGitHubUrl. Used to detect when
 * a workingDir's `origin` already points at the project's configured repo.
 */
export function sameGitHubRepo(a: string, b: string): boolean {
  const pa = parseGitHubUrl(a);
  const pb = parseGitHubUrl(b);
  if (!pa || !pb) return false;
  return (
    pa.host.toLowerCase() === pb.host.toLowerCase() &&
    pa.owner.toLowerCase() === pb.owner.toLowerCase() &&
    pa.repo.toLowerCase() === pb.repo.toLowerCase()
  );
}

/**
 * Stable directory key for shared bare clones (Phase 3). Two URLs that
 * normalize to the same repo produce the same key, so multiple projects
 * referencing the same git URL share one bare clone. Format:
 * `<host>-<owner>-<repo>-<8-char-hash>` for github-shaped URLs;
 * `local-<8-char-hash>` for filesystem paths and other non-github
 * git URLs. The hash disambiguates between repos whose owner/repo
 * collide across hosts (rare but possible with enterprise github);
 * the human-readable prefix keeps the directory name greppable from
 * `ls ~/.gezel/git-clones/`.
 *
 * Returns null only when the URL is empty or whitespace-only — every
 * non-empty string gets SOME key so callers don't have to special-case
 * non-github sources (local repos, gitea, gitlab, etc.).
 */
export function sharedCloneKey(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return null;
  const parsed = parseGitHubUrl(trimmed);
  if (parsed) {
    const slug = `${parsed.host}-${parsed.owner}-${parsed.repo}`
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '');
    // Hash the lowercased canonical so case variants (BendyLine vs
    // bendyline) collapse to the same key — matches `sameGitHubRepo`'s
    // case-insensitive comparison.
    const hash = hashUrl(parsed.canonical.toLowerCase()).slice(0, 8);
    return `${slug}-${hash}`;
  }
  // Non-github git URL (local path, ssh-elsewhere, gitlab, etc.).
  // Hash the URL as-is — case-sensitive because filesystem paths are.
  const hash = hashUrl(trimmed).slice(0, 8);
  return `local-${hash}`;
}

function hashUrl(canonical: string): string {
  // Simple FNV-1a-style hash, 32-bit. We only need 8 hex chars of
  // collision-resistance across a user's projects, not crypto.
  let h = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i++) {
    h ^= canonical.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
