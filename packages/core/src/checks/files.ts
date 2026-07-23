import type { CheckResult, WorkspaceLike } from './types.js';

/**
 * File-fact checks: sizes, counts, CSS volume, content patterns. Ported
 * verbatim from service/src/tasks/gate-eval.ts so the failure prose
 * users see is byte-identical wherever a check runs.
 */

export async function fileMinBytes(
  ws: WorkspaceLike,
  file: string,
  bytes: number,
  trim = false,
): Promise<CheckResult> {
  const content = await ws.read(file);
  const n = (trim ? content?.trim() : content)?.length ?? 0;
  return n >= bytes
    ? { ok: true, detail: `${file} is ${n} bytes` }
    : { ok: false, detail: `${file} is ${n} bytes, need ≥ ${bytes}` };
}

export async function fileMinLines(
  ws: WorkspaceLike,
  file: string,
  minLines: number,
): Promise<CheckResult> {
  const content = await ws.read(file);
  const lines = (content ?? '').split('\n').filter((l) => l.trim().length > 0).length;
  return lines >= minLines
    ? { ok: true, detail: `${file} has ${lines} non-blank lines` }
    : { ok: false, detail: `${file} has ${lines} non-blank line(s), need ≥ ${minLines}` };
}

export async function totalMinBytes(
  ws: WorkspaceLike,
  files: string[],
  bytes: number,
): Promise<CheckResult> {
  let total = 0;
  for (const f of files) total += (await ws.read(f))?.length ?? 0;
  return total >= bytes
    ? { ok: true, detail: `${files.join(' + ')} total ${total} bytes` }
    : { ok: false, detail: `${files.join(' + ')} total ${total} bytes, need ≥ ${bytes}` };
}

export async function fileCountByExt(
  ws: WorkspaceLike,
  ext: string[],
  min: number,
  dir?: string,
): Promise<CheckResult & { matched: string[] }> {
  const all = await ws.list();
  const exts = new Set(ext.map((e) => e.toLowerCase().replace(/^\./, '')));
  const dirPrefix = dir ? `${dir.toLowerCase().replace(/\/+$/, '')}/` : null;
  const matched = all.filter((p) => {
    const lower = p.toLowerCase();
    if (dirPrefix && !lower.startsWith(dirPrefix)) return false;
    return exts.has(lower.split('.').pop() ?? '');
  });
  return matched.length >= min
    ? { ok: true, detail: `found ${matched.length} ${ext.join('/')} file(s)`, matched }
    : {
        ok: false,
        detail: `found ${matched.length} ${ext.join('/')} file(s), need ≥ ${min}`,
        matched,
      };
}

/**
 * `<style>` blocks + inline `style=""` attributes + linked local
 * stylesheets in `file` total ≥ `bytes`. Style attributes count because a
 * fully-inline-styled page is real CSS work — ignoring them false-failed
 * valid pages that never opened a `<style>` block.
 */
export async function cssMinBytes(
  ws: WorkspaceLike,
  bytes: number,
  file = 'index.html',
): Promise<CheckResult> {
  const html = (await ws.read(file)) ?? '';
  let css = 0;
  for (const m of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
    css += (m[1] ?? '').trim().length;
  }
  for (const m of html.matchAll(/\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    css += (m[1] ?? m[2] ?? '').trim().length;
  }
  for (const m of html.matchAll(
    /<link\b[^>]*rel=["']?stylesheet["']?[^>]*href=["']([^"']+)["']/gi,
  )) {
    const href = m[1];
    if (href && !/^https?:/i.test(href)) {
      css += (await ws.read(href.replace(/^\.?\//, '')))?.length ?? 0;
    }
  }
  return css >= bytes
    ? { ok: true, detail: `CSS is ${css} bytes (inline + linked in ${file})` }
    : { ok: false, detail: `CSS is ${css} bytes (inline + linked in ${file}), need ≥ ${bytes}` };
}

export async function containsPattern(
  ws: WorkspaceLike,
  file: string,
  pattern: string,
  flags?: string,
  label?: string,
): Promise<CheckResult> {
  const content = await ws.read(file);
  if (content === null) return { ok: false, detail: `${file} not found` };
  let re: RegExp;
  try {
    re = new RegExp(pattern, flags);
  } catch {
    return { ok: false, detail: `invalid gate pattern /${pattern}/` };
  }
  const target = label ? `: ${label}` : ` /${pattern}/`;
  // A non-match has nothing to quote, so quote the requirement plus what
  // WAS observed (size) — "nothing in its N bytes matches /X/" reads as a
  // concrete gap where "missing required content" reads as a rule.
  return re.test(content)
    ? { ok: true, detail: `${file} contains required content${target}` }
    : {
        ok: false,
        detail: `${file} is missing required content${target} — nothing in its ${content.length} bytes matches${label ? ` /${pattern}/` : ''}. Add that content.`,
      };
}

export async function notContainsPattern(
  ws: WorkspaceLike,
  file: string,
  pattern: string,
  flags?: string,
  label?: string,
): Promise<CheckResult> {
  const content = await ws.read(file);
  if (content === null) return { ok: false, detail: `${file} not found` };
  let re: RegExp;
  try {
    re = new RegExp(pattern, flags);
  } catch {
    return { ok: false, detail: `invalid gate pattern /${pattern}/` };
  }
  const match = re.exec(content);
  const target = label ? `: ${label}` : ` /${pattern}/`;
  const matchedText = match?.[0]?.replace(/\s+/g, ' ').slice(0, 180);
  const matchedSuffix = label && matchedText ? ` (matched "${matchedText}")` : '';
  return match
    ? { ok: false, detail: `${file} contains forbidden content${target}${matchedSuffix}` }
    : { ok: true, detail: `${file} excludes forbidden content${target}` };
}

/**
 * Grep-returns-results across the workspace: at least `minMatches` files
 * (optionally under `dir`, optionally filtered to `ext`) whose content
 * matches `pattern`.
 */
export async function grepMatches(
  ws: WorkspaceLike,
  pattern: string,
  opts: { dir?: string; ext?: string[]; flags?: string; minMatches?: number } = {},
): Promise<CheckResult & { matched: string[] }> {
  const min = opts.minMatches ?? 1;
  let re: RegExp;
  try {
    re = new RegExp(pattern, opts.flags);
  } catch {
    return { ok: false, detail: `invalid grep pattern /${pattern}/`, matched: [] };
  }
  const dirPrefix = opts.dir ? `${opts.dir.toLowerCase().replace(/\/+$/, '')}/` : null;
  const exts = opts.ext?.length
    ? new Set(opts.ext.map((e) => e.toLowerCase().replace(/^\./, '')))
    : null;
  const matched: string[] = [];
  for (const p of await ws.list()) {
    const lower = p.toLowerCase();
    if (dirPrefix && !lower.startsWith(dirPrefix)) continue;
    if (exts && !exts.has(lower.split('.').pop() ?? '')) continue;
    const content = await ws.read(p);
    if (content !== null && re.test(content)) {
      matched.push(p);
      // Keep scanning only while the verdict could still change or the
      // caller benefits from a few example paths.
      if (matched.length >= Math.max(min, 5)) break;
    }
  }
  return matched.length >= min
    ? { ok: true, detail: `${matched.length} file(s) match /${pattern}/`, matched }
    : {
        ok: false,
        detail: `${matched.length} file(s) match /${pattern}/, need ≥ ${min}`,
        matched,
      };
}
