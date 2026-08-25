import { createLogger, isSharedLibraryProject } from '@bendyline/gezel';
import type {
  RetrievalSource,
  UnifiedSearchResult,
  UnifiedSearchResultKind,
} from '@bendyline/gezel';
import type { Store } from '../fs/store.js';
import { isLibraryInternalPath } from '../fs/sync-junk.js';
import type { ContentIndex } from '../index-store/content-index.js';
import type { GlobalIndex } from '../index-store/global-index.js';
import { embedQuery, embeddingPipelineStatus } from '../memory/embeddings.js';
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
 * Measured against the shipped embedder (Xenova/bge-small-en-v1.5, 384d,
 * query-instruction prefix) with `evals/src/bin/embed-calibration.ts`
 * (query→passage mode, 2026-08-19): relevant query→memory pairs scored
 * 0.561-0.787 while the worst unrelated pair reached 0.429 (median 0.323 —
 * the old MiniLM-era 0.35 floor admitted half the noise band). 0.45 sits in
 * that gap, biased toward the noise side: recall losses are visible and
 * recoverable, noise admissions are silent. Re-run the harness and re-pick
 * whenever the embedder changes.
 */
const MEMORY_MIN_SIMILARITY = 0.45;
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

// Per-kind merge weights — corpus PRIORITY, kept strictly separate from
// within-corpus relevance. Bias name/quick-open matches above content so a
// typed project name out-ranks a fuzzy file hit, while a strong content match
// can still surface. Multiplied by a calibrated 0..1 relevance in
// `scoreResult` to produce the merged ordering key. Typed against the full
// kind enum so a future kind (e.g. `knowledge`, planned weight ~380 — below
// project content, above memory) is a compile error here until weighted.
export const MERGE_WEIGHTS: Record<UnifiedSearchResultKind, number> = {
  project: 1000,
  gezel: 950,
  file: 700,
  document: 680,
  // A named task beats fuzzy content — the user typed something close to its
  // title — but never a project/gezel/file name match.
  task: 640,
  // A subject-line match on the user's own mail is personal content — above
  // catalogs and symbols, below tasks (a typed task title is more deliberate
  // than a remembered subject fragment).
  mail: 620,
  symbol: 520,
  craftbook: 500,
  content: 420,
  session: 400,
  // Manual articles orient, they don't answer about the user's own work —
  // below every user-content corpus, above nothing.
  handboek: 380,
  // Knowledge catalogs are generic reference material: below every corpus
  // about the user's own work AND below the handboek (which at least is
  // about this product), above only memory's ambient recall. The audit's
  // "~380" slot collided with handboek — 370 keeps a strict ordering.
  knowledge: 370,
  memory: 360,
};

/**
 * Relevance estimate for an FTS-only corpus that reports rank order but no
 * usable score. RRF-shaped (k=10) and anchored so rank 0 = 0.6 — the fixed
 * pseudo-relevance these corpora carried historically — so the top hit's
 * merged score is bit-identical to the pre-calibration behavior and later
 * ranks decay instead of tying.
 */
export function ftsRankRelevance(rank: number): number {
  return 0.6 * (11 / (11 + rank));
}

/** Documented explicit pseudo-relevance for a symbol the query didn't fuzzy-match. */
const SYMBOL_FALLBACK_RELEVANCE = 0.4;

/** Relevance at or above which a hit renders as high-confidence. */
const STRONG_TIER_MIN_RELEVANCE = 0.6;

/**
 * One retrieval arm's observed timing — non-content telemetry. Rides the
 * `retrieval.context-injected` history event so a slow, failing, or
 * timed-out arm is visible instead of being indistinguishable from "found
 * nothing" (every arm is otherwise caught-to-null in the fan-out).
 */
export interface RetrievalArmTiming {
  /** Arm discriminant, e.g. 'workspace:code', 'gezel-memory', 'shared'. */
  arm: string;
  /** Scope id (project/gezel) when the arm is per-scope. */
  scope?: string;
  ms: number;
  hits: number;
  timedOut: boolean;
  failed: boolean;
}

/**
 * The single scoring seam: every result construction site routes through
 * this, so relevance stays a calibrated 0–1, tiers derive from one constant,
 * and `score` remains purely relevance × corpus priority.
 */
export function scoreResult(
  kind: UnifiedSearchResultKind,
  relevance: number,
): { relevance: number; tier: 'strong' | 'weak'; score: number } {
  const clamped = clamp01(relevance);
  return {
    relevance: clamped,
    tier: clamped >= STRONG_TIER_MIN_RELEVANCE ? 'strong' : 'weak',
    score: clamped * MERGE_WEIGHTS[kind],
  };
}

/**
 * Extra name-catalog providers wired in AFTER construction (they depend on
 * subsystems built later in service boot). Titlebar quick-open only — the
 * model-scoped project search never consumes the name catalog.
 */
/**
 * Late-wired knowledge-catalog arm (KnowledgeManager builds after the
 * SearchService). Returns FINISHED UnifiedSearchResults — provenance,
 * topic-name resolution, and scoring live with the catalog owner, keeping
 * this service ignorant of the .gezk runtime.
 */
export interface KnowledgeSearchProvider {
  search(
    query: string,
    opts: {
      /** The already-embedded query vector; null → FTS-only catalogs search. */
      vector: number[] | null;
      maxResults: number;
      /** The session project (scoped search) — resolves the project policy. */
      projectId?: string;
    },
  ): Promise<UnifiedSearchResult[]>;
}

export interface ExtraSearchCatalogs {
  /** Handboek TOC entries (id + title + optional keywords). */
  handboekEntries?: () => Promise<Array<{ id: string; title: string; keywords?: string[] }>>;
  /** Craftbooks reachable from anywhere (bundled + user-local). */
  craftbookEntries?: () => Promise<
    Array<{ id: string; name: string; source: 'bundled' | 'local' | 'project' }>
  >;
  /**
   * Mail messages by subject/sender, derived from the connector corpus paths
   * (no file reads). Bodies are already covered by the artifacts content arm.
   */
  mailEntries?: () => Promise<
    Array<{ projectId: string; path: string; subject: string; from: string; date: string }>
  >;
}

interface CatalogEntry {
  kind: 'project' | 'gezel' | 'file' | 'document' | 'task' | 'craftbook' | 'handboek' | 'mail';
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

  private extraCatalogs: ExtraSearchCatalogs = {};
  private knowledgeSearch: KnowledgeSearchProvider | null = null;

  constructor(
    private readonly store: Store,
    private readonly contentIndex: ContentIndex,
    private readonly memory: MemoryManager,
    private readonly indexManager: WorkspaceIndexManager,
    private readonly globalIndex?: GlobalIndex,
  ) {}

  /** Wire the late-boot name-catalog providers (handboek, craftbooks). */
  setExtraCatalogs(extra: ExtraSearchCatalogs): void {
    this.extraCatalogs = extra;
    this.invalidateCatalog();
  }

  /** Wire the knowledge-catalog arm (late-boot, like the extra catalogs). */
  setKnowledgeSearch(provider: KnowledgeSearchProvider | null): void {
    this.knowledgeSearch = provider;
  }

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
  ): Promise<{ results: UnifiedSearchResult[]; truncated: boolean; sourcesIncomplete?: boolean }> {
    const q = query.trim();
    if (!q) return { results: [], truncated: false };
    const maxResults = opts.maxResults ?? DEFAULT_MAX_RESULTS;
    const mode = opts.mode ?? 'full';

    const nameResults = await this.quickOpen(q, maxResults);
    if (mode === 'names') {
      return { results: nameResults.slice(0, maxResults), truncated: false };
    }

    const { results: contentResults, sourcesIncomplete } = await this.contentFanOut(q, maxResults);

    const merged = this.merge([...nameResults, ...contentResults], maxResults);
    return {
      results: merged,
      truncated: sourcesIncomplete || merged.length < nameResults.length + contentResults.length,
      sourcesIncomplete,
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
      /** Skip this many merged results — the tool cursor. */
      offset?: number;
      /** Keep only results under this forward-slashed path prefix. */
      pathPrefix?: string;
      /** Answer from the keyword arms rather than wait for a cold embedder. */
      skipColdEmbedder?: boolean;
    },
  ): Promise<{
    results: UnifiedSearchResult[];
    truncated: boolean;
    sourcesIncomplete?: boolean;
    /** Per-arm timing/outcome telemetry from the fan-out (non-content). */
    arms?: RetrievalArmTiming[];
  }> {
    const q = query.trim();
    if (!q || opts.projectIds.length === 0) return { results: [], truncated: false };
    const maxResults = opts.maxResults ?? DEFAULT_MAX_RESULTS;
    const offset = opts.offset ?? 0;
    const fetchDepth = offset + maxResults;
    const found = await this.contentFanOut(q, fetchDepth, {
      projectIds: new Set(opts.projectIds),
      ...(opts.gezelId ? { gezelId: opts.gezelId } : {}),
      includeShared: opts.includeShared !== false,
      ...(opts.sources ? { sources: new Set(opts.sources) } : {}),
      ...(opts.projectIds[0] ? { primaryProjectId: opts.projectIds[0] } : {}),
      ...(opts.skipColdEmbedder ? { skipColdEmbedder: true } : {}),
      // Scale per-source fetch with paging depth so page 2 has material to
      // page into; identical to PER_SOURCE_RESULTS at offset 0.
      perSourceResults: Math.min(25, Math.max(PER_SOURCE_RESULTS, Math.ceil(fetchDepth / 6))),
    });
    const prefix = normalizePathPrefix(opts.pathPrefix);
    const pool = prefix
      ? found.results.filter((r) => {
          if (!r.path) return false; // a path filter asks for files
          if (r.path.startsWith(prefix)) return true;
          // Models see linked-project paths as ../<project-id>/<path>.
          return Boolean(r.projectId && `../${r.projectId}/${r.path}`.startsWith(prefix));
        })
      : found.results;
    // Merge one past the page boundary so "more exists" is a fact, not a guess.
    const merged = this.merge(pool, fetchDepth + 1);
    const results = merged.slice(offset, fetchDepth);
    return {
      results,
      truncated: found.sourcesIncomplete || merged.length > fetchDepth,
      sourcesIncomplete: found.sourcesIncomplete,
      arms: found.arms,
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
    const [projects, gezels, documents, tasks, craftbooks, handboek, mail] = await Promise.all([
      this.store.listProjects().catch(() => []),
      this.store.listGezels().catch(() => []),
      this.store.listDocumentsRecursive().catch(() => []),
      Promise.resolve()
        .then(() => this.store.listAllTasks())
        .catch(() => []),
      this.extraCatalogs.craftbookEntries?.().catch(() => []) ?? Promise.resolve([]),
      this.extraCatalogs.handboekEntries?.().catch(() => []) ?? Promise.resolve([]),
      this.extraCatalogs.mailEntries?.().catch(() => []) ?? Promise.resolve([]),
    ]);
    const projectNameById = new Map(projects.map((p) => [p.id, p.name]));

    for (const t of tasks) {
      entries.push({
        kind: 'task',
        id: `task:${t.projectId}/${t.num}`,
        title: t.title,
        subtitle: `Task · ${projectNameById.get(t.projectId) ?? t.projectId} · ${t.status}`,
        projectId: t.projectId,
        ...(projectNameById.has(t.projectId)
          ? { projectName: projectNameById.get(t.projectId)! }
          : {}),
      });
    }
    for (const c of craftbooks) {
      entries.push({
        kind: 'craftbook',
        id: `craftbook:${c.source}:${c.id}`,
        title: c.name,
        subtitle: `Craftbook · ${c.source === 'bundled' ? 'Gilde' : c.source}`,
      });
    }
    for (const h of handboek) {
      entries.push({
        kind: 'handboek',
        id: `handboek:${h.id}`,
        title: h.title,
        subtitle: 'Handboek',
        ...(h.keywords && h.keywords.length > 0 ? { keywords: h.keywords } : {}),
      });
    }
    for (const m of mail) {
      entries.push({
        kind: 'mail',
        id: `mail:${m.projectId}:${m.path}`,
        title: m.subject,
        subtitle: `${m.from} · ${m.date}`,
        // Sender reachable even when the subject doesn't match the query.
        keywords: [m.from],
        path: m.path,
        projectId: m.projectId,
        ...(projectNameById.has(m.projectId)
          ? { projectName: projectNameById.get(m.projectId)! }
          : {}),
        source: 'artifacts',
      });
    }

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
        ...scoreResult(e.kind, rel),
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
      /** Per-source fetch cap override — paging scales it with depth. */
      perSourceResults?: number;
      /** The session project — resolves the knowledge-catalog policy. */
      primaryProjectId?: string;
      /**
       * Run keyword-only rather than wait for a cold/warming embedder. The
       * model load is tens of seconds on a fresh install (minutes under
       * memory pressure), and a chat turn's implicit retrieval must never
       * hold the user's message hostage for it — same rule the auto-recall
       * path follows. Explicit searches leave this off and wait.
       */
      skipColdEmbedder?: boolean;
    },
  ): Promise<{
    results: UnifiedSearchResult[];
    sourcesIncomplete: boolean;
    arms: RetrievalArmTiming[];
  }> {
    const [allProjects, allGezels] = await Promise.all([
      this.store.listProjects().catch(() => []),
      this.store.listGezels().catch(() => []),
    ]);
    const projects = scope ? allProjects.filter((p) => scope.projectIds.has(p.id)) : allProjects;
    const gezels = scope ? allGezels.filter((g) => g.id === scope.gezelId) : allGezels;
    const wants = (source: RetrievalSource): boolean =>
      !scope?.sources || scope.sources.has(source);
    const perSource = scope?.perSourceResults ?? PER_SOURCE_RESULTS;

    // Embed the query once; thread the vector into every per-project call.
    let vector: number[] | null = null;
    const embedderStatus = embeddingPipelineStatus();
    const embedderCold = embedderStatus === 'cold' || embedderStatus === 'warming';
    if (scope?.skipColdEmbedder && embedderCold) {
      // Answer from the keyword arms alone. Warming is the service's job (a
      // deferred boot warm); kicking it from here would start a model load
      // inside short-lived processes — `gezel run --standalone` boots a
      // service, answers, and exits, and an in-process load outlives it.
      log.debug(`skipping the vector arm while embeddings are ${embedderStatus}`);
    } else {
      try {
        vector = await embedQuery(query);
      } catch {
        vector = null; // embeddings disabled → keyword/FTS only, no memory hits
      }
    }

    // A scope that blows its per-scope budget means the results genuinely
    // under-represent the corpus — distinct from caps/dedupe truncation.
    let sourcesIncomplete = false;

    // Per-arm timing/outcome telemetry. Every arm is caught-to-null below,
    // so without this a failing arm is indistinguishable from an empty one.
    const armTimings: RetrievalArmTiming[] = [];
    const timed = async <T>(
      arm: string,
      scopeId: string | undefined,
      count: (r: T) => number,
      run: () => Promise<T>,
    ): Promise<T | null> => {
      const started = performance.now();
      const base = { arm, ...(scopeId ? { scope: scopeId } : {}) };
      try {
        const r = await run();
        armTimings.push({
          ...base,
          ms: Math.round(performance.now() - started),
          hits: count(r),
          timedOut: false,
          failed: false,
        });
        return r;
      } catch {
        armTimings.push({
          ...base,
          ms: Math.round(performance.now() - started),
          hits: 0,
          timedOut: false,
          failed: true,
        });
        return null;
      }
    };

    // One pool unit per project: code + docs + symbols + project memory.
    const perProject = projects.map((p) => ({
      label: `project:${p.id}`,
      run: async () => {
        const out: UnifiedSearchResult[] = [];
        // The shared library has its own arm below, emitting `document` rows.
        // Running it here too would list every document a second time as
        // project content.
        if (isSharedLibraryProject(p)) return out;
        const workspaceIndexing = p.indexingEnabled !== false;
        const codeOpts = vector
          ? { queryVector: vector, maxResults: perSource }
          : { mode: 'keyword' as const, maxResults: perSource };
        const [code, docs, artifacts, symbols, areas, mem] = await Promise.all([
          workspaceIndexing && wants('workspace')
            ? timed(
                'workspace:code',
                p.id,
                (r) => r?.results.length ?? 0,
                () => this.contentIndex.searchCode(p.id, query, codeOpts),
              )
            : Promise.resolve(null),
          workspaceIndexing && wants('workspace')
            ? timed(
                'workspace:docs',
                p.id,
                (r) => r?.results.length ?? 0,
                () => this.contentIndex.searchDocs(p.id, query, perSource),
              )
            : Promise.resolve(null),
          workspaceIndexing && wants('artifacts')
            ? timed(
                'artifacts',
                p.id,
                (r) => r?.results.length ?? 0,
                () => this.contentIndex.searchArtifacts(p.id, query, perSource),
              )
            : Promise.resolve(null),
          workspaceIndexing && wants('workspace')
            ? timed(
                'workspace:symbols',
                p.id,
                (r) => r?.matches.length ?? 0,
                () => this.contentIndex.findSymbol(p.id, query, { maxResults: perSource }),
              )
            : Promise.resolve(null),
          workspaceIndexing && wants('workspace')
            ? timed(
                'workspace:areas',
                p.id,
                (r) => r?.length ?? 0,
                () => this.contentIndex.searchAreaSummaries(p.id, query, perSource),
              )
            : Promise.resolve(null),
          vector && wants('project-memory')
            ? timed(
                'project-memory',
                p.id,
                (r) => r?.length ?? 0,
                () =>
                  this.memory.searchVector('project', p.id, vector as number[], PER_MEMORY_RESULTS),
              )
            : Promise.resolve(null),
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
            ...scoreResult('content', r.score),
          });
        }
        for (const [rank, r] of (docs?.results ?? []).entries()) {
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
            ...scoreResult('content', ftsRankRelevance(rank)),
          });
        }
        for (const [rank, r] of (artifacts?.results ?? []).entries()) {
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
            ...scoreResult('content', ftsRankRelevance(rank)),
          });
        }
        for (const m of symbols?.matches ?? []) {
          const rel = fuzzyScore(query, m.name) ?? SYMBOL_FALLBACK_RELEVANCE;
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
            ...scoreResult('symbol', rel),
          });
        }
        for (const area of areas ?? []) {
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
            ...scoreResult('content', area.score),
          });
        }
        for (const r of mem ?? []) {
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
            ...scoreResult('memory', r.score),
          });
        }
        return out;
      },
    }));

    // One pool unit per gezel: gezel memory (vector-only).
    const perGezel =
      vector && wants('gezel-memory')
        ? gezels.map((g) => ({
            label: `gezel:${g.id}`,
            run: async () => {
              const mem =
                (await timed(
                  'gezel-memory',
                  g.id,
                  (r) => r?.length ?? 0,
                  () =>
                    this.memory.searchVector('gezel', g.id, vector as number[], PER_MEMORY_RESULTS),
                )) ?? [];
              return mem
                .filter((r) => r.score >= MEMORY_MIN_SIMILARITY)
                .map((r) => ({
                  kind: 'memory' as const,
                  id: `memory:gezel:${g.id}:${r.day}:${hashText(r.text)}`,
                  title: r.text.slice(0, 80),
                  subtitle: `Memory · ${g.name}`,
                  snippet: r.text,
                  retrievalSource: 'gezel-memory' as const,
                  ...scoreResult('memory', r.score),
                }));
            },
          }))
        : [];

    // Global collections (session transcripts + documents content) — one task
    // each, not per-project: the global index answers across all scopes in a
    // single FTS query.
    const globalTasks: Array<{ label: string; run: () => Promise<UnifiedSearchResult[]> }> = [];
    const globalIndex = this.globalIndex;
    if (globalIndex && !scope) {
      const projectNames = new Map(projects.map((p) => [p.id, p.name]));
      const gezelNames = new Map(gezels.map((g) => [g.id, g.name]));
      globalTasks.push({
        label: 'sessions',
        run: async () => {
          const hits =
            (await timed(
              'sessions',
              undefined,
              (r) => r?.length ?? 0,
              () => globalIndex.searchSessions(query, { maxResults: perSource }),
            )) ?? [];
          return hits.map((h, rank) => {
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
              // 1-based index of the matched message in the session — the
              // deep-link coordinate (global-index chunk lineStart semantics).
              ...(h.messageStart ? { line: h.messageStart } : {}),
              ...scoreResult('session', ftsRankRelevance(rank)),
            };
          });
        },
      });
    }
    if ((!scope || scope.includeShared) && wants('shared')) {
      globalTasks.push({
        label: 'shared',
        run: async () => {
          // The library is a project now, so its content search is the ranked
          // hybrid one. It is emitted as `document` rather than `content` so a
          // library hit keeps its global provenance wherever it surfaces.
          const libraryId = await this.store.sharedProjectId().catch(() => null);
          if (!libraryId) return [];
          const found = await timed(
            'shared',
            undefined,
            (r) => r?.results.length ?? 0,
            () =>
              this.contentIndex.searchLibrary(libraryId, query, {
                maxResults: perSource,
                ...(vector ? { queryVector: vector } : {}),
              }),
          );
          return (found?.results ?? []).map((h, rank) => ({
            kind: 'document' as const,
            id: `document:${h.path}`,
            title: basename(h.path),
            subtitle: `Shared library · ${h.path}`,
            snippet: h.snippet,
            path: h.path,
            retrievalSource: 'shared' as const,
            line: h.lineStart,
            lineEnd: h.lineEnd,
            // Hybrid score when the library index reports one; rank-based
            // pseudo-relevance for keyword-only rows.
            ...scoreResult('document', h.score ?? ftsRankRelevance(rank)),
          }));
        },
      });
    }
    if (wants('knowledge') && this.knowledgeSearch) {
      // Installed reference catalogs — one arm across every active catalog
      // (the global routing budget lives with the catalog owner). Results
      // arrive finished: provenance, citation URIs, calibrated scores.
      const knowledgeSearch = this.knowledgeSearch;
      globalTasks.push({
        label: 'knowledge',
        run: async () => {
          const hits = await timed(
            'knowledge',
            undefined,
            (r) => r?.length ?? 0,
            () =>
              knowledgeSearch.search(query, {
                vector,
                maxResults: Math.max(10, perSource * 2),
                ...(scope?.primaryProjectId ? { projectId: scope.primaryProjectId } : {}),
              }),
          );
          return hits ?? [];
        },
      });
    }

    const tasks = [...perProject, ...perGezel, ...globalTasks];
    const settled = await mapPool(tasks, FANOUT_CONCURRENCY, async (task) => {
      const res = await withTimeout(task.run(), PER_SCOPE_TIMEOUT_MS, null);
      if (res === null) {
        sourcesIncomplete = true;
        armTimings.push({
          arm: 'scope-timeout',
          scope: task.label,
          ms: PER_SCOPE_TIMEOUT_MS,
          hits: 0,
          timedOut: true,
          failed: false,
        });
      }
      return res ?? [];
    });

    return { results: settled.flat(), sourcesIncomplete, arms: armTimings };
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

/** Forward-slash and strip a leading ./ so model-supplied prefixes match index paths. */
function normalizePathPrefix(prefix: string | undefined): string | null {
  if (!prefix) return null;
  const p = prefix.replaceAll('\\', '/').replace(/^\.\//, '');
  return p.length > 0 ? p : null;
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
  // Compactness counts quadratically, and a short query counts for less than
  // a long one. A scattered subsequence is weak evidence in proportion to how
  // easy it is to hit by accident: "kim" is a subsequence of "SKILL.md", and
  // linearly-weighted it scored 0.41 — high enough for twenty-five skills
  // fixtures to tie and bury the library document that actually said Kim.
  const evidence = Math.min(1, q.length / 4);
  return Math.max(0.05, (0.55 * compactness * compactness + 0.15 * earliness) * evidence);
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
