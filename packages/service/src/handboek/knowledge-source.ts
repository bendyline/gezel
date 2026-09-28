/** Turn the published Handboek into ordinary `.gezk` compiler input. */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, posix } from 'node:path';
import { formatKnowledgeUri } from '@bendyline/gezel';
import type { CatalogDocument, CompileAsset, CompileTopic } from '@bendyline/gezel-knowledge';
import { HANDBOEK_AREAS, HANDBOEK_AREA_TITLES, loadCuratedArticles } from './content.js';
import type { HandboekEngine } from './engine.js';

export const HANDBOEK_KNOWLEDGE_PUBLISHER = 'bendyline';
export const HANDBOEK_KNOWLEDGE_CATALOG = 'handboek';

export interface HandboekKnowledgeSource {
  topics: CompileTopic[];
  documents: CatalogDocument[];
  assets: CompileAsset[];
}

/**
 * Freeze the device-neutral article rendering for a bundled catalog. The
 * daemon's personal details are deliberately absent; this is reference
 * material shared by every install and handled by the normal Knowledge RAG.
 */
export async function handboekKnowledgeSource(
  engine: HandboekEngine,
  contentDir: string,
): Promise<HandboekKnowledgeSource> {
  const toc = await engine.toc();
  const entries = toc.areas.flatMap((area) => area.entries);
  const ids = new Set(entries.map((entry) => entry.id));
  const curated = loadCuratedArticles(contentDir);
  const curatedPaths = new Map(
    curated.map((article) => [`${article.area}/${article.id}`, article.id]),
  );
  const byStem = new Map<string, string>();
  for (const entry of entries) {
    const stem = entry.id.split('/').at(-1)!;
    if (!byStem.has(stem)) byStem.set(stem, entry.id);
  }

  const topics: CompileTopic[] = [];
  const documents: CatalogDocument[] = [];
  const shelfIds = new Set<string>();
  for (const [areaIndex, area] of HANDBOEK_AREAS.entries()) {
    if (!entries.some((entry) => entry.area === area)) continue;
    topics.push({
      id: area,
      name: HANDBOEK_AREA_TITLES[area],
      sortKey: String(areaIndex).padStart(4, '0'),
    });
  }
  for (const entry of entries) {
    const article = await engine.article(entry.id, { mode: 'site' });
    if (!article) throw new Error(`Handboek article ${entry.id} disappeared during catalog build`);
    const path: string[] = [entry.area];
    if (entry.subcategory) {
      const shelfId = `${entry.area}-${entry.subcategory.id}`;
      if (!shelfIds.has(shelfId)) {
        topics.push({
          id: shelfId,
          parentId: entry.area,
          name: entry.subcategory.title,
          sortKey: String(entry.subcategory.order).padStart(4, '0'),
        });
        shelfIds.add(shelfId);
      }
      path.push(shelfId);
    }
    documents.push({
      id: entry.id,
      title: entry.title,
      slug: entry.id,
      ...(entry.summary ? { summary: entry.summary } : {}),
      language: 'en',
      topicPath: path,
      markdown: rewriteHandboekKnowledgeLinks(
        article.markdown,
        entry.area,
        ids,
        curatedPaths,
        byStem,
      ),
      ordinal: documents.length,
      sourceUrl: `https://gezel.com/docs/${entry.id}/`,
      meta: { handboekArea: entry.area, generated: entry.generated },
    });
  }

  const assets: CompileAsset[] = [];
  const collectAssets = (directory: string, relative: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = posix.join(relative, entry.name);
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) collectAssets(absolute, path);
      else if (entry.isFile()) assets.push({ path, absPath: absolute });
    }
  };
  collectAssets(join(contentDir, 'assets'), 'assets');
  return { topics, documents, assets };
}

/** Checked in beside the archive so source edits cannot silently ship stale bytes. */
export function handboekKnowledgeFingerprint(source: HandboekKnowledgeSource): string {
  const assets = source.assets.map((asset) => ({
    path: asset.path,
    sha256: createHash('sha256')
      .update(asset.content ?? readFileSync(asset.absPath!))
      .digest('hex'),
  }));
  return createHash('sha256')
    .update(JSON.stringify({ topics: source.topics, documents: source.documents, assets }))
    .digest('hex');
}

/** Rewrite only links, leaving code fences and external URLs untouched. */
export function rewriteHandboekKnowledgeLinks(
  markdown: string,
  area: string,
  ids: Set<string>,
  curatedPaths: Map<string, string>,
  byStem: Map<string, string>,
): string {
  let fence: string | null = null;
  return markdown
    .split('\n')
    .map((line) => {
      const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
      if (marker) {
        if (fence === null) fence = marker[0]!;
        else if (fence === marker[0]) fence = null;
        return line;
      }
      if (fence) return line;
      return line.replace(
        /(!?)\[([^\]]*)\]\(([^()\s]+)\)/g,
        (whole, image: string, label: string, href: string) => {
          if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//') || href.startsWith('#'))
            return whole;
          const [, rawPath = '', suffix = ''] = /^([^?#]*)(.*)$/.exec(href) ?? [];
          if (image) {
            const assetPath = posix.normalize(`${area}/${rawPath}`);
            return assetPath.startsWith('assets/') ? `![${label}](${assetPath}${suffix})` : whole;
          }
          const withoutMd = rawPath.replace(/\.md$/i, '');
          const relativePath = posix.normalize(`${area}/${withoutMd}`);
          const id = ids.has(withoutMd)
            ? withoutMd
            : (curatedPaths.get(relativePath) ?? byStem.get(withoutMd.split('/').at(-1) ?? ''));
          return id
            ? `[${label}](${formatKnowledgeUri({ publisherId: HANDBOEK_KNOWLEDGE_PUBLISHER, catalogId: HANDBOEK_KNOWLEDGE_CATALOG, documentId: id })}${suffix})`
            : whole;
        },
      );
    })
    .join('\n');
}
