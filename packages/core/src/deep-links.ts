/**
 * `gezel://` links: a web page (gezel.com's app and craftbook pages, Hugging
 * Face's "Use this model" menu) asks the desktop app to open a screen. Every
 * target only opens something for the person to confirm. None creates, runs,
 * installs or downloads anything, and a link carries no text into a form,
 * because the page that sent it is not the person. Contract in
 * docs/deep-links.md.
 */

import { isHuggingFaceRepoId, isSafeGgufRepoPath } from './model-import/hf-reference.js';

export const GEZEL_URL_SCHEME = 'gezel';

/** Longer than any real link; a longer one is someone probing. */
export const MAX_DEEP_LINK_LENGTH = 1024;

export type GezelDeepLink =
  | { kind: 'home' }
  /** A project type ("Gezel app"): New Project on that type's form. */
  | { kind: 'app'; id: string }
  /** A craftbook: its launch form, in the project new work goes to. */
  | { kind: 'craftbook'; id: string }
  /** A Handboek article, by its frontmatter id. */
  | { kind: 'docs'; id: string }
  /**
   * A model on Hugging Face: the review that checks it before any download.
   * `file` narrows it to one GGUF (any shard of a split model).
   */
  | { kind: 'model'; source: 'huggingface'; repo: string; file?: string };

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
  if (kind === 'model') return parseModelLink(segments, url.searchParams);
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

/**
 * `gezel://model/huggingface/<owner>/<name>[?file=<path.gguf>]`. The file is
 * the one query parameter any target accepts, and only because it is an
 * identifier with a strict grammar, not text: the review shows it and the
 * person still chooses. Anything malformed opens Home.
 */
function parseModelLink(segments: string[], query: URLSearchParams): GezelDeepLink {
  if (segments.length !== 3 || segments[0]?.toLowerCase() !== 'huggingface') {
    return { kind: 'home' };
  }
  let repo: string;
  try {
    repo = `${decodeURIComponent(segments[1] as string)}/${decodeURIComponent(segments[2] as string)}`;
  } catch {
    return { kind: 'home' };
  }
  if (!isHuggingFaceRepoId(repo)) return { kind: 'home' };
  const file = query.get('file');
  if (file !== null && !isSafeGgufRepoPath(file)) return { kind: 'home' };
  return { kind: 'model', source: 'huggingface', repo, ...(file ? { file } : {}) };
}

/** Re-check a link that crossed a process boundary (main to renderer). */
export function isGezelDeepLink(value: unknown): value is GezelDeepLink {
  if (!value || typeof value !== 'object') return false;
  const link = value as { kind?: unknown; id?: unknown };
  if (link.kind === 'home') return true;
  if (link.kind === 'model') {
    const model = value as { source?: unknown; repo?: unknown; file?: unknown };
    return (
      model.source === 'huggingface' &&
      typeof model.repo === 'string' &&
      isHuggingFaceRepoId(model.repo) &&
      (model.file === undefined ||
        (typeof model.file === 'string' && isSafeGgufRepoPath(model.file)))
    );
  }
  return (
    typeof link.kind === 'string' &&
    ID_KINDS.has(link.kind) &&
    typeof link.id === 'string' &&
    LINK_ID.test(link.id)
  );
}

/** The link for a target, as gezel.com (or Hugging Face) writes it. */
export function gezelDeepLinkUrl(link: GezelDeepLink): string {
  if (link.kind === 'home') return `${GEZEL_URL_SCHEME}://open`;
  if (link.kind === 'model') {
    const [owner, name] = link.repo.split('/') as [string, string];
    const base = `${GEZEL_URL_SCHEME}://model/huggingface/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
    return link.file ? `${base}?file=${encodeURIComponent(link.file)}` : base;
  }
  return `${GEZEL_URL_SCHEME}://${link.kind}/${encodeURIComponent(link.id)}`;
}
