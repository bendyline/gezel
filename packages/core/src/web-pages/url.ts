/**
 * Address rules for saved web pages, shared by the website connector (which
 * crawls), the desktop UI (which maps a link to its saved copy) and the chat
 * composer (which notices addresses a person pastes). Pure: no network, no
 * Node built-ins, so the phone and the renderer can use it too.
 */

/** Query parameters that only track a visit and never change the page. */
const TRACKING_PARAM =
  /^(utm_[a-z_]+|fbclid|gclid|dclid|gbraid|wbraid|msclkid|mc_cid|mc_eid|_hsenc|_hsmi|igshid|ref_src|ref_url|yclid|_ga|_gl|vero_id|oly_anon_id|oly_enc_id|__s|ck_subscriber_id)$/i;

/**
 * Query parameters whose values are credentials or one-time proofs. A link
 * carrying one is never followed (following it can act on the person's
 * behalf) and its value never reaches a record, a log line or History.
 */
const SECRET_PARAM =
  /^(.*token.*|.*secret.*|.*passw(or)?d.*|key|api_?key|apikey|auth|authorization|sig|signature|session|sessionid|sid|nonce|code|state|otp|ticket|jwt|access_?key|x-amz-[a-z-]+|x-goog-[a-z-]+)$/i;

/** File types that are not pages a person reads in a browser tab. */
const NON_PAGE_EXTENSION =
  /\.(zip|gz|tgz|bz2|xz|rar|7z|tar|exe|msi|msix|dmg|pkg|deb|rpm|appimage|iso|img|apk|ipa|jpe?g|png|gif|webp|avif|svg|ico|bmp|tiff?|heic|mp4|m4v|mov|webm|mkv|avi|wmv|mp3|m4a|wav|flac|ogg|opus|woff2?|ttf|otf|eot|css|js|mjs|map|json|xml|rss|atom|ics|vcf|csv|tsv|xlsx?|docx?|pptx?|odt|ods|odp|pdf|epub|torrent|bin|dat|wasm)$/i;

/**
 * Path words never followed, signed in or not: they end a session, leave a
 * list, fill a cart or open an editor, and none of them is a page worth
 * saving. Matched on whole path words (`report-2024` is not `report`).
 */
const ALWAYS_ACTION_WORDS = new Set([
  'logout',
  'log-out',
  'signout',
  'sign-out',
  'logoff',
  'log-off',
  'unsubscribe',
  'checkout',
  'cart',
  'basket',
  'edit',
]);

/**
 * Path or query words that mark a link as an action rather than a page when
 * the crawl is signed in: following it could delete something, buy something
 * or change a setting on the person's account. Anonymous crawls follow these,
 * since without a session a link like `/archive/2024` or `/report/annual` is
 * just a page.
 */
const SIGNED_IN_ACTION_WORDS = new Set([
  ...ALWAYS_ACTION_WORDS,
  'delete',
  'remove',
  'destroy',
  'revoke',
  'deactivate',
  'disable',
  'enable',
  'cancel',
  'approve',
  'reject',
  'accept',
  'decline',
  'vote',
  'upvote',
  'downvote',
  'flag',
  'report',
  'block',
  'mute',
  'follow',
  'unfollow',
  'like',
  'unlike',
  'purchase',
  'checkout',
  'cart',
  'basket',
  'buy',
  'order',
  'pay',
  'payment',
  'subscribe',
  'confirm',
  'reset',
  'archive',
  'transfer',
  'withdraw',
  'invite',
  'share',
  'print',
  'download',
  'export',
  'edit',
  'action',
  'admin',
]);

/** Pages that ask a person to sign in or register; never content worth saving. */
const ACCOUNT_WORDS = new Set([
  'login',
  'log-in',
  'signin',
  'sign-in',
  'signup',
  'sign-up',
  'register',
  'oauth',
  'sso',
  'forgot-password',
  'reset-password',
]);

function wordsOf(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9-]+/)
    .filter(Boolean);
}

function hostKey(host: string): string {
  return host.toLowerCase().replace(/^www\./, '');
}

/**
 * The identity of a page: an http(s) address without its fragment, without
 * tracking parameters, with the remaining parameters sorted. Null for
 * anything that is not an http(s) page address, and for an address carrying
 * a user name or password.
 */
export function normalizePageUrl(raw: string, base?: string): string | null {
  let u: URL;
  try {
    u = base ? new URL(raw, base) : new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  if (!u.hostname) return null;
  u.hash = '';
  const kept = [...u.searchParams.entries()].filter(([k]) => !TRACKING_PARAM.test(k));
  kept.sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0));
  u.search = '';
  for (const [k, v] of kept) u.searchParams.append(k, v);
  if (u.pathname === '') u.pathname = '/';
  return u.href;
}

/** One site a website binding follows: a host, and the folder links must stay inside. */
export interface SiteScope {
  /** The start address as the person typed it, normalized. */
  start: string;
  /** Host as a person reads it (`gezel.com`). */
  host: string;
  /** `https:` or `http:`. */
  protocol: string;
  /** Port when not the scheme default, else ''. */
  port: string;
  /**
   * Links are followed only under this path, which always ends in `/`. The
   * folder of the start address: `https://site/docs/intro` → `/docs/`,
   * `https://site/docs/` → `/docs/`, `https://site/` → `/`.
   */
  pathPrefix: string;
}

/** The scope a start address defines, or null for an address that is not a page. */
export function siteScopeFor(startRaw: string): SiteScope | null {
  const start = normalizePageUrl(startRaw.trim());
  if (!start) return null;
  const u = new URL(start);
  const lastSlash = u.pathname.lastIndexOf('/');
  const pathPrefix = lastSlash >= 0 ? u.pathname.slice(0, lastSlash + 1) : '/';
  return {
    start,
    host: u.hostname,
    protocol: u.protocol,
    port: u.port,
    pathPrefix: pathPrefix || '/',
  };
}

/** True when a host counts as the scope's site (a leading `www.` is ignored). */
export function sameSite(host: string, scope: Pick<SiteScope, 'host'>): boolean {
  return hostKey(host) === hostKey(scope.host);
}

/**
 * The scope an address falls inside, or null. A page is inside a scope when
 * it is on the same site, the same scheme and port, and under its folder.
 */
export function scopeOfUrl(url: string, scopes: readonly SiteScope[]): SiteScope | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  for (const s of scopes) {
    if (!sameSite(u.hostname, s)) continue;
    if (u.protocol !== s.protocol && !(s.protocol === 'http:' && u.protocol === 'https:')) continue;
    if (u.port !== s.port) continue;
    if (!u.pathname.startsWith(s.pathPrefix) && `${u.pathname}/` !== s.pathPrefix) continue;
    return s;
  }
  return null;
}

/** Why a link is not followed, or null when it may be. */
export type LinkRefusal = 'not-a-page' | 'account' | 'action' | 'secret' | 'excluded';

/**
 * Whether the crawler may follow a link it found on a saved page. A crawler
 * that only reads must never follow a link that acts: sign out, delete, buy,
 * vote. `signedIn` tightens the rule, because there an action link does real
 * harm to the person's account.
 */
export function linkRefusal(
  url: string,
  opts: { signedIn?: boolean; exclude?: readonly string[] } = {},
): LinkRefusal | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'not-a-page';
  }
  if (NON_PAGE_EXTENSION.test(u.pathname)) return 'not-a-page';
  for (const [k] of u.searchParams) if (SECRET_PARAM.test(k)) return 'secret';
  const pathWords = wordsOf(decodeSafe(u.pathname));
  const queryWords = wordsOf([...u.searchParams.keys()].join(' '));
  const queryValues = wordsOf([...u.searchParams.values()].join(' '));
  if (pathWords.some((w) => ACCOUNT_WORDS.has(w))) return 'account';
  const actionWords = opts.signedIn ? SIGNED_IN_ACTION_WORDS : ALWAYS_ACTION_WORDS;
  if (pathWords.some((w) => actionWords.has(w))) return 'action';
  if (queryWords.some((w) => w === 'action' || w === 'do' || w === 'cmd' || w === 'op'))
    return 'action';
  if (opts.signedIn && queryValues.some((w) => SIGNED_IN_ACTION_WORDS.has(w))) return 'action';
  for (const raw of opts.exclude ?? []) {
    if (excludeMatches(raw.trim(), u)) return 'excluded';
  }
  return null;
}

function decodeSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * A person's exclude pattern. `*` matches any run of characters. A pattern
 * starting with `/` is a path prefix (`/blog/` skips the blog); anything else
 * matches anywhere in the address (`?page=`, `/tag/`, `print`).
 */
export function excludeMatches(pattern: string, url: URL): boolean {
  if (!pattern) return false;
  const body = pattern
    .split('*')
    .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  if (pattern.startsWith('/')) return new RegExp(`^${body}`, 'i').test(url.pathname + url.search);
  return new RegExp(body, 'i').test(url.href);
}

/**
 * An address safe to show in a log line, an error or History: no user name or
 * password, no fragment, and the value of any credential-like parameter
 * replaced. Unparseable input comes back as a fixed placeholder, never raw.
 */
export function redactPageUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return '(address)';
  }
  u.username = '';
  u.password = '';
  u.hash = '';
  const entries = [...u.searchParams.entries()];
  if (entries.some(([k]) => SECRET_PARAM.test(k))) {
    u.search = '';
    for (const [k, v] of entries) u.searchParams.append(k, SECRET_PARAM.test(k) ? '…' : v);
  }
  return u.href;
}

/** Characters that end an address in running text. */
const TRAILING = /[.,;:!?'"’”)\]}>]+$/;

/**
 * A markdown link or image, `[label](target "title")`. The chat composer
 * stores every link it autolinks this way, so `[https://x](https://x)` is the
 * usual shape of an address a person typed; read as running text, the
 * address pattern swallowed the brackets and produced `https://x](https://x)`.
 */
const MARKDOWN_LINK =
  /(!?)\[(?:[^[\]\n]|\[[^[\]\n]*\])*\]\(\s*<?((?:[^\s()<>]|\([^\s()<>]*\))+)>?\s*(?:"[^"\n]*"\s*|'[^'\n]*'\s*)?\)/g;

/** The text with each markdown link replaced by its target and each image dropped. */
function withMarkdownLinkTargets(text: string): string {
  if (!text.includes('](')) return text;
  return text.replace(MARKDOWN_LINK, (_match, image: string, target: string) =>
    image ? ' ' : ` ${target} `,
  );
}

/**
 * Web addresses written in a message: `https://…`, `http://…` and `www.…`.
 * Trailing punctuation is trimmed, a closing parenthesis is kept when the
 * address opened one, and duplicates are dropped. Returned normalized, in the
 * order they appear.
 */
export function findUrlsInText(text: string, max = 10): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /\b(?:https?:\/\/|www\.)[^\s<>"'`]+/gi;
  for (const m of withMarkdownLinkTargets(text).matchAll(re)) {
    let raw = m[0];
    while (TRAILING.test(raw)) {
      const last = raw.at(-1);
      if (last === ')' && (raw.match(/\(/g)?.length ?? 0) >= (raw.match(/\)/g)?.length ?? 0)) break;
      raw = raw.slice(0, -1);
    }
    const url = normalizePageUrl(/^www\./i.test(raw) ? `https://${raw}` : raw);
    if (!url) continue;
    const host = new URL(url).hostname;
    if (!host.includes('.') && host !== 'localhost') continue;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(url);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * An address as a person reads it in a sentence: host and path, without the
 * scheme. A query is shown as `?…`, so the label never hides that the address
 * carries more than its path (the full address belongs in a tooltip).
 */
export function pageLabel(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname === '/' ? '' : u.pathname}${u.search ? '?…' : ''}`;
  } catch {
    return url;
  }
}
