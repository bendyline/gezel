/**
 * Markdown-folder catalog source — the `gezel knowledge build` input adapter.
 * Folders become the shipped table of contents (a format requirement:
 * the gezk spec §5.2), files become documents, images the bodies reference
 * become assets. A flat corpus — files at the root with no subfolders —
 * gets the single root topic the compiler demands.
 *
 * A tree that already carries an outline keeps it: GitBook's `SUMMARY.md`,
 * an `mkdocs.yml` nav, Jupyter Book's `_toc.yml` and docfx's per-folder
 * `toc.yml` files are read into the same topic tree (`outline.ts`,
 * `docfx.ts`), and Hugo's conventions — `_index.md` section pages,
 * `weight`, `draft` — are honored on top of the folders. A file an outline
 * omits stays in its folder, with a warning, so nothing is lost.
 *
 * Front matter carries what a documentation tree knows about itself: the
 * title and summary, an explicit `id`, an `order` (the listing ordinal), a
 * `subcategory` shelf below the folder topic, and anything else as opaque
 * metadata. Two passes keep it deterministic: the first walks files in
 * sorted order and fixes every id; the second rewrites relative image and
 * article links now that every target is known.
 */

import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import type { CatalogDocument } from '@bendyline/gezk';
import {
  CatalogDocumentSchema,
  KnowledgeDocumentIdSchema,
  KnowledgeLocationsSchema,
  KnowledgeOrdinalSchema,
  MAX_KNOWLEDGE_TOPIC_DEPTH,
  assetExtension,
  formatKnowledgeUri,
  topicSortKeyForOrder,
} from '@bendyline/gezk';
import type { CompileAsset, CompileTopic } from '../compiler/compile.js';
import { documentSlug } from '../format/ids.js';
import { type DocfxProject, docfxPublishes, parseDocfxJson, parseDocfxToc } from './docfx.js';
import { OUTLINE_MAX_BYTES, parseMarkdownFrontMatter, parseYaml } from './frontmatter.js';
import {
  type Outline,
  type OutlineEntry,
  type OutlineTopic,
  type TableOfContentsFormat,
  parseGitbookSummary,
  parseJupyterBookToc,
  parseMkdocsNav,
  titleFromFolderName,
} from './outline.js';

export interface MarkdownCatalogSource {
  topics: CompileTopic[];
  documents: CatalogDocument[];
  /** Images referenced by the bodies, resolved to files under the root. */
  assets: CompileAsset[];
  /** The outline that shaped the topics, with its file when it came from one. */
  toc: { format: TableOfContentsFormat; path?: string };
}

export interface TopicOverride {
  name?: string;
  /** Listing position among sibling topics; encoded into the sort key. */
  order?: number;
  description?: string;
}

export interface TableOfContentsOptions {
  format: TableOfContentsFormat;
  /**
   * The outline file for `gitbook` (`SUMMARY.md`), `mkdocs` (`mkdocs.yml`)
   * and `jupyter-book` (`_toc.yml`), absolute or relative to the root. By
   * default the root is searched, and for mkdocs its parent as well. For
   * `docfx` it is the entry TOC (a breadcrumb such as `bread/toc.yml`, or a
   * root `toc.yml`); by default docfx.json's `breadcrumb_path`, else the
   * root `toc.yml`.
   */
  path?: string;
}

export interface LoadMarkdownCatalogOptions {
  language: string;
  /** Topic id used for root-level files (default `general`). */
  rootTopicId?: string;
  rootTopicName?: string;
  /**
   * Root-relative POSIX directory path → overrides. An explicit entry wins
   * over a `_topic.yaml` sidecar in that directory.
   */
  topics?: Record<string, TopicOverride>;
  /** Root-relative files (POSIX) to leave out, e.g. `['README.md']`. */
  ignore?: string[];
  /** Where the table of contents comes from (default: the folders). */
  toc?: TableOfContentsOptions;
  /**
   * When set, relative links to other Markdown files in the tree are
   * rewritten to `knowledge://` references so a viewer can follow them.
   */
  uri?: { publisherId: string; catalogId: string };
  /** What to do with an image link whose file is missing (default `error`; `warn` for docfx). */
  missingAssets?: 'error' | 'warn';
  onWarning?: (message: string) => void;
}

const ROOT_TOPIC_ID = 'general';
const SUMMARY_MAX_CHARS = 280;
const TOPIC_SIDECAR = '_topic.yaml';
const HUGO_SECTION_PAGE = '_index';
const DOCFX_JSON = 'docfx.json';
/** How many warnings of one kind are shown before the rest are counted. */
const WARNING_EXAMPLES = 20;
/**
 * A Hugo section page (`_index.md`) is the landing page of its folder and
 * lists before every sibling, whatever their weights: the smallest int32
 * ordinal, which no `weight` can undercut.
 */
const SECTION_PAGE_ORDINAL = -2147483648;

interface Subcategory {
  id: string;
  title?: string;
  order?: number;
}

interface FrontMatter {
  locations?: CatalogDocument['locations'];
  title?: string;
  summary?: string;
  aliases?: string[];
  id?: string;
  order?: number;
  subcategory?: Subcategory;
  /** Hugo: `weight` above zero, the listing position. */
  weight?: number;
  /** Hugo and docfx: `description`, the summary a section or page declares. */
  description?: string;
  /** Hugo: `draft: true` or `headless: true` pages are never published. */
  unpublished?: 'draft' | 'headless';
  meta: Record<string, unknown>;
  body: string;
}

const RESERVED_KEYS = new Set([
  'title',
  'summary',
  'aliases',
  'id',
  'order',
  'subcategory',
  'locations',
]);

function readFrontMatter(
  raw: string,
  file: string,
  conventions: { hugo: boolean; description: boolean },
): FrontMatter {
  const { hugo } = conventions;
  let data: Record<string, unknown>;
  let body: string;
  try {
    ({ data, body } = parseMarkdownFrontMatter(raw));
  } catch (error) {
    throw new Error(`${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const out: FrontMatter = { meta: {}, body };
  // A numeric-looking scalar (`title: 1.26234`) parses as a number under
  // YAML; it is coerced back, so quote such values when the digits matter.
  const str = (key: string): string | undefined => {
    const value = data[key];
    if (value === undefined || value === null) return undefined;
    if (typeof value === 'number') return String(value);
    if (typeof value !== 'string')
      throw new Error(`${file}: front matter '${key}' must be a string`);
    return value.trim() || undefined;
  };
  if (data.locations !== undefined) {
    const locations = KnowledgeLocationsSchema.safeParse(data.locations);
    if (!locations.success)
      throw new Error(`${file}: invalid front matter locations: ${locations.error.message}`);
    out.locations = locations.data;
  }
  out.title = str('title');
  out.summary = str('summary');
  out.id = str('id');
  const aliases = data.aliases;
  if (typeof aliases === 'string') {
    out.aliases = aliases
      .split(',')
      .map((a) => a.trim())
      .filter(Boolean);
  } else if (Array.isArray(aliases)) {
    out.aliases = aliases.map((a) => String(a).trim()).filter(Boolean);
  } else if (aliases !== undefined && aliases !== null) {
    throw new Error(`${file}: front matter 'aliases' must be a list or a comma-separated string`);
  }
  if (data.order !== undefined && data.order !== null) {
    const order = KnowledgeOrdinalSchema.safeParse(data.order);
    if (!order.success) throw new Error(`${file}: front matter 'order' must be an int32`);
    out.order = order.data;
  }
  const sub = data.subcategory;
  if (sub !== undefined && sub !== null) {
    if (typeof sub !== 'object' || Array.isArray(sub)) {
      throw new Error(`${file}: front matter 'subcategory' must be a mapping with an id`);
    }
    const record = sub as Record<string, unknown>;
    if (typeof record.id !== 'string' || !record.id.trim()) {
      throw new Error(`${file}: front matter 'subcategory' must be a mapping with an id`);
    }
    const subcategory: Subcategory = { id: record.id.trim() };
    if (record.title !== undefined && record.title !== null) {
      if (typeof record.title !== 'string') {
        throw new Error(`${file}: front matter 'subcategory.title' must be a string`);
      }
      subcategory.title = record.title.trim();
    }
    if (record.order !== undefined && record.order !== null) {
      const order = KnowledgeOrdinalSchema.safeParse(record.order);
      if (!order.success)
        throw new Error(`${file}: front matter 'subcategory.order' must be an int32`);
      subcategory.order = order.data;
    }
    out.subcategory = subcategory;
  }
  if (hugo) {
    if (data.draft === true) out.unpublished = 'draft';
    else if (data.headless === true) out.unpublished = 'headless';
    if (data.weight !== undefined && data.weight !== null) {
      const weight = KnowledgeOrdinalSchema.safeParse(data.weight);
      if (!weight.success) throw new Error(`${file}: front matter 'weight' must be an int32`);
      // Hugo treats weight 0 as unweighted: such pages list after weighted ones.
      if (weight.data > 0) out.weight = weight.data;
    }
  }
  if (conventions.description) out.description = str('description');
  for (const [key, value] of Object.entries(data)) {
    if (RESERVED_KEYS.has(key) || value === undefined) continue;
    out.meta[key] = value;
  }
  return out;
}

function firstHeading(markdown: string): string | undefined {
  const match = /^#\s+(.+)$/m.exec(markdown);
  return match?.[1]?.trim() || undefined;
}

function firstParagraph(markdown: string): string | undefined {
  for (const block of markdown.split(/\n\s*\n/)) {
    const text = block.trim();
    if (!text || text.startsWith('#') || text.startsWith('```') || text.startsWith('|')) continue;
    const flat = text.replace(/\s+/g, ' ');
    return flat.length > SUMMARY_MAX_CHARS ? `${flat.slice(0, SUMMARY_MAX_CHARS - 1)}…` : flat;
  }
  return undefined;
}

/** Folder name → DNS-label topic id (≤64 chars, deterministic dedupe). */
function topicIdFor(name: string, taken: Set<string>): string {
  let base = documentSlug(name).slice(0, 60).replace(/-+$/, '');
  if (!base) base = 'topic';
  let id = base;
  let n = 2;
  while (taken.has(id)) id = `${base}-${n++}`;
  taken.add(id);
  return id;
}

async function walkFiles(root: string, matches: (name: string) => boolean): Promise<string[]> {
  const out: string[] = [];
  const visit = async (dir: string): Promise<void> => {
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) await visit(abs);
      else if (entry.isFile() && matches(entry.name)) out.push(abs);
    }
  };
  await visit(root);
  return out;
}

function walkMarkdownFiles(root: string): Promise<string[]> {
  return walkFiles(root, (name) => /\.(md|markdown)$/i.test(name));
}

/** Warn for the first few, then count the rest: a large tree can raise thousands. */
function warnCapped(
  warn: (message: string) => void,
  items: readonly string[],
  each: (item: string) => string,
  rest: (count: number) => string,
): void {
  for (const item of items.slice(0, WARNING_EXAMPLES)) warn(each(item));
  if (items.length > WARNING_EXAMPLES) warn(rest(items.length - WARNING_EXAMPLES));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readTopicSidecar(dir: string): Promise<TopicOverride | undefined> {
  const path = join(dir, TOPIC_SIDECAR);
  if (!existsSync(path)) return undefined;
  const raw = (await readFile(path, 'utf8')).replace(/^\uFEFF/, '');
  const data = parseYaml(raw, { what: path });
  if (data === null || data === undefined) return {};
  if (!isRecord(data)) throw new Error(`${path}: must be a mapping`);
  const out: TopicOverride = {};
  if (typeof data.name === 'string' && data.name.trim()) out.name = data.name.trim();
  if (typeof data.description === 'string' && data.description.trim()) {
    out.description = data.description.trim();
  }
  if (data.order !== undefined && data.order !== null) {
    const order = KnowledgeOrdinalSchema.safeParse(data.order);
    if (!order.success) throw new Error(`${path}: 'order' must be an int32`);
    out.order = order.data;
  }
  return out;
}

function applyOverride(topic: CompileTopic | undefined, override: TopicOverride | undefined): void {
  if (!topic || !override) return;
  if (override.name) topic.name = override.name;
  if (override.description) topic.description = override.description;
  if (override.order !== undefined) topic.sortKey = topicSortKeyForOrder(override.order);
}

// ── outlines ────────────────────────────────────────────────────────────────

/** `abs` as a root-relative POSIX path (`''` for the root itself), or null when it lies outside. */
function insideRoot(rootDir: string, abs: string): string | null {
  const rel = relative(rootDir, abs).split(sep).join('/');
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) return null;
  return rel;
}

function firstExisting(candidates: string[]): string | undefined {
  return candidates.find((candidate) => existsSync(candidate));
}

/** The docs directory an `mkdocs.yml` names (`docs_dir`, default `docs`), absolute. */
export async function readMkdocsDocsDir(mkdocsPath: string): Promise<string> {
  const config = parseYaml((await readFile(mkdocsPath, 'utf8')).replace(/^\uFEFF/, ''), {
    what: basename(mkdocsPath),
    maxBytes: OUTLINE_MAX_BYTES,
    tolerateUnknownTags: true,
    maxAliasCount: 100,
  });
  const docsDir =
    isRecord(config) && typeof config.docs_dir === 'string' ? config.docs_dir : 'docs';
  return resolve(dirname(mkdocsPath), docsDir);
}

/**
 * Which outline a tree carries: GitBook's `SUMMARY.md` or Jupyter Book's
 * `_toc.yml` at the root, an `mkdocs.yml` at the root, the project folder
 * or the root's parent, a docfx project (`docfx.json` or a `toc.yml` at the
 * root), Hugo's `_index.md` section pages anywhere in the tree — else the
 * folders themselves.
 */
export async function detectTableOfContents(
  rootDir: string,
  projectDir = rootDir,
): Promise<TableOfContentsOptions> {
  const summary = join(rootDir, 'SUMMARY.md');
  if (existsSync(summary)) return { format: 'gitbook', path: summary };
  const jupyter = firstExisting([join(rootDir, '_toc.yml'), join(rootDir, '_toc.yaml')]);
  if (jupyter) return { format: 'jupyter-book', path: jupyter };
  const mkdocs = firstExisting(
    [rootDir, projectDir, dirname(rootDir)].flatMap((dir) => [
      join(dir, 'mkdocs.yml'),
      join(dir, 'mkdocs.yaml'),
    ]),
  );
  if (mkdocs) return { format: 'mkdocs', path: mkdocs };
  const docfx = firstExisting(
    [DOCFX_JSON, 'toc.yml', 'TOC.yml', 'toc.yaml'].map((name) => join(rootDir, name)),
  );
  if (docfx) return { format: 'docfx' };
  const files = await walkMarkdownFiles(rootDir);
  if (files.some((file) => basename(file).replace(/\.(md|markdown)$/i, '') === HUGO_SECTION_PAGE)) {
    return { format: 'hugo' };
  }
  return { format: 'folders' };
}

async function readOutlineText(path: string): Promise<string> {
  const text = (await readFile(path, 'utf8')).replace(/^\uFEFF/, '');
  if (Buffer.byteLength(text, 'utf8') > OUTLINE_MAX_BYTES) {
    throw new Error(`${basename(path)} exceeds ${OUTLINE_MAX_BYTES} bytes`);
  }
  return text;
}

interface LoadedOutline {
  outline: Outline | null;
  path?: string;
  /** Root-relative files the tree's own build publishes; the rest are left out. */
  publishes?: (file: string) => boolean;
}

async function loadOutline(
  rootDir: string,
  toc: TableOfContentsOptions,
  files: readonly string[],
): Promise<LoadedOutline> {
  if (toc.format === 'folders' || toc.format === 'hugo') return { outline: null };
  const explicit = toc.path
    ? isAbsolute(toc.path)
      ? toc.path
      : join(rootDir, toc.path)
    : undefined;
  if (explicit && !existsSync(explicit)) {
    throw new Error(`${toc.format} table of contents not found: ${explicit}`);
  }
  if (toc.format === 'docfx') return loadDocfxOutline(rootDir, explicit, files);
  if (toc.format === 'gitbook') {
    const path = explicit ?? join(rootDir, 'SUMMARY.md');
    const rel = insideRoot(rootDir, path);
    if (!existsSync(path)) throw new Error(`gitbook table of contents not found: ${path}`);
    if (rel === null)
      throw new Error(`${basename(path)} must live inside the content root ${rootDir}`);
    return { outline: parseGitbookSummary(await readOutlineText(path), rel), path };
  }
  if (toc.format === 'mkdocs') {
    const path =
      explicit ??
      firstExisting(
        [rootDir, dirname(rootDir)].flatMap((dir) => [
          join(dir, 'mkdocs.yml'),
          join(dir, 'mkdocs.yaml'),
        ]),
      );
    if (!path) throw new Error(`mkdocs.yml not found in ${rootDir} or its parent`);
    const config = parseYaml(await readOutlineText(path), {
      what: basename(path),
      maxBytes: OUTLINE_MAX_BYTES,
      tolerateUnknownTags: true,
      maxAliasCount: 100,
    });
    const docsDir = await readMkdocsDocsDir(path);
    const docsRel = insideRoot(rootDir, docsDir);
    if (docsRel === null) {
      throw new Error(
        `${basename(path)}: docs_dir ${docsDir} is outside the content root ${rootDir}`,
      );
    }
    return { outline: parseMkdocsNav(config, docsRel, basename(path)), path };
  }
  const path = explicit ?? firstExisting([join(rootDir, '_toc.yml'), join(rootDir, '_toc.yaml')]);
  if (!path) throw new Error(`_toc.yml not found in ${rootDir}`);
  const tocDir = insideRoot(rootDir, dirname(path));
  if (tocDir === null)
    throw new Error(`${basename(path)} must live inside the content root ${rootDir}`);
  const doc = parseYaml(await readOutlineText(path), {
    what: basename(path),
    maxBytes: OUTLINE_MAX_BYTES,
  });
  return { outline: parseJupyterBookToc(doc, tocDir, files, basename(path)), path };
}

/**
 * A docfx project: docfx.json's content groups decide which Markdown is
 * published (so `includes/` fragments and repo READMEs stay out), and every
 * `toc.yml` in the tree is read for the parser to stitch together. A TOC
 * that does not parse is skipped with a warning, unless it is the entry.
 */
async function loadDocfxOutline(
  rootDir: string,
  explicit: string | undefined,
  files: readonly string[],
): Promise<LoadedOutline> {
  const configPath = join(rootDir, DOCFX_JSON);
  let project: DocfxProject | undefined;
  if (existsSync(configPath)) {
    let config: unknown;
    try {
      config = JSON.parse(await readOutlineText(configPath));
    } catch (error) {
      throw new Error(`${DOCFX_JSON}: ${error instanceof Error ? error.message : String(error)}`);
    }
    project = parseDocfxJson(config, DOCFX_JSON);
  }
  const entry = explicit === undefined ? undefined : insideRoot(rootDir, explicit);
  if (entry === null) {
    throw new Error(`${basename(explicit as string)} must live inside the content root ${rootDir}`);
  }
  const readToc = async (abs: string, rel: string): Promise<unknown> =>
    parseYaml(await readOutlineText(abs), {
      what: rel,
      maxBytes: OUTLINE_MAX_BYTES,
      tolerateUnknownTags: true,
      maxAliasCount: 100,
    });
  const tocs = new Map<string, unknown>();
  const warnings: string[] = [];
  for (const abs of await walkFiles(rootDir, (name) => /^toc\.ya?ml$/i.test(name))) {
    const rel = insideRoot(rootDir, abs) as string;
    try {
      tocs.set(rel, await readToc(abs, rel));
    } catch (error) {
      if (rel === entry) throw error;
      warnings.push(`${rel}: ${error instanceof Error ? error.message : String(error)}; skipped`);
    }
  }
  if (entry !== undefined && explicit !== undefined && !tocs.has(entry)) {
    tocs.set(entry, await readToc(explicit, entry));
  }
  const publishes = project ? (file: string): boolean => docfxPublishes(project, file) : undefined;
  const outline = parseDocfxToc({
    tocs,
    files: publishes ? files.filter(publishes) : files,
    ...(project ? { project } : {}),
    ...(entry !== undefined ? { entry } : {}),
  });
  outline.warnings.unshift(...warnings);
  const path = outline.entry ? join(rootDir, ...outline.entry.split('/')) : undefined;
  return {
    outline,
    ...(path ? { path } : project ? { path: configPath } : {}),
    ...(publishes ? { publishes } : {}),
  };
}

// ── links ───────────────────────────────────────────────────────────────────

const INLINE_LINK = /(!?)\[([^\]]*)\]\(\s*(<[^>]*>|[^)\s]+)((?:\s+"[^"]*")?)\s*\)/g;
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

interface LinkRewriteContext {
  rootDir: string;
  docDir: string;
  file: string;
  idByRel: Map<string, string>;
  uri: LoadMarkdownCatalogOptions['uri'];
  assets: Map<string, CompileAsset>;
  missingAssets: 'error' | 'warn';
  /** docfx: a target starting `~/` is relative to the docset root, not the page. */
  tildeIsRoot: boolean;
  warn: (message: string) => void;
}

/** Resolve a relative target against the document's directory, staying inside the tree. */
function resolveInTree(ctx: LinkRewriteContext, target: string): string | null {
  const fromRoot = ctx.tildeIsRoot && target.startsWith('~/');
  const resolved = posix.normalize(fromRoot ? target.slice(2) : posix.join(ctx.docDir, target));
  if (resolved === '..' || resolved.startsWith('../') || posix.isAbsolute(resolved)) return null;
  return resolved === '.' ? '' : resolved;
}

function rewriteTarget(
  ctx: LinkRewriteContext,
  isImage: boolean,
  rawTarget: string,
): string | null {
  const target = rawTarget.startsWith('<') ? rawTarget.slice(1, -1) : rawTarget;
  if (
    target === '' ||
    HAS_SCHEME.test(target) ||
    target.startsWith('//') ||
    target.startsWith('#') ||
    target.startsWith('/')
  ) {
    return null;
  }
  const hashAt = target.search(/[#?]/);
  const pathPart = hashAt === -1 ? target : target.slice(0, hashAt);
  const decoded = safeDecode(pathPart);
  const resolved = resolveInTree(ctx, decoded);
  if (resolved === null) {
    ctx.warn(`${ctx.file}: link '${target}' leaves the catalog tree; left as is`);
    return null;
  }
  if (isImage) {
    if (!assetExtension(resolved)) {
      ctx.warn(`${ctx.file}: image '${target}' is not a supported asset type; left as is`);
      return null;
    }
    const abs = join(ctx.rootDir, ...resolved.split('/'));
    if (!existsSync(abs)) {
      const message = `${ctx.file}: image '${target}' does not exist in the catalog tree`;
      if (ctx.missingAssets === 'error') throw new Error(message);
      ctx.warn(`${message}; left as is`);
      return null;
    }
    const archivePath = resolved.startsWith('assets/') ? resolved : `assets/${resolved}`;
    if (!ctx.assets.has(archivePath))
      ctx.assets.set(archivePath, { path: archivePath, absPath: abs });
    return archivePath;
  }
  if (!/\.(md|markdown)$/i.test(resolved)) return null;
  const documentId = ctx.idByRel.get(resolved.replace(/\.(md|markdown)$/i, '').normalize('NFC'));
  if (!documentId) {
    ctx.warn(`${ctx.file}: link '${target}' does not name a document in the catalog; left as is`);
    return null;
  }
  if (!ctx.uri) return null;
  return formatKnowledgeUri({
    publisherId: ctx.uri.publisherId,
    catalogId: ctx.uri.catalogId,
    documentId,
  });
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Rewrite links outside fenced code blocks; fences and their contents pass through verbatim. */
function rewriteLinks(ctx: LinkRewriteContext, markdown: string): string {
  const lines = markdown.split('\n');
  let fence: string | null = null;
  return lines
    .map((line) => {
      const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
      if (fenceMatch) {
        const marker = fenceMatch[1] as string;
        if (fence === null) fence = marker[0] as string;
        else if (marker[0] === fence) fence = null;
        return line;
      }
      if (fence !== null) return line;
      return line.replace(
        INLINE_LINK,
        (whole, bang: string, text: string, target: string, title: string) => {
          const rewritten = rewriteTarget(ctx, bang === '!', target);
          return rewritten === null ? whole : `${bang}[${text}](${rewritten}${title})`;
        },
      );
    })
    .join('\n');
}

// ── loading ─────────────────────────────────────────────────────────────────

/**
 * Load a folder of Markdown into compiler inputs. Directory chain → topic
 * chain unless an outline places the file; the relative path (without
 * extension, `/`-separated) is the stable document id unless the front
 * matter names one.
 */
export async function loadMarkdownCatalog(
  rootDir: string,
  opts: LoadMarkdownCatalogOptions,
): Promise<MarkdownCatalogSource> {
  const warn = opts.onWarning ?? (() => {});
  const toc: TableOfContentsOptions = opts.toc ?? { format: 'folders' };
  const hugo = toc.format === 'hugo';
  const docfx = toc.format === 'docfx';
  const conventions = { hugo, description: hugo || docfx };
  const ignore = new Set(opts.ignore ?? []);
  const relOf = (abs: string): string => relative(rootDir, abs).split(sep).join('/');
  let files = (await walkMarkdownFiles(rootDir)).filter((abs) => !ignore.has(relOf(abs)));
  const {
    outline,
    path: outlinePath,
    publishes,
  } = await loadOutline(rootDir, toc, files.map(relOf));
  for (const message of outline?.warnings ?? []) warn(message);
  if (publishes) files = files.filter((abs) => publishes(relOf(abs)));
  if (outline) {
    const consumed = new Set(outline.consumed.map((file) => file.normalize('NFC')));
    files = files.filter((abs) => !consumed.has(relOf(abs).normalize('NFC')));
  }
  if (files.length === 0) {
    throw new Error(`no Markdown files found under ${rootDir}`);
  }

  const takenTopicIds = new Set<string>();
  /** dir-relative-path → topic id, built parent-first so chains resolve. */
  const topicIdByDir = new Map<string, string>();
  const topics: CompileTopic[] = [];
  const topicById = new Map<string, CompileTopic>();
  const rootTopicId = opts.rootTopicId ?? ROOT_TOPIC_ID;
  let rootTopicUsed = false;
  let rootOverride: TopicOverride | undefined;

  const addTopic = (topic: CompileTopic): CompileTopic => {
    topics.push(topic);
    topicById.set(topic.id, topic);
    return topic;
  };

  const ensureTopicChain = async (relDirPosix: string): Promise<string[]> => {
    if (!relDirPosix) {
      rootTopicUsed = true;
      return [rootTopicId];
    }
    const segments = relDirPosix.split('/');
    const path: string[] = [];
    let prefix = '';
    for (const segment of segments) {
      prefix = prefix ? `${prefix}/${segment}` : segment;
      let id = topicIdByDir.get(prefix);
      if (!id) {
        id = topicIdFor(segment, takenTopicIds);
        topicIdByDir.set(prefix, id);
        const topic = addTopic({
          id,
          name: titleFromFolderName(segment),
          ...(path.length > 0 ? { parentId: path[path.length - 1] as string } : {}),
        });
        applyOverride(topic, await readTopicSidecar(join(rootDir, ...prefix.split('/'))));
        applyOverride(topic, opts.topics?.[prefix]);
      }
      path.push(id);
    }
    return path;
  };

  /** Where the outline files each Markdown file (root-relative, NFC). */
  interface Placement {
    chain: OutlineTopic[];
    entry: OutlineEntry;
  }
  const placements = new Map<string, Placement[]>();
  if (outline) {
    const walk = (topic: OutlineTopic, chain: OutlineTopic[]): void => {
      for (const entry of topic.entries) {
        const key = entry.file.normalize('NFC');
        const existing = placements.get(key) ?? [];
        existing.push({ chain, entry });
        placements.set(key, existing);
      }
      for (const child of topic.children) walk(child, [...chain, child]);
    };
    walk(outline.root, []);
  }
  const outlineTopicIds = new Map<OutlineTopic, string>();
  let outlineTooDeep = false;
  const ensureOutlineChain = (chain: OutlineTopic[]): string[] => {
    if (chain.length === 0) {
      rootTopicUsed = true;
      return [rootTopicId];
    }
    // Sections below the format's depth limit fold into their deepest allowed
    // ancestor, keeping one level free for a subcategory shelf.
    if (chain.length > MAX_KNOWLEDGE_TOPIC_DEPTH - 1) outlineTooDeep = true;
    const ids: string[] = [];
    for (const node of chain.slice(0, MAX_KNOWLEDGE_TOPIC_DEPTH - 1)) {
      let id = outlineTopicIds.get(node);
      if (!id) {
        id = topicIdFor(node.name, takenTopicIds);
        outlineTopicIds.set(node, id);
        const topic: CompileTopic = {
          id,
          name: node.name,
          ...(ids.length > 0 ? { parentId: ids[ids.length - 1] as string } : {}),
        };
        if (node.description) topic.description = node.description;
        if (node.order !== undefined) topic.sortKey = topicSortKeyForOrder(node.order);
        addTopic(topic);
      }
      ids.push(id);
    }
    return ids;
  };

  /** `<parent topic id>/<subcategory id>` → topic id, with its declared shape. */
  const shelves = new Map<
    string,
    { topicId: string; title?: string; order?: number; file: string }
  >();
  const ensureShelf = (parentId: string, sub: Subcategory, file: string): string => {
    const key = `${parentId}/${sub.id}`;
    const existing = shelves.get(key);
    if (existing) {
      if (existing.title !== sub.title || existing.order !== sub.order) {
        throw new Error(
          `${file}: subcategory '${sub.id}' is declared with a different title or order in ${existing.file}`,
        );
      }
      return existing.topicId;
    }
    const topicId = topicIdFor(`${parentId}-${sub.id}`, takenTopicIds);
    const topic: CompileTopic = { id: topicId, name: sub.title ?? sub.id, parentId };
    if (sub.order !== undefined) topic.sortKey = topicSortKeyForOrder(sub.order);
    addTopic(topic);
    shelves.set(key, { topicId, title: sub.title, order: sub.order, file });
    return topicId;
  };

  // ── pass 1: ids, topics, front matter ─────────────────────────────────────
  interface Loaded {
    rel: string;
    file: string;
    doc: Omit<CatalogDocument, 'markdown'> & { markdown: string };
  }
  const loaded: Loaded[] = [];
  const fileById = new Map<string, string>();
  const idByRel = new Map<string, string>();
  const seenRel = new Set<string>();
  const unlisted: string[] = [];
  for (const abs of files) {
    const rel = relOf(abs);
    const relDir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
    const relNoExt = rel.replace(/\.(md|markdown)$/i, '').normalize('NFC');
    const raw = (await readFile(abs, 'utf8')).replace(/^\uFEFF/, '');
    const fm = readFrontMatter(raw, rel, conventions);
    if (fm.unpublished) {
      warn(`${rel}: skipped, ${fm.unpublished} page`);
      continue;
    }
    seenRel.add(rel.normalize('NFC'));
    const id = fm.id ?? relNoExt;
    const idCheck = KnowledgeDocumentIdSchema.safeParse(id);
    if (!idCheck.success) throw new Error(`${rel}: front matter 'id' is not a valid document id`);
    const previous = fileById.get(id);
    if (previous) throw new Error(`${rel}: document id '${id}' is already used by ${previous}`);
    fileById.set(id, rel);
    idByRel.set(relNoExt, id);

    const stem = rel.slice(rel.lastIndexOf('/') + 1).replace(/\.(md|markdown)$/i, '');
    // docfx pages carry the HTML <title> in front matter ("Azure API Center -
    // Overview"); the H1 is the title the page shows ("What is Azure API Center?").
    let title = docfx
      ? (firstHeading(fm.body) ?? fm.title ?? stem)
      : (fm.title ?? firstHeading(fm.body) ?? stem);
    let ordinal = fm.order;
    let topicPath: string[];
    const documentPlacements = placements.get(rel.normalize('NFC')) ?? [];
    const placement = documentPlacements[0];
    if (placement) {
      topicPath = ensureOutlineChain(placement.chain);
      if (placement.entry.title) title = placement.entry.title;
      if (placement.entry.order !== undefined) ordinal = placement.entry.order;
    } else {
      if (outline) unlisted.push(rel);
      topicPath = await ensureTopicChain(relDir);
      if (hugo && ordinal === undefined) ordinal = fm.weight;
    }
    if (hugo && stem === HUGO_SECTION_PAGE) {
      // The section page describes its folder: title, description and weight
      // belong to the topic. Explicit overrides keep the last word.
      const override: TopicOverride = {
        ...(fm.title ? { name: fm.title } : {}),
        ...((fm.description ?? fm.summary) ? { description: fm.description ?? fm.summary } : {}),
        ...(fm.weight !== undefined ? { order: fm.weight } : {}),
      };
      if (relDir === '') {
        rootOverride = override;
      } else {
        const leaf = topicById.get(topicPath[topicPath.length - 1] as string);
        applyOverride(leaf, override);
        applyOverride(leaf, opts.topics?.[relDir]);
      }
      if (!fm.body.trim()) continue;
      ordinal = SECTION_PAGE_ORDINAL;
    }
    if (fm.subcategory) {
      const parentId = topicPath[topicPath.length - 1] as string;
      topicPath = [...topicPath, ensureShelf(parentId, fm.subcategory, rel)];
    }
    const tocReferences: NonNullable<CatalogDocument['tocReferences']> = [];
    const placedLeaves = new Set([topicPath.at(-1)]);
    for (const extra of documentPlacements.slice(1)) {
      let path = ensureOutlineChain(extra.chain);
      if (fm.subcategory) path = [...path, ensureShelf(path.at(-1) as string, fm.subcategory, rel)];
      const leaf = path.at(-1);
      // Repeated links inside the same section (or depth-folded sections)
      // represent a single placement. The first listing position wins.
      if (placedLeaves.has(leaf)) continue;
      placedLeaves.add(leaf);
      const order = extra.entry.order ?? fm.order;
      tocReferences.push({ topicPath: path, ...(order !== undefined ? { ordinal: order } : {}) });
    }
    const summary = fm.summary ?? fm.description ?? firstParagraph(fm.body);
    loaded.push({
      rel,
      file: rel,
      doc: {
        id,
        title,
        slug: documentSlug(title),
        ...(summary ? { summary } : {}),
        language: opts.language,
        topicPath,
        ...(tocReferences.length ? { tocReferences } : {}),
        ...(fm.locations ? { locations: fm.locations } : {}),
        markdown: fm.body,
        ...(fm.aliases && fm.aliases.length > 0 ? { aliases: fm.aliases } : {}),
        ...(ordinal !== undefined ? { ordinal } : {}),
        ...(Object.keys(fm.meta).length > 0 ? { meta: fm.meta } : {}),
      },
    });
  }

  if (outline) {
    const titleByRel = new Map(
      loaded.map((entry) => [entry.rel.normalize('NFC'), entry.doc.title]),
    );
    const nameFromPages = (topic: OutlineTopic): void => {
      for (const child of topic.children) {
        const id = outlineTopicIds.get(child);
        const title = child.titleFromFile
          ? titleByRel.get(child.titleFromFile.normalize('NFC'))
          : undefined;
        const compiled = id ? topicById.get(id) : undefined;
        if (compiled && title) compiled.name = title;
        nameFromPages(child);
      }
    };
    nameFromPages(outline.root);
    warnCapped(
      warn,
      unlisted,
      (file) => `${file}: not in the ${outline.format} table of contents; filed under its folder`,
      (more) =>
        `${more} more files are not in the ${outline.format} table of contents; filed under their folders`,
    );
    warnCapped(
      warn,
      [...placements].filter(([file]) => !seenRel.has(file)).map(([file]) => file),
      (file) => `${file}: named by the table of contents but not found among the Markdown files`,
      (more) =>
        `${more} more files named by the table of contents are not among the Markdown files`,
    );
    if (outlineTooDeep) {
      warn(
        `the table of contents nests deeper than ${MAX_KNOWLEDGE_TOPIC_DEPTH - 1} levels; deeper sections are folded into their ancestors`,
      );
    }
  }

  if (rootTopicUsed) {
    // Root-level files need the single root topic; keep taken-id discipline.
    if (takenTopicIds.has(rootTopicId)) {
      throw new Error(
        `root topic id '${rootTopicId}' collides with a folder-derived topic; pass rootTopicId`,
      );
    }
    const root: CompileTopic = { id: rootTopicId, name: opts.rootTopicName ?? 'General' };
    applyOverride(root, await readTopicSidecar(rootDir));
    applyOverride(root, rootOverride);
    applyOverride(root, opts.topics?.['']);
    topics.unshift(root);
    topicById.set(root.id, root);
  }

  // ── pass 2: links and assets, now that every target is known ─────────────
  const assets = new Map<string, CompileAsset>();
  const documents: CatalogDocument[] = [];
  const linkWarnings: string[] = [];
  for (const entry of loaded) {
    const ctx: LinkRewriteContext = {
      rootDir,
      docDir: entry.rel.includes('/') ? entry.rel.slice(0, entry.rel.lastIndexOf('/')) : '',
      file: entry.file,
      idByRel,
      uri: opts.uri,
      assets,
      // A docfx docset draws on dependent repositories (`~/reusable-content`)
      // that a checkout never holds, so a missing image is expected there.
      missingAssets: opts.missingAssets ?? (docfx ? 'warn' : 'error'),
      tildeIsRoot: docfx,
      warn: (message) => linkWarnings.push(message),
    };
    documents.push(
      CatalogDocumentSchema.parse({
        ...entry.doc,
        markdown: rewriteLinks(ctx, entry.doc.markdown),
      }),
    );
  }
  warnCapped(
    warn,
    linkWarnings,
    (message) => message,
    (more) => `${more} more link and image warnings`,
  );

  return {
    topics,
    documents,
    assets: [...assets.values()].sort((a, b) => (a.path < b.path ? -1 : 1)),
    toc: { format: toc.format, ...(outlinePath ? { path: outlinePath } : {}) },
  };
}
