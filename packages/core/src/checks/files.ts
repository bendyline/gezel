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

/**
 * Real-image predicate for the raster formats an image deliverable can
 * plausibly be. Magic bytes AND a size floor: a bare header is exactly as
 * gameable as a filename, and a 1 KiB floor rejects placeholders while
 * accepting aggressively optimized real assets. Lifted from the petshop
 * scenario so the eval sniff and the runtime gate share one definition.
 */
export function isValidRasterAsset(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  const containsAscii = (token: string): boolean => {
    const wanted = [...token].map((char) => char.charCodeAt(0));
    outer: for (let i = 0; i <= bytes.length - wanted.length; i++) {
      for (let j = 0; j < wanted.length; j++) {
        if (bytes[i + j] !== wanted[j]) continue outer;
      }
      return true;
    }
    return false;
  };
  const ascii = (from: number, to: number): string =>
    String.fromCharCode(...bytes.slice(from, to));
  const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every(
    (value, index) => bytes[index] === value,
  );
  const png =
    pngSignature && ascii(12, 16) === 'IHDR' && containsAscii('IDAT') && containsAscii('IEND');
  const jpeg =
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff &&
    bytes[bytes.length - 2] === 0xff &&
    bytes[bytes.length - 1] === 0xd9;
  const gif =
    (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a') &&
    bytes.includes(0x2c) &&
    bytes[bytes.length - 1] === 0x3b;
  const webp =
    ascii(0, 4) === 'RIFF' &&
    ascii(8, 12) === 'WEBP' &&
    ['VP8 ', 'VP8L', 'VP8X'].includes(ascii(12, 16));
  return bytes.length >= 1024 && (png || jpeg || gif || webp);
}

/** Extensions `verifyImageBytes` validates; others (e.g. svg, text) pass through. */
const RASTER_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);

export async function fileCountByExt(
  ws: WorkspaceLike,
  ext: string[],
  min: number,
  dir?: string,
  opts?: { verifyImageBytes?: boolean },
): Promise<CheckResult & { matched: string[] }> {
  const all = await ws.list();
  const exts = new Set(ext.map((e) => e.toLowerCase().replace(/^\./, '')));
  const dirPrefix = dir ? `${dir.toLowerCase().replace(/\/+$/, '')}/` : null;
  let matched = all.filter((p) => {
    const lower = p.toLowerCase();
    if (dirPrefix && !lower.startsWith(dirPrefix)) return false;
    return exts.has(lower.split('.').pop() ?? '');
  });

  // Filename-only matching counts a text stub named `panel-1.png`. When
  // the caller asks for byte verification, drop raster candidates whose
  // bytes aren't a real image. Non-raster extensions (svg is text) are
  // never dropped. Without a byte reader the check REFUSES rather than
  // silently degrading to the gameable behavior it exists to replace.
  let unverifiable = false;
  if (opts?.verifyImageBytes) {
    const readBytes = ws.readBytes?.bind(ws);
    if (!readBytes) {
      unverifiable = true;
    } else {
      const verdicts = await Promise.all(
        matched.map(async (p) => {
          const fileExt = p.toLowerCase().split('.').pop() ?? '';
          if (!RASTER_EXTS.has(fileExt)) return true;
          const bytes = await readBytes(p).catch(() => null);
          return bytes !== null && isValidRasterAsset(bytes);
        }),
      );
      matched = matched.filter((_, i) => verdicts[i]);
    }
  }
  if (unverifiable) {
    return {
      ok: false,
      detail: `cannot verify image bytes for ${ext.join('/')} files — this workspace view serves no binary reads, so the count would only prove filenames exist`,
      matched,
    };
  }
  // Name the directory in both verdicts. A bare "found 0 md file(s)"
  // gives a repairing model (and the repair-loop's target picker) nothing
  // to aim at — it fixates on whichever deliverable happens to be first.
  // Wild-caught: memory-prompt-session wrote the session record into the
  // index JSON while every nudge kept pointing at report.md.
  const where = dir ? ` in ${dir.replace(/\/+$/, '')}/` : '';
  const verified = opts?.verifyImageBytes ? ' real (byte-verified)' : '';
  const stubNote = opts?.verifyImageBytes
    ? ' A file with an image name but placeholder/text bytes does not count — generate the actual image.'
    : '';
  return matched.length >= min
    ? {
        ok: true,
        detail: `found ${matched.length}${verified} ${ext.join('/')} file(s)${where}`,
        matched,
      }
    : {
        ok: false,
        detail: `found ${matched.length}${verified} ${ext.join('/')} file(s)${where}, need ≥ ${min} — create the missing ${ext[0] ?? ''} file(s)${where ? ` under ${dir!.replace(/\/+$/, '')}/` : ''}.${stubNote}`,
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
