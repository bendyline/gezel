/**
 * docfx tables of contents — the build behind Microsoft Learn (the Azure,
 * .NET and Microsoft 365 docs repos). A docfx tree has no single outline:
 * any folder may carry a `toc.yml` whose `href`s name pages and other TOCs,
 * and a breadcrumb TOC (`bread/toc.yml`, named by docfx.json's
 * `breadcrumb_path`) arranges those folders by site URL through `tocHref`.
 *
 * The parser starts from that entry TOC and follows `tocHref` and TOC
 * `href`s into the per-folder TOCs. Every TOC it did not reach is grafted
 * under the section that covers its nearest ancestor folder, or at the top,
 * because a breadcrumb is curated by hand and drifts from the tree: Azure's
 * names folders that left the repo and misses services that arrived. A page
 * another folder's TOC links to is a cross-link, filed there only when its
 * own folder's TOC does not list it, and a page no TOC lists joins the
 * section of the nearest folder that has one.
 *
 * Like the other outline parsers this one is pure: the caller reads
 * docfx.json and every `toc.yml` and hands over their parsed contents.
 */

import { posix } from 'node:path';
import {
  type Outline,
  type OutlineEntry,
  type OutlineTopic,
  assignOutlineOrders,
  newOutlineTopic,
  resolveOutlinePath,
  titleFromFolderName,
} from './outline.js';

export interface DocfxContentGroup {
  /** Source folder, root-relative POSIX (`''` for the root). */
  src: string;
  /** Site path the folder publishes to, relative to the site base (`''` for the base). */
  dest: string;
  include: RegExp[];
  exclude: RegExp[];
}

export interface DocfxProject {
  /** `build.content`; empty when the config names none, which publishes everything. */
  content: DocfxContentGroup[];
  /** `globalMetadata.breadcrumb_path`: the site URL of the breadcrumb TOC. */
  breadcrumbPath?: string;
}

export interface DocfxTocInput {
  /** Root-relative POSIX path of every `toc.yml` → its parsed YAML. */
  tocs: ReadonlyMap<string, unknown>;
  /** Root-relative POSIX paths of the Markdown files the build publishes. */
  files: readonly string[];
  project?: DocfxProject;
  /** Root-relative entry TOC; by default the breadcrumb, else the root `toc.yml`. */
  entry?: string;
}

export interface DocfxOutline extends Outline {
  /** The TOC the outline started from, root-relative; absent when every TOC was grafted. */
  entry?: string;
}

const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const MARKDOWN_EXT = /\.(md|markdown)$/i;
const TOC_FILE = /^toc\.(ya?ml|json|md)$/i;
const LANDING_PAGE = /(^|\/)index\.(ya?ml|md)$/i;
/** How many examples an aggregated warning names before it counts the rest. */
const WARNING_EXAMPLES = 5;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `./articles/` → `articles`; `.` and `./` → `''`. */
function normalizeFolder(value: unknown): string {
  if (typeof value !== 'string') return '';
  const cleaned = posix.normalize(value.replace(/\\/g, '/')).replace(/^\.?\/+|\/+$/g, '');
  return cleaned === '.' ? '' : cleaned;
}

function dirOf(file: string): string {
  const dir = posix.dirname(file);
  return dir === '.' ? '' : dir;
}

function parentOf(dir: string): string | null {
  return dir === '' ? null : dirOf(dir);
}

function isUnder(file: string, dir: string): boolean {
  return dir === '' || file.startsWith(`${dir}/`);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.+^$()|[\]\\]/g, '\\$&');
}

/**
 * A docfx file glob: `**` crosses folders (`**\/` also matches none), `*`
 * and `?` stay within one, `{a,b}` alternates. Case-insensitive, as the
 * Windows-born toolchain treats it.
 */
export function docfxGlob(pattern: string): RegExp {
  const p = pattern.replace(/\\/g, '/').replace(/^\.\//, '');
  let source = '';
  for (let i = 0; i < p.length; i++) {
    const ch = p[i] as string;
    if (ch === '*') {
      if (p[i + 1] === '*') {
        if (p[i + 2] === '/') {
          source += '(?:.*/)?';
          i += 2;
        } else {
          source += '.*';
          i += 1;
        }
      } else source += '[^/]*';
    } else if (ch === '?') {
      source += '[^/]';
    } else if (ch === '{' && p.indexOf('}', i) > i) {
      const close = p.indexOf('}', i);
      source += `(?:${p
        .slice(i + 1, close)
        .split(',')
        .map(escapeRegExp)
        .join('|')})`;
      i = close;
    } else {
      source += escapeRegExp(ch);
    }
  }
  return new RegExp(`^${source}$`, 'i');
}

function globList(value: unknown): RegExp[] {
  const list = typeof value === 'string' ? [value] : Array.isArray(value) ? value : [];
  return list.filter((g): g is string => typeof g === 'string' && g.trim() !== '').map(docfxGlob);
}

/** The parts of a docfx.json the outline needs: content groups and the breadcrumb URL. */
export function parseDocfxJson(config: unknown, configFile = 'docfx.json'): DocfxProject {
  if (!isRecord(config)) throw new Error(`${configFile}: not a JSON object`);
  const build = isRecord(config.build) ? config.build : {};
  const content: DocfxContentGroup[] = [];
  for (const group of Array.isArray(build.content) ? build.content : []) {
    if (!isRecord(group)) continue;
    const include = globList(group.files);
    if (include.length === 0) continue;
    content.push({
      src: normalizeFolder(group.src),
      dest: normalizeFolder(group.dest),
      include,
      exclude: globList(group.exclude),
    });
  }
  const meta = isRecord(build.globalMetadata) ? build.globalMetadata : {};
  const breadcrumb = meta.breadcrumb_path;
  return {
    content,
    ...(typeof breadcrumb === 'string' && breadcrumb.trim()
      ? { breadcrumbPath: breadcrumb.trim() }
      : {}),
  };
}

/**
 * Whether a docfx.json content group publishes this root-relative file.
 * The groups are a union: Azure's `articles` group excludes `iot-edge/**`
 * only because a group of its own publishes it.
 */
export function docfxPublishes(project: DocfxProject, file: string): boolean {
  if (project.content.length === 0) return true;
  return project.content.some((group) => {
    if (!isUnder(file, group.src)) return false;
    const rel = group.src === '' ? file : file.slice(group.src.length + 1);
    return group.include.some((r) => r.test(rel)) && !group.exclude.some((r) => r.test(rel));
  });
}

/** A TOC's item list: the bare-list form or the `items:` mapping. */
function tocItems(doc: unknown): unknown[] {
  if (Array.isArray(doc)) return doc;
  if (isRecord(doc) && Array.isArray(doc.items)) return doc.items;
  return [];
}

/**
 * A breadcrumb TOC lays out site URLs, never pages: no node has an `href`,
 * and some carry a `tocHref`. Service folders keep their own beside their
 * content TOC; walked as content, one would re-file whole services.
 */
function isBreadcrumbToc(doc: unknown): boolean {
  let tocHref = false;
  const visit = (items: unknown[]): boolean => {
    for (const item of items) {
      if (!isRecord(item)) continue;
      if (typeof item.href === 'string') return false;
      if (typeof item.tocHref === 'string') tocHref = true;
      if (Array.isArray(item.items) && !visit(item.items)) return false;
    }
    return true;
  };
  return visit(tocItems(doc)) && tocHref;
}

/** Every `/`-bounded prefix of a site path: `/azure/x/` → `/`, `/azure/`, `/azure/x/`. */
function basePrefixes(url: string): string[] {
  const segments = url.split('/').filter(Boolean);
  const out = ['/'];
  for (let i = 1; i < segments.length; i++) out.push(`/${segments.slice(0, i).join('/')}/`);
  return out;
}

type Target = { kind: 'page'; file: string } | { kind: 'toc'; file: string };

/** Build the outline of a docfx tree. See the module comment for the rules. */
export function parseDocfxToc(input: DocfxTocInput): DocfxOutline {
  const outline: DocfxOutline = {
    format: 'docfx',
    root: newOutlineTopic(''),
    consumed: input.files.filter((file) => TOC_FILE.test(posix.basename(file))),
    warnings: [],
  };
  const known = new Set(input.files.map((file) => file.normalize('NFC')));
  const groups: DocfxContentGroup[] = input.project?.content.length
    ? [...input.project.content].sort((a, b) => b.dest.length - a.dest.length)
    : [{ src: '', dest: '', include: [], exclude: [] }];
  const tocByDir = new Map<string, string>();
  for (const file of [...input.tocs.keys()].sort()) {
    if (/\.ya?ml$/i.test(file) && !tocByDir.has(dirOf(file))) tocByDir.set(dirOf(file), file);
  }

  /** Root-relative paths a site path (below the base) is published from. */
  const sourcesOf = (sitePath: string): string[] => {
    const out: string[] = [];
    for (const group of groups) {
      if (group.dest !== '' && sitePath !== group.dest && !sitePath.startsWith(`${group.dest}/`))
        continue;
      const rest = sitePath.slice(group.dest.length).replace(/^\/+/, '');
      out.push(group.src && rest ? `${group.src}/${rest}` : group.src || rest);
    }
    return out;
  };
  const tocAt = (path: string): string | undefined => {
    const trimmed = path.replace(/\/+$/, '');
    return TOC_FILE.test(posix.basename(trimmed))
      ? tocByDir.get(dirOf(trimmed))
      : tocByDir.get(trimmed);
  };
  const pageAt = (path: string): string | undefined => {
    const candidates =
      path === '' || path.endsWith('/')
        ? [`${path}index.md`]
        : MARKDOWN_EXT.test(path)
          ? [path]
          : [`${path}.md`, `${path}/index.md`];
    return candidates.find((candidate) => known.has(candidate.normalize('NFC')));
  };
  const resolveSite = (url: string, base: string): Target | null => {
    const path = url.replace(/[?#].*$/, '');
    let below: string;
    if (`${path}/` === base) below = '';
    else if (path.startsWith(base)) below = path.slice(base.length);
    else return null;
    for (const source of sourcesOf(below)) {
      const page = pageAt(source);
      if (page) return { kind: 'page', file: page };
      const toc = tocAt(source);
      if (toc) return { kind: 'toc', file: toc };
    }
    return null;
  };

  // ── the entry TOC and the site base its URLs hang from ──────────────────
  let entry = input.entry;
  let base: string | undefined;
  const breadcrumb = input.project?.breadcrumbPath;
  if (!entry && breadcrumb) {
    for (const candidate of basePrefixes(breadcrumb)) {
      const target = resolveSite(breadcrumb, candidate);
      if (target?.kind === 'toc') {
        entry = target.file;
        base = candidate;
        break;
      }
    }
    if (!entry) {
      outline.warnings.push(
        `docfx.json: breadcrumb_path '${breadcrumb}' names no toc.yml in the tree; ignored`,
      );
    }
  }
  entry ??= tocByDir.get('');
  if (entry && base === undefined) {
    const urls: string[] = [];
    const collect = (items: unknown[]): void => {
      for (const item of items) {
        if (!isRecord(item)) continue;
        for (const key of ['tocHref', 'topicHref', 'href']) {
          const value = item[key];
          if (typeof value === 'string' && value.startsWith('/') && !value.startsWith('//')) {
            urls.push(value);
          }
        }
        if (Array.isArray(item.items)) collect(item.items);
      }
    };
    collect(tocItems(input.tocs.get(entry)));
    let best = { base: '/', hits: 0 };
    for (const candidate of [...new Set(urls.flatMap(basePrefixes))].sort(
      (a, b) => a.length - b.length,
    )) {
      const hits = urls.filter((url) => resolveSite(url, candidate) !== null).length;
      if (hits > best.hits) best = { base: candidate, hits };
    }
    base = best.base;
  }
  const siteBase = base ?? '/';

  const classify = (href: string, tocDir: string): Target | null => {
    const value = href.trim();
    if (value === '' || value.startsWith('#') || HAS_SCHEME.test(value) || value.startsWith('//'))
      return null;
    if (value.startsWith('/')) return resolveSite(value, siteBase);
    const path = resolveOutlinePath(tocDir, value);
    if (path === null) return null;
    if (MARKDOWN_EXT.test(path)) return { kind: 'page', file: path };
    const toc = tocAt(path);
    return toc ? { kind: 'toc', file: toc } : null;
  };

  // ── walking: entries, topics, and which TOC owns which folder ───────────
  const crossLinks = new WeakSet<OutlineEntry>();
  const included = new Set<string>();
  /** Folder of an included TOC → the topic it filled (the root is never a home). */
  const homes = new Map<string, OutlineTopic>();

  const pageEntry = (file: string, tocDir: string): OutlineEntry => {
    const entry: OutlineEntry = { file };
    if (!isUnder(file, tocDir)) crossLinks.add(entry);
    return entry;
  };

  const walkItems = (
    items: unknown[],
    tocFile: string,
    container: OutlineTopic,
    followTocHref: boolean,
  ): void => {
    const tocDir = dirOf(tocFile);
    for (const item of items) {
      if (!isRecord(item)) continue;
      const name = typeof item.name === 'string' ? item.name.trim() : '';
      const href = typeof item.href === 'string' ? classify(item.href, tocDir) : null;
      const topicHref =
        typeof item.topicHref === 'string' ? classify(item.topicHref, tocDir) : null;
      const tocHref =
        followTocHref && typeof item.tocHref === 'string' ? classify(item.tocHref, tocDir) : null;
      const page = [href, topicHref].find((target) => target?.kind === 'page');
      const nested = [href, tocHref].find(
        (target) => target?.kind === 'toc' && !included.has(target.file),
      );
      const children = Array.isArray(item.items) && item.items.length > 0 ? item.items : null;
      if (!nested && !children) {
        if (page) container.entries.push(pageEntry(page.file, tocDir));
        continue;
      }
      const topic = newOutlineTopic(
        name || (nested ? titleFromFolderName(posix.basename(dirOf(nested.file))) : 'Untitled'),
      );
      if (!name && page) topic.titleFromFile = page.file;
      if (page) topic.entries.push(pageEntry(page.file, tocDir));
      if (nested) includeToc(nested.file, topic, false);
      if (children) walkItems(children, tocFile, topic, followTocHref);
      container.children.push(topic);
    }
  };

  const includeToc = (file: string, container: OutlineTopic, followTocHref: boolean): void => {
    if (included.has(file)) return;
    included.add(file);
    const dir = dirOf(file);
    if (container !== outline.root && !homes.has(dir)) homes.set(dir, container);
    walkItems(tocItems(input.tocs.get(file)), file, container, followTocHref);
  };

  const homeOf = (dir: string): OutlineTopic | undefined => {
    for (let d: string | null = dir; d !== null; d = parentOf(d)) {
      const home = homes.get(d);
      if (home) return home;
    }
    return undefined;
  };

  if (entry) {
    outline.entry = entry;
    includeToc(entry, outline.root, true);
  }
  // A breadcrumb opens on one node for the whole site ("Azure"); it is the
  // catalog itself, so TOCs the breadcrumb missed join its children.
  const lone =
    outline.root.entries.length === 0 && outline.root.children.length === 1
      ? outline.root.children[0]
      : undefined;
  const top = lone ?? outline.root;

  const orphans = [...input.tocs.keys()]
    .filter((file) => !included.has(file) && /\.ya?ml$/i.test(file))
    .sort((a, b) => a.split('/').length - b.split('/').length || (a < b ? -1 : a > b ? 1 : 0));
  for (const file of orphans) {
    if (included.has(file)) continue;
    const doc = input.tocs.get(file);
    if (isBreadcrumbToc(doc)) continue;
    const parent = parentOf(dirOf(file));
    const topic = newOutlineTopic(orphanTopicName(file, doc));
    ((parent === null ? undefined : homeOf(parent)) ?? top).children.push(topic);
    includeToc(file, topic, false);
  }

  // ── one place per page ──────────────────────────────────────────────────
  const listed = new Set<string>();
  const collectListed = (topic: OutlineTopic): void => {
    for (const entry of topic.entries) {
      if (!crossLinks.has(entry)) listed.add(entry.file.normalize('NFC'));
    }
    topic.children.forEach(collectListed);
  };
  collectListed(outline.root);
  const placed = new Set<string>();
  const missing: string[] = [];
  const duplicates: string[] = [];
  const settle = (topic: OutlineTopic): void => {
    topic.entries = topic.entries.filter((entry) => {
      const key = entry.file.normalize('NFC');
      if (!known.has(key)) {
        missing.push(entry.file);
        return false;
      }
      if (crossLinks.has(entry) && listed.has(key)) return false;
      if (placed.has(key)) {
        if (!crossLinks.has(entry)) duplicates.push(entry.file);
        return false;
      }
      placed.add(key);
      return true;
    });
    topic.children.forEach(settle);
  };
  settle(outline.root);

  const consumed = new Set(outline.consumed.map((file) => file.normalize('NFC')));
  const homed: string[] = [];
  for (const file of input.files) {
    const key = file.normalize('NFC');
    if (placed.has(key) || consumed.has(key)) continue;
    const home = homeOf(dirOf(file));
    if (!home) continue;
    home.entries.push({ file });
    homed.push(file);
  }

  if (lone) {
    outline.root.entries = lone.entries;
    outline.root.children = lone.children;
  }
  assignOutlineOrders(outline.root);

  const report = (files: string[], what: string): void => {
    if (files.length === 0) return;
    const named = files.slice(0, WARNING_EXAMPLES).join(', ');
    const more =
      files.length > WARNING_EXAMPLES ? `, and ${files.length - WARNING_EXAMPLES} more` : '';
    outline.warnings.push(`${files.length} ${what}: ${named}${more}`);
  };
  report(
    [...new Set(missing)],
    'pages named by a toc.yml are not among the published Markdown files',
  );
  report([...new Set(duplicates)], 'pages are listed more than once; the first place wins');
  report(homed, "pages are in no toc.yml; filed with their folder's section");
  return outline;
}

/**
 * The topic for a TOC no other TOC reached: the name of its landing page
 * (`Azure NAT Gateway documentation` → `Azure NAT Gateway`), else its folder.
 */
function orphanTopicName(file: string, doc: unknown): string {
  for (const item of tocItems(doc)) {
    if (!isRecord(item) || typeof item.name !== 'string' || typeof item.href !== 'string') continue;
    if (!LANDING_PAGE.test(item.href.replace(/[?#].*$/, ''))) continue;
    const name = item.name
      .trim()
      .replace(/\s+(documentation|docs)$/i, '')
      .trim();
    if (name) return name;
  }
  const folder = posix.basename(dirOf(file));
  return folder ? titleFromFolderName(folder) : 'Documentation';
}
