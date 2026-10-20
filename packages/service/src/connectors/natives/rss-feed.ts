/**
 * Web feeds as a `native` connector: RSS 2.0, RSS 1.0 (RDF), Atom 1.0 and
 * JSON Feed 1.1, one scope per configured feed URL, one record per item.
 *
 * A feed is a window, not a mirror: a publisher keeps only its newest items
 * in the document, so every pass re-reads the whole document and returns
 * every item it still carries. The writer's content hash makes that cheap —
 * an unchanged item is skipped, an edited one (same guid, new content) is
 * refreshed in place — and an item that falls off the end of the feed simply
 * stays in the corpus. There are no tombstones to report: absence from a
 * feed says nothing about whether the article still exists.
 *
 * Polite polling is conditional GET: the validators (`ETag`, `Last-Modified`)
 * of the last document we fully processed ride the scope cursor, and a 304
 * is a quiet empty batch. 429/503 are reported as `rateLimited` so the
 * engine backs the binding off.
 *
 * The URL is user-configured, so private and loopback feeds are allowed —
 * a person may well read a feed on their own network. What is refused is
 * the publisher steering us somewhere the person never pointed us: a
 * redirect (or an autodiscovered link) to a non-http(s) scheme, to a URL
 * carrying credentials, or from a public host to a private or loopback
 * address literal. Redirects are followed by hand so each hop is checked.
 *
 * Parsing uses @xmldom/xmldom, which never resolves external entities and
 * never expands entities declared in a DTD (they stay as literal `&name;`
 * text), so an XXE or billion-laughs document parses inertly.
 */

import { createHash } from 'node:crypto';
import { HttpStatusError, createLogger, isRateLimitStatus } from '@bendyline/gezel';
import { DOMParser, type Element, type Node, XMLSerializer } from '@xmldom/xmldom';
import { htmlBodyToMarkdown } from '../../mail/html.js';
import { isPrivateAddress } from '../../utils/ssrf.js';
import { registerNativeAdapter } from '../registry.js';
import type {
  AdapterDeps,
  ChangeBatch,
  ConnectorAdapter,
  ConnectorBindingRef,
  ListChangesOptions,
  NormalizedRecord,
  RecordRef,
} from '../types.js';
import { sha8, slug } from '../writer.js';
import { monthSegments, orderedFrontmatter, postFileStem } from './social-shared.js';

const log = createLogger('connectors');

export const RSS_FEED_TYPE_ID = 'rss-feed';
export const FEED_USER_AGENT = 'Gezel/1.0 (+https://github.com/bendyline/gezel) rss-feed connector';
const DEFAULT_MAX_ITEMS = 200;
const MAX_ITEMS_CEILING = 1000;
const DEFAULT_TIMEOUT_MS = 30_000;
/** Big enough for a long podcast feed with full show notes; small enough to never hurt. */
export const DEFAULT_MAX_FEED_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const ACCEPT =
  'application/rss+xml, application/atom+xml, application/feed+json, application/rdf+xml, ' +
  'application/xml;q=0.9, text/xml;q=0.9, application/json;q=0.8, text/html;q=0.5, */*;q=0.1';

const NS = {
  atom: 'http://www.w3.org/2005/Atom',
  atom03: 'http://purl.org/atom/ns#',
  rss1: 'http://purl.org/rss/1.0/',
  rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  content: 'http://purl.org/rss/1.0/modules/content/',
  dc: 'http://purl.org/dc/elements/1.1/',
  media: 'http://search.yahoo.com/mrss/',
  itunes: 'http://www.itunes.com/dtds/podcast-1.0.dtd',
  yt: 'http://www.youtube.com/xml/schemas/2015',
  xml: 'http://www.w3.org/XML/1998/namespace',
} as const;

/**
 * Prefixes real feeds use without declaring them. xmldom treats an unbound
 * prefix as fatal, and a feed reader that rejects a sloppy-but-common feed
 * is a feed reader nobody keeps; a declaration in the document still wins.
 */
const ASSUMED_PREFIXES: Record<string, string> = {
  atom: NS.atom,
  content: NS.content,
  dc: NS.dc,
  media: NS.media,
  itunes: NS.itunes,
  rdf: NS.rdf,
  yt: NS.yt,
  slash: 'http://purl.org/rss/1.0/modules/slash/',
  wfw: 'http://wellformedweb.org/CommentAPI/',
  sy: 'http://purl.org/rss/1.0/modules/syndication/',
  georss: 'http://www.georss.org/georss',
  feedburner: 'http://rssnamespace.org/feedburner/ext/1.0',
  googleplay: 'http://www.google.com/schemas/play-podcasts/1.0',
  podcast: 'https://podcastindex.org/namespace/1.0',
};

type NsSet = readonly (string | null)[];
const CORE: NsSet = [null, '', NS.rss1];
const ATOM: NsSet = [NS.atom, NS.atom03, null, ''];
const MEDIA: NsSet = [NS.media, 'http://search.yahoo.com/mrss'];
const ITUNES: NsSet = [NS.itunes, 'https://www.itunes.com/dtds/podcast-1.0.dtd'];

// ── public shapes ──────────────────────────────────────────────────────────

export type FeedFormat = 'rss' | 'rdf' | 'atom' | 'json';

export interface FeedEnclosure {
  url: string;
  type?: string;
  length?: number;
}

/** One item as parsed out of a feed document, before normalization. */
export interface FeedItem {
  guid?: string;
  /** Absolute http(s) permalink. */
  link?: string;
  /** Plain text. */
  title?: string;
  contentHtml?: string;
  contentText?: string;
  /** ISO 8601 UTC. */
  published?: string;
  /**
   * Last edit, when the feed says so. Parsed but deliberately not written to
   * records: generators that stamp every entry with the build time (and
   * YouTube, whose `updated` follows view counts) would rewrite the whole
   * corpus on every pass; an edit that matters changes the content anyway.
   */
  updated?: string;
  authors: string[];
  categories: string[];
  enclosures: FeedEnclosure[];
  thumbnail?: string;
  commentsUrl?: string;
  /** Human `h:mm:ss` / `m:ss` (podcasts). */
  duration?: string;
}

export interface ParsedFeed {
  format: FeedFormat;
  title?: string;
  /** The site the feed describes. */
  link?: string;
  items: FeedItem[];
}

/** A feed document could not be read as a feed (malformed, not a feed at all). */
export class FeedParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FeedParseError';
  }
}

/**
 * A feed could not be fetched or used. Its messages are written to be shown
 * to a person and deliberately avoid the transport vocabulary the engine's
 * transient-retry classifier matches on: retrying a refused scheme or a 404
 * three times inside one pass helps nobody.
 */
export class FeedUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FeedUnavailableError';
  }
}

// ── config + targets ───────────────────────────────────────────────────────

interface FeedConfig {
  feeds: string[];
  maxItemsPerFeed: number;
}

function parseFeedConfig(raw: Record<string, unknown> | undefined): FeedConfig {
  const value = raw?.feeds;
  const list = Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string')
    : typeof value === 'string'
      ? value.split(/\s+/)
      : [];
  const feeds = [...new Set(list.map((s) => s.trim()).filter(Boolean))];
  const max = raw?.maxItemsPerFeed;
  return {
    feeds,
    maxItemsPerFeed:
      typeof max === 'number' && Number.isFinite(max)
        ? Math.min(MAX_ITEMS_CEILING, Math.max(1, Math.floor(max)))
        : DEFAULT_MAX_ITEMS,
  };
}

interface FeedTarget {
  scope: string;
  /** Absent when the configured entry is refused. */
  url?: URL;
  /** Namespace for record ids: the configured URL without credentials or fragment. */
  key: string;
  /** Redacted, human form for messages and frontmatter. */
  display: string;
  /** The configured host is private/loopback, so the person asked for a LAN feed. */
  allowPrivate: boolean;
  refusal?: string;
}

const SECRET_PARAM = /token|key|secret|auth|pass|sig|session|credential/i;

/**
 * The feed URL as it may appear in records, logs and `_meta.json`: no
 * credentials, no fragment, and secret-looking query values masked. Private
 * podcast feeds put an access token in the URL, and the corpus is read by a
 * model that may be reading a hostile item at the same time.
 */
export function displayFeedUrl(url: URL): string {
  const u = new URL(url.href);
  u.username = '';
  u.password = '';
  u.hash = '';
  for (const name of [...new Set(u.searchParams.keys())]) {
    if (SECRET_PARAM.test(name)) u.searchParams.set(name, 'REDACTED');
  }
  return u.href;
}

/**
 * A readable, unique scope string for a feed. The engine names the scope's
 * directory `slug(scope)` cut at 48 characters, so a long URL — every
 * `youtube.com/feeds/videos.xml?channel_id=…` feed, for one — would share a
 * directory with its siblings. Those, and anything with a query string,
 * carry a hash of the full URL inside the first 48 characters instead.
 */
export function feedScopeLabel(url: URL): string {
  const shown = new URL(displayFeedUrl(url));
  const host = shown.hostname.replace(/^www\./, '');
  const label = `${host}${shown.pathname.replace(/\/+$/, '')}${shown.search}`;
  if (!shown.search && slug(label, 1000).length <= 48) return label;
  return `${slug(label, 39)}-${sha8(url.href)}`;
}

function isPrivateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[/, '').replace(/\]$/, '');
  return host === 'localhost' || host.endsWith('.localhost') || isPrivateAddress(host);
}

function buildTargets(feeds: string[]): Map<string, FeedTarget> {
  const out = new Map<string, FeedTarget>();
  feeds.forEach((raw, index) => {
    let url: URL | null = null;
    // `example.com/feed.xml` as people paste it: assume https.
    const candidate = /^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?(\/|\?|$)/i.test(raw)
      ? `https://${raw}`
      : raw;
    try {
      url = new URL(candidate);
    } catch {
      /* refused below */
    }
    if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
      // Never echo the entry: a mistyped line can be anything, credentials included.
      const scope = `invalid-feed-${index + 1}-${sha8(raw)}`;
      out.set(scope, {
        scope,
        key: scope,
        display: `feed #${index + 1}`,
        allowPrivate: false,
        refusal: url
          ? `Feed #${index + 1} uses the '${url.protocol}' scheme; only http and https feeds are supported.`
          : `Feed #${index + 1} is not a web address. Enter the full feed URL, starting with https://.`,
      });
      return;
    }
    const keyUrl = new URL(url.href);
    keyUrl.username = '';
    keyUrl.password = '';
    keyUrl.hash = '';
    const scope = feedScopeLabel(keyUrl);
    const display = displayFeedUrl(keyUrl);
    if (out.has(scope)) return;
    out.set(scope, {
      scope,
      url: keyUrl,
      key: keyUrl.href,
      display,
      allowPrivate: isPrivateHost(keyUrl.hostname),
      ...(url.username || url.password
        ? {
            refusal: `The feed URL ${display} contains a user name or password. Gezel does not send credentials to feeds; remove them from the URL.`,
          }
        : {}),
    });
  });
  return out;
}

// ── fetching ───────────────────────────────────────────────────────────────

export interface FeedCursor {
  etag?: string;
  lastModified?: string;
  /** Feed URL autodiscovery found behind the configured web page. */
  discovered?: string;
  /** Items already returned from an oversized document; validators wait for the last batch. */
  offset?: number;
}

function parseCursor(raw: unknown): FeedCursor {
  if (!raw || typeof raw !== 'object') return {};
  const v = raw as Record<string, unknown>;
  const str = (k: string) => (typeof v[k] === 'string' && v[k] ? (v[k] as string) : undefined);
  const etag = str('etag');
  const lastModified = str('lastModified');
  const discovered = str('discovered');
  const offset =
    typeof v.offset === 'number' && Number.isInteger(v.offset) && v.offset > 0 ? v.offset : 0;
  return {
    ...(etag ? { etag } : {}),
    ...(lastModified ? { lastModified } : {}),
    ...(discovered ? { discovered } : {}),
    ...(offset ? { offset } : {}),
  };
}

type FetchOutcome =
  | { notModified: true; finalUrl: string }
  | {
      notModified: false;
      finalUrl: string;
      bytes: Uint8Array;
      contentType: string;
      etag?: string;
      lastModified?: string;
    };

interface FetchOptions {
  fetchImpl: typeof fetch;
  etag?: string;
  lastModified?: string;
  allowPrivate: boolean;
  timeoutMs: number;
  maxBytes: number;
  /** Shown in messages in place of the (possibly secret-bearing) URL. */
  display: string;
}

/** Throws unless `next` is a URL we may follow on the publisher's say-so. */
function checkFollowTarget(next: URL, allowPrivate: boolean, display: string): void {
  // A non-http(s) Location is how a feed steers a reader at file:, data: or
  // an app-specific scheme; credentials in a Location would be sent to a host
  // the person never chose.
  if (next.protocol !== 'http:' && next.protocol !== 'https:') {
    throw new FeedUnavailableError(
      `The feed at ${display} points to a '${next.protocol}' address; only http and https are followed.`,
    );
  }
  if (next.username || next.password) {
    throw new FeedUnavailableError(
      `The feed at ${display} points to an address carrying credentials; it was not followed.`,
    );
  }
  if (!allowPrivate && isPrivateHost(next.hostname)) {
    throw new FeedUnavailableError(
      `The feed at ${display} points to a private or loopback address; it was not followed.`,
    );
  }
}

function describeTransportFailure(err: unknown, timeoutMs: number): string {
  const name = (err as { name?: unknown } | null)?.name;
  if (name === 'TimeoutError' || name === 'AbortError') {
    const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
    return `did not respond within ${seconds} second${seconds === 1 ? '' : 's'}`;
  }
  let code = '';
  for (let e: unknown = err, i = 0; e && i < 5; i++) {
    const c = (e as { code?: unknown }).code;
    if (typeof c === 'string') {
      code = c;
      break;
    }
    e = (e as { cause?: unknown }).cause;
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN')
    return 'has a host name that could not be found';
  if (code === 'ECONNREFUSED') return 'refused the connection';
  if (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET') return 'dropped the connection';
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(code)) {
    return 'presented a TLS certificate that could not be verified';
  }
  return 'could not be reached';
}

async function readCapped(res: Response, maxBytes: number, display: string): Promise<Uint8Array> {
  const tooBig = () =>
    new FeedUnavailableError(
      `The feed at ${display} is larger than ${Math.round(maxBytes / 1024 / 1024)} MB; it was not read.`,
    );
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw tooBig();
  }
  if (!res.body) return new Uint8Array(0);
  // Counted while streaming: a missing or lying Content-Length (or a gzip
  // body that inflates past the cap) never lands in memory whole.
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw tooBig();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** GET a feed document: manual redirects, conditional headers, size cap. */
export async function fetchFeedDocument(
  startUrl: string,
  opts: FetchOptions,
): Promise<FetchOutcome> {
  const signal = AbortSignal.timeout(opts.timeoutMs);
  let url = startUrl;
  for (let hop = 0; ; hop++) {
    let res: Response;
    try {
      res = await opts.fetchImpl(url, {
        method: 'GET',
        redirect: 'manual',
        headers: {
          'User-Agent': FEED_USER_AGENT,
          Accept: ACCEPT,
          ...(opts.etag ? { 'If-None-Match': opts.etag } : {}),
          ...(opts.lastModified ? { 'If-Modified-Since': opts.lastModified } : {}),
        },
        signal,
      });
    } catch (err) {
      throw new FeedUnavailableError(
        `The feed at ${opts.display} ${describeTransportFailure(err, opts.timeoutMs)}.`,
      );
    }
    if (res.status >= 300 && res.status < 400 && res.status !== 304) {
      await res.body?.cancel().catch(() => {});
      const location = res.headers.get('location');
      if (!location) {
        throw new FeedUnavailableError(
          `The feed at ${opts.display} answered HTTP ${res.status} without saying where to go.`,
        );
      }
      if (hop >= MAX_REDIRECTS) {
        throw new FeedUnavailableError(
          `The feed at ${opts.display} redirected more than ${MAX_REDIRECTS} times; it was not followed further.`,
        );
      }
      let next: URL;
      try {
        next = new URL(location, url);
      } catch {
        throw new FeedUnavailableError(
          `The feed at ${opts.display} redirected to an address that could not be read.`,
        );
      }
      checkFollowTarget(next, opts.allowPrivate, opts.display);
      url = next.href;
      continue;
    }
    if (res.status === 304) {
      await res.body?.cancel().catch(() => {});
      return { notModified: true, finalUrl: url };
    }
    if (isRateLimitStatus(res.status)) {
      await res.body?.cancel().catch(() => {});
      throw new HttpStatusError(res.status, `feed ${opts.display} answered HTTP ${res.status}`);
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      const hint =
        res.status === 404 || res.status === 410
          ? ' Check that the address is still the feed URL.'
          : res.status === 401 || res.status === 403
            ? ' The feed may need a sign-in, which this connector does not support.'
            : '';
      throw new FeedUnavailableError(
        `The feed at ${opts.display} answered HTTP ${res.status}.${hint}`,
      );
    }
    let bytes: Uint8Array;
    try {
      bytes = await readCapped(res, opts.maxBytes, opts.display);
    } catch (err) {
      if (err instanceof FeedUnavailableError) throw err;
      throw new FeedUnavailableError(
        `The feed at ${opts.display} ${describeTransportFailure(err, opts.timeoutMs)}.`,
      );
    }
    const etag = res.headers.get('etag') ?? undefined;
    const lastModified = res.headers.get('last-modified') ?? undefined;
    return {
      notModified: false,
      finalUrl: url,
      bytes,
      contentType: res.headers.get('content-type') ?? '',
      ...(etag ? { etag } : {}),
      ...(lastModified ? { lastModified } : {}),
    };
  }
}

/**
 * Bytes → text. A byte-order mark wins, then the HTTP charset, then the XML
 * declaration's `encoding` (RFC 7303's order); unknown labels fall back to
 * UTF-8 rather than failing the feed.
 */
export function decodeFeedBytes(bytes: Uint8Array, contentType = ''): string {
  let label: string | undefined;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) label = 'utf-8';
  else if (bytes[0] === 0xff && bytes[1] === 0xfe) label = 'utf-16le';
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) label = 'utf-16be';
  label ??= /charset\s*=\s*"?([^";\s]+)/i.exec(contentType)?.[1];
  if (!label) {
    const head = Buffer.from(bytes.subarray(0, 256)).toString('latin1');
    label = /^\s*<\?xml[^>]*\bencoding\s*=\s*["']([^"']+)["']/i.exec(head)?.[1];
  }
  try {
    return new TextDecoder(label ?? 'utf-8').decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

// ── text helpers ───────────────────────────────────────────────────────────

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  lsquo: '‘',
  rsquo: '’',
  sbquo: '‚',
  ldquo: '“',
  rdquo: '”',
  bdquo: '„',
  hellip: '…',
  laquo: '«',
  raquo: '»',
  bull: '•',
  middot: '·',
  copy: '©',
  reg: '®',
  trade: '™',
  euro: '€',
  pound: '£',
  yen: '¥',
  cent: '¢',
  deg: '°',
  times: '×',
  aacute: 'á',
  agrave: 'à',
  acirc: 'â',
  auml: 'ä',
  aring: 'å',
  ccedil: 'ç',
  eacute: 'é',
  egrave: 'è',
  ecirc: 'ê',
  euml: 'ë',
  iacute: 'í',
  iuml: 'ï',
  ntilde: 'ñ',
  oacute: 'ó',
  ocirc: 'ô',
  ouml: 'ö',
  oslash: 'ø',
  uacute: 'ú',
  uuml: 'ü',
  szlig: 'ß',
};

/**
 * HTML entities left in text. XML defines only five, so `&nbsp;` and friends
 * survive parsing literally; unknown names (including any a DTD declared,
 * which the parser never expands) stay exactly as written.
 */
function decodeHtmlEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (match, body: string) => {
    if (body[0] === '#') {
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

/** Markup-free single-line text (titles, names, categories). */
function plainText(s: string | undefined, max = 300): string {
  if (!s) return '';
  const text = decodeHtmlEntities(s.replace(/<\/?[a-z][^>]*>/gi, ' '))
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function looksLikeHtml(s: string): boolean {
  return /<\/?[a-z][a-z0-9]*(\s[^>]*)?\/?>/i.test(s) || /&(#\d+|#x[0-9a-f]+|[a-z]+);/i.test(s);
}

/** An absolute http(s) URL for `href` against `base`, or undefined. */
function absoluteHttpUrl(href: string | null | undefined, base: string): string | undefined {
  const raw = href?.trim();
  if (!raw) return undefined;
  try {
    const u = new URL(raw, base);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve relative `href`/`src` in item HTML against the item's base. Feeds
 * routinely ship `/images/x.png`, and a markdown record read far from its
 * site cannot resolve them later. Script-ish schemes are neutralized here
 * rather than trusted to the converter.
 */
function absolutizeHtml(html: string, base: string): string {
  const fix = (value: string): string => {
    const trimmed = decodeHtmlEntities(value.trim());
    if (/^(javascript|vbscript|data):/i.test(trimmed)) return '#';
    if (/^(mailto|tel):/i.test(trimmed) || trimmed.startsWith('#')) return value;
    return absoluteHttpUrl(trimmed, base) ?? value;
  };
  return html
    .replace(
      /(\s(?:href|src)\s*=\s*)(["'])([^"']*)\2/gi,
      (_m, pre: string, q: string, v: string) => `${pre}${q}${fix(v).replace(/"/g, '&quot;')}${q}`,
    )
    .replace(
      /(\s(?:href|src)\s*=\s*)([^\s"'>]+)/gi,
      (_m, pre: string, v: string) => `${pre}"${fix(v).replace(/"/g, '&quot;')}"`,
    );
}

const TZ_OFFSETS: Record<string, string> = {
  UTC: '+0000',
  WET: '+0000',
  WEST: '+0100',
  BST: '+0100',
  CET: '+0100',
  CEST: '+0200',
  MET: '+0100',
  MEST: '+0200',
  EET: '+0200',
  EEST: '+0300',
  MSK: '+0300',
  IST: '+0530',
  SGT: '+0800',
  HKT: '+0800',
  JST: '+0900',
  KST: '+0900',
  AEST: '+1000',
  AEDT: '+1100',
  NZST: '+1200',
  NZDT: '+1300',
};

/**
 * Feed dates are RFC 822 (RSS), RFC 3339 (Atom, JSON Feed) or W3CDTF
 * (Dublin Core). A zone-less timestamp is read as UTC — never as the
 * machine's local time, which would file the same item in a different month
 * bucket on another computer. Unparseable dates are dropped, not guessed.
 */
export function parseFeedDate(raw: string | null | undefined): string | undefined {
  let s = raw?.trim();
  if (!s) return undefined;
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s)) s = `${s.replace(' ', 'T')}Z`;
  s = s.replace(/\b([A-Z]{3,4})$/, (zone) => TZ_OFFSETS[zone] ?? zone);
  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) return undefined;
  return new Date(ms).toISOString();
}

/** `2712` or `45:12` or `00:45:12` → `45:12`. Anything else passes through. */
function normalizeDuration(raw: string | undefined): string | undefined {
  const s = raw?.trim();
  if (!s) return undefined;
  let seconds: number | undefined;
  if (/^\d+(\.\d+)?$/.test(s)) seconds = Math.round(Number(s));
  else if (/^\d+(:\d{1,2}){1,2}$/.test(s)) {
    seconds = s.split(':').reduce((acc, part) => acc * 60 + Number(part), 0);
  }
  return seconds === undefined ? s.slice(0, 32) : formatSeconds(seconds);
}

export function formatSeconds(total: number): string {
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

/** `jane@example.com (Jane Doe)` → `Jane Doe`; anything else as written. */
function rssAuthorName(raw: string): string {
  const m = /^\s*[^\s@()]+@[^\s()]+\s*\(([^)]+)\)\s*$/.exec(raw);
  return plainText(m ? m[1] : raw, 120);
}

function uniq(values: (string | undefined)[], max: number): string[] {
  const out: string[] = [];
  for (const v of values) {
    if (v && !out.includes(v)) out.push(v);
    if (out.length >= max) break;
  }
  return out;
}

// ── XML walking ────────────────────────────────────────────────────────────

const ELEMENT_NODE = 1;

function elementChildren(el: Element | null | undefined): Element[] {
  const out: Element[] = [];
  for (let n: Node | null = el?.firstChild ?? null; n; n = n.nextSibling) {
    if (n.nodeType === ELEMENT_NODE) out.push(n as Element);
  }
  return out;
}

function matches(el: Element, local: string, ns: NsSet): boolean {
  return el.localName === local && ns.includes(el.namespaceURI ?? null);
}

function first(el: Element | null | undefined, local: string, ns: NsSet): Element | undefined {
  return elementChildren(el).find((c) => matches(c, local, ns));
}

function all(el: Element | null | undefined, local: string, ns: NsSet): Element[] {
  return elementChildren(el).filter((c) => matches(c, local, ns));
}

function text(el: Element | null | undefined): string {
  return el?.textContent?.trim() ?? '';
}

function attr(el: Element | null | undefined, name: string): string {
  return el?.getAttribute(name)?.trim() ?? '';
}

/** The effective `xml:base` for an element, folded from the root down. */
function baseOf(el: Element, docUrl: string): string {
  const chain: string[] = [];
  for (let n: Node | null = el; n && n.nodeType === ELEMENT_NODE; n = n.parentNode) {
    const e = n as Element;
    const b = e.getAttributeNS(NS.xml, 'base') || e.getAttribute('xml:base');
    if (b) chain.unshift(b);
  }
  let base = docUrl;
  for (const b of chain) {
    try {
      base = new URL(b, base).href;
    } catch {
      /* keep the outer base */
    }
  }
  return base;
}

/** Thumbnail and description from Media RSS (direct, in a group, or in content). */
function mediaInfo(el: Element, base: string): { thumbnail?: string; description?: string } {
  const scopes = [el, ...all(el, 'group', MEDIA)];
  let thumbnail: string | undefined;
  let description: string | undefined;
  for (const scope of scopes) {
    for (const child of elementChildren(scope)) {
      if (!MEDIA.includes(child.namespaceURI ?? null)) continue;
      if (!thumbnail && child.localName === 'thumbnail') {
        thumbnail = absoluteHttpUrl(attr(child, 'url'), base);
      } else if (child.localName === 'content') {
        const type = attr(child, 'type').toLowerCase();
        if (!thumbnail && (attr(child, 'medium') === 'image' || type.startsWith('image/'))) {
          thumbnail = absoluteHttpUrl(attr(child, 'url'), base);
        }
        if (!thumbnail)
          thumbnail = absoluteHttpUrl(attr(first(child, 'thumbnail', MEDIA), 'url'), base);
      } else if (!description && child.localName === 'description') {
        description = text(child) || undefined;
      }
    }
  }
  return {
    ...(thumbnail ? { thumbnail } : {}),
    ...(description ? { description } : {}),
  };
}

/** Body text: HTML when it looks like markup, plain text otherwise. */
function bodyOf(raw: string | undefined): { contentHtml?: string; contentText?: string } {
  if (!raw?.trim()) return {};
  return looksLikeHtml(raw) ? { contentHtml: raw } : { contentText: raw.trim() };
}

function parseRssItem(el: Element, docUrl: string, rdf: boolean): FeedItem {
  const base = baseOf(el, docUrl);
  const guidEl = first(el, 'guid', CORE);
  const guid = text(guidEl) || (rdf ? el.getAttributeNS(NS.rdf, 'about') || '' : '');
  const permaGuid = guidEl && attr(guidEl, 'isPermaLink').toLowerCase() !== 'false';
  const link =
    absoluteHttpUrl(text(first(el, 'link', CORE)), base) ??
    (permaGuid || rdf ? absoluteHttpUrl(guid, base) : undefined);
  const media = mediaInfo(el, base);
  const body =
    text(first(el, 'encoded', [NS.content])) ||
    text(first(el, 'description', CORE)) ||
    text(first(el, 'description', [NS.dc])) ||
    media.description ||
    text(first(el, 'summary', ITUNES));
  const published = parseFeedDate(
    text(first(el, 'pubDate', CORE)) ||
      text(first(el, 'date', [NS.dc])) ||
      text(first(el, 'published', [NS.atom])),
  );
  const updated = parseFeedDate(text(first(el, 'updated', [NS.atom])));
  const enclosures: FeedEnclosure[] = [];
  for (const enc of all(el, 'enclosure', CORE)) {
    const url = absoluteHttpUrl(attr(enc, 'url'), base);
    if (!url) continue;
    const length = Number(attr(enc, 'length'));
    enclosures.push({
      url,
      ...(attr(enc, 'type') ? { type: attr(enc, 'type') } : {}),
      ...(Number.isFinite(length) && length > 0 ? { length } : {}),
    });
  }
  const itunesImage = absoluteHttpUrl(attr(first(el, 'image', ITUNES), 'href'), base);
  const imageEnclosure = enclosures.find((e) => e.type?.startsWith('image/'))?.url;
  const thumbnail = media.thumbnail ?? itunesImage ?? imageEnclosure;
  const commentsUrl = absoluteHttpUrl(text(first(el, 'comments', CORE)), base);
  const duration = normalizeDuration(text(first(el, 'duration', ITUNES)));
  const title = plainText(text(first(el, 'title', CORE)));
  return {
    ...(guid ? { guid } : {}),
    ...(link ? { link } : {}),
    ...(title ? { title } : {}),
    ...bodyOf(body),
    ...(published ? { published } : {}),
    ...(updated && updated !== published ? { updated } : {}),
    authors: uniq(
      [
        rssAuthorName(text(first(el, 'author', CORE))),
        ...all(el, 'creator', [NS.dc]).map((c) => plainText(text(c), 120)),
        plainText(text(first(el, 'author', ITUNES)), 120),
      ],
      10,
    ),
    categories: uniq(
      [...all(el, 'category', CORE), ...all(el, 'subject', [NS.dc])].map((c) =>
        plainText(text(c), 80),
      ),
      20,
    ),
    enclosures,
    ...(thumbnail ? { thumbnail } : {}),
    ...(commentsUrl ? { commentsUrl } : {}),
    ...(duration ? { duration } : {}),
  };
}

/** An Atom text construct (`type` text | html | xhtml) as HTML or text. */
function atomText(el: Element | undefined): { html?: string; text?: string } {
  if (!el) return {};
  const type = attr(el, 'type').toLowerCase() || attr(el, 'mode').toLowerCase();
  if (type === 'xhtml' || type === 'xml') {
    const div = elementChildren(el).find((c) => c.localName === 'div') ?? el;
    const serializer = new XMLSerializer();
    let html = '';
    for (let n: Node | null = div.firstChild; n; n = n.nextSibling) {
      html += serializer.serializeToString(n);
    }
    return html.trim() ? { html } : {};
  }
  const value = text(el);
  if (!value) return {};
  if (type === 'html' || type === 'text/html' || type === 'escaped') return { html: value };
  return { text: value };
}

function atomPersons(el: Element | undefined, local: string): string[] {
  return all(el, local, ATOM)
    .map((p) => plainText(text(first(p, 'name', ATOM)) || text(p), 120))
    .filter(Boolean);
}

function parseAtomEntry(el: Element, docUrl: string, feedAuthors: string[]): FeedItem {
  const base = baseOf(el, docUrl);
  const links = all(el, 'link', ATOM).map((l) => ({
    rel: (attr(l, 'rel') || 'alternate').toLowerCase(),
    type: attr(l, 'type').toLowerCase(),
    href: absoluteHttpUrl(attr(l, 'href'), baseOf(l, docUrl)),
    length: Number(attr(l, 'length')),
    rawType: attr(l, 'type'),
  }));
  const alternates = links.filter((l) => l.rel === 'alternate' && l.href);
  const link = (alternates.find((l) => !l.type || l.type.includes('html')) ?? alternates[0])?.href;
  const enclosures: FeedEnclosure[] = links
    .filter((l) => l.rel === 'enclosure' && l.href)
    .map((l) => ({
      url: l.href!,
      ...(l.rawType ? { type: l.rawType } : {}),
      ...(Number.isFinite(l.length) && l.length > 0 ? { length: l.length } : {}),
    }));
  const commentsUrl = links.find((l) => l.rel === 'replies' && l.href)?.href;
  const contentEl = first(el, 'content', ATOM);
  const content = contentEl && !attr(contentEl, 'src') ? atomText(contentEl) : {};
  const summary = atomText(first(el, 'summary', ATOM));
  const media = mediaInfo(el, base);
  const contentBase = contentEl ? baseOf(contentEl, docUrl) : base;
  const titleParts = atomText(first(el, 'title', ATOM));
  const title = plainText(titleParts.html ?? titleParts.text);
  const published = parseFeedDate(
    text(first(el, 'published', ATOM)) ||
      text(first(el, 'issued', ATOM)) ||
      text(first(el, 'created', ATOM)),
  );
  const updated = parseFeedDate(
    text(first(el, 'updated', ATOM)) || text(first(el, 'modified', ATOM)),
  );
  const guid = text(first(el, 'id', ATOM)) || text(first(el, 'videoId', [NS.yt]));
  const authors = atomPersons(el, 'author');
  const sourceAuthors = atomPersons(first(el, 'source', ATOM), 'author');
  let body: { contentHtml?: string; contentText?: string } = {};
  if (content.html) body = { contentHtml: absolutizeHtml(content.html, contentBase) };
  else if (content.text) body = { contentText: content.text };
  else if (summary.html) body = { contentHtml: absolutizeHtml(summary.html, base) };
  else if (summary.text) body = { contentText: summary.text };
  else if (media.description) body = { contentText: media.description };
  return {
    ...(guid ? { guid } : {}),
    ...(link ? { link } : {}),
    ...(title ? { title } : {}),
    ...body,
    ...((published ?? updated) ? { published: published ?? updated } : {}),
    ...(updated && published && updated !== published ? { updated } : {}),
    authors: uniq(
      authors.length ? authors : sourceAuthors.length ? sourceAuthors : feedAuthors,
      10,
    ),
    categories: uniq(
      all(el, 'category', ATOM).map((c) => plainText(attr(c, 'label') || attr(c, 'term'), 80)),
      20,
    ),
    enclosures,
    ...(media.thumbnail ? { thumbnail: media.thumbnail } : {}),
    ...(commentsUrl ? { commentsUrl } : {}),
  };
}

function parseXmlFeed(source: string, docUrl: string, display: string): ParsedFeed {
  const cleaned = source.replace(/^﻿/, '').trimStart();
  let doc: ReturnType<DOMParser['parseFromString']>;
  try {
    doc = new DOMParser({
      // Recoverable problems (an undefined `&nbsp;`, a stray attribute) are
      // tolerated the way every feed reader tolerates them; only a document
      // the parser cannot build at all fails the feed.
      onError: () => {},
      xmlns: ASSUMED_PREFIXES,
    }).parseFromString(cleaned, 'text/xml');
  } catch (err) {
    const detail = err instanceof Error ? err.message.split('\n')[0] : String(err);
    throw new FeedParseError(`The feed at ${display} is not well-formed XML (${detail}).`);
  }
  const root = doc.documentElement;
  if (!root) throw new FeedParseError(`The feed at ${display} is an empty document.`);
  const local = root.localName ?? '';
  if (local === 'feed') {
    const feedTitle = atomText(first(root, 'title', ATOM));
    const siteLinks = all(root, 'link', ATOM).filter(
      (l) => (attr(l, 'rel') || 'alternate').toLowerCase() === 'alternate',
    );
    const feedAuthors = atomPersons(root, 'author');
    return {
      format: 'atom',
      ...titleAndLink(
        plainText(feedTitle.html ?? feedTitle.text),
        absoluteHttpUrl(attr(siteLinks[0], 'href'), baseOf(root, docUrl)),
      ),
      items: all(root, 'entry', ATOM).map((e) => parseAtomEntry(e, docUrl, feedAuthors)),
    };
  }
  if (local === 'rss' || local === 'RDF' || local === 'channel') {
    const rdf = local === 'RDF';
    const channel = local === 'channel' ? root : (first(root, 'channel', CORE) ?? root);
    const itemParents = rdf ? [root] : [channel, root];
    const items = [...new Set(itemParents.flatMap((p) => all(p, 'item', CORE)))];
    const channelAuthors = uniq(
      [
        plainText(text(first(channel, 'author', ITUNES)), 120),
        plainText(text(first(channel, 'creator', [NS.dc])), 120),
      ],
      3,
    );
    return {
      format: rdf ? 'rdf' : 'rss',
      ...titleAndLink(
        plainText(text(first(channel, 'title', CORE))),
        absoluteHttpUrl(text(first(channel, 'link', CORE)), baseOf(channel, docUrl)),
      ),
      items: items.map((el) => {
        const item = parseRssItem(el, docUrl, rdf);
        if (item.contentHtml)
          item.contentHtml = absolutizeHtml(item.contentHtml, baseOf(el, docUrl));
        return item.authors.length === 0 ? { ...item, authors: channelAuthors } : item;
      }),
    };
  }
  throw new FeedParseError(
    `The document at ${display} is XML but not an RSS, RDF or Atom feed (its root element is <${root.nodeName}>).`,
  );
}

function titleAndLink(title: string, link: string | undefined): { title?: string; link?: string } {
  return { ...(title ? { title } : {}), ...(link ? { link } : {}) };
}

function jsonString(v: unknown): string {
  return typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : '';
}

function jsonAuthors(item: Record<string, unknown>): string[] {
  const list = Array.isArray(item.authors) ? item.authors : item.author ? [item.author] : [];
  return list
    .map((a) => plainText(jsonString((a as { name?: unknown } | null)?.name), 120))
    .filter(Boolean);
}

function parseJsonFeed(source: string, docUrl: string, display: string): ParsedFeed {
  let data: unknown;
  try {
    data = JSON.parse(source.replace(/^﻿/, ''));
  } catch {
    throw new FeedParseError(`The feed at ${display} is not valid JSON.`);
  }
  const feed = (data ?? {}) as Record<string, unknown>;
  if (typeof feed !== 'object' || !Array.isArray(feed.items)) {
    throw new FeedParseError(
      `The document at ${display} is JSON but not a JSON Feed (it has no items list).`,
    );
  }
  const feedAuthors = jsonAuthors(feed);
  const items: FeedItem[] = [];
  for (const raw of feed.items) {
    if (!raw || typeof raw !== 'object') continue;
    const it = raw as Record<string, unknown>;
    const guid = jsonString(it.id);
    const link =
      absoluteHttpUrl(jsonString(it.url), docUrl) ??
      absoluteHttpUrl(jsonString(it.external_url), docUrl);
    const html = jsonString(it.content_html);
    const textBody = jsonString(it.content_text) || jsonString(it.summary);
    const published = parseFeedDate(jsonString(it.date_published));
    const updated = parseFeedDate(jsonString(it.date_modified));
    const enclosures: FeedEnclosure[] = [];
    let duration: string | undefined;
    for (const a of Array.isArray(it.attachments) ? it.attachments : []) {
      const att = (a ?? {}) as Record<string, unknown>;
      const url = absoluteHttpUrl(jsonString(att.url), docUrl);
      if (!url) continue;
      const size = att.size_in_bytes;
      enclosures.push({
        url,
        ...(jsonString(att.mime_type) ? { type: jsonString(att.mime_type) } : {}),
        ...(typeof size === 'number' && size > 0 ? { length: size } : {}),
      });
      if (!duration && typeof att.duration_in_seconds === 'number') {
        duration = formatSeconds(Math.round(att.duration_in_seconds));
      }
    }
    const authors = jsonAuthors(it);
    const title = plainText(jsonString(it.title));
    const thumbnail =
      absoluteHttpUrl(jsonString(it.image), docUrl) ??
      absoluteHttpUrl(jsonString(it.banner_image), docUrl);
    items.push({
      ...(guid ? { guid } : {}),
      ...(link ? { link } : {}),
      ...(title ? { title } : {}),
      ...(html
        ? { contentHtml: absolutizeHtml(html, docUrl) }
        : textBody
          ? { contentText: textBody }
          : {}),
      ...((published ?? updated) ? { published: published ?? updated } : {}),
      ...(updated && published && updated !== published ? { updated } : {}),
      authors: uniq(authors.length ? authors : feedAuthors, 10),
      categories: uniq(
        (Array.isArray(it.tags) ? it.tags : []).map((t) => plainText(jsonString(t), 80)),
        20,
      ),
      enclosures,
      ...(thumbnail ? { thumbnail } : {}),
      ...(duration ? { duration } : {}),
    });
  }
  return {
    format: 'json',
    ...titleAndLink(
      plainText(jsonString(feed.title)),
      absoluteHttpUrl(jsonString(feed.home_page_url), docUrl),
    ),
    items,
  };
}

/** True when a fetched document is a web page rather than a feed. */
export function isHtmlDocument(source: string, contentType = ''): boolean {
  if (/\btext\/html\b|application\/xhtml\+xml/i.test(contentType)) return true;
  return /^\s*(﻿)?\s*(<!doctype\s+html|<html[\s>])/i.test(source);
}

/**
 * Parse a feed document of any supported format. `docUrl` is the URL the
 * document was served from (relative links resolve against it).
 */
export function parseFeedDocument(
  source: string,
  opts: { docUrl: string; contentType?: string; display?: string },
): ParsedFeed {
  const display = opts.display ?? opts.docUrl;
  const contentType = opts.contentType ?? '';
  const head = source.replace(/^﻿/, '').trimStart();
  if (/json/i.test(contentType) || head.startsWith('{')) {
    return parseJsonFeed(head, opts.docUrl, display);
  }
  if (!head) throw new FeedParseError(`The feed at ${display} is an empty document.`);
  return parseXmlFeed(head, opts.docUrl, display);
}

const FEED_LINK_TYPES = new Set([
  'application/rss+xml',
  'application/atom+xml',
  'application/feed+json',
  'application/rdf+xml',
]);

/** `<link rel="alternate" type="application/rss+xml" href>` targets on a web page. */
export function findFeedLinks(html: string, pageUrl: string): string[] {
  const out: string[] = [];
  for (const tag of html.matchAll(/<link\b[^>]*>/gi)) {
    const attrs: Record<string, string> = {};
    for (const m of tag[0].matchAll(/([a-z-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi)) {
      attrs[m[1]!.toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
    }
    const rel = (attrs.rel ?? '').toLowerCase().split(/\s+/);
    const type = (attrs.type ?? '').toLowerCase().split(';')[0]!.trim();
    if (!rel.includes('alternate') || !FEED_LINK_TYPES.has(type)) continue;
    const href = absoluteHttpUrl(decodeHtmlEntities(attrs.href ?? ''), pageUrl);
    if (href && !out.includes(href)) out.push(href);
  }
  return out;
}

// ── normalization ──────────────────────────────────────────────────────────

export interface FeedRecordContext {
  /** Record-id namespace: the configured feed URL (credentials stripped). */
  key: string;
  /** Redacted configured URL, for frontmatter. */
  feedUrl: string;
  feedTitle?: string;
}

/** The item's identity within its feed: guid, else link, else title + date. */
export function feedItemIdentity(item: FeedItem): string {
  if (item.guid) return item.guid;
  if (item.link) return item.link;
  const basis =
    item.title || item.published
      ? `${item.title ?? ''}\n${item.published ?? ''}`
      : (item.contentHtml ?? item.contentText ?? '');
  return `h:${createHash('sha256').update(basis).digest('hex').slice(0, 16)}`;
}

/** Map one parsed feed item to its corpus record. */
export async function feedItemToRecord(
  item: FeedItem,
  ctx: FeedRecordContext,
): Promise<NormalizedRecord> {
  let body = '';
  if (item.contentHtml) body = (await htmlBodyToMarkdown(item.contentHtml)).trim();
  else if (item.contentText) body = item.contentText.trim();
  if (item.enclosures.length > 1) {
    const lines = item.enclosures.map((e) => {
      const meta = [e.type, e.length ? `${e.length} bytes` : ''].filter(Boolean).join(', ');
      return `- ${e.url}${meta ? ` (${meta})` : ''}`;
    });
    body = `${body}${body ? '\n\n' : ''}Enclosures:\n${lines.join('\n')}`;
  }
  if (!body && item.link) body = `Link: ${item.link}`;
  // Untitled items (micro-posts) are named by their first line of text.
  const firstLine = item.contentText?.split('\n').find((line) => line.trim());
  const title = item.title || plainText(firstLine ?? item.contentHtml, 80) || '(untitled)';
  const enclosure = item.enclosures[0];
  const feedLabel = ctx.feedTitle || new URL(ctx.feedUrl).hostname;
  return {
    recordId: `${ctx.key}#${feedItemIdentity(item)}`,
    dirSegments: monthSegments(item.published),
    fileStem: postFileStem(item.published, title),
    frontmatter: orderedFrontmatter([
      ['title', title],
      ['date', item.published],
      ['author', item.authors.join(', ') || undefined],
      ['url', item.link],
      ['feed', ctx.feedTitle],
      ['feed_url', ctx.feedUrl],
      ['categories', item.categories.join(', ') || undefined],
      ['enclosure_url', enclosure?.url],
      ['enclosure_type', enclosure?.type],
      ['enclosure_length', enclosure?.length],
      ['duration', item.duration],
      ['thumbnail', item.thumbnail],
      ['comments_url', item.commentsUrl],
      ['direction', 'inbound'],
    ]),
    bodyMarkdown: body,
    scanOrigin: RSS_FEED_TYPE_ID,
    quarantineNamespace: RSS_FEED_TYPE_ID,
    quarantineLabel: `Feed item from ${feedLabel}`,
  };
}

/** Newest first; undated items keep document order after the dated ones. */
function newestFirst(items: FeedItem[]): FeedItem[] {
  return items
    .map((item, index) => ({
      item,
      index,
      ms: item.published ? Date.parse(item.published) : Number.NaN,
    }))
    .sort((a, b) => {
      const am = Number.isFinite(a.ms) ? a.ms : Number.NEGATIVE_INFINITY;
      const bm = Number.isFinite(b.ms) ? b.ms : Number.NEGATIVE_INFINITY;
      return bm === am ? a.index - b.index : bm - am;
    })
    .map((x) => x.item);
}

// ── the adapter ────────────────────────────────────────────────────────────

/** Test seams; production uses the defaults. */
export interface RssFeedOptions {
  timeoutMs?: number;
  maxBytes?: number;
}

interface ItemRaw {
  item: FeedItem;
  ctx: FeedRecordContext;
}

export class RssFeedAdapter implements ConnectorAdapter {
  readonly typeId = RSS_FEED_TYPE_ID;
  /** An edited pubDate can move an item into another month bucket. */
  readonly recordsMayMove = true;
  private config?: FeedConfig;
  private targets = new Map<string, FeedTarget>();

  constructor(
    private readonly binding: ConnectorBindingRef,
    private readonly deps: AdapterDeps,
    private readonly options: RssFeedOptions = {},
  ) {}

  /** No credential: this only validates that there is something to read. */
  async ensureAuth(): Promise<void> {
    this.config = parseFeedConfig(this.binding.config);
    if (this.config.feeds.length === 0) {
      throw new Error(
        "This feed connector has no feed URLs. Add at least one in the connector's settings.",
      );
    }
    this.targets = buildTargets(this.config.feeds);
  }

  async listScopes(): Promise<string[]> {
    return [...this.targets.keys()];
  }

  async listChangesSince(
    scope: string,
    cursor: unknown,
    opts?: ListChangesOptions,
  ): Promise<ChangeBatch<unknown>> {
    const config = this.config;
    const target = this.targets.get(scope);
    if (!config || !target) {
      log.warn(`rss-feed: '${scope}' is not one of this binding's feeds; skipped`);
      return { records: [], cursor };
    }
    // A refused or broken feed fails only its own scope; the engine keeps
    // syncing the others and names this one in the binding's status.
    if (target.refusal || !target.url) throw new FeedUnavailableError(target.refusal ?? scope);
    const prior = parseCursor(cursor);
    const fetchOpts = {
      fetchImpl: this.deps.fetch ?? fetch,
      allowPrivate: target.allowPrivate,
      timeoutMs: this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBytes: this.options.maxBytes ?? DEFAULT_MAX_FEED_BYTES,
      display: target.display,
    };
    let parsed: ParsedFeed;
    let validators: { etag?: string; lastModified?: string };
    let discovered = prior.discovered;
    try {
      // Mid-walk rounds re-read the document unconditionally: the stored
      // validators describe a document whose tail has not been returned yet.
      const conditional = prior.offset
        ? {}
        : {
            ...(prior.etag ? { etag: prior.etag } : {}),
            ...(prior.lastModified ? { lastModified: prior.lastModified } : {}),
          };
      const pageUrl = target.url.href;
      let got = await fetchFeedDocument(discovered ?? pageUrl, {
        ...fetchOpts,
        ...conditional,
      }).catch((err: unknown) => {
        // A discovered feed that moved: rediscover from the page, once.
        if (
          discovered &&
          err instanceof FeedUnavailableError &&
          /HTTP (404|410)/.test(err.message)
        ) {
          discovered = undefined;
          return fetchFeedDocument(pageUrl, fetchOpts);
        }
        throw err;
      });
      if (got.notModified) return { records: [], cursor };
      let doc = got;
      let source = decodeFeedBytes(doc.bytes, doc.contentType);
      if (isHtmlDocument(source, doc.contentType)) {
        if (discovered) {
          throw new FeedUnavailableError(
            `The feed at ${target.display} now serves a web page instead of a feed.`,
          );
        }
        // Autodiscovery, followed once: the person pasted a site's address.
        const link = findFeedLinks(source, doc.finalUrl)[0];
        if (!link) {
          throw new FeedUnavailableError(
            `${target.display} is a web page that names no RSS, Atom or JSON feed. Paste the feed's own address instead.`,
          );
        }
        checkFollowTarget(new URL(link), target.allowPrivate, target.display);
        got = await fetchFeedDocument(link, fetchOpts);
        if (got.notModified) return { records: [], cursor };
        doc = got;
        source = decodeFeedBytes(doc.bytes, doc.contentType);
        if (isHtmlDocument(source, doc.contentType)) {
          throw new FeedUnavailableError(
            `The feed ${target.display} advertises is itself a web page, not a feed.`,
          );
        }
        discovered = link;
      }
      parsed = parseFeedDocument(source, {
        docUrl: doc.finalUrl,
        contentType: doc.contentType,
        display: target.display,
      });
      validators = {
        ...(doc.etag ? { etag: doc.etag } : {}),
        ...(doc.lastModified ? { lastModified: doc.lastModified } : {}),
      };
    } catch (err) {
      if (err instanceof HttpStatusError && isRateLimitStatus(err.status)) {
        return { records: [], cursor, rateLimited: true };
      }
      throw err;
    }

    const items = newestFirst(parsed.items).slice(0, config.maxItemsPerFeed);
    const ctx: FeedRecordContext = {
      key: target.key,
      feedUrl: target.display,
      ...(parsed.title ? { feedTitle: parsed.title } : {}),
    };
    const limit = Math.max(1, opts?.limit ?? items.length);
    const offset = Math.min(prior.offset ?? 0, items.length);
    const batch = items.slice(offset, offset + limit);
    const records: RecordRef[] = batch.map((item) => {
      const ms = item.published ? Date.parse(item.published) : Number.NaN;
      return {
        id: feedItemIdentity(item).slice(0, 200),
        raw: { item, ctx } satisfies ItemRaw,
        ...(item.published ? { ts: item.published } : {}),
        ...(Number.isFinite(ms) ? { ordinalKey: ms } : {}),
      };
    });
    const next = offset + batch.length;
    if (next < items.length) {
      return {
        records,
        cursor: { ...(discovered ? { discovered } : {}), offset: next } satisfies FeedCursor,
        partial: true,
      };
    }
    return {
      records,
      cursor: { ...validators, ...(discovered ? { discovered } : {}) } satisfies FeedCursor,
    };
  }

  async fetchRecord(_scope: string, ref: RecordRef): Promise<NormalizedRecord> {
    const raw = ref.raw as ItemRaw | undefined;
    if (!raw?.item || !raw.ctx) throw new Error(`rss-feed record ${ref.id} has no parsed item`);
    return feedItemToRecord(raw.item, raw.ctx);
  }

  async close(): Promise<void> {}
}

/** Register the RSS/Atom/JSON Feed native adapter (adapterId `rss-feed`). */
export function registerRssFeedAdapters(): void {
  registerNativeAdapter(
    RSS_FEED_TYPE_ID,
    async (binding, deps) => new RssFeedAdapter(binding, deps),
  );
}
