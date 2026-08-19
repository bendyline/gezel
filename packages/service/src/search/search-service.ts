import { createLogger, isSharedLibraryProject } from '@bendyline/gezel';
import type { RetrievalSource, UnifiedSearchResult } from '@bendyline/gezel';
import type { Store } from '../fs/store.js';
import { isLibraryInternalPath } from '../fs/sync-junk.js';
import type { ContentIndex } from '../index-store/content-index.js';
import type { GlobalIndex } from '../index-store/global-index.js';
import { embedQuery } from '../memory/embeddings.js';
import type { MemoryManager } from '../memory/manager.js';
import type { WorkspaceIndexManager } from '../workspace/index-manager.js';

/**
 * Cross-project unified search backing the titlebar search box.
 *
 * Two surfaces:
 *   - {@link quickOpen} — instant, name-only. Matches project + gezel names,
 *     document paths, and per-project workspace file paths from an in-memory
 *     catalog (rebuilt lazily on a short TTL; reuses the indexer's `files.json`
 *     rather than re-walking).
 *   - {@link search} — quick-open results PLUS a content fan-out across every
 *     project's per-project content index (FTS + sqlite-vec) and the gezel /
 *     project memory indices. The query is embedded ONCE and the vector is
 *     threaded into every per-project call, so a fan-out over dozens of
 *     projects pays a single embedding.
 *
 * This is deliberately a fan-out, not a global "index of indexes": node:sqlite
 * open/close is cheap and the per-project index already exists. Escalate to a
 * dedicated aggregate index only if project counts reach the low hundreds.
 */

const log = createLogger('search');

/** How long the name catalog stays warm before a rebuild. */
const CATALOG_TTL_MS = 10_000;
/** Concurrent per-project / per-gezel fan-out tasks. */
const FANOUT_CONCURRENCY = 8;
/** Budget for a single project's (or gezel's) fan-out work before we drop it. */
const PER_SCOPE_TIMEOUT_MS = 600;
/** Hits requested from each per-project content source. */
const PER_SOURCE_RESULTS = 5;
/** Catalog cap on indexed artifact-corpus records per project. */
const ARTIFACT_CATALOG_CAP = 2000;
/** Hits requested from each memory scope. */
const PER_MEMORY_RESULTS = 3;
/**
 * Cosine-similarity floor for a memory hit to be worth showing.
 *
 * Vector search is nearest-neighbour, not match/no-match: it returns the top
 * K rows for *any* query, so without a floor a nonsense string still produced
 * three confident-looking results, and real queries carried two or three
 * unrelated fragments alongside the genuine hit. It also meant "No results"
 * was unreachable once an install had memories — the user got debris instead
 * of an honest answer.
 *
 * Measured against the shipped embedder (Xenova/all-MiniLM-L6-v2, 384d) on
 * representative rows: genuine paraphrase matches scored 0.83-0.86, while the
 * worst unrelated pair reached only 0.33. 0.35 sits in that gap. Raising it
 * costs recall on loosely-worded matches; lowering it lets noise back in.
 */
const MEMORY_MIN_SIMILARITY = 0.35;
/** Default merged result cap returned to the caller. */
const DEFAULT_MAX_RESULTS = 30;

/**
 * History-event kinds that change what the name catalog returns: project +
 * gezel + document create/rename/delete. (Workspace file edits aren't here —
 * the catalog's file list comes from the indexer's `files.json`, which only
 * refreshes on a re-scan, so invalidating on a raw write would surface
 * nothing new.) Wired to `HistoryManager.subscribe` in `service.ts`.
 */
export const CATALOG_RELEVANT_HISTORY_KINDS: ReadonlySet<string> = new Set([
  'gezel.created',
  'gezel.renamed',
  'project.created',
  'project.updated',
  'document.created',
  'document.folder.created',
  'document.renamed',
  'document.deleted',
]);

// Kind weights — bias name/quick-open matches above content so a typed project
// name out-ranks a fuzzy file hit, while a strong content match can still
// surface. Multiplied by a 0..1 relevance to produce the merged `score`.
const WEIGHT = {
  project: 1000,
  gezel: 950,
  file: 700,
  document: 680,
  symbol: 520,
  content: 420,
  session: 400,
  memory: 360,
} as const;

interface CatalogEntry {
  kind: 'project' | 'gezel' | 'file' | 'document';
  id: string;
  /** The primary string we fuzzy-match (name or basename). */
  title: string;
  /** Optional secondary match target (full path) for files/documents. */
  path?: string;
  /**
   * Extra match targets that are not the display title — a gezel's role and
   * role-based name. Searchable because the product's whole vocabulary is
   * roles: a user reading the Handboek types "meester" or "boekwachter", not
   * the random first name that gezel happens to carry. Matched at a discount
   * so a real name match still wins.
   */
  keywords?: string[];
  subtitle?: string;
  projectId?: string;
  projectName?: string;
  source?: 'workspace' | 'artifacts';
}

export class SearchService {
  private catalog: CatalogEntry[] | null = null;
  private catalogBuiltAt = 0;
  private catalogBuilding: Promise<CatalogEntry[]> | null = null;

  constructor(
    private readonly store: Store,
    private readonly contentIndex: ContentIndex,
    private readonly memory: MemoryManager,
    private readonly indexManager: WorkspaceIndexManager,
    private readonly globalIndex?: GlobalIndex,
  ) {}

  /** Drop the cached catalog — called when projects/gezels/documents change. */
  invalidateCatalog(): void {
    this.catalog = null;
  }

  /** Instant name-only quick-open over the cached catalog. */
  async quickOpen(query: string, maxResults = DEFAULT_MAX_RESULTS): Promise<UnifiedSearchResult[]> {
    const q = query.trim();
    if (!q) return [];
    const catalog = await this.getCatalog();
    return this.matchCatalog(catalog, q, maxResults);
  }

  /**
   * Full unified search: quick-open catalog + content fan-out + memories.
   * Returns merged, de-duplicated, ranked results plus a `truncated` flag.
   */
  async search(
    query: string,
    opts: { mode?: 'names' | 'full'; maxResults?: number } = {},
  ): Promise<{ results: UnifiedSearchResult[]; truncated: boolean }> {
    const q = query.trim();
    if (!q) return { results: [], truncated: false };
    const maxResults = opts.maxResults ?? DEFAULT_MAX_RESULTS;
    const mode = opts.mode ?? 'full';

    const nameResults = await this.quickOpen(q, maxResults);
    if (mode === 'names') {
      return { results: nameResults.slice(0, maxResults), truncated: false };
    }

    const { results: contentResults, truncated } = await this.contentFanOut(q, maxResults);

    const merged = this.merge([...nameResults, ...contentResults], maxResults);
    return {
      results: merged,
      truncated: truncated || merged.length < nameResults.length + contentResults.length,
    };
  }

  /**
   * Model-facing retrieval over an explicitly bounded project set. Unlike the
   * titlebar search, this never fans out through unrelated projects, gezels, or
   * transcripts. The array-shaped project boundary is intentional: project
   * linking can supply additional authorized ids later without changing the
   * search contract or ranking pipeline.
   */
  async searchProject(
    query: string,
    opts: {
      projectIds: readonly string[];
      gezelId?: string;
      includeShared?: boolean;
      sources?: readonly RetrievalSource[];
      maxResults?: number;
    },
  ): Promise<{ results: UnifiedSearchResult[]; truncated: boolean }> {
    const q = query.trim();
    if (!q || opts.projectIds.length === 0) return { results: [], truncated: false };
    const maxResults = opts.maxResults ?? DEFAULT_MAX_RESULTS;
    const found = await this.contentFanOut(q, maxResults, {
      projectIds: new Set(opts.projectIds),
      ...(opts.gezelId ? { gezelId: opts.gezelId } : {}),
      includeShared: opts.includeShared !== false,
      ...(opts.sources ? { sources: new Set(opts.sources) } : {}),
    });
    const results = this.merge(found.results, maxResults);
    return {
      results,
      truncated: found.truncated || results.length < found.results.length,
    };
  }

  // ── catalog ────────────────────────────────────────────────────────────

  private async getCatalog(): Promise<CatalogEntry[]> {
    const fresh = this.catalog && Date.now() - this.catalogBuiltAt < CATALOG_TTL_MS;
    if (fresh) return this.catalog!;
    if (this.catalogBuilding) return this.catalogBuilding;
    this.catalogBuilding = this.buildCatalog()
      .then((c) => {
        this.catalog = c;
        this.catalogBuiltAt = Date.now();
        return c;
      })
      .finally(() => {
        this.catalogBuilding = null;
      });
    return this.catalogBuilding;
  }

  private async buildCatalog(): Promise<CatalogEntry[]> {
    const entries: CatalogEntry[] = [];
    const [projects, gezels, documents] = await Promise.all([
      this.store.listProjects().catch(() => []),
      this.store.listGezels().catch(() => []),
      this.store.listDocumentsRecursive().catch(() => []),
    ]);

    for (const p of projects) {
      entries.push({ kind: 'project', id: `project:${p.id}`, title: p.name, projectId: p.id });
    }
    for (const g of gezels) {
      const keywords = [g.role, g.roleBasedName].filter(
        (k): k is string => typeof k === 'string' && k.trim().length > 0,
      );
      entries.push({
        kind: 'gezel',
        id: `gezel:${g.id}`,
        title: g.name,
        ...(g.role ? { subtitle: g.role } : {}),
        ...(keywords.length > 0 ? { keywords } : {}),
      });
    }
    for (const d of documents) {
      if (d.isDirectory) continue;
      // Companion twins of a binary document (`brief.docx_files/brief.md`)
      // are a derived view of a document already listed here.
      if (isLibraryInternalPath(d.path)) continue;
      entries.push({
        kind: 'document',
        id: `document:${d.path}`,
        title: basename(d.path),
        path: d.path,
        subtitle: d.path,
      });
    }

    // File paths from each project's persisted files.json (no re-walk), plus
    // indexed artifact-corpus records (connector data under artifacts/data/**).
    // The library's files are already in the catalog as `document` entries
    // above; walking it again here would list every document twice, once as
    // a document and once as a file in a project the user never opens.
    const fileListProjects = projects.filter((p) => !isSharedLibraryProject(p));
    const fileLists = await mapPool(fileListProjects, FANOUT_CONCURRENCY, async (p) => {
      const [files, artifactFiles] = await Promise.all([
        this.indexManager.readFiles(p.id).catch(() => []),
        this.contentIndex.listArtifactIndexFiles(p.id, ARTIFACT_CATALOG_CAP).catch(() => []),
      ]);
      return { project: p, files, artifactFiles };
    });
    for (const { project, files, artifactFiles } of fileLists) {
      for (const f of files) {
        entries.push({
          kind: 'file',
          id: `file:${project.id}:${f.path}`,
          title: basename(f.path),
          path: f.path,
          subtitle: `${project.name} · ${f.path}`,
          projectId: project.id,
          projectName: project.name,
          source: 'workspace',
        });
      }
      for (const path of artifactFiles) {
        entries.push({
          kind: 'file',
          // `artifacts:` segment — a workspace file may share the same
          // relative path, and the two must stay distinct rows.
          id: `file:${project.id}:artifacts:${path}`,
          title: basename(path),
          path,
          subtitle: `${project.name} · ${path}`,
          projectId: project.id,
          projectName: project.name,
          source: 'artifacts',
        });
      }
    }

    log.info(`[search] catalog built: ${entries.length} entries`);
    return entries;
  }

  private matchCatalog(
    catalog: CatalogEntry[],
    query: string,
    maxResults: number,
  ): UnifiedSearchResult[] {
    const scored: UnifiedSearchResult[] = [];
    for (const e of catalog) {
      // Match the title (name/basename) first; fall back to full path with a
      // discount so a path-fragment match still finds the file, then to the
      // entry's keywords so a gezel is reachable by role as well as by name.
      let rel = fuzzyScore(query, e.title);
      if (rel === null && e.path) {
        const pathScore = fuzzyScore(query, e.path);
        if (pathScore !== null) rel = pathScore * 0.7;
      }
      if (rel === null && e.keywords) {
        let best: number | null = null;
        for (const keyword of e.keywords) {
          const score = fuzzyScore(query, keyword);
          if (score !== null && (best === null || score > best)) best = score;
        }
        if (best !== null) rel = best * 0.7;
      }
      if (rel === null) continue;
      scored.push({
        kind: e.kind,
        id: e.id,
        title: e.title,
        ...(e.subtitle ? { subtitle: e.subtitle } : {}),
        ...(e.projectId ? { projectId: e.projectId } : {}),
        ...(e.projectName ? { projectName: e.projectName } : {}),
        ...(e.path ? { path: e.path } : {}),
        ...(e.source ? { source: e.source } : {}),
        score: rel * WEIGHT[e.kind],
      });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, maxResults);
  }

  // ── content fan-out ──────────────────────────────────────────────────────

  private async contentFanOut(
    query: string,
    maxResults: number,
    scope?: {
      projectIds: ReadonlySet<string>;
      gezelId?: string;
      includeShared: boolean;
      sources?: ReadonlySet<RetrievalSource>;
    },
  ): Promise<{ results: UnifiedSearchResult[]; truncated: boolean }> {
    const [allProjects, allGezels] = await Promise.all([
      this.store.listProjects().catch(() => []),
      this.store.listGezels().catch(() => []),
    ]);
    const projects = scope ? allProjects.filter((p) => scope.projectIds.has(p.id)) : allProjects;
    const gezels = scope ? allGezels.filter((g) => g.id === scope.gezelId) : allGezels;
    const wants = (source: RetrievalSource): boolean =>
      !scope?.sources || scope.sources.has(source);

    // Embed the query once; thread the vector into every per-project call.
    let vector: number[] | null = null;
    try {
      vector = await embedQuery(query);
    } catch {
      vector = null; // embeddings disabled → keyword/FTS only, no memory hits
    }

    let truncated = false;

    // One pool unit per project: code + docs + symbols + project memory.
    const perProject = projects.map((p) => async () => {
      const out: UnifiedSearchResult[] = [];
      // The shared library has its own arm below, emitting `document` rows.
      // Running it here too would list every document a second time as
      // project content.
      if (isSharedLibraryProject(p)) return out;
      const workspaceIndexing = p.indexingEnabled !== false;
      const codeOpts = vector
        ? { queryVector: vector, maxResults: PER_SOURCE_RESULTS }
        : { mode: 'keyword' as const, maxResults: PER_SOURCE_RESULTS };
      const [code, docs, artifacts, symbols, areas, mem] = await Promise.all([
        workspaceIndexing && wants('workspace')
          ? this.contentIndex.searchCode(p.id, query, codeOpts).catch(() => null)
          : Promise.resolve(null),
        workspaceIndexing && wants('workspace')
          ? this.contentIndex.searchDocs(p.id, query, PER_SOURCE_RESULTS).catch(() => null)
          : Promise.resolve(null),
        workspaceIndexing && wants('artifacts')
          ? this.contentIndex.searchArtifacts(p.id, query, PER_SOURCE_RESULTS).catch(() => null)
          : Promise.resolve(null),
        workspaceIndexing && wants('workspace')
          ? this.contentIndex
              .findSymbol(p.id, query, { maxResults: PER_SOURCE_RESULTS })
              .catch(() => null)
          : Promise.resolve(null),
        workspaceIndexing && wants('workspace')
          ? this.contentIndex.searchAreaSummaries(p.id, query, PER_SOURCE_RESULTS).catch(() => [])
          : Promise.resolve([]),
        vector && wants('project-memory')
          ? this.memory.searchVector('project', p.id, vector, PER_MEMORY_RESULTS).catch(() => [])
          : Promise.resolve([]),
      ]);
      for (const r of code?.results ?? []) {
        out.push({
          kind: 'content',
          id: `content:${p.id}:${r.path}:${r.lineStart}`,
          title: r.name ?? basename(r.path),
          subtitle: `${p.name} · ${r.path}`,
          snippet: r.snippet,
          projectId: p.id,
          projectName: p.name,
          path: r.path,
          source: 'workspace',
          retrievalSource: 'workspace',
          line: r.lineStart,
          lineEnd: r.lineEnd,
          score: clamp01(r.score) * WEIGHT.content,
        });
      }
      for (const r of docs?.results ?? []) {
        out.push({
          kind: 'content',
          id: `content:${p.id}:${r.sourcePath}:${r.lineStart}`,
          title: basename(r.sourcePath),
          subtitle: `${p.name} · ${r.sourcePath}`,
          snippet: r.snippet,
          projectId: p.id,
          projectName: p.name,
          path: r.sourcePath,
          source: 'workspace',
          retrievalSource: 'workspace',
          line: r.lineStart,
          lineEnd: r.lineEnd,
          score: 0.6 * WEIGHT.content,
        });
      }
      for (const r of artifacts?.results ?? []) {
        out.push({
          kind: 'content',
          id: `content:${p.id}:artifacts:${r.path}:${r.lineStart}`,
          title: basename(r.path),
          subtitle: `${p.name} · ${r.path}`,
          snippet: r.snippet,
          projectId: p.id,
          projectName: p.name,
          path: r.path,
          source: 'artifacts',
          retrievalSource: 'artifacts',
          line: r.lineStart,
          lineEnd: r.lineEnd,
          score: 0.6 * WEIGHT.content,
        });
      }
      for (const m of symbols?.matches ?? []) {
        const rel = fuzzyScore(query, m.name) ?? 0.4;
        out.push({
          kind: 'symbol',
          id: `symbol:${p.id}:${m.path}:${m.name}`,
          title: m.name,
          subtitle: `${m.kind} · ${p.name} · ${m.path}`,
          projectId: p.id,
          projectName: p.name,
          path: m.path,
          source: 'workspace',
          retrievalSource: 'workspace',
          line: m.lineStart,
          score: rel * WEIGHT.symbol,
        });
      }
      for (const area of areas) {
        const projectOverview = area.areaPath === '::project';
        out.push({
          kind: 'content',
          id: `overview:${p.id}:${area.areaPath}`,
          title: projectOverview ? `${p.name} overview` : `${area.areaPath}/ overview`,
          subtitle: projectOverview ? `Project architecture · ${p.name}` : `Area map · ${p.name}`,
          snippet: area.summary,
          projectId: p.id,
          projectName: p.name,
          retrievalSource: 'workspace',
          score: clamp01(area.score) * WEIGHT.content,
        });
      }
      for (const r of mem) {
        if (r.score < MEMORY_MIN_SIMILARITY) continue;
        out.push({
          kind: 'memory',
          id: `memory:project:${p.id}:${r.day}:${hashText(r.text)}`,
          title: r.text.slice(0, 80),
          subtitle: `Memory · ${p.name}`,
          snippet: r.text,
          projectId: p.id,
          projectName: p.name,
          retrievalSource: 'project-memory',
          score: clamp01(r.score) * WEIGHT.memory,
        });
      }
      return out;
    });

    // One pool unit per gezel: gezel memory (vector-only).
    const perGezel =
      vector && wants('gezel-memory')
        ? gezels.map((g) => async () => {
            const mem = await this.memory
              .searchVector('gezel', g.id, vector as number[], PER_MEMORY_RESULTS)
              .catch(() => []);
            return mem
              .filter((r) => r.score >= MEMORY_MIN_SIMILARITY)
              .map((r) => ({
                kind: 'memory' as const,
                id: `memory:gezel:${g.id}:${r.day}:${hashText(r.text)}`,
                title: r.text.slice(0, 80),
                subtitle: `Memory · ${g.name}`,
                snippet: r.text,
                retrievalSource: 'gezel-memory' as const,
                score: clamp01(r.score) * WEIGHT.memory,
              }));
          })
        : [];

    // Global collections (session transcripts + documents content) — one task
    // each, not per-project: the global index answers across all scopes in a
    // single FTS query.
    const globalTasks: Array<() => Promise<UnifiedSearchResult[]>> = [];
    const globalIndex = this.globalIndex;
    if (globalIndex && !scope) {
      const projectNames = new Map(projects.map((p) => [p.id, p.name]));
      const gezelNames = new Map(gezels.map((g) => [g.id, g.name]));
      globalTasks.push(async () => {
        const hits = await globalIndex
          .searchSessions(query, { maxResults: PER_SOURCE_RESULTS })
          .catch(() => []);
        return hits.map((h) => {
          const projectName = projectNames.get(h.projectId);
          const gezelName = gezelNames.get(h.gezelId) ?? h.gezelId;
          return {
            kind: 'session' as const,
            id: `session:${h.sessionId}`,
            title: h.title || 'Untitled session',
            subtitle: projectName ? `${gezelName} · ${projectName}` : gezelName,
            snippet: h.snippet,
            ...(h.projectId ? { projectId: h.projectId } : {}),
            ...(projectName ? { projectName } : {}),
            gezelId: h.gezelId,
            score: 0.6 * WEIGHT.session,
          };
        });
      });
    }
    if ((!scope || scope.includeShared) && wants('shared')) {
      globalTasks.push(async () => {
        // The library is a project now, so its content search is the ranked
        // hybrid one. It is emitted as `document` rather than `content` so a
        // library hit keeps its global provenance wherever it surfaces.
        const libraryId = await this.store.sharedProjectId().catch(() => null);
        if (!libraryId) return [];
        const found = await this.contentIndex
          .searchLibrary(libraryId, query, {
            maxResults: PER_SOURCE_RESULTS,
            ...(vector ? { queryVector: vector } : {}),
          })
          .catch(() => null);
        return (found?.results ?? []).map((h) => ({
          kind: 'document' as const,
          id: `document:${h.path}`,
          title: basename(h.path),
          subtitle: `Shared library · ${h.path}`,
          snippet: h.snippet,
          path: h.path,
          retrievalSource: 'shared' as const,
          line: h.lineStart,
          lineEnd: h.lineEnd,
          score: clamp01(h.score ?? 0.6) * WEIGHT.document,
        }));
      });
    }

    const tasks = [...perProject, ...perGezel, ...globalTasks];
    const settled = await mapPool(tasks, FANOUT_CONCURRENCY, async (task) => {
      const res = await withTimeout(task(), PER_SCOPE_TIMEOUT_MS, null);
      if (res === null) truncated = true;
      return res ?? [];
    });

    return { results: settled.flat(), truncated };
  }

  // ── merge ────────────────────────────────────────────────────────────────

  private merge(all: UnifiedSearchResult[], maxResults: number): UnifiedSearchResult[] {
    const byId = new Map<string, UnifiedSearchResult>();
    for (const r of all) {
      const existing = byId.get(r.id);
      if (!existing || r.score > existing.score) byId.set(r.id, r);
    }
    // A memory's id carries its scope and day, so the same remembered
    // sentence recorded for two gezels — or on two days — survives the id
    // pass and lists two, three, four times over. The text is what the reader
    // sees, so that is what has to be unique; the best-scoring copy wins and
    // keeps its own id, which is what navigation resolves against.
    const bestByText = new Map<string, UnifiedSearchResult>();
    const out: UnifiedSearchResult[] = [];
    for (const r of byId.values()) {
      if (r.kind !== 'memory') {
        out.push(r);
        continue;
      }
      const key = memoryTextKey(r.snippet ?? r.title);
      const existing = bestByText.get(key);
      if (!existing || r.score > existing.score) bestByText.set(key, r);
    }
    out.push(...bestByText.values());
    return out.sort((a, b) => b.score - a.score).slice(0, maxResults);
  }
}

// ── helpers ──────────────────────────────────────────────────────────────

function basename(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? path : path.slice(i + 1);
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/**
 * Identity of a remembered sentence for de-duplication: case- and
 * whitespace-insensitive, so the same fact written on two days collapses to
 * one row rather than reading as two separate recollections.
 */
function memoryTextKey(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * VS Code-style subsequence fuzzy score in [0,1], or null when `query` is not a
 * subsequence of `target`. Rewards exact / prefix / word-boundary matches and
 * penalizes scattered, late matches.
 */
export function fuzzyScore(query: string, target: string): number | null {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (q.length === 0) return null;
  if (q === t) return 1;

  const idx = t.indexOf(q);
  if (idx === 0) return 0.95; // prefix
  if (idx > 0) {
    // Contiguous substring; boost when it starts on a word boundary.
    const boundary = idx > 0 && /[^a-z0-9]/.test(t[idx - 1] ?? '');
    const positionPenalty = idx / (t.length + 1);
    return (boundary ? 0.9 : 0.8) - 0.1 * positionPenalty;
  }

  // Scattered subsequence.
  let ti = 0;
  let matched = 0;
  let firstPos = -1;
  let lastPos = -1;
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi]!;
    let found = -1;
    while (ti < t.length) {
      if (t[ti] === ch) {
        found = ti;
        ti++;
        break;
      }
      ti++;
    }
    if (found === -1) return null;
    if (firstPos === -1) firstPos = found;
    lastPos = found;
    matched++;
  }
  if (matched < q.length) return null;
  const span = lastPos - firstPos + 1;
  const compactness = q.length / span; // 1 = contiguous
  const earliness = 1 - firstPos / (t.length + 1);
  return Math.max(0.1, 0.55 * compactness + 0.15 * earliness);
}

/** Tiny non-cryptographic hash for stable ids over snippet text. */
function hashText(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** Resolve `p` to `fallback` if it doesn't settle within `ms`. */
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        resolve(fallback);
      }
    }, ms);
    if (typeof (timer as { unref?: () => void }).unref === 'function') {
      (timer as { unref: () => void }).unref();
    }
    p.then(
      (v) => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          resolve(v);
        }
      },
      () => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          resolve(fallback);
        }
      },
    );
  });
}

/** Run `fn` over `items` with a bounded number of concurrent executions. */
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers: Promise<void>[] = [];
  const run = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  };
  for (let i = 0; i < Math.min(limit, items.length); i++) workers.push(run());
  await Promise.all(workers);
  return results;
}
