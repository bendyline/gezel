/**
 * Helpers for normalizing the YAML aria-snapshot that
 * `@playwright/mcp` produces.
 *
 * Three transforms, each a pure string -> string|list:
 *
 *   1. `stripNoise` — remove cosmetic annotations
 *      (`[cursor=pointer]`, etc.) that bloat the prompt without
 *      affecting model decision-making.
 *   2. `extractUrls` — pull `/url:` lines and pair them with the
 *      visible text of their parent link/button. Surfaced to the
 *      model as a flat "Links on this page" list so a small model
 *      doesn't have to walk the tree to find href targets.
 *   3. `extractRefIndex` — collect every interactive element's
 *      `[ref=eN]` along with role + accessible name, so the model
 *      has a quick lookup table for the next click/type/select.
 *
 * Kept separate from the wrapper so they can be unit-tested without
 * touching the bridge.
 */

const CURSOR_ANNOTATION_RE = / \[cursor=pointer\]/g;

const URL_LINE_RE = /^(\s*)- \/url:\s*(?:"([^"]+)"|(\S+))\s*$/;
const PARENT_LINE_RE = /^(\s*)- (link|button|menuitem)\s+"([^"]+)"(?:.*\[ref=(e\d+)\])?/;

/**
 * Roles whose `[ref=eN]` is worth surfacing in the index. Excludes
 * structural roles (generic, banner, navigation) — those exist to
 * group children and aren't actionable on their own.
 */
const INTERACTIVE_ROLES = [
  'button',
  'link',
  'textbox',
  'searchbox',
  'combobox',
  'checkbox',
  'radio',
  'switch',
  'slider',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'tab',
  'option',
  'spinbutton',
];

const REF_INDEX_RE = new RegExp(
  String.raw`^\s*- (` + INTERACTIVE_ROLES.join('|') + String.raw`)\s+"([^"]+)"\s+\[ref=(e\d+)\]`,
);

export function stripNoise(yaml: string): string {
  return yaml.replace(CURSOR_ANNOTATION_RE, '');
}

export interface ExtractedUrl {
  text: string;
  url: string;
  ref?: string;
}

/**
 * Pull every `/url:` reference from the YAML, paired with the visible
 * text of its parent link/button. The parent line is the closest
 * preceding line with strictly less indentation.
 */
export function extractUrls(yaml: string): ExtractedUrl[] {
  const lines = yaml.split('\n');
  const out: ExtractedUrl[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    const m = line.match(URL_LINE_RE);
    if (!m) continue;
    const childIndent = (m[1] ?? '').length;
    const url = m[2] ?? m[3];
    if (!url) continue;
    // Walk back until we find a line with less indentation that
    // matches a parent role we recognize.
    for (let j = i - 1; j >= 0; j--) {
      const prev = lines[j];
      if (prev === undefined) continue;
      const pm = prev.match(PARENT_LINE_RE);
      if (!pm) continue;
      if ((pm[1] ?? '').length >= childIndent) continue;
      const text = pm[3];
      if (!text) continue;
      out.push({ text, url, ...(pm[4] ? { ref: pm[4] } : {}) });
      break;
    }
  }
  // Dedupe by URL — pages often link the same target many times.
  // Keep the first occurrence so the order matches reading order.
  const seen = new Set<string>();
  const deduped: ExtractedUrl[] = [];
  for (const u of out) {
    if (seen.has(u.url)) continue;
    seen.add(u.url);
    deduped.push(u);
  }
  return deduped;
}

export interface RefEntry {
  role: string;
  name: string;
  ref: string;
}

export function extractRefIndex(yaml: string): RefEntry[] {
  const out: RefEntry[] = [];
  const seen = new Set<string>();
  for (const line of yaml.split('\n')) {
    const m = line.match(REF_INDEX_RE);
    if (!m) continue;
    const role = m[1];
    const name = m[2];
    const ref = m[3];
    if (!role || !name || !ref) continue;
    const key = `${ref}:${role}:${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ role, name, ref });
  }
  return out;
}

/**
 * Format the URL list as a markdown bulleted list, capped to
 * `maxEntries`. Adds a footer noting how many were dropped.
 */
export function formatUrlList(urls: ExtractedUrl[], maxEntries = 80): string {
  if (urls.length === 0) return '';
  const head = urls.slice(0, maxEntries);
  const lines = head.map((u) => {
    const refMark = u.ref ? ` [${u.ref}]` : '';
    return `- "${u.text}" → ${u.url}${refMark}`;
  });
  if (urls.length > maxEntries) {
    lines.push(`- … (${urls.length - maxEntries} more URLs in the aria tree below)`);
  }
  return lines.join('\n');
}

/**
 * Format the ref index as a markdown bulleted list, capped.
 */
export function formatRefIndex(refs: RefEntry[], maxEntries = 60): string {
  if (refs.length === 0) return '';
  const head = refs.slice(0, maxEntries);
  const lines = head.map((r) => `- ${r.role} [${r.ref}] "${r.name}"`);
  if (refs.length > maxEntries) {
    lines.push(
      `- … (${refs.length - maxEntries} more interactive elements in the aria tree below)`,
    );
  }
  return lines.join('\n');
}
