import type { WorkspaceLike } from './types.js';

/**
 * Existence oracle for cited workspace paths — the shared spine of the
 * anti-fabrication checks (`citationsResolve`, `securityReport`,
 * `codebaseReviewReport`).
 *
 * `list()` is only a FAST PATH here, never ground truth. The real surface
 * behind it walks the workspace breadth-first under an entry cap (500 on
 * the service side) and skips dotfiles, so in any repo bigger than the cap
 * a truthful citation (`packages/core/src/paths.ts`, `.gitignore`) is
 * simply absent from the listing. Treating that absence as fabrication
 * made the gates unsatisfiable by honest citation and pressured models
 * toward exactly the shallow or invented paths the gates exist to catch
 * (task gezel/8, 2026-08-23: a 3,843-file repo where only the first 500
 * entries counted as "real"). A listing miss therefore falls back to a
 * per-path `read()` probe before any path may be called fabricated.
 */
export function createCitedPathChecker(ws: WorkspaceLike): (cited: string) => Promise<boolean> {
  let listing: Promise<Set<string>> | null = null;
  const probes = new Map<string, Promise<boolean>>();
  const loadListing = () => {
    listing ??= ws.list().then((files) => new Set(files.map((f) => citedPathKey(f))));
    return listing;
  };
  return async (cited) => {
    const probe = cleanCitedPath(cited);
    if (!probe) return false;
    if ((await loadListing()).has(probe.toLowerCase())) return true;
    let hit = probes.get(probe);
    if (!hit) {
      hit = ws.read(probe).then(
        (content) => content !== null,
        () => false,
      );
      probes.set(probe, hit);
    }
    return hit;
  };
}

/**
 * Strip citation decoration down to a workspace-relative path: backticks,
 * a `:line` / `#anchor` suffix, leading `./` or `/`, and a `workspace/`
 * prefix. Case is preserved — the probe read needs the real path on
 * case-sensitive filesystems; only the listing key lowercases.
 */
export function cleanCitedPath(p: string): string {
  return p
    .trim()
    .replace(/^`+|`+$/g, '')
    .replace(/[:#].*$/, '')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .replace(/^workspace\//i, '');
}

/** Case-insensitive membership key for listing entries and citations alike. */
export function citedPathKey(p: string): string {
  return cleanCitedPath(p).toLowerCase();
}
