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
 * Minimal HTML→markdown used only when squisq's importer isn't present. Strips
 * dangerous elements, maps a handful of common tags, and flattens the rest.
 */
export function fallbackHtmlToMarkdown(html: string): string {
  let s = html;
  // Drop script/style/head wholesale (content must not leak).
  s = s.replace(/<(script|style|head|noscript|template)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  // Block separators → newlines.
  s = s.replace(/<\/(p|div|h[1-6]|li|tr|blockquote|table|ul|ol)>/gi, '\n');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<li\b[^>]*>/gi, '- ');
  // Links → "text (url)".
  s = s.replace(/<a\b[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, text) => {
    const t = stripTags(text).trim();
    const url = String(href);
    if (url.startsWith('javascript:') || url.startsWith('data:')) return t;
    return t && t !== url ? `${t} (${url})` : url;
  });
  // Emphasis.
  s = s.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**');
  s = s.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, '*$2*');
  // Strip remaining tags.
  s = stripTags(s);
  s = decodeEntities(s);
  return s
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, '');
}
