import { type FileInsightResponse, fileUseOf, summaryLead } from '@bendyline/gezel';
import { normalizeSeverity } from '../filemap/health.js';
import { importersOf, specifierResolver } from './edges/readers.js';
import { fileEdgesAvailable } from './edges/refresh.js';
import { GIT_META_COMMITS, GIT_META_LAST_COMMIT } from './git-stats.js';
import type { FileEdge } from './index-store-types.js';
import type { IndexStore } from './index-store.js';

/** Each connection list stops here; `truncated` says when one did. */
const MAX_CONNECTIONS = 100;

/**
 * Everything the index knows about one file, for the inspector: its facts,
 * summary, what folder it sits in and what that folder is for, its photo or
 * document facts, its history, and what it depends on and is depended on by.
 * One read of the index; never touches the file itself.
 */
export function buildFileInsight(index: IndexStore, path: string): FileInsightResponse {
  const rec = index.getFile(path);
  const meta = rec ? index.getMetadata(path) : {};
  const summaryText = rec?.hash ? index.getSummary(rec.hash)?.trim() : undefined;

  const connections = connectionsOf(index, path);
  const duplicates = rec?.hash ? index.pathsWithHash(rec.hash).filter((p) => p !== path) : [];
  const finding = index.securityFindingCountsByFile().get(path);
  const commits = Number(meta[GIT_META_COMMITS]);

  return {
    path,
    indexed: rec !== undefined,
    file: rec
      ? {
          size: rec.size ?? null,
          mtimeMs: rec.mtimeMs ?? null,
          lang: rec.lang,
          kind: rec.kind,
          modality: rec.modality,
          use:
            rec.kind === 'code' || rec.kind === 'config' || rec.kind === 'data'
              ? fileUseOf(path, rec.lang)
              : null,
          loc: rec.loc ?? null,
          trivial: rec.trivial,
        }
      : null,
    summary: summaryText ? { text: summaryText, lead: summaryLead(summaryText) } : null,
    folder: folderPurpose(index, path),
    ...(rec?.modality === 'image' ? { media: mediaFacts(meta) } : {}),
    ...(rec?.kind === 'markdown' ? { doc: docFacts(index, path, meta) } : {}),
    ...(Number.isFinite(commits) && meta[GIT_META_COMMITS] !== undefined
      ? {
          git: {
            commits,
            ...(meta[GIT_META_LAST_COMMIT] ? { lastCommitAt: meta[GIT_META_LAST_COMMIT] } : {}),
          },
        }
      : {}),
    connections: { ...connections, duplicates: duplicates.slice(0, MAX_CONNECTIONS) },
    findings: {
      count: finding?.count ?? 0,
      maxSeverity: normalizeSeverity(finding?.maxSeverity),
    },
  };
}

function connectionsOf(
  index: IndexStore,
  path: string,
): Omit<FileInsightResponse['connections'], 'duplicates'> {
  let truncated = false;
  const cap = <T>(list: T[]): T[] => {
    if (list.length > MAX_CONNECTIONS) truncated = true;
    return list.slice(0, MAX_CONNECTIONS);
  };
  const named = (bindings: FileEdge['bindings']): string[] =>
    [...new Set((bindings ?? []).filter((b) => b.kind === 'named').map((b) => b.name))].sort();

  if (!fileEdgesAvailable(index)) {
    const resolve = specifierResolver(index, path);
    const imports = index
      .importsForFile(path)
      .flatMap((r) => {
        const dst = resolve(r.raw);
        return dst ? [{ path: dst, names: named(r.bindings) }] : [];
      })
      .sort(byPath);
    const importedBy = importersOf(index, path)
      .map((e) => ({ path: e.src, names: named(e.bindings) }))
      .sort(byPath);
    return {
      imports: cap(imports),
      importedBy: cap(importedBy),
      links: [],
      linkedFrom: [],
      truncated,
    };
  }

  const group = (edges: FileEdge[], end: 'src' | 'dst') => {
    const byFile = new Map<string, Set<string>>();
    for (const e of edges) {
      const other = e[end];
      const names = byFile.get(other) ?? new Set<string>();
      for (const n of named(e.bindings)) names.add(n);
      byFile.set(other, names);
    }
    return [...byFile.entries()]
      .map(([p, names]) => ({ path: p, names: [...names].sort() }))
      .sort(byPath);
  };
  const out = index.fileEdges.from(path);
  const inn = index.fileEdges.to(path);
  const isCode = (e: FileEdge) => e.kind !== 'link';
  return {
    imports: cap(group(out.filter(isCode), 'dst')),
    importedBy: cap(group(inn.filter(isCode), 'src')),
    links: cap(
      group(
        out.filter((e) => !isCode(e)),
        'dst',
      ),
    ),
    linkedFrom: cap(
      group(
        inn.filter((e) => !isCode(e)),
        'src',
      ),
    ),
    truncated,
  };
}

/** The nearest folder at or above the file that the index has summarized. */
function folderPurpose(index: IndexStore, path: string): FileInsightResponse['folder'] {
  const folder = folderOf(path);
  const areas = new Map(index.allAreaSummaries().map((a) => [a.areaPath, a.summaryMd]));
  let dir = folder;
  for (;;) {
    const purpose = areas.get(dir || '.');
    if (purpose) return { path: folder, purpose: summaryLead(purpose), purposePath: dir || '.' };
    if (!dir) return { path: folder };
    dir = folderOf(dir);
  }
}

/** Photo facts from the image tier's metadata. The location is never read. */
function mediaFacts(meta: Record<string, string>): NonNullable<FileInsightResponse['media']> {
  const int = (v: string | undefined) => {
    const n = v === undefined ? Number.NaN : Number(v);
    return Number.isInteger(n) && n > 0 ? n : undefined;
  };
  const width = int(meta.width);
  const height = int(meta.height);
  return {
    ...(meta.taken_at ? { takenAt: meta.taken_at } : {}),
    ...(meta.camera_make ? { cameraMake: meta.camera_make } : {}),
    ...(meta.camera_model ? { cameraModel: meta.camera_model } : {}),
    ...(meta.lens ? { lens: meta.lens } : {}),
    ...(width ? { width } : {}),
    ...(height ? { height } : {}),
    ...(meta.screenshot !== undefined
      ? { screenshot: meta.screenshot === 'true' || meta.screenshot === '1' }
      : {}),
  };
}

/** A document's frontmatter (its own keys, not the index's) and title. */
function docFacts(
  index: IndexStore,
  path: string,
  meta: Record<string, string>,
): NonNullable<FileInsightResponse['doc']> {
  const frontmatter = Object.fromEntries(
    Object.entries(meta).filter(([key]) => !key.includes(':')),
  );
  const title =
    frontmatter.title ?? index.symbolsForFile(path).find((s) => s.kind.startsWith('h'))?.name;
  return { ...(title ? { title } : {}), frontmatter };
}

function byPath(a: { path: string }, b: { path: string }): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

function folderOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}
