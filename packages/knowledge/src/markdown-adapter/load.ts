/**
 * Markdown-folder catalog source — the `gezel knowledge build` input adapter.
 * Folders become the shipped table of contents (a format requirement:
 * gezk-format-v1.md §6.1), files become documents. A flat corpus — files at
 * the root with no subfolders — gets the single root topic the compiler
 * demands. Deterministic: sorted walk, stable topic-id collision suffixes.
 */

import { readFile, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { CatalogDocument } from '@bendyline/gezel';
import { CatalogDocumentSchema } from '@bendyline/gezel';
import type { CompileTopic } from '../compiler/compile.js';
import { documentSlug } from '../format/ids.js';

export interface MarkdownCatalogSource {
  topics: CompileTopic[];
  documents: CatalogDocument[];
}

export interface LoadMarkdownCatalogOptions {
  language: string;
  /** Topic id used for root-level files (default `general`). */
  rootTopicId?: string;
  rootTopicName?: string;
}

const ROOT_TOPIC_ID = 'general';
const SUMMARY_MAX_CHARS = 280;

/** Front matter is optional and deliberately tiny: `key: value` lines only. */
interface FrontMatter {
  title?: string;
  summary?: string;
  aliases?: string[];
  body: string;
}

function parseFrontMatter(markdown: string): FrontMatter {
  if (!markdown.startsWith('---\n') && !markdown.startsWith('---\r\n')) return { body: markdown };
  const end = markdown.indexOf('\n---', 3);
  if (end === -1) return { body: markdown };
  const head = markdown.slice(markdown.indexOf('\n') + 1, end);
  const body = markdown.slice(markdown.indexOf('\n', end + 1) + 1);
  const out: FrontMatter = { body };
  for (const line of head.split('\n')) {
    const at = line.indexOf(':');
    if (at === -1) continue;
    const key = line.slice(0, at).trim();
    const value = line.slice(at + 1).trim();
    if (!value) continue;
    if (key === 'title') out.title = value;
    else if (key === 'summary') out.summary = value;
    else if (key === 'aliases') {
      out.aliases = value
        .split(',')
        .map((a) => a.trim())
        .filter(Boolean);
    }
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

/**
 * Load a folder of Markdown into compiler inputs. Directory chain → topic
 * chain; the relative path (without extension, `/`-separated) is the stable
 * document id.
 */
export async function loadMarkdownCatalog(
  rootDir: string,
  opts: LoadMarkdownCatalogOptions,
): Promise<MarkdownCatalogSource> {
  const files = await walkMarkdownFiles(rootDir);
  if (files.length === 0) {
    throw new Error(`no Markdown files found under ${rootDir}`);
  }

  const takenTopicIds = new Set<string>();
  /** dir-relative-path → topic id, built parent-first so chains resolve. */
  const topicIdByDir = new Map<string, string>();
  const topics: CompileTopic[] = [];
  const rootTopicId = opts.rootTopicId ?? ROOT_TOPIC_ID;
  let rootTopicUsed = false;

  const ensureTopicChain = (relDirPosix: string): string[] => {
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
        topics.push({
          id,
          name: segment,
          ...(path.length > 0 ? { parentId: path[path.length - 1] as string } : {}),
        });
      }
      path.push(id);
    }
    return path;
  };

  const documents: CatalogDocument[] = [];
  const seenIds = new Set<string>();
  for (const abs of files) {
    const rel = relative(rootDir, abs).split(sep).join('/');
    const relDir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
    const topicPath = ensureTopicChain(relDir);
    const id = rel.replace(/\.(md|markdown)$/i, '').normalize('NFC');
    if (seenIds.has(id)) throw new Error(`duplicate document id from path: ${rel}`);
    seenIds.add(id);

    const raw = (await readFile(abs, 'utf8')).replace(/^\uFEFF/, '');
    const fm = parseFrontMatter(raw);
    const stem = rel.slice(rel.lastIndexOf('/') + 1).replace(/\.(md|markdown)$/i, '');
    const title = fm.title ?? firstHeading(fm.body) ?? stem;
    const summary = fm.summary ?? firstParagraph(fm.body);

    documents.push(
      CatalogDocumentSchema.parse({
        id,
        title,
        slug: documentSlug(title),
        ...(summary ? { summary } : {}),
        language: opts.language,
        topicPath,
        markdown: fm.body,
        ...(fm.aliases && fm.aliases.length > 0 ? { aliases: fm.aliases } : {}),
      }),
    );
  }

  if (rootTopicUsed) {
    // Root-level files need the single root topic; keep taken-id discipline.
    if (takenTopicIds.has(rootTopicId)) {
      throw new Error(
        `root topic id '${rootTopicId}' collides with a folder-derived topic; pass rootTopicId`,
      );
    }
    topics.unshift({ id: rootTopicId, name: opts.rootTopicName ?? 'General' });
  }

  return { topics, documents };
}
