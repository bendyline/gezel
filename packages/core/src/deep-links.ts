/**
 * `gezel://` links: a web page (gezel.com's app and craftbook pages) asks the
 * desktop app to open a screen. Every target only opens something for the
 * person to confirm. None creates, runs, installs or downloads anything, and a
 * link carries no text into a form, because the page that sent it is not the
 * person. Contract in docs/deep-links.md.
 */

export const GEZEL_URL_SCHEME = 'gezel';

/** Longer than any real link; a longer one is someone probing. */
export const MAX_DEEP_LINK_LENGTH = 512;

export type GezelDeepLink =
  | { kind: 'home' }
  /** A project type ("Gezel app"): New Project on that type's form. */
  | { kind: 'app'; id: string }
  /** A craftbook: its launch form, in the project new work goes to. */
  | { kind: 'craftbook'; id: string }
  /** A Handboek article, by its frontmatter id. */
  | { kind: 'docs'; id: string };

/** Catalog ids and Handboek article ids: lowercase, digits, `-`, `_`, `.`. */
const LINK_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;

const ID_KINDS = new Set(['app', 'craftbook', 'docs']);

/**
 * Read a raw `gezel://` URL. Answers null for anything that is not a gezel
 * URL at all, so a command-line scan can hand it every argument. A gezel URL
 * this build does not understand (a newer target, a malformed id) opens Home:
 * the link still brings the app forward, and nothing guesses at what it meant.
 */
export function parseGezelDeepLink(raw: string): GezelDeepLink | null {
  const text = raw.trim();
  if (!text.toLowerCase().startsWith(`${GEZEL_URL_SCHEME}:`)) return null;
  if (text.length > MAX_DEEP_LINK_LENGTH) return { kind: 'home' };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { kind: 'home' };
  }
  const kind = url.hostname.toLowerCase();
  const segments = url.pathname.split('/').filter(Boolean);
  if (!ID_KINDS.has(kind) || segments.length !== 1) return { kind: 'home' };
  let id: string;
  try {
    id = decodeURIComponent(segments[0] as string);
  } catch {
    return { kind: 'home' };
  }
  if (!LINK_ID.test(id)) return { kind: 'home' };
  return { kind: kind as 'app' | 'craftbook' | 'docs', id };
}

/** Re-check a link that crossed a process boundary (main to renderer). */
export function isGezelDeepLink(value: unknown): value is GezelDeepLink {
  if (!value || typeof value !== 'object') return false;
  const link = value as { kind?: unknown; id?: unknown };
  if (link.kind === 'home') return true;
  return (
    typeof link.kind === 'string' &&
    ID_KINDS.has(link.kind) &&
    typeof link.id === 'string' &&
    LINK_ID.test(link.id)
  );
}

/** The link for a target, as gezel.com writes it. */
export function gezelDeepLinkUrl(link: GezelDeepLink): string {
  if (link.kind === 'home') return `${GEZEL_URL_SCHEME}://open`;
  return `${GEZEL_URL_SCHEME}://${link.kind}/${encodeURIComponent(link.id)}`;
}
