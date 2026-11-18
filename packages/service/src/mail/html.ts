/**
 * HTML email body → markdown. Prefers squisq's `htmlToMarkdown` importer (the
 * canonical, sanitized converter that reuses parse5 + the squisq HTML
 * sanitizer); falls back to a compact in-process converter when the installed
 * squisq build predates that export (it ships in a later squisq release / when
 * linked locally). The fallback still sanitizes by stripping script/style and
 * dangerous attributes before flattening.
 */

import { createLogger } from '@bendyline/gezel';

const log = createLogger('mail');

let squisqHtmlToMarkdown: ((html: string) => string) | null | undefined;

/** Resolve squisq's htmlToMarkdown once (or learn it isn't available). */
async function resolveSquisq(): Promise<((html: string) => string) | null> {
  if (squisqHtmlToMarkdown !== undefined) return squisqHtmlToMarkdown;
  try {
    const fmt = (await import('@bendyline/squisq-formats')) as unknown as {
      htmlToMarkdown?: (html: string, opts?: { sanitize?: boolean }) => string;
    };
    squisqHtmlToMarkdown =
      typeof fmt.htmlToMarkdown === 'function' ? (html) => fmt.htmlToMarkdown!(html) : null;
    if (!squisqHtmlToMarkdown) {
      log.info('squisq htmlToMarkdown not available; using built-in HTML fallback');
    }
  } catch {
    squisqHtmlToMarkdown = null;
  }
  return squisqHtmlToMarkdown;
}

/** Convert an HTML email body to markdown. */
export async function htmlBodyToMarkdown(html: string): Promise<string> {
  const squisq = await resolveSquisq();
  if (squisq) {
    try {
      return squisq(html);
    } catch (err) {
      log.warn(`squisq htmlToMarkdown failed; falling back: ${err}`);
    }
  }
  return fallbackHtmlToMarkdown(html);
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
};

function decodeEntities(s: string): string {
  return s
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (m) => ENTITIES[m] ?? m)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(Number.parseInt(h, 16)));
}

/**
 * Minimal HTML→markdown used when squisq's importer is missing or refuses the
 * input (it refuses anything over 16 MiB). Strips dangerous elements, maps a
 * handful of common tags, and flattens the rest.
 *
 * The input is a stranger's email or feed, so every step is linear: the
 * earlier regexes (`[\s\S]*?` up to a closing tag, `[^>]*` with no `>` in
 * sight) rescanned the rest of the document from every unclosed tag, and a
 * crafted 17 MB message blocked the daemon for an hour.
 */
export function fallbackHtmlToMarkdown(html: string): string {
  // Drop script/style/head wholesale (content must not leak).
  let s = dropElements(html, /<(script|style|head|noscript|template)\b/g);
  // Block separators → newlines.
  s = s.replace(/<\/(p|div|h[1-6]|li|tr|blockquote|table|ul|ol)\s*>/gi, '\n');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<li\b[^<>]*>/gi, '- ');
  // Links → "text (url)".
  s = convertLinks(s);
  // Emphasis, tag by tag (pairing tags would need the rescans above).
  s = s.replace(/<\/?(?:strong|b)\b[^<>]*>/gi, '**');
  s = s.replace(/<\/?(?:em|i)\b[^<>]*>/gi, '*');
  s = decodeEntities(stripTags(s));
  return s
    .split('\n')
    .map(trimTrailingBlanks)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** `line` without trailing spaces and tabs (`/[ \t]+$/` is quadratic on a long run). */
function trimTrailingBlanks(line: string): string {
  let end = line.length;
  while (end > 0 && (line[end - 1] === ' ' || line[end - 1] === '\t')) end--;
  return end === line.length ? line : line.slice(0, end);
}

/**
 * Remove each element `open` matches through its closing tag, in one forward
 * scan. An element that never closes takes the rest of the document with it.
 */
function dropElements(html: string, open: RegExp): string {
  const lower = html.toLowerCase();
  let out = '';
  let at = 0;
  for (;;) {
    open.lastIndex = at;
    const m = open.exec(lower);
    if (!m) return out + html.slice(at);
    out += html.slice(at, m.index);
    const close = lower.indexOf(`</${m[1]}`, m.index + m[0].length);
    if (close < 0) return out;
    const end = lower.indexOf('>', close);
    if (end < 0) return out;
    at = end + 1;
  }
}

/** `<a href="url">text</a>` → `text (url)`, in one forward scan. */
function convertLinks(s: string): string {
  const lower = s.toLowerCase();
  const openTag = /<a\b[^<>]*>/g;
  const closeTag = /<\/a\s*>/g;
  let out = '';
  let at = 0;
  for (;;) {
    openTag.lastIndex = at;
    const open = openTag.exec(lower);
    if (!open) return out + s.slice(at);
    closeTag.lastIndex = open.index + open[0].length;
    const close = closeTag.exec(lower);
    if (!close) return out + s.slice(at);
    out += s.slice(at, open.index);
    const tag = s.slice(open.index, open.index + open[0].length);
    const text = stripTags(s.slice(open.index + open[0].length, close.index)).trim();
    const url = /\bhref\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1];
    if (!url || /^\s*(?:javascript|data):/i.test(url)) out += text;
    else out += text && text !== url ? `${text} (${url})` : url;
    at = close.index + close[0].length;
  }
}

function stripTags(s: string): string {
  return s.replace(/<[^<>]+>/g, '');
}
