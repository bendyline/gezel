/**
 * Tables of contents that documentation trees already carry. Each parser
 * turns one tool's outline into the same shape — a tree of topics holding
 * ordered document entries — which the Markdown adapter lays over its
 * folder-derived tree: a file the outline names is filed where the outline
 * puts it, with the outline's title and position, and a file it omits stays
 * in its folder. Parsers are pure: they see text and the list of Markdown
 * files, never the disk, so an outline can be checked in a test without a
 * tree on disk.
 */

import { posix } from 'node:path';

export type TableOfContentsFormat = 'folders' | 'hugo' | 'gitbook' | 'mkdocs' | 'jupyter-book';
export type OutlineFormat = Exclude<TableOfContentsFormat, 'folders' | 'hugo'>;

export interface OutlineEntry {
  /** Root-relative POSIX path of the Markdown file, extension included. */
  file: string;
  /** The title the outline gives the page; wins over the file's own. */
  title?: string;
  /** Listing position among the documents of the containing topic. */
  order?: number;
}

export interface OutlineTopic {
  name: string;
  description?: string;
  /** Position among sibling topics. */
  order?: number;
  /** When set, the topic takes the resolved title of this document (a root-relative file). */
  titleFromFile?: string;
  children: OutlineTopic[];
  entries: OutlineEntry[];
}

export interface Outline {
  format: OutlineFormat;
  /** Top-level documents and topics; `root.name` is unused. */
  root: OutlineTopic;
  /** Root-relative files that are the outline itself and never documents. */
  consumed: string[];
  warnings: string[];
}

const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const MARKDOWN_EXT = /\.(md|markdown)$/i;

export function newOutlineTopic(name: string): OutlineTopic {
  return { name, children: [], entries: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isExternal(target: string): boolean {
  return HAS_SCHEME.test(target) || target.startsWith('//');
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function stem(file: string): string {
  return posix.basename(file).replace(MARKDOWN_EXT, '');
}

/**
 * A link target relative to `baseDir` (root-relative POSIX, `''` for the
 * root) as a root-relative POSIX path, or null when it is empty, absolute
 * or leaves the root. Fragments and queries are dropped.
 */
export function resolveOutlinePath(baseDir: string, target: string): string | null {
  const cleaned = safeDecode(
    target
      .replace(/\\/g, '/')
      .replace(/[#?].*$/, '')
      .trim(),
  );
  if (cleaned === '' || posix.isAbsolute(cleaned)) return null;
  const joined = posix.normalize(posix.join(baseDir, cleaned));
  if (joined === '..' || joined.startsWith('../')) return null;
  return joined === '.' ? '' : joined;
}

/**
 * Positions become orders wherever the outline gave none. Entries and
 * child topics are ranked separately, each 1-based, because the catalog
 * orders documents by ordinal and topics by sort key.
 */
export function assignOutlineOrders(topic: OutlineTopic): void {
  topic.entries.forEach((entry, i) => {
    if (entry.order === undefined) entry.order = i + 1;
  });
  topic.children.forEach((child, i) => {
    if (child.order === undefined) child.order = i + 1;
    assignOutlineOrders(child);
  });
}

/**
 * `getting-started` → `Getting Started`. Separators become spaces and each
 * all-lowercase word is capitalized; a word that already carries a capital
 * (`API`, `iPhone`) is left as written.
 */
export function titleFromFolderName(name: string): string {
  const words = name.replace(/[_-]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return name;
  return words
    .map((word) => (/[A-Z]/.test(word) ? word : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(' ');
}

// ── GitBook: SUMMARY.md ─────────────────────────────────────────────────────

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const LIST_ITEM = /^([ \t]*)(?:[-*+]|\d+[.)])\s+(.+?)\s*$/;
const ITEM_LINK = /^\[([^\]]*)\]\(\s*<?([^)>\s]*)>?(?:\s+"[^"]*")?\s*\)$/;

interface SummarySlot {
  indent: number;
  title: string;
  container: OutlineTopic;
  entry?: OutlineEntry;
  topic?: OutlineTopic;
}

/** A page with sub-pages heads its own section and is listed first in it. */
function materializeSummaryTopic(slot: SummarySlot): OutlineTopic {
  if (slot.topic) return slot.topic;
  const topic = newOutlineTopic(slot.title || 'Untitled');
  if (slot.entry) {
    const at = slot.container.entries.indexOf(slot.entry);
    if (at >= 0) slot.container.entries.splice(at, 1);
    topic.entries.push(slot.entry);
  }
  slot.container.children.push(topic);
  slot.topic = topic;
  return topic;
}

/**
 * GitBook's `SUMMARY.md`: a nested list of `[Title](page.md)` items, where a
 * `## Heading` opens a part. An item with children becomes a topic; when
 * it links a page, that page leads the topic. Plain-text items are groups.
 */
export function parseGitbookSummary(text: string, summaryFile: string): Outline {
  const dir = posix.dirname(summaryFile);
  const baseDir = dir === '.' ? '' : dir;
  const outline: Outline = {
    format: 'gitbook',
    root: newOutlineTopic(''),
    consumed: [summaryFile],
    warnings: [],
  };
  let container = outline.root;
  const stack: SummarySlot[] = [];
  let fence: string | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\t/g, '    ');
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = (fenceMatch[1] as string)[0] as string;
      if (fence === null) fence = marker;
      else if (marker === fence) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const heading = HEADING.exec(line);
    if (heading) {
      // The H1 is the book's own title; deeper headings open parts.
      if ((heading[1] as string).length === 1) continue;
      const part = newOutlineTopic((heading[2] as string).replace(/[*_`]/g, '').trim() || 'Part');
      outline.root.children.push(part);
      container = part;
      stack.length = 0;
      continue;
    }
    const item = LIST_ITEM.exec(line);
    if (!item) continue;
    const indent = (item[1] as string).length;
    while (stack.length > 0 && (stack[stack.length - 1] as SummarySlot).indent >= indent) {
      stack.pop();
    }
    const parent = stack[stack.length - 1];
    const parentTopic = parent ? materializeSummaryTopic(parent) : container;
    const content = (item[2] as string).trim();
    const link = ITEM_LINK.exec(content);
    const title = (link ? (link[1] as string) : content).replace(/[*_`]/g, '').trim();
    const slot: SummarySlot = { indent, title, container: parentTopic };
    const target = link?.[2] ?? '';
    if (link && target !== '' && !isExternal(target)) {
      const file = resolveOutlinePath(baseDir, target);
      if (file === null) {
        outline.warnings.push(`${summaryFile}: '${target}' leaves the catalog tree; skipped`);
      } else if (!MARKDOWN_EXT.test(file)) {
        outline.warnings.push(`${summaryFile}: '${target}' is not a Markdown page; skipped`);
      } else {
        slot.entry = { file, ...(title ? { title } : {}) };
        parentTopic.entries.push(slot.entry);
      }
    }
    stack.push(slot);
  }
  assignOutlineOrders(outline.root);
  return outline;
}

// ── MkDocs: mkdocs.yml nav ──────────────────────────────────────────────────

/**
 * The `nav` list of an `mkdocs.yml`: `- page.md`, `- Title: page.md`, and
 * `- Section: [ … ]`. Returns null when the config has no `nav`, which in
 * MkDocs means the folder tree is the outline — the adapter's default too.
 * `docsDir` is the docs directory relative to the content root.
 */
export function parseMkdocsNav(
  config: unknown,
  docsDir: string,
  configFile = 'mkdocs.yml',
): Outline | null {
  if (!isRecord(config)) throw new Error(`${configFile}: not a mapping`);
  const nav = config.nav;
  if (nav === undefined || nav === null) return null;
  if (!Array.isArray(nav)) throw new Error(`${configFile}: 'nav' must be a list`);
  const outline: Outline = {
    format: 'mkdocs',
    root: newOutlineTopic(''),
    consumed: [],
    warnings: [],
  };
  const add = (container: OutlineTopic, target: string, title?: string): void => {
    if (isExternal(target)) return;
    const file = resolveOutlinePath(docsDir, target);
    if (file === null) {
      outline.warnings.push(
        `${configFile}: nav entry '${target}' leaves the docs directory; skipped`,
      );
      return;
    }
    if (!MARKDOWN_EXT.test(file)) {
      outline.warnings.push(`${configFile}: nav entry '${target}' is not a Markdown page; skipped`);
      return;
    }
    container.entries.push({ file, ...(title ? { title } : {}) });
  };
  const walk = (items: unknown[], container: OutlineTopic): void => {
    for (const item of items) {
      if (typeof item === 'string') {
        add(container, item);
        continue;
      }
      if (!isRecord(item)) {
        outline.warnings.push(`${configFile}: unrecognized nav entry ${JSON.stringify(item)}`);
        continue;
      }
      for (const [title, value] of Object.entries(item)) {
        if (typeof value === 'string') {
          add(container, value, title.trim());
        } else if (Array.isArray(value)) {
          const section = newOutlineTopic(title.trim() || 'Section');
          walk(value, section);
          container.children.push(section);
        } else {
          outline.warnings.push(
            `${configFile}: nav entry '${title}' is neither a page nor a section`,
          );
        }
      }
    }
  };
  walk(nav, outline.root);
  assignOutlineOrders(outline.root);
  return outline;
}

// ── Jupyter Book: _toc.yml ──────────────────────────────────────────────────

function globToRegExp(pattern: string): RegExp {
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i] as string;
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        source += '.*';
        i++;
      } else source += '[^/]*';
    } else if (ch === '?') source += '[^/]';
    else source += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

/**
 * Jupyter Book's `_toc.yml`: `format: jb-book` (`root`, `parts` with a
 * `caption`, `chapters`, nested `sections`) or `jb-article` (`root`,
 * `sections`); the pre-1.0 list form is read too. Files are named without
 * extension and resolved against the Markdown files of the tree, so a
 * notebook entry is skipped with a warning. A chapter with sections becomes
 * a topic, led by its own page; `glob` entries expand in sorted order;
 * `url` entries are links, not pages.
 */
export function parseJupyterBookToc(
  doc: unknown,
  tocDir: string,
  files: readonly string[],
  tocFile = '_toc.yml',
): Outline {
  const outline: Outline = {
    format: 'jupyter-book',
    root: newOutlineTopic(''),
    consumed: [],
    warnings: [],
  };
  const known = new Set(files.map((f) => f.normalize('NFC')));
  const resolveFile = (spec: string): string | null => {
    const candidates = MARKDOWN_EXT.test(spec) ? [spec] : [`${spec}.md`, `${spec}.markdown`];
    for (const candidate of candidates) {
      const path = resolveOutlinePath(tocDir, candidate);
      if (path !== null && known.has(path.normalize('NFC'))) return path;
    }
    return null;
  };
  const expandGlob = (pattern: string): string[] => {
    const regex = globToRegExp(pattern.replace(/\\/g, '/'));
    const prefix = tocDir ? `${tocDir}/` : '';
    return files
      .filter((file) => {
        if (!file.startsWith(prefix)) return false;
        const rel = file.slice(prefix.length);
        return regex.test(rel) || regex.test(rel.replace(MARKDOWN_EXT, ''));
      })
      .sort();
  };
  const walkItems = (items: unknown, container: OutlineTopic, where: string): void => {
    if (items === undefined || items === null) return;
    if (!Array.isArray(items)) {
      outline.warnings.push(`${tocFile}: ${where} must be a list`);
      return;
    }
    for (const item of items) {
      if (!isRecord(item)) {
        outline.warnings.push(`${tocFile}: ${where} holds an unrecognized entry`);
        continue;
      }
      const title = typeof item.title === 'string' ? item.title.trim() : undefined;
      if (typeof item.url === 'string') continue;
      if (typeof item.glob === 'string') {
        for (const file of expandGlob(item.glob)) container.entries.push({ file });
        continue;
      }
      if (typeof item.file !== 'string') {
        outline.warnings.push(`${tocFile}: ${where} holds an entry without 'file'`);
        continue;
      }
      const file = resolveFile(item.file);
      if (file === null) {
        outline.warnings.push(
          `${tocFile}: '${item.file}' is not a Markdown file in the tree (notebooks are not supported); skipped`,
        );
        continue;
      }
      const entry: OutlineEntry = { file, ...(title ? { title } : {}) };
      const children = item.sections ?? item.chapters ?? item.entries;
      if (Array.isArray(children) && children.length > 0) {
        const topic = newOutlineTopic(title ?? titleFromFolderName(stem(file)));
        if (!title) topic.titleFromFile = file;
        topic.entries.push(entry);
        walkItems(children, topic, `'${item.file}'`);
        container.children.push(topic);
      } else {
        container.entries.push(entry);
      }
    }
  };

  if (Array.isArray(doc)) {
    for (const item of doc) {
      if (isRecord(item) && typeof item.part === 'string') {
        const part = newOutlineTopic(item.part.trim() || 'Part');
        walkItems(item.chapters ?? item.sections, part, `part '${item.part}'`);
        outline.root.children.push(part);
      } else {
        walkItems([item], outline.root, 'the list');
      }
    }
  } else if (isRecord(doc)) {
    if (typeof doc.root === 'string') {
      const file = resolveFile(doc.root);
      if (file === null) {
        outline.warnings.push(
          `${tocFile}: root '${doc.root}' is not a Markdown file in the tree; skipped`,
        );
      } else {
        outline.root.entries.push({ file });
      }
    }
    if (Array.isArray(doc.parts)) {
      for (const part of doc.parts) {
        if (!isRecord(part)) continue;
        const caption = typeof part.caption === 'string' ? part.caption.trim() : '';
        const topic = newOutlineTopic(caption || 'Part');
        walkItems(part.chapters ?? part.sections, topic, `part '${topic.name}'`);
        outline.root.children.push(topic);
      }
    }
    walkItems(doc.chapters, outline.root, 'chapters');
    walkItems(doc.sections, outline.root, 'sections');
  } else {
    throw new Error(`${tocFile}: not a mapping or a list`);
  }
  assignOutlineOrders(outline.root);
  return outline;
}
