import type { PageLibraryForm, PageLibraryLine } from '../schemas/page-library.js';
import {
  type PageImportMap,
  buildPageImportMap,
  importMapJson,
  mergeAuthoredImportMap,
} from './import-map.js';
import { type PageLibraryPins, pageLibraryFileUrl, resolvePageLibraryUrl } from './resolver.js';

/**
 * Points a page's library spellings at the shelf: CDN `<script>` and `<link>`
 * addresses, CDN imports inside inline modules, and the page's import map.
 * The file on disk is never changed, so the page still names its libraries
 * the way the open web serves them.
 */

export interface HtmlAttribute {
  name: string;
  /** Decoded value; empty for an attribute with none. */
  value: string;
  /** The whole attribute, name included. */
  start: number;
  end: number;
  /** The value's text without its quotes. Equal when there is no value. */
  valueStart: number;
  valueEnd: number;
}

export interface HtmlElementPart {
  tag: 'script' | 'link';
  /** The `<` that opens the tag. */
  start: number;
  /** Just past the tag: past `</script>` for a script, past `>` for a link. */
  end: number;
  attributes: HtmlAttribute[];
  /** A script's inline text. Absent on `<link>` and on a script never closed. */
  bodyStart?: number;
  bodyEnd?: number;
}

/** Elements whose text is never markup, so a `<script` inside one is only text. */
const TEXT_ONLY = new Set(['style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes']);

function decodeAttribute(text: string): string {
  return text
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function closingTag(html: string, tag: string, from: number): number {
  const pattern = new RegExp(`</${tag}(?=[\\s/>])`, 'gi');
  pattern.lastIndex = from;
  return pattern.exec(html)?.index ?? -1;
}

/**
 * Finds every `<script>` and `<link>` with exact offsets, reading tags the
 * way a browser's tokenizer does: comments and text-only elements are
 * skipped, and a script's body runs to its closing tag whatever it contains.
 */
export function locateScriptsAndLinks(html: string): HtmlElementPart[] {
  const parts: HtmlElementPart[] = [];
  const length = html.length;
  let at = 0;
  while (at < length) {
    const open = html.indexOf('<', at);
    if (open === -1) break;
    if (html.startsWith('<!--', open)) {
      const end = html.indexOf('-->', open + 4);
      at = end === -1 ? length : end + 3;
      continue;
    }
    const named = /^<([a-zA-Z][^\s/>]*)/.exec(html.slice(open, open + 64));
    if (!named) {
      at = open + 1;
      continue;
    }
    const tag = named[1]!.toLowerCase();
    const attributes: HtmlAttribute[] = [];
    let cursor = open + named[0].length;
    while (cursor < length && html[cursor] !== '>') {
      if (/[\s/]/.test(html[cursor]!)) {
        cursor += 1;
        continue;
      }
      const start = cursor;
      while (cursor < length && !/[\s=>/]/.test(html[cursor]!)) cursor += 1;
      const name = html.slice(start, cursor).toLowerCase();
      let end = cursor;
      let valueStart = cursor;
      let valueEnd = cursor;
      let probe = cursor;
      while (probe < length && /\s/.test(html[probe]!)) probe += 1;
      if (html[probe] === '=') {
        probe += 1;
        while (probe < length && /\s/.test(html[probe]!)) probe += 1;
        const quote = html[probe];
        if (quote === '"' || quote === "'") {
          const close = html.indexOf(quote, probe + 1);
          valueStart = probe + 1;
          valueEnd = close === -1 ? length : close;
          end = Math.min(length, valueEnd + 1);
        } else {
          valueStart = probe;
          while (probe < length && !/[\s>]/.test(html[probe]!)) probe += 1;
          valueEnd = probe;
          end = probe;
        }
        cursor = end;
      }
      if (name) {
        attributes.push({
          name,
          value: decodeAttribute(html.slice(valueStart, valueEnd)),
          start,
          end,
          valueStart,
          valueEnd,
        });
      }
      // A stray character that is neither a name nor a value must not stall the scan.
      if (cursor === start) cursor += 1;
    }
    const openEnd = Math.min(length, cursor + 1);
    if (tag === 'script') {
      const close = closingTag(html, 'script', openEnd);
      const closeEnd = close === -1 ? length : html.indexOf('>', close) + 1 || length;
      parts.push({
        tag,
        start: open,
        end: closeEnd,
        attributes,
        ...(close === -1 ? {} : { bodyStart: openEnd, bodyEnd: close }),
      });
      at = close === -1 ? length : close + 2;
    } else if (TEXT_ONLY.has(tag)) {
      const close = closingTag(html, tag, openEnd);
      at = close === -1 ? length : close + 2;
    } else {
      if (tag === 'link') parts.push({ tag, start: open, end: openEnd, attributes });
      at = openEnd;
    }
  }
  return parts;
}

export interface ModuleImport {
  specifier: string;
  /** The specifier's text inside its quotes. */
  start: number;
  end: number;
}

export interface PageLibraryContext {
  lines: readonly PageLibraryLine[];
  /** Where shelf files are served. Ends in `/`. */
  base: string;
  /** The project's settled versions (`PageLibraryPins`). */
  pins?: PageLibraryPins;
  /** Finds the imports in module code. Without it, inline modules keep their CDN imports. */
  scanImports?: (code: string) => ModuleImport[];
}

interface Edit {
  start: number;
  end: number;
  text: string;
}

function applyEdits(text: string, edits: Edit[]): string {
  let out = text;
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  }
  return out;
}

function isAbsoluteUrl(value: string): boolean {
  return /^(?:https?:)?\/\//i.test(value.trim());
}

/** Module code with its CDN imports pointed at the shelf. Bare imports are the import map's. */
export function rewriteModuleLibraryImports(
  code: string,
  imports: readonly ModuleImport[],
  ctx: Pick<PageLibraryContext, 'lines' | 'base' | 'pins'>,
): { code: string; notes: string[] } {
  const edits: Edit[] = [];
  const notes: string[] = [];
  for (const found of imports) {
    if (!isAbsoluteUrl(found.specifier)) continue;
    const file = resolvePageLibraryUrl(ctx.lines, found.specifier, 'module', ctx.pins);
    if (!file) continue;
    if (file.note) notes.push(file.note);
    edits.push({ start: found.start, end: found.end, text: pageLibraryFileUrl(ctx.base, file) });
  }
  return { code: edits.length ? applyEdits(code, edits) : code, notes };
}

function attribute(part: HtmlElementPart, name: string): HtmlAttribute | undefined {
  return part.attributes.find((entry) => entry.name === name);
}

/** How a `<script src>` or `<link href>` loads what it names, or null when it loads no library. */
function loadedForm(part: HtmlElementPart): PageLibraryForm | null {
  if (part.tag === 'script') {
    const type = attribute(part, 'type')?.value.trim().toLowerCase() ?? '';
    if (type === 'module') return 'module';
    return !type || /^(?:text|application)\/(?:java|ecma)script$/.test(type) ? 'classic' : null;
  }
  const rel = (attribute(part, 'rel')?.value ?? '').toLowerCase().split(/\s+/);
  if (rel.includes('stylesheet')) return 'style';
  if (rel.includes('modulepreload')) return 'module';
  if (rel.includes('preload')) {
    const as = attribute(part, 'as')?.value.trim().toLowerCase();
    return as === 'style' ? 'style' : as === 'script' ? 'classic' : null;
  }
  return null;
}

export interface PageLibraryRewrite {
  html: string;
  /** The import map element to add ahead of the page's scripts; null when the page's own was merged. */
  importMap: string | null;
  /** What the person and the model should know: a version that was swapped, a map that was ignored. */
  notes: string[];
}

export function rewritePageLibraries(
  html: string,
  ctx: PageLibraryContext,
  parts: readonly HtmlElementPart[] = locateScriptsAndLinks(html),
): PageLibraryRewrite {
  if (!ctx.lines.length) return { html, importMap: null, notes: [] };
  const edits: Edit[] = [];
  const notes: string[] = [];
  const ours: PageImportMap = buildPageImportMap(ctx.lines, ctx.base, ctx.pins);
  let authoredMap = false;

  for (const part of parts) {
    const address = attribute(part, part.tag === 'script' ? 'src' : 'href');
    const type = attribute(part, 'type')?.value.trim().toLowerCase();
    if (address) {
      const form = loadedForm(part);
      if (!form || !isAbsoluteUrl(address.value)) continue;
      const file = resolvePageLibraryUrl(ctx.lines, address.value.trim(), form, ctx.pins);
      if (!file) continue;
      if (file.note) notes.push(file.note);
      edits.push({
        start: address.valueStart,
        end: address.valueEnd,
        text: pageLibraryFileUrl(ctx.base, file),
      });
      // The hash is of the CDN's bytes at the version the page named.
      const integrity = attribute(part, 'integrity');
      if (integrity) {
        const lead = /\s/.test(html[integrity.start - 1] ?? '') ? 1 : 0;
        edits.push({ start: integrity.start - lead, end: integrity.end, text: '' });
      }
      continue;
    }
    if (part.tag !== 'script' || part.bodyStart === undefined || part.bodyEnd === undefined) {
      continue;
    }
    const body = html.slice(part.bodyStart, part.bodyEnd);
    if (type === 'importmap') {
      // A browser reads only a page's first import map.
      if (authoredMap) continue;
      authoredMap = true;
      const merged = mergeAuthoredImportMap(body, ours, ctx.lines, ctx.base, ctx.pins);
      notes.push(...merged.notes);
      edits.push({ start: part.bodyStart, end: part.bodyEnd, text: importMapJson(merged.map) });
    } else if (type === 'module' && ctx.scanImports) {
      const rewritten = rewriteModuleLibraryImports(body, ctx.scanImports(body), ctx);
      notes.push(...rewritten.notes);
      if (rewritten.code !== body) {
        edits.push({ start: part.bodyStart, end: part.bodyEnd, text: rewritten.code });
      }
    }
  }

  const needsMap = !authoredMap && Object.keys(ours.imports).length > 0;
  return {
    html: edits.length ? applyEdits(html, edits) : html,
    importMap: needsMap ? `<script type="importmap">${importMapJson(ours)}</script>` : null,
    notes: [...new Set(notes)],
  };
}
