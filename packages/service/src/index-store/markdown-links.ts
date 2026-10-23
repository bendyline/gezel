import type { ImportEdgeInput } from './index-store-types.js';

/**
 * The files a markdown document links to, as import rows: inline links and
 * images (`[t](x)`, `![a](x)`), reference definitions (`[id]: x`), and HTML
 * `href`/`src` attributes. Only paths inside the project survive — anything
 * with a scheme (`https:`, `mailto:`), protocol-relative `//host`, or a bare
 * `#anchor` is dropped, and code (fenced or inline) is never read as links.
 *
 * A target relative to the document is spelled with a leading `./` so every
 * row reads like a relative import; a root-absolute `/docs/x.md` (GitHub's
 * repo-root form) keeps its slash. Anchors and queries are stripped.
 */

/** Past this, a document is not prose with links but generated content. */
const MAX_LINKS = 500;

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const INLINE_LINK =
  /!?\[(?:[^\]\\]|\\.)*\]\(\s*(<[^>]*>|[^\s)]+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;
const REFERENCE_DEF = /^ {0,3}\[[^\]]+\]:\s*(<[^>]*>|\S+)/;
const HTML_ATTR = /\b(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const INLINE_CODE = /`+[^`]*`+/g;

export function extractMarkdownLinks(content: string): ImportEdgeInput[] {
  const out = new Set<string>();
  const add = (target: string | undefined): void => {
    if (out.size >= MAX_LINKS || !target) return;
    const raw = normalizeLinkTarget(target);
    if (raw) out.add(raw);
  };
  let fence: string | null = null;
  for (const line of content.split(/\r?\n/)) {
    const marker = FENCE.exec(line)?.[1];
    if (marker) {
      if (fence === null) fence = marker[0]!.repeat(marker.length);
      else if (marker.startsWith(fence)) fence = null;
      continue;
    }
    if (fence !== null) continue;
    // Indented code (4 spaces) after a blank line is rare in docs and costly
    // to track; a false link from one only adds an edge to an existing file.
    const prose = line.replace(INLINE_CODE, '');
    const ref = REFERENCE_DEF.exec(prose);
    if (ref) add(ref[1]);
    for (const m of prose.matchAll(INLINE_LINK)) add(m[1]);
    for (const m of prose.matchAll(HTML_ATTR)) add(m[1] ?? m[2]);
  }
  return [...out].sort().map((raw) => ({ raw }));
}

/** One link destination as an import specifier, or null when it leaves the project. */
export function normalizeLinkTarget(target: string): string | null {
  let t = target.trim();
  if (t.startsWith('<') && t.endsWith('>')) t = t.slice(1, -1).trim();
  if (!t || t.startsWith('#') || t.startsWith('//') || SCHEME.test(t)) return null;
  const cut = t.search(/[?#]/);
  if (cut >= 0) t = t.slice(0, cut);
  try {
    t = decodeURIComponent(t);
  } catch {
    /* a stray `%` — keep the text as written */
  }
  t = t.replace(/\\/g, '/');
  if (!t || t === '.' || t === './') return null;
  if (t.startsWith('/') || t.startsWith('./') || t.startsWith('../')) return t;
  return `./${t}`;
}
