/**
 * Markdown-folder catalog source — the `gezel knowledge build` input adapter.
 * Folders become the shipped table of contents (a format requirement:
 * the gezk spec §5.2), files become documents, images the bodies reference
 * become assets. A flat corpus — files at the root with no subfolders —
 * gets the single root topic the compiler demands.
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
import { join, posix, relative, sep } from 'node:path';
import type { CatalogDocument } from '@bendyline/gezk';
import {
  CatalogDocumentSchema,
  KnowledgeDocumentIdSchema,
  KnowledgeOrdinalSchema,
  assetExtension,
  formatKnowledgeUri,
  topicSortKeyForOrder,
} from '@bendyline/gezk';
import type { CompileAsset, CompileTopic } from '../compiler/compile.js';
import { documentSlug } from '../format/ids.js';
import { parseMarkdownFrontMatter } from './frontmatter.js';

export interface MarkdownCatalogSource {
  topics: CompileTopic[];
  documents: CatalogDocument[];
  /** Images referenced by the bodies, resolved to files under the root. */
  assets: CompileAsset[];
}

export interface TopicOverride {
  name?: string;
  /** Listing position among sibling topics; encoded into the sort key. */
  order?: number;
  description?: string;
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
  /**
   * When set, relative links to other Markdown files in the tree are
   * rewritten to `knowledge://` references so a viewer can follow them.
   */
  uri?: { publisherId: string; catalogId: string };
  /** What to do with an image link whose file is missing (default `error`). */
  missingAssets?: 'error' | 'warn';
  onWarning?: (message: string) => void;
}

const ROOT_TOPIC_ID = 'general';
const SUMMARY_MAX_CHARS = 280;
const TOPIC_SIDECAR = '_topic.yaml';

interface Subcategory {
  id: string;
  title?: string;
  order?: number;
}

interface FrontMatter {
  title?: string;
  summary?: string;
  aliases?: string[];
  id?: string;
  order?: number;
  subcategory?: Subcategory;
  meta: Record<string, unknown>;
  body: string;
}

const RESERVED_KEYS = new Set(['title', 'summary', 'aliases', 'id', 'order', 'subcategory']);

function readFrontMatter(raw: string, file: string): FrontMatter {
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

async function walkMarkdownFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const visit = async (dir: string): Promise<void> => {
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) await visit(abs);
      else if (entry.isFile() && /\.(md|markdown)$/i.test(entry.name)) out.push(abs);
    }
  };
  await visit(root);
  return out;
}

async function readTopicSidecar(dir: string): Promise<TopicOverride | undefined> {
  const path = join(dir, TOPIC_SIDECAR);
  if (!existsSync(path)) return undefined;
  const raw = (await readFile(path, 'utf8')).replace(/^\uFEFF/, '');
  const { data } = parseMarkdownFrontMatter(`---\n${raw}\n---\n`);
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

function applyOverride(topic: CompileTopic, override: TopicOverride | undefined): void {
  if (!override) return;
  if (override.name) topic.name = override.name;
  if (override.description) topic.description = override.description;
  if (override.order !== undefined) topic.sortKey = topicSortKeyForOrder(override.order);
}

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
  warn: (message: string) => void;
}

/** Resolve a relative target against the document's directory, staying inside the tree. */
function resolveInTree(ctx: LinkRewriteContext, target: string): string | null {
  const resolved = posix.normalize(posix.join(ctx.docDir, target));
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

/**
 * Load a folder of Markdown into compiler inputs. Directory chain → topic
 * chain; the relative path (without extension, `/`-separated) is the stable
 * document id unless the front matter names one.
 */
export async function loadMarkdownCatalog(
  rootDir: string,
  opts: LoadMarkdownCatalogOptions,
): Promise<MarkdownCatalogSource> {
  const ignore = new Set(opts.ignore ?? []);
  const files = (await walkMarkdownFiles(rootDir)).filter(
    (abs) => !ignore.has(relative(rootDir, abs).split(sep).join('/')),
  );
  if (files.length === 0) {
    throw new Error(`no Markdown files found under ${rootDir}`);
  }
  const warn = opts.onWarning ?? (() => {});

  const takenTopicIds = new Set<string>();
  /** dir-relative-path → topic id, built parent-first so chains resolve. */
  const topicIdByDir = new Map<string, string>();
  const topics: CompileTopic[] = [];
  const topicById = new Map<string, CompileTopic>();
  const rootTopicId = opts.rootTopicId ?? ROOT_TOPIC_ID;
  let rootTopicUsed = false;

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
          name: segment,
          ...(path.length > 0 ? { parentId: path[path.length - 1] as string } : {}),
        });
        applyOverride(topic, await readTopicSidecar(join(rootDir, ...prefix.split('/'))));
        applyOverride(topic, opts.topics?.[prefix]);
      }
      path.push(id);
    }
    return path;
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
  for (const abs of files) {
    const rel = relative(rootDir, abs).split(sep).join('/');
    const relDir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
    const relNoExt = rel.replace(/\.(md|markdown)$/i, '').normalize('NFC');
    const raw = (await readFile(abs, 'utf8')).replace(/^\uFEFF/, '');
    const fm = readFrontMatter(raw, rel);
    const id = fm.id ?? relNoExt;
    const idCheck = KnowledgeDocumentIdSchema.safeParse(id);
    if (!idCheck.success) throw new Error(`${rel}: front matter 'id' is not a valid document id`);
    const previous = fileById.get(id);
    if (previous) throw new Error(`${rel}: document id '${id}' is already used by ${previous}`);
    fileById.set(id, rel);
    idByRel.set(relNoExt, id);

    let topicPath = await ensureTopicChain(relDir);
    if (fm.subcategory) {
      const parentId = topicPath[topicPath.length - 1] as string;
      topicPath = [...topicPath, ensureShelf(parentId, fm.subcategory, rel)];
    }
    const stem = rel.slice(rel.lastIndexOf('/') + 1).replace(/\.(md|markdown)$/i, '');
    const title = fm.title ?? firstHeading(fm.body) ?? stem;
    const summary = fm.summary ?? firstParagraph(fm.body);
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
        markdown: fm.body,
        ...(fm.aliases && fm.aliases.length > 0 ? { aliases: fm.aliases } : {}),
        ...(fm.order !== undefined ? { ordinal: fm.order } : {}),
        ...(Object.keys(fm.meta).length > 0 ? { meta: fm.meta } : {}),
      },
    });
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
    applyOverride(root, opts.topics?.['']);
    topics.unshift(root);
    topicById.set(root.id, root);
  }

  // ── pass 2: links and assets, now that every target is known ─────────────
  const assets = new Map<string, CompileAsset>();
  const documents: CatalogDocument[] = [];
  for (const entry of loaded) {
    const ctx: LinkRewriteContext = {
      rootDir,
      docDir: entry.rel.includes('/') ? entry.rel.slice(0, entry.rel.lastIndexOf('/')) : '',
      file: entry.file,
      idByRel,
      uri: opts.uri,
      assets,
      missingAssets: opts.missingAssets ?? 'error',
      warn,
    };
    documents.push(
      CatalogDocumentSchema.parse({
        ...entry.doc,
        markdown: rewriteLinks(ctx, entry.doc.markdown),
      }),
    );
  }

  return {
    topics,
    documents,
    assets: [...assets.values()].sort((a, b) => (a.path < b.path ? -1 : 1)),
  };
}
