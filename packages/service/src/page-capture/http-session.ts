/**
 * Text-only capture: a plain download of the page's HTML, with no browser.
 * Used where no sandboxed browser can run (store builds, a container without
 * a seccomp profile, a failed launch check) and when the person turned the
 * browser off for a connection. Records say `render: http` and carry no
 * screenshots. Script-built pages come back thin here; the Connections row
 * says so rather than pretending.
 *
 * The transport follows redirects by hand and checks every hop: http(s) only,
 * no credentials in the address, and no private, loopback or link-local
 * target unless the person typed that host. DNS rebinding is not closed in
 * this mode (the browser's proxy closes it); the same limitation as
 * `fetch_url`, recorded in docs/website-connector.md.
 */

import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { createAwakeTimeout, normalizePageUrl, scopeOfUrl } from '@bendyline/gezel';
import { htmlBodyToMarkdown } from '../mail/html.js';
import {
  SsrfError,
  assertNotLoopbackOrMetadata,
  assertPublicUrl,
  isPrivateAddress,
} from '../utils/ssrf.js';
import type {
  CaptureFailure,
  CaptureSession,
  CaptureSessionOptions,
  FoundLink,
  PageCaptureOutcome,
  PageCaptureRequest,
} from './types.js';

export const PAGE_USER_AGENT =
  'Mozilla/5.0 (compatible; Gezel/1.0; +https://gezel.com) website connector';
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 30_000;
const MAX_LINKS = 600;

export interface HttpFetchResult {
  status: number;
  finalUrl: string;
  headers: Headers;
  body: string;
}

export class HttpCaptureSession implements CaptureSession {
  readonly render = 'http' as const;

  constructor(
    private readonly opts: CaptureSessionOptions,
    private readonly fetchImpl: typeof fetch = fetch,
    readonly browserUnavailableReason?: string,
  ) {}

  async capture(req: PageCaptureRequest): Promise<PageCaptureOutcome> {
    let res: HttpFetchResult;
    try {
      res = await safeFetchPage(req.url, {
        privateHosts: this.opts.privateHosts,
        fetchImpl: this.fetchImpl,
        ...(this.opts.signal ? { signal: this.opts.signal } : {}),
        ...(req.etag ? { etag: req.etag } : {}),
        ...(req.lastModified ? { lastModified: req.lastModified } : {}),
      });
    } catch (err) {
      if (err instanceof SsrfError)
        return fail('failed', 'This address points at a private or local network address.');
      const message = err instanceof Error ? err.message : String(err);
      return fail('failed', `The page did not load: ${message.slice(0, 160)}`);
    }
    return pageFromHtml(res, req);
  }

  async close(): Promise<void> {}
}

function fail(
  kind: CaptureFailure['kind'],
  message: string,
  extra: Partial<CaptureFailure> = {},
): CaptureFailure {
  return { ok: false, kind, message, ...extra };
}

/**
 * Turn a downloaded HTML page into a capture. Shared by the text-only session
 * and the browser session's conditional pre-check.
 */
export async function pageFromHtml(
  res: HttpFetchResult,
  req: PageCaptureRequest,
): Promise<PageCaptureOutcome> {
  const { status, finalUrl } = res;
  if (status === 304)
    return fail('not-modified', 'Unchanged since the last visit.', { status, finalUrl });
  if (status === 404 || status === 410)
    return fail('gone', 'The site says this page no longer exists.', { status, finalUrl });
  if (status === 429 || status === 503) {
    const retry = Number(res.headers.get('retry-after'));
    return fail('rate-limited', 'The site asked us to slow down.', {
      status,
      finalUrl,
      ...(Number.isFinite(retry) && retry > 0 ? { retryAfterSec: Math.min(retry, 86_400) } : {}),
    });
  }
  if (status === 401 || status === 403) {
    return fail(
      'blocked',
      'The site refused the visit (it may need a sign-in or block automated visits).',
      { status, finalUrl },
    );
  }
  if (status >= 400)
    return fail('failed', `The site answered with an error (${status}).`, { status, finalUrl });
  const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
  if (contentType && !contentType.includes('html')) {
    return fail('not-a-page', 'This address is a file, not a web page.', { status, finalUrl });
  }
  if (req.scopes && req.scopes.length > 0 && !scopeOfUrl(finalUrl, req.scopes)) {
    return fail('left-scope', 'The address redirected outside the site.', { status, finalUrl });
  }
  const html = res.body;
  const title = decodeEntities(firstMatch(html, /<title[^>]*>([\s\S]*?)<\/title>/i) ?? '').trim();
  const meta = (name: string): string | undefined => {
    const re = new RegExp(
      `<meta[^>]+(?:name|property)=["']${name}["'][^>]*content=["']([^"']*)["']|<meta[^>]+content=["']([^"']*)["'][^>]*(?:name|property)=["']${name}["']`,
      'i',
    );
    const m = re.exec(html);
    const v = m?.[1] ?? m?.[2];
    return v ? decodeEntities(v).trim().slice(0, 1000) : undefined;
  };
  const metadata = {
    title: meta('og:title') ?? title,
    ...optional('description', meta('description') ?? meta('og:description')),
    ...optional('siteName', meta('og:site_name')),
    ...optional('lang', firstMatch(html, /<html[^>]*\blang=["']([^"']+)["']/i)),
    ...optional('published', meta('article:published_time')),
    ...optional('modified', meta('article:modified_time')),
    ...optional('author', meta('author')),
    ...optional('type', meta('og:type')),
  };
  if (
    /just a moment|attention required|checking your browser|captcha/i.test(title) &&
    html.length < 60_000
  ) {
    return fail('blocked', 'The site showed a bot check instead of the page.', {
      status,
      finalUrl,
    });
  }
  const main = mainHtml(html);
  const markdown = absolutizeMarkdownLinks(await htmlBodyToMarkdown(main), finalUrl);
  const words = markdown
    .replace(/\]\([^)]*\)/g, ']')
    .split(/\s+/)
    .filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  const passwordField = /<input\b[^>]*\btype=["']?password\b/i.test(html);
  if (passwordField && words < 120) {
    return fail('blocked', 'The site asked for a sign-in instead of showing the page.', {
      status,
      finalUrl,
    });
  }
  const etag = res.headers.get('etag');
  const lastModified = res.headers.get('last-modified');
  return {
    ok: true,
    finalUrl,
    status,
    render: 'http',
    metadata,
    markdown,
    method: 'text',
    words,
    links: linksOf(html, finalUrl),
    screenshots: [],
    images: [],
    hiddenElements: 0,
    ...(passwordField ? { passwordField: true } : {}),
    ...(etag ? { etag } : {}),
    ...(lastModified ? { lastModified } : {}),
    staticText: true,
  };
}

function optional<K extends string>(key: K, value: string | undefined): Partial<Record<K, string>> {
  return value ? ({ [key]: value } as Record<K, string>) : {};
}

function firstMatch(s: string, re: RegExp): string | undefined {
  return re.exec(s)?.[1];
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'",
};
function decodeEntities(s: string): string {
  return s
    .replace(/&(amp|lt|gt|quot|apos|nbsp|#39);/g, (_, k: string) => ENTITIES[k] ?? _)
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(Number.parseInt(h, 16)));
}

/**
 * The page's main content without a browser: `<main>`, else a single
 * `<article>`, else the body without its header, navigation, footer and
 * asides. Elements marked hidden in the markup are dropped (styles cannot be
 * computed here, so this is best effort).
 */
export function mainHtml(html: string): string {
  let s = html.slice(0, MAX_BYTES);
  // A <form> stays: some sites wrap the whole page in one.
  s = s.replace(
    /<(script|style|noscript|template|svg|iframe|select|textarea|button)\b[\s\S]*?<\/\1>/gi,
    ' ',
  );
  s = s.replace(
    /<([a-z][a-z0-9]*)\b[^>]*\b(hidden|aria-hidden=["']true["']|style=["'][^"']*(display\s*:\s*none|visibility\s*:\s*hidden)[^"']*["'])[^>]*>[\s\S]*?<\/\1>/gi,
    ' ',
  );
  const main = /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(s)?.[1];
  if (main && main.replace(/<[^>]+>/g, '').trim().length > 200) return main;
  const articles = s.match(/<article\b[^>]*>[\s\S]*?<\/article>/gi);
  if (articles && articles.length === 1) return articles[0]!;
  const body = /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(s)?.[1] ?? s;
  return body.replace(/<(header|nav|footer|aside)\b[\s\S]*?<\/\1>/gi, ' ');
}

/** Visible-ish links, absolute, deduplicated. */
export function linksOf(html: string, base: string): FoundLink[] {
  const out: FoundLink[] = [];
  const seen = new Set<string>();
  const re = /<a\b[^>]*\bhref=["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const m of html.matchAll(re)) {
    if (out.length >= MAX_LINKS) break;
    const href = normalizePageUrl(decodeEntities(m[1]!), base);
    if (!href) continue;
    const text = decodeEntities(m[2]!.replace(/<[^>]+>/g, ' '))
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 160);
    const key = `${href}\u0000${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ href, text });
  }
  return out;
}

/** Relative markdown links and images become absolute against the page address. */
export function absolutizeMarkdownLinks(markdown: string, base: string): string {
  return markdown.replace(
    /(!?)\[([^\]]*)\]\(([^)\s]+)\)/g,
    (whole, bang: string, text: string, href: string) => {
      if (href.startsWith('#')) return bang ? '' : text;
      if (/^javascript:/i.test(href) || /^data:/i.test(href)) return bang ? '' : text;
      let abs: string;
      try {
        abs = new URL(href, base).href;
      } catch {
        return whole;
      }
      // Images in a text-only copy are links: an offline record never loads remotely.
      if (bang) return `[Image${text ? `: ${text}` : ''}](${abs})`;
      return `[${text}](${abs})`;
    },
  );
}

/** True when a host is in the person's private list (`www.` ignored). */
function privateAllowed(host: string, privateHosts: readonly string[]): boolean {
  const key = host.toLowerCase().replace(/^www\./, '');
  return privateHosts.some((h) => h.toLowerCase().replace(/^www\./, '') === key);
}

async function checkHop(url: URL, privateHosts: readonly string[]): Promise<void> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new SsrfError(`unsupported scheme ${url.protocol}`);
  if (url.username || url.password) throw new SsrfError('credentials in the address');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (privateAllowed(host, privateHosts)) {
    // The person typed this host; its private address is the point. This
    // computer's own services and cloud metadata stay out of reach regardless,
    // for literals and resolved names alike (the name is the site's to answer).
    await assertNotLoopbackOrMetadata(url.href);
    return;
  }
  if (isIP(host) && isPrivateAddress(host)) throw new SsrfError('private address');
  await assertPublicUrl(url.href);
}

/**
 * Download a page the way the text-only session does: manual redirects with
 * every hop checked, a byte cap, an awake-time deadline.
 */
export async function safeFetchPage(
  rawUrl: string,
  opts: {
    privateHosts: readonly string[];
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
    etag?: string;
    lastModified?: string;
  },
): Promise<HttpFetchResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const deadline = createAwakeTimeout(TIMEOUT_MS);
  const signal = opts.signal ? AbortSignal.any([opts.signal, deadline.signal]) : deadline.signal;
  try {
    let url = new URL(rawUrl);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      await checkHop(url, opts.privateHosts);
      const headers: Record<string, string> = {
        'user-agent': PAGE_USER_AGENT,
        accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
      };
      if (hop === 0 && opts.etag) headers['if-none-match'] = opts.etag;
      if (hop === 0 && opts.lastModified) headers['if-modified-since'] = opts.lastModified;
      const res = await fetchImpl(url.href, { redirect: 'manual', headers, signal });
      if (res.status >= 300 && res.status < 400 && res.status !== 304) {
        const location = res.headers.get('location');
        await res.body?.cancel().catch(() => {});
        if (!location) throw new Error(`redirect without a location (${res.status})`);
        url = new URL(location, url);
        continue;
      }
      const body = res.status === 304 ? '' : await readCapped(res, MAX_BYTES);
      return { status: res.status, finalUrl: url.href, headers: res.headers, body };
    }
    throw new Error('too many redirects');
  } finally {
    deadline.dispose();
  }
}

async function readCapped(res: Response, max: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
  }
  const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  const charset = /charset=([^;]+)/i
    .exec(res.headers.get('content-type') ?? '')?.[1]
    ?.trim()
    .toLowerCase();
  try {
    return new TextDecoder(charset && charset !== 'utf-8' ? charset : 'utf-8').decode(buf);
  } catch {
    return buf.toString('utf8');
  }
}

/** Stable short hash of a page's text, the change signal. */
export function textHash(markdown: string): string {
  return createHash('sha256')
    .update(markdown.replace(/\s+/g, ' ').trim())
    .digest('hex')
    .slice(0, 16);
}
