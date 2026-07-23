/**
 * Reference-resolution checks: do the things a document points at
 * actually exist? Ported from the petShop eval sniff
 * (evals/src/success-check.ts) — its "working image link" rule caught
 * the most common broken-deliverable mode: assets generated but linked
 * from the wrong path.
 */

export const IMG_EXT = /\.(png|jpe?g|webp|gif|svg)$/i;

/**
 * Resolve a relative path against a base file's directory using POSIX
 * semantics (`..` walks up, `.` is no-op, leading `/` is project root).
 * Returns null for external/anchor/data refs or paths escaping the root.
 */
export function resolveRelative(basePath: string, srcRaw: string): string | null {
  if (/^(?:[a-z]+:|\/\/|#|data:|mailto:)/i.test(srcRaw)) return null;
  const src = srcRaw.replace(/[?#].*$/, '').trim();
  if (!src) return null;
  if (src.startsWith('/')) return src.slice(1);
  const baseDirParts = basePath.split(/[\\/]+/);
  baseDirParts.pop();
  const parts = src.split(/[\\/]+/);
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (baseDirParts.length === 0) return null;
      baseDirParts.pop();
    } else {
      baseDirParts.push(part);
    }
  }
  return baseDirParts.join('/');
}

/** Every `<img src="…">` value in document order. */
export function findImageRefs(html: string): string[] {
  const refs: string[] = [];
  for (const m of html.matchAll(/<img\b[^>]*\bsrc\s*=\s*("([^"]+)"|'([^']+)')/gi)) {
    const src = m[2] ?? m[3];
    if (src) refs.push(src);
  }
  return refs;
}

export interface ImageRefsReport {
  ok: boolean;
  detail: string;
  /** Refs that point at image files which do NOT exist in the project. */
  broken: string[];
  /** Count of refs that resolve to real files. */
  working: number;
  /** Total image-shaped refs found. */
  total: number;
}

/**
 * Check that `<img>` refs in `html` resolve to real files.
 * `requireAll: false` (default) = at least one working image ref;
 * `true` = every image-shaped ref must resolve.
 */
export function imageRefsResolve(
  html: string,
  htmlPath: string,
  projectFiles: readonly string[],
  requireAll = false,
): ImageRefsReport {
  const fileSet = new Set(projectFiles.map((p) => p.replace(/\\/g, '/')));
  const refs = findImageRefs(html).filter((src) => IMG_EXT.test(src.replace(/[?#].*$/, '')));
  const broken: string[] = [];
  let working = 0;
  for (const src of refs) {
    const resolved = resolveRelative(htmlPath, src);
    if (resolved !== null && fileSet.has(resolved)) working++;
    else broken.push(src);
  }
  const ok = requireAll ? refs.length > 0 && broken.length === 0 : working > 0;
  const detail = ok
    ? `${working}/${refs.length} image ref(s) resolve`
    : refs.length === 0
      ? `${htmlPath} has no image references`
      : `${broken.length} image ref(s) point at missing files: ${broken.slice(0, 4).join(', ')}`;
  return { ok, detail, broken, working, total: refs.length };
}
