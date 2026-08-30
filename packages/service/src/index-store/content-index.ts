import { existsSync } from 'node:fs';
import { readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  BoekwachterIssue,
  BoekwachterIssueDismissalReason,
  BoekwachterIssueStatus,
  DescribeFolderResponse,
  FileContextFinding,
  FileContextResponse,
  FileMapRequest,
  FileMapResponse,
  FileReviewIssueSeverity,
  FileReviewResponse,
  FileReviewWire,
  FindEntityResponse,
  FindSimilarImagesResponse,
  FindSymbolResponse,
  ImageRegion,
  ListDependenciesResponse,
  ListEntityMentionsResponse,
  ListFileIssuesRequest,
  ListFileIssuesResponse,
  ListPeopleResponse,
  MapAttackSurfaceResponse,
  MapRepoResponse,
  OutlineFileResponse,
  ReadDocAsMarkdownResponse,
  ReadSymbolResponse,
  ScanFindingsRequest,
  ScanFindingsResponse,
  SearchCodeResponse,
  SearchDocsResponse,
  SearchDocumentsResponse,
  SearchImagesResponse,
  SecurityFindingWire,
  SecurityOverviewResponse,
  SecurityScanProvenance,
  SecurityScanResponse,
  SymbolContext,
  TraceTaintResponse,
} from '@bendyline/gezel';
import {
  SecurityScanProvenanceSchema,
  createLogger,
  isSharedLibraryProject,
  nowIso,
  projectAllowsWorkspaceTables,
} from '@bendyline/gezel';
import {
  fallbackProjectIndexDir,
  fallbackProjectVillageFile,
  projectArtifactsIndexDbFile,
  projectContentIndexDbFile,
  projectLocalFilesDir,
  projectLocalIndexDbFile,
  projectLocalVillageFile,
  projectStorageScope,
} from '@bendyline/gezel/paths';
import {
  resolveImportEdges,
  resolveImportEdgesDetailed,
  resolveSpecifier,
} from '../filemap/affinity.js';
import { buildFileMap } from '../filemap/build.js';
import { VillageFileStore } from '../filemap/village-file.js';
import { safeJoin } from '../fs/safe-paths.js';
import type { ProjectBoekwachterIssueRecord, Store } from '../fs/store.js';
import type {
  FaceDetectOutcome,
  FaceModelPaths,
  ImageEmbedJob,
  ImageEmbedOutcome,
} from '../memory/image-embeddings.js';
import { IMAGE_EMBED_EXTS } from '../memory/image-pixels.js';
import type { DuckRunner } from '../observations/duck.js';
import {
  type DrainResult,
  NIGHT_MAX_INLINE_BYTES,
  NIGHT_MAX_TABLES_PER_DRAIN,
  drainWorkspaceTables,
} from '../observations/workspace-drain.js';
import { runSecurityScan } from '../security/scan.js';
import { type AiShadowDeps, aiShadowFile } from './ai-shadow.js';
import { ARCHITECTURE_KEY, type AreaPassResult, runAreaPass } from './area-pass.js';
import {
  type ArtifactsIndexStats,
  artifactsCollectionId,
  indexProjectArtifacts,
} from './artifacts-indexer.js';
import { classifyFile } from './classify.js';
import type { ContentIndexStats } from './content-indexer.js';
import { ensureShadowDocSidecar, isConvertibleDoc, shadowDocFilesPaths } from './docs.js';
import { type EnrichDeps, embedOnlyFile, enrichFile } from './enrich.js';
import { buildEntitiesFromMetadata } from './entities.js';
import { ensureFaceModels, installedFaceModels } from './face/catalog.js';
import { clusterNewFaces, mergeFaceClusters, syncPersonEntities } from './face/clustering.js';
import { refreshGitStats } from './git-stats.js';
import { ensureIndexGitignore } from './gitignore.js';
import {
  type FileReviewRow,
  IndexStore,
  type SecurityFindingRow,
  type SecuritySeverity,
  type SymbolHit,
} from './index-store.js';
import { MAX_REVIEW_ATTEMPTS, reviewFile } from './review.js';
import { type ResolvedRubric, resolveRubrics } from './rubrics.js';
import { isTransientIndexError } from './sqlite-driver.js';
import { runStaticIndex } from './static-index-runner.js';
import { extractCodeSymbols, extractMarkdownOutline, isCodeLangSupported } from './symbols.js';

/**
 * Service-side façade over the per-project content `IndexStore`. Owns nothing
 * long-lived: each call opens the collection's `index.db`, queries, and closes
 * (node:sqlite open is cheap; WAL lets reads run alongside the indexer's
 * writes). Backs the `code-intel` MCP tools and is driven by the workspace
 * indexer's `refresh`.
 *
 * Read tools degrade gracefully: when the index is empty/unbuilt, `outline_file`
 * and `read_symbol` fall back to on-demand extraction from disk so they're
 * useful before the first full scan; `find_symbol`/`map_repo` report
 * `engine: 'unavailable'` / `indexed: false`.
 */

const MAX_READ_BYTES = 2 * 1024 * 1024;

/**
 * Debounce for artifacts-corpus refreshes: a connector pass fires one
 * fire-and-forget refresh per binding, and a project can sync several
 * bindings back to back — collapsing them buys one walk per burst.
 */

const log = createLogger('index');
const ARTIFACTS_REFRESH_DEBOUNCE_MS = 5_000;

/** Mirror of the `filesNeedingReview` SQL predicate's modality filter. */
const REVIEWABLE_MODALITIES: ReadonlySet<string> = new Set(['code', 'text', 'doc']);

// file-context caps — keep worst-case responses small and bounded.
const CTX_MAX_SYMBOLS = 200;
const CTX_MAX_IMPORTED_BY_PER_SYMBOL = 25;
const CTX_MAX_FILE_IMPORTED_BY = 100;
const CTX_MAX_USES = 50;
const CTX_MAX_USED_IN_FILE_BY = 50;

/**
 * Run `fn` over a work source keeping up to `width()` calls in flight. The
 * source is either a fixed array or a pull supplier (`undefined` = no more
 * work) — the supplier form lets a caller re-query its work-list as slots
 * open, so the pool never drains to zero between what used to be fixed
 * batches. Width is re-read as slots free, so a lazily-initialized provider
 * (reporting 1 until its first call spins it up) widens mid-batch. `stop`
 * halts NEW dispatches; in-flight calls always finish. sqlite writes inside
 * `fn` stay safe under this interleaving: the driver is synchronous, so
 * statements never actually overlap — only the awaited model calls do.
 */
async function runPooled<T>(
  source: readonly T[] | (() => Promise<T | undefined> | T | undefined),
  width: () => number,
  fn: (item: T) => Promise<void>,
  stop?: () => boolean,
): Promise<void> {
  let next: () => Promise<T | undefined> | T | undefined;
  if (typeof source === 'function') {
    next = source;
  } else {
    let i = 0;
    next = () => (i < source.length ? (source[i++] as T) : undefined);
  }
  const state: { failure: { error: unknown } | null } = { failure: null };
  const active = new Set<Promise<void>>();
  let exhausted = false;
  const dispatch = async () => {
    while (
      !exhausted &&
      active.size < Math.max(1, width()) &&
      !stop?.() &&
      state.failure === null
    ) {
      const item = await next();
      if (item === undefined) {
        exhausted = true;
        break;
      }
      const p: Promise<void> = fn(item)
        .catch((error) => {
          state.failure ??= { error };
        })
        .finally(() => active.delete(p));
      active.add(p);
    }
  };
  await dispatch();
  while (active.size > 0) {
    await Promise.race(active);
    await dispatch();
  }
  if (state.failure) throw state.failure.error;
}

/**
 * Pool options for the AI passes. `concurrency` is the live width of the
 * summarizer target's queue (full drives pass it; background stays serial).
 * `drain` switches a call from "one fixed batch" to "run to empty": the
 * work-list is re-queried as slots open so the pool never sits idle at a
 * batch tail. `shouldStop` (the indexing job's pause switch) is checked and
 * `onProgress` fired at each refill — the same cadence the caller's old
 * per-batch loop provided.
 */
export interface EnrichDriveOpts {
  concurrency?: () => number;
  drain?: {
    shouldStop?: () => Promise<boolean> | boolean;
    onProgress?: (progress: { files: number }) => void;
  };
}

export class ContentIndex {
  /** Per-project village-file stores (they cache last-written content so
   *  no-change builds skip touching the user's repo). */
  private readonly cityStores = new Map<string, VillageFileStore>();

  /** Debounce window for {@link refreshArtifacts}; tests shrink it. */
  private readonly artifactsDebounceMs: number;
  /** Per-project pending artifacts pass — calls within the window join it. */
  private readonly artifactsRefreshPending = new Map<string, Promise<ArtifactsIndexStats | null>>();
  /** Per-project settle of the last dispatched pass, so passes never overlap. */
  private readonly artifactsRefreshLast = new Map<string, Promise<unknown>>();

  /**
   * Late-bound because the query engine is constructed after the index in boot
   * order, and because a build with no engine installed must still index — the
   * drain simply reports nothing converted and picks the files up later.
   */
  private duck: DuckRunner | null = null;

  constructor(
    private readonly store: Store,
    private readonly home: string,
    opts: { artifactsDebounceMs?: number } = {},
  ) {
    this.artifactsDebounceMs = opts.artifactsDebounceMs ?? ARTIFACTS_REFRESH_DEBOUNCE_MS;
  }

  /** Give the index the engine it needs to derive tables from data files. */
  setDuckRunner(duck: DuckRunner): void {
    this.duck = duck;
  }

  private cityStoreFor(projectId: string, workspaceDir: string | null): VillageFileStore {
    let cs = this.cityStores.get(projectId);
    if (!cs) {
      cs = new VillageFileStore({
        workspaceDir,
        primaryPath: workspaceDir ? projectLocalVillageFile(workspaceDir) : null,
        fallbackPath: fallbackProjectVillageFile(this.home, projectId),
      });
      this.cityStores.set(projectId, cs);
    }
    return cs;
  }

  /** Bring the project's content index up to date. Called by the indexer tick. */
  async refresh(projectId: string): Promise<ContentIndexStats | null> {
    if (!(await this.store.projectIndexingEnabled(projectId).catch(() => true))) return null;
    const opened = await this.open(projectId);
    if (!opened) return null;
    const { workspaceDir, artifactsDir, dbPath, isLibrary } = opened;
    try {
      // The library keeps its database home-side, so there is no in-workspace
      // `.gezel/` to ignore — and writing one into the user's documents
      // folder is exactly what that placement avoids.
      if (!isLibrary && projectStorageScope(this.home, projectId) !== 'machine-shared') {
        await ensureIndexGitignore(workspaceDir);
      }
    } finally {
      // The worker owns the only open connection while it writes. Keeping a
      // parent connection alive is unnecessary and makes SQLite lock behavior
      // platform-dependent.
      opened.index.close();
    }

    const stats = await runStaticIndex({
      dbPath,
      workspaceDir,
      artifactsDir,
      collectionId: projectId,
      ...(isLibrary ? { scope: 'library' as const } : {}),
    });
    if (!isLibrary && projectStorageScope(this.home, projectId) !== 'machine-shared') {
      // Conversions now live under artifacts/shadow; the old in-workspace
      // cache is stranded stale content and doubled disk. Regenerable and
      // deny-all-gitignored, so removal is safe. Machine-shared workspaces are
      // skipped: an older daemon on another account would recreate the tree,
      // and cross-daemon churn is worse than a stale cache.
      await rm(projectLocalFilesDir(workspaceDir), { recursive: true, force: true }).catch(
        () => {},
      );
    }
    const post = await this.open(projectId);
    if (!post) return stats;
    try {
      // Scanner rows are rebuildable; lifecycle is durable Store state. A
      // completed refresh prunes lifecycle for findings that truly vanished,
      // then mirrors the surviving states back into SQLite for fast queries.
      await this.syncFindingLifecycle(projectId, post.index, true);
      // Deterministic meta-boekwachter: rebuild entities from the metadata the
      // scan just refreshed (cheap; no model).
      buildEntitiesFromMetadata(post.index);
      // Git churn/last-commit for the map's signals — before the map build so
      // the same tick that ingests churn also refreshes the persisted map.
      // Never throws; degrades to 'unavailable' without git.
      await refreshGitStats(post.index, workspaceDir);
      // Data files the pass just enrolled become queryable tables. Runs here,
      // after the worker, because the conversion spawns a DuckDB child and the
      // static pass executes inside a worker thread. Never throws: an
      // unreadable CSV must not take down the index pass around it.
      // Both halves of the user's gate: the project-wide indexing opt-out the
      // enrichment manager already honours, and the per-feature one.
      //
      // A project we cannot read is skipped rather than assumed permissive:
      // deriving tables spends CPU and disk, and doing that for a project
      // whose settings are unreadable is the wrong way to be wrong. The drain
      // is idempotent, so the next pass picks the work up.
      //
      // Wrapped rather than `.catch`ed because a Store that lacks the method
      // throws synchronously, which no promise catch would see.
      let tablesAllowed = false;
      try {
        const meta = await this.store.getProject(projectId);
        tablesAllowed =
          meta != null && meta.indexingEnabled !== false && projectAllowsWorkspaceTables(meta);
      } catch {
        tablesAllowed = false;
      }
      if (this.duck && tablesAllowed) {
        await drainWorkspaceTables({
          store: post.index,
          duck: this.duck,
          storageDir: this.store.projectArtifactsDir(projectId),
          workspaceDir,
        }).catch((err) => {
          log.warn(`[index] derived-table drain failed for ${projectId}: ${String(err)}`);
        });
      }
      // Refresh the persisted city-map layout so it grows with the code. Failure
      // here must not break indexing — the map is a derived, regenerable view.
      try {
        await buildFileMap(post.index, workspaceDir, {
          persist: true,
          villageFile: this.cityStoreFor(projectId, workspaceDir),
          userFacing: false,
        });
      } catch {
        /* layout build is best-effort */
      }
      return stats;
    } finally {
      post.index.close();
    }
  }

  async outlineFile(projectId: string, relPath: string): Promise<OutlineFileResponse> {
    const opened = await this.open(projectId);
    if (!opened) {
      return {
        path: relPath,
        lang: null,
        symbols: [],
        totalLines: 0,
        engine: 'unavailable',
        truncated: false,
      };
    }
    const { index, workspaceDir } = opened;
    try {
      const abs = safeJoin(workspaceDir, relPath);
      const content = abs ? await readFile(abs, 'utf8').catch(() => null) : null;
      const totalLines = content ? content.split(/\r?\n/).length : 0;

      const fileRec = index.getFile(relPath);
      let symbols = index.symbolsForFile(relPath).map(toSym);
      let engine: 'index' | 'live' = 'index';
      let lang = fileRec?.lang ?? null;
      const summary = fileRec?.hash ? (index.getSummary(fileRec.hash) ?? null) : null;
      // Hash-keyed lookup: an edited file never serves a stale review.
      const review = fileRec?.hash ? index.getFileReview(fileRec.hash) : undefined;

      if (symbols.length === 0 && content != null) {
        const cls = classifyFile(relPath, Buffer.byteLength(content));
        lang = cls.lang;
        if (cls.kind === 'code' && isCodeLangSupported(cls.lang)) {
          const live = await extractCodeSymbols(cls.lang!, content);
          if (live) {
            symbols = live.map((s) => toSym({ ...s, id: `${relPath}#${s.name}` }));
            engine = 'live';
          }
        } else if (cls.kind === 'markdown') {
          symbols = extractMarkdownOutline(content).map((s) =>
            toSym({ ...s, id: `${relPath}#${s.name}` }),
          );
          engine = 'live';
        }
      }

      return {
        path: relPath,
        lang,
        summary,
        symbols,
        totalLines,
        engine,
        truncated: false,
        ...(review ? { review: toReviewWire(review) } : {}),
      };
    } finally {
      index.close();
    }
  }

  /**
   * Per-symbol intelligence for one file — the file viewer's context sections.
   * Structured facts only (hosts compose markdown): inbound importers via
   * named-binding matching, outbound `uses` + within-file `usedInFileBy` via a
   * single lexical identifier pass (honest, same stance as find-references),
   * findings assigned to the innermost containing symbol, and any LLM
   * one-liners the enrichment pass has produced for this content hash.
   */
  async fileContext(projectId: string, relPath: string): Promise<FileContextResponse> {
    const empty: FileContextResponse = {
      path: relPath,
      lang: null,
      totalLines: 0,
      summary: null,
      importedBy: [],
      importedByTruncated: false,
      imports: [],
      fileFindings: [],
      symbols: [],
      symbolsTruncated: false,
      engine: 'unavailable',
    };
    const opened = await this.open(projectId);
    if (!opened) return empty;
    const { index, workspaceDir } = opened;
    try {
      const abs = safeJoin(workspaceDir, relPath);
      const content = abs ? await readFile(abs, 'utf8').catch(() => null) : null;
      const lines = content ? content.split(/\r?\n/) : [];
      const totalLines = lines.length;

      const fileRec = index.getFile(relPath);
      let lang = fileRec?.lang ?? null;
      const summary = fileRec?.hash ? (index.getSummary(fileRec.hash) ?? null) : null;

      let engine: 'index' | 'live' = 'index';
      let symbolRows = index.symbolsForFile(relPath);
      if (symbolRows.length === 0 && content != null) {
        const cls = classifyFile(relPath, Buffer.byteLength(content));
        lang = lang ?? cls.lang;
        if (cls.kind === 'code' && isCodeLangSupported(cls.lang)) {
          const live = await extractCodeSymbols(cls.lang!, content);
          if (live?.length) {
            symbolRows = live.map((s) => ({
              ...s,
              id: `${relPath}#${s.name}`,
              filePath: relPath,
              signature: s.signature ?? '',
            }));
            engine = 'live';
          }
        }
      }
      const symbolsTruncated = symbolRows.length > CTX_MAX_SYMBOLS;
      const picked = symbolRows.slice(0, CTX_MAX_SYMBOLS);

      // One identifier pass over the file: identifier → 1-based lines mentioning it.
      const refLines = new Map<string, number[]>();
      for (let i = 0; i < lines.length; i++) {
        for (const m of lines[i]!.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)) {
          const arr = refLines.get(m[0]);
          if (arr) arr.push(i + 1);
          else refLines.set(m[0], [i + 1]);
        }
      }

      // Innermost symbol containing a line (smallest range wins), memoized.
      const containerCache = new Map<number, SymbolHit | null>();
      const innermostAt = (line: number): SymbolHit | null => {
        const hit = containerCache.get(line);
        if (hit !== undefined) return hit;
        let best: SymbolHit | null = null;
        for (const s of picked) {
          if (line < s.lineStart || line > s.lineEnd) continue;
          if (!best || s.lineEnd - s.lineStart < best.lineEnd - best.lineStart) best = s;
        }
        containerCache.set(line, best);
        return best;
      };

      // Dependency edges — inbound (who imports this file, with bindings) and
      // this file's own outbound rows.
      const allPaths = index.allFilePaths();
      const pathSet = new Set(allPaths);
      const inbound = resolveImportEdgesDetailed(allPaths, index.allImportsWithBindings()).filter(
        (e) => e.dst === relPath,
      );
      inbound.sort((a, b) => a.src.localeCompare(b.src));

      const outboundRows = index.importsForFile(relPath);
      const imports = outboundRows
        .map((r) => ({
          specifier: r.raw,
          resolvedPath: resolveSpecifier(relPath, r.raw, pathSet),
          names: r.bindings?.filter((b) => b.kind === 'named').map((b) => b.name) ?? [],
          default: r.bindings?.some((b) => b.kind === 'default') ?? false,
          namespace: r.bindings === null || r.bindings.some((b) => b.kind === 'namespace'),
        }))
        .sort((a, b) => a.specifier.localeCompare(b.specifier));

      // local identifier → where it comes from, for per-symbol `uses`.
      const localOrigins = new Map<string, { from: string; inRepo: boolean }>();
      for (const r of outboundRows) {
        const resolved = resolveSpecifier(relPath, r.raw, pathSet);
        for (const b of r.bindings ?? []) {
          if (b.local === '*' || localOrigins.has(b.local)) continue;
          localOrigins.set(b.local, { from: resolved ?? r.raw, inRepo: resolved != null });
        }
      }

      const findings = index.securityFindingsForFile(relPath);
      const summariesByName = fileRec?.hash
        ? index.symbolSummariesFor(relPath, fileRec.hash)
        : new Map<string, string>();

      const inRange = (line: number, s: SymbolHit): boolean =>
        line >= s.lineStart && line <= s.lineEnd;

      const symbols: SymbolContext[] = picked.map((s) => {
        const viaBinding: string[] = [];
        const wholeFile: string[] = [];
        for (const e of inbound) {
          if (e.bindings?.some((b) => b.kind === 'named' && b.name === s.name)) {
            viaBinding.push(e.src);
          } else if (
            e.bindings === null ||
            e.bindings.some((b) => b.kind === 'default' || b.kind === 'namespace')
          ) {
            wholeFile.push(e.src);
          }
        }
        const importers = [
          ...viaBinding.map((path) => ({ path, viaBinding: true })),
          ...wholeFile.map((path) => ({ path, viaBinding: false })),
        ];

        const uses: SymbolContext['uses'] = [];
        for (const [local, origin] of localOrigins) {
          if (uses.length >= CTX_MAX_USES) break;
          if (refLines.get(local)?.some((line) => inRange(line, s))) {
            uses.push({ name: local, from: origin.from, inRepo: origin.inRepo });
          }
        }

        const usedBy = new Set<string>();
        for (const line of refLines.get(s.name) ?? []) {
          if (usedBy.size >= CTX_MAX_USED_IN_FILE_BY) break;
          if (inRange(line, s)) continue;
          const container = innermostAt(line);
          if (container && container.name !== s.name) usedBy.add(container.name);
        }

        const own = findings.filter((f) => f.line != null && innermostAt(f.line) === s);
        const oneLiner = summariesByName.get(s.name);
        return {
          name: s.name,
          kind: s.kind,
          lineStart: s.lineStart,
          lineEnd: s.lineEnd,
          ...(s.signature ? { signature: s.signature } : {}),
          ...(s.parent ? { parent: s.parent } : {}),
          importedBy: importers.slice(0, CTX_MAX_IMPORTED_BY_PER_SYMBOL),
          importedByTruncated: importers.length > CTX_MAX_IMPORTED_BY_PER_SYMBOL,
          uses,
          usedInFileBy: [...usedBy],
          findings: own.map(toContextFinding),
          ...(oneLiner ? { summary: oneLiner } : {}),
        };
      });

      const fileFindings = findings
        .filter((f) => f.line == null || innermostAt(f.line) == null)
        .map(toContextFinding);

      const review = fileRec?.hash ? index.getFileReview(fileRec.hash) : undefined;

      return {
        path: relPath,
        lang,
        totalLines,
        summary,
        importedBy: inbound.slice(0, CTX_MAX_FILE_IMPORTED_BY).map((e) => ({
          path: e.src,
          names: e.bindings?.filter((b) => b.kind === 'named').map((b) => b.name) ?? [],
        })),
        importedByTruncated: inbound.length > CTX_MAX_FILE_IMPORTED_BY,
        imports,
        fileFindings,
        symbols,
        symbolsTruncated,
        engine,
        ...(review ? { review: toReviewWire(review) } : {}),
      };
    } finally {
      index.close();
    }
  }

  async findSymbol(
    projectId: string,
    name: string,
    opts: { kind?: string; maxResults?: number } = {},
  ): Promise<FindSymbolResponse> {
    const opened = await this.open(projectId);
    if (!opened) return { matches: [], truncated: false, engine: 'unavailable' };
    try {
      const limit = opts.maxResults ?? 50;
      const hits = opened.index.searchSymbols({
        name,
        ...(opts.kind ? { kind: opts.kind } : {}),
        limit: limit + 1,
      });
      const truncated = hits.length > limit;
      return {
        matches: hits.slice(0, limit).map((h) => ({ ...toSym(h), path: h.filePath })),
        truncated,
        engine: 'index',
      };
    } finally {
      opened.index.close();
    }
  }

  async readSymbol(projectId: string, name: string, path?: string): Promise<ReadSymbolResponse> {
    const opened = await this.open(projectId);
    if (!opened) return { found: false };
    const { index, workspaceDir } = opened;
    try {
      let hit: SymbolHit | undefined;
      if (path) {
        hit = index.symbolsForFile(path).find((s) => s.name === name);
      } else {
        hit = index.searchSymbols({ name, limit: 1 })[0];
      }

      // Live fallback when a path is given but the index has nothing yet.
      if (!hit && path) {
        const abs = safeJoin(workspaceDir, path);
        const content = abs ? await readFile(abs, 'utf8').catch(() => null) : null;
        if (content != null) {
          const cls = classifyFile(path, Buffer.byteLength(content));
          const live =
            cls.kind === 'code' && isCodeLangSupported(cls.lang)
              ? await extractCodeSymbols(cls.lang!, content)
              : cls.kind === 'markdown'
                ? extractMarkdownOutline(content)
                : null;
          const found = live?.find((s) => s.name === name);
          if (found) {
            return readSpan(
              content,
              path,
              name,
              found.kind,
              found.lineStart,
              found.lineEnd,
              found.signature,
            );
          }
        }
      }

      if (!hit) return { found: false };
      const abs = safeJoin(workspaceDir, hit.filePath);
      const content = abs ? await readFile(abs, 'utf8').catch(() => null) : null;
      if (content == null) {
        return {
          found: true,
          path: hit.filePath,
          name: hit.name,
          kind: hit.kind,
          lineStart: hit.lineStart,
          lineEnd: hit.lineEnd,
          signature: hit.signature,
        };
      }
      return readSpan(
        content,
        hit.filePath,
        hit.name,
        hit.kind,
        hit.lineStart,
        hit.lineEnd,
        hit.signature,
      );
    } finally {
      index.close();
    }
  }

  async mapRepo(projectId: string): Promise<MapRepoResponse> {
    const opened = await this.open(projectId);
    if (!opened) {
      return {
        root: '',
        languages: [],
        areas: [],
        entryPoints: [],
        keyFiles: [],
        fileCount: 0,
        indexed: false,
      };
    }
    const { index, workspaceDir } = opened;
    try {
      const files = index.allFiles();
      const langCounts = new Map<string, number>();
      const areaCounts = new Map<string, number>();
      const entryPoints: string[] = [];
      const keyFiles: string[] = [];
      const KEY =
        /^(package\.json|readme(\.md)?|cargo\.toml|pyproject\.toml|go\.mod|makefile|dockerfile|tsconfig\.json)$/i;
      const ENTRY = /(^|\/)(index|main|app|server|cli)\.(ts|tsx|js|mjs|py|go|rs)$/i;

      for (const f of files) {
        if (f.lang) langCounts.set(f.lang, (langCounts.get(f.lang) ?? 0) + 1);
        const top = f.path.includes('/') ? f.path.slice(0, f.path.indexOf('/')) : '.';
        areaCounts.set(top, (areaCounts.get(top) ?? 0) + 1);
        const base = f.path.slice(f.path.lastIndexOf('/') + 1);
        if (KEY.test(base)) keyFiles.push(f.path);
        if (ENTRY.test(f.path)) entryPoints.push(f.path);
      }

      const areaSummaries = new Map(index.allAreaSummaries().map((a) => [a.areaPath, a.summaryMd]));
      const architecture = areaSummaries.get(ARCHITECTURE_KEY);

      // Review-pass rollup — aggregates only; omitted until any file is
      // reviewed (same optionality stance as `architecture`).
      const rubrics = await resolveRubrics(this.store);
      const rollup = rubrics.size > 0 ? index.reviewRollup(rubricKeys(rubrics)) : null;

      return {
        root: workspaceDir,
        languages: [...langCounts.entries()]
          .map(([lang, fileCount]) => ({ lang, fileCount }))
          .sort((a, b) => b.fileCount - a.fileCount),
        areas: [...areaCounts.entries()]
          .map(([path, fileCount]) => {
            const purpose = areaSummaries.get(path);
            return { path, fileCount, ...(purpose ? { purpose } : {}) };
          })
          .sort((a, b) => b.fileCount - a.fileCount)
          .slice(0, 50),
        entryPoints: entryPoints.slice(0, 25),
        keyFiles: keyFiles.slice(0, 25),
        fileCount: files.length,
        indexed: files.length > 0,
        ...(architecture ? { architecture } : {}),
        ...(rollup && rollup.reviewedFiles > 0
          ? {
              health: {
                reviewedFiles: rollup.reviewedFiles,
                eligibleFiles: rollup.eligibleFiles,
                avgHealth: rollup.avgHealth,
                majorIssues: rollup.issueCounts.major,
                minorIssues: rollup.issueCounts.minor,
                worstFiles: rollup.worstFiles,
              },
            }
          : {}),
      };
    } finally {
      index.close();
    }
  }

  // ── security-intel (static security analysis over the index) ─────────────

  /** Run the on-demand whole-repo scan (dependency inventory + opportunistic OSS tools). */
  async securityScan(
    projectId: string,
    opts: { useExternalTools?: boolean } = {},
  ): Promise<SecurityScanResponse> {
    const opened = await this.open(projectId);
    if (!opened) {
      return {
        ran: false,
        engines: [],
        toolsAvailable: { semgrep: false, osvScanner: false, gitleaks: false, npm: false },
        findingCounts: EMPTY_COUNTS,
        dependencies: 0,
        advisories: 0,
      };
    }
    try {
      const r = await runSecurityScan(opened.index, opened.workspaceDir, opts);
      return { ran: true, ...r };
    } finally {
      opened.index.close();
    }
  }

  async scanFindings(projectId: string, req: ScanFindingsRequest): Promise<ScanFindingsResponse> {
    const opened = await this.open(projectId);
    if (!opened) {
      return { findings: [], counts: EMPTY_COUNTS, truncated: false, indexed: false };
    }
    const { index } = opened;
    try {
      const limit = req.maxResults ?? 200;
      const rows = index.securityFindings({
        ...(req.severity ? { severity: req.severity } : {}),
        ...(req.category ? { category: req.category } : {}),
        ...(req.source ? { source: req.source } : {}),
        ...(req.path ? { pathPrefix: req.path } : {}),
        limit: limit + 1,
      });
      return {
        findings: rows.slice(0, limit).map(toWireFinding),
        counts: index.securityFindingCounts(),
        truncated: rows.length > limit,
        indexed: index.fileCount() > 0,
      };
    } finally {
      index.close();
    }
  }

  async findingByFingerprint(
    projectId: string,
    fingerprint: string,
  ): Promise<SecurityFindingWire | null> {
    const opened = await this.open(projectId);
    if (!opened) return null;
    try {
      const row = opened.index.securityFindingByFingerprint(fingerprint);
      return row ? toWireFinding(row) : null;
    } finally {
      opened.index.close();
    }
  }

  async setFindingStatus(
    projectId: string,
    fingerprint: string,
    status: 'open' | 'in_progress' | 'resolved',
    taskRef?: string,
  ): Promise<boolean> {
    const opened = await this.open(projectId);
    if (!opened) return false;
    try {
      if (!opened.index.securityFindingByFingerprint(fingerprint)) return false;
      if (typeof this.store.setProjectFindingStatus === 'function') {
        await this.store.setProjectFindingStatus(projectId, fingerprint, status, taskRef);
      }
      return opened.index.setSecurityFindingStatus(fingerprint, status, taskRef);
    } finally {
      opened.index.close();
    }
  }

  async settleFindingsForTask(
    projectId: string,
    taskRef: string,
    outcome: 'complete' | 'canceled',
  ): Promise<number> {
    const opened = await this.open(projectId);
    if (!opened) return 0;
    try {
      const durable =
        typeof this.store.settleProjectFindingsForTask === 'function'
          ? await this.store.settleProjectFindingsForTask(projectId, taskRef, outcome)
          : 0;
      const mirrored =
        outcome === 'complete'
          ? opened.index.resolveSecurityFindingsForTask(taskRef)
          : opened.index.reopenSecurityFindingsForTask(taskRef);
      return Math.max(durable, mirrored);
    } finally {
      opened.index.close();
    }
  }

  async mapAttackSurface(projectId: string): Promise<MapAttackSurfaceResponse> {
    const opened = await this.open(projectId);
    if (!opened) {
      return {
        root: '',
        entryPoints: [],
        routes: [],
        authBoundaries: [],
        secretTouchpoints: [],
        taintSources: [],
        indexed: false,
      };
    }
    const { index, workspaceDir } = opened;
    try {
      const files = index.allFiles().map((f) => f.path);
      const surface = computeAttackSurface(files, index.securityFindings({ limit: 5000 }));
      return { root: workspaceDir, ...surface, indexed: files.length > 0 };
    } finally {
      index.close();
    }
  }

  async listDependencies(projectId: string): Promise<ListDependenciesResponse> {
    const opened = await this.open(projectId);
    if (!opened) return { dependencies: [], total: 0, withAdvisories: 0, scanned: false };
    const { index } = opened;
    try {
      const deps = index.dependencies();
      return {
        dependencies: deps.map((d) => ({
          name: d.name,
          ecosystem: d.ecosystem,
          version: d.version,
          direct: d.direct,
          advisoryIds: d.advisoryIds,
          maxSeverity: d.maxSeverity,
          license: d.license,
        })),
        total: deps.length,
        withAdvisories: deps.filter((d) => d.advisoryIds.length > 0).length,
        scanned: !!index.getMeta('security_scanned_at'),
        ...maybeScanProvenance(index),
      };
    } finally {
      index.close();
    }
  }

  async securityOverview(projectId: string): Promise<SecurityOverviewResponse> {
    const opened = await this.open(projectId);
    if (!opened) {
      return {
        indexed: false,
        scanned: false,
        findings: EMPTY_COUNTS,
        attackSurface: {
          entryPoints: 0,
          routes: 0,
          authBoundaries: 0,
          secretTouchpoints: 0,
          taintSources: 0,
        },
        dependencies: { total: 0, withAdvisories: 0 },
        systemicCandidates: [],
      };
    }
    const { index } = opened;
    try {
      const findings = index.securityFindings({ limit: 10000 });
      const surface = computeAttackSurface(
        index.allFiles().map((f) => f.path),
        findings,
      );
      const deps = index.dependencies();

      // Categories recurring across ≥3 files are candidate systemic themes.
      const byCat = new Map<string, { files: Set<string>; count: number; sev: SecuritySeverity }>();
      for (const f of findings) {
        if (f.category === 'taint-source') continue;
        const rec = byCat.get(f.category) ?? {
          files: new Set<string>(),
          count: 0,
          sev: 'info' as SecuritySeverity,
        };
        rec.files.add(f.filePath);
        rec.count++;
        rec.sev = maxSeverity(rec.sev, f.severity);
        byCat.set(f.category, rec);
      }
      const systemicCandidates = [...byCat.entries()]
        .filter(([, r]) => r.files.size >= 3)
        .map(([category, r]) => ({
          category,
          fileCount: r.files.size,
          findingCount: r.count,
          severity: r.sev,
        }))
        .sort(
          (a, b) =>
            severityRank(b.severity) - severityRank(a.severity) || b.fileCount - a.fileCount,
        );

      return {
        indexed: index.fileCount() > 0,
        scanned: !!index.getMeta('security_scanned_at'),
        findings: index.securityFindingCounts(),
        attackSurface: {
          entryPoints: surface.entryPoints.length,
          routes: surface.routes.length,
          authBoundaries: surface.authBoundaries.length,
          secretTouchpoints: surface.secretTouchpoints.length,
          taintSources: surface.taintSources.length,
        },
        dependencies: {
          total: deps.length,
          withAdvisories: deps.filter((d) => d.advisoryIds.length > 0).length,
        },
        systemicCandidates,
        ...maybeScanProvenance(index),
      };
    } finally {
      index.close();
    }
  }

  async traceTaint(
    projectId: string,
    req: { file: string; maxHops?: number },
  ): Promise<TraceTaintResponse> {
    const note =
      'Reachability is import-graph module proximity (who imports whom), not precise dataflow. Confirm the source→sink path by reading the code.';
    const opened = await this.open(projectId);
    const empty = {
      file: req.file,
      found: false,
      upstream: [],
      downstream: [],
      taintSources: [],
      sinks: [],
      note,
    };
    if (!opened) return empty;
    const { index } = opened;
    try {
      const files = index.allFiles().map((f) => f.path);
      if (!files.includes(req.file)) return empty;

      const edges = resolveImportEdges(
        files,
        index.allImports().map((i) => ({ srcPath: i.srcPath, raw: i.raw })),
      );
      const fwd = new Map<string, string[]>();
      const rev = new Map<string, string[]>();
      const push = (m: Map<string, string[]>, k: string, v: string) => {
        const a = m.get(k);
        if (a) a.push(v);
        else m.set(k, [v]);
      };
      for (const e of edges) {
        push(fwd, e.src, e.dst);
        push(rev, e.dst, e.src);
      }
      const maxHops = req.maxHops ?? 3;
      const downstream = bfsReach(fwd, req.file, maxHops);
      const upstream = bfsReach(rev, req.file, maxHops);
      const upSet = new Set([req.file, ...upstream]);
      const downSet = new Set([req.file, ...downstream]);
      const findings = index.securityFindings({ limit: 10000 });
      return {
        file: req.file,
        found: true,
        upstream,
        downstream,
        taintSources: findings
          .filter((f) => f.category === 'taint-source' && upSet.has(f.filePath))
          .map(toWireFinding),
        sinks: findings
          .filter((f) => SINK_CATEGORIES.has(f.category) && downSet.has(f.filePath))
          .map(toWireFinding),
        note,
      };
    } finally {
      index.close();
    }
  }

  /**
   * Build (and persist) the stylized city-map model for the project — districts
   * (folders), blocks (files), buildings (symbols), and roads (the import
   * graph). Building on demand means the map is available the first time a user
   * opens the tab, before any background refresh tick. Returns an empty,
   * `indexed: false` model when the index hasn't been built yet.
   */
  async fileMap(projectId: string, req: FileMapRequest = {}): Promise<FileMapResponse> {
    const opened = await this.open(projectId);
    if (!opened) {
      return {
        domain: req.domain ?? 'code',
        root: '',
        bounds: { x: 0, y: 0, w: 0, h: 0 },
        builtAt: nowIso(),
        indexed: false,
        districts: [],
        blocks: [],
        buildings: [],
        roads: [],
      };
    }
    try {
      return await buildFileMap(opened.index, opened.workspaceDir, {
        scope: req.scope,
        persist: true,
        villageFile: this.cityStoreFor(projectId, opened.workspaceDir),
        userFacing: true,
      });
    } finally {
      opened.index.close();
    }
  }

  // ── search_code (hybrid) ─────────────────────────────────────────────────

  async searchCode(
    projectId: string,
    query: string,
    opts: {
      mode?: 'auto' | 'semantic' | 'keyword';
      maxResults?: number;
      /**
       * Precomputed embedding of `query`. The cross-project unified search
       * embeds the query ONCE and threads the vector into every per-project
       * call so we don't pay N embeddings for one fan-out. When omitted we
       * embed on demand (the single-project MCP-tool path).
       */
      queryVector?: number[];
      /**
       * Answer from the keyword arm rather than wait for a cold/warming
       * embedder. Set by callers riding a user's chat turn: the model load
       * costs tens of seconds on a fresh install, and implicit retrieval must
       * never hold the turn hostage for it.
       */
      skipColdEmbedder?: boolean;
    } = {},
  ): Promise<SearchCodeResponse> {
    const opened = await this.open(projectId);
    if (!opened) return { results: [], engine: 'unavailable', truncated: false };
    const { index } = opened;
    try {
      const limit = opts.maxResults ?? 20;
      const mode = opts.mode ?? 'auto';

      let queryVector: number[] | null = null;
      if (mode !== 'keyword' && index.vecAvailable) {
        if (opts.queryVector) {
          queryVector = opts.queryVector;
        } else {
          try {
            const { embedQuery, embeddingPipelineStatus } = await import('../memory/embeddings.js');
            const status = embeddingPipelineStatus();
            if (opts.skipColdEmbedder && (status === 'cold' || status === 'warming')) {
              queryVector = null; // the service's deferred boot warm owns the load
            } else {
              queryVector = await embedQuery(query);
            }
          } catch {
            queryVector = null; // embeddings disabled → keyword only
          }
        }
      }

      const hits = index.searchCodeHybrid(
        mode === 'keyword' ? null : queryVector,
        mode === 'semantic' ? null : query,
        limit + 1,
      );
      const truncated = hits.length > limit;
      const usedVector = hits.some((h) => h.source === 'vector');
      const usedFts = hits.some((h) => h.source === 'fts');
      const engine =
        mode === 'semantic'
          ? queryVector
            ? 'semantic'
            : 'unavailable'
          : usedVector && usedFts
            ? 'hybrid'
            : usedVector
              ? 'semantic'
              : 'fts';

      return {
        results: hits.slice(0, limit).map((h) => ({
          path: h.path,
          lineStart: h.lineStart,
          lineEnd: h.lineEnd,
          kind: h.kind,
          ...(h.name ? { name: h.name } : {}),
          snippet: h.snippet,
          score: h.score,
          source: h.source,
        })),
        engine,
        truncated,
      };
    } finally {
      index.close();
    }
  }

  /**
   * Run one batch of enrichment for a project (summaries + embeddings for files
   * whose hash isn't enriched yet). Driven by IndexEnrichmentManager when idle.
   */
  /** Whether the background AI scan (boekwachter enrichment — summaries +
   *  embeddings) still has files to process for this project. Cheap COUNT;
   *  opens + closes like the other façade reads. Returns false when there's
   *  no content index on disk yet (we can't tell, so don't flag it). */
  async needsEnrichment(projectId: string): Promise<boolean> {
    const opened = await this.open(projectId);
    if (!opened) return false;
    try {
      return opened.index.countNeedingEnrichment() > 0;
    } finally {
      opened.index.close();
    }
  }

  /** Files still awaiting enrichment (0 when no index exists yet). */
  async countNeedingEnrichment(projectId: string): Promise<number> {
    const opened = await this.open(projectId);
    if (!opened) return 0;
    try {
      return opened.index.countNeedingEnrichment();
    } finally {
      opened.index.close();
    }
  }

  /** Enrichment coverage counts (null when no index exists yet). */
  async enrichmentCounts(projectId: string): Promise<{
    eligible: number;
    summarized: number;
    embedded: number;
    searchReady: number;
    pending: number;
    skipped: number;
    skippedFiles: Array<{ path: string; attempts: number; reason?: string }>;
    shadowsPending: number;
    embedOnlyPending: number;
    embedModel?: string;
    vectorsAvailable: boolean;
  } | null> {
    const opened = await this.open(projectId);
    if (!opened) return null;
    try {
      // vectorsAvailable rides along so status can distinguish "embedding
      // still pending" from "this index cannot store vectors at all"
      // (sqlite-vec failed to load — hybrid search is silently keyword-only).
      return { ...opened.index.enrichmentCounts(), vectorsAvailable: opened.index.vecAvailable };
    } finally {
      opened.index.close();
    }
  }

  async enrich(
    projectId: string,
    deps: EnrichDeps,
    limit = 5,
    opts?: EnrichDriveOpts,
  ): Promise<{ files: number; summarized: number; embedded: number } | null> {
    const opened = await this.open(projectId);
    if (!opened) return null;
    const { index, workspaceDir, artifactsDir } = opened;
    try {
      let files = 0;
      let summarized = 0;
      let embedded = 0;
      const drain = opts?.drain;
      // `seen` guards the refill re-query: in-flight files still match the
      // needing-enrichment predicate (they're marked only on completion), and
      // a failed file stays on the list until its attempt cap — without the
      // guard one drive could dispatch the same file twice.
      const seen = new Set<string>();
      let queue = index.filesNeedingEnrichment(limit);
      for (const f of queue) if (f.hash) seen.add(f.hash);
      let exhausted = false;
      const next = async (): Promise<(typeof queue)[number] | undefined> => {
        if (queue.length === 0 && drain && !exhausted) {
          if (await drain.shouldStop?.()) return undefined;
          const fresh = index
            .filesNeedingEnrichment(limit + seen.size)
            .filter((f) => f.hash !== null && !seen.has(f.hash));
          if (fresh.length === 0) {
            exhausted = true;
            return undefined;
          }
          queue = fresh.slice(0, limit);
          for (const f of queue) if (f.hash) seen.add(f.hash);
          drain.onProgress?.({ files });
        }
        return queue.shift();
      };
      await runPooled(next, opts?.concurrency ?? (() => 1), async (file) => {
        const r = await enrichFile(index, workspaceDir, artifactsDir, file, deps);
        files++;
        if (r.summarized) summarized++;
        embedded += r.embedded;
      });
      return { files, summarized, embedded };
    } finally {
      index.close();
    }
  }

  /**
   * Run one batch of the always-on embed-only tier: give chunks vectors with
   * no LLM involved, so semantic search works before any Boekwachter joins
   * the roster. Deliberately serial and modest — the shared embeddings worker
   * does the work, and this runs ahead of (not instead of) the roster-gated
   * enrichment tiers. Stops the batch early when embeddings are unavailable
   * so one outage can't burn every file's attempt budget.
   */
  async embedOnly(
    projectId: string,
    limit = 10,
  ): Promise<{ files: number; embedded: number } | null> {
    const opened = await this.open(projectId);
    if (!opened) return null;
    const { index, workspaceDir, artifactsDir } = opened;
    try {
      if (!index.vecAvailable) return { files: 0, embedded: 0 };
      const { embedBatch } = await import('../memory/embeddings.js');
      let files = 0;
      let embedded = 0;
      for (const file of index.filesNeedingEmbedOnly(limit)) {
        const outcome = await embedOnlyFile(index, workspaceDir, artifactsDir, file, embedBatch);
        files++;
        if (outcome === 'embedded') embedded++;
        if (outcome === 'unavailable') break;
      }
      return { files, embedded };
    } finally {
      index.close();
    }
  }

  /**
   * Run one batch of the always-on IMAGE-embed tier (lane A of image search):
   * CLIP vectors into the hash-keyed image_vectors table, no LLM involved.
   * Same pre-Boekwachter placement discipline as {@link embedOnly}; unlike it,
   * this does NOT require sqlite-vec — image vectors are plain BLOBs. Per-image
   * outcomes consume the gate (ok / terminal unsupported / capped attempt); a
   * pipeline-level failure sets `unavailable` so callers stop the drain instead
   * of burning every file's attempt budget in one outage. `embed` is a test
   * seam; production lazily imports the real worker-backed embedder.
   */
  async embedImages(
    projectId: string,
    limit = 5,
    embed?: (jobs: ImageEmbedJob[]) => Promise<ImageEmbedOutcome[]>,
  ): Promise<{ files: number; embedded: number; unavailable: boolean } | null> {
    const opened = await this.open(projectId);
    if (!opened) return null;
    const { index, workspaceDir } = opened;
    try {
      let files = 0;
      let embedded = 0;
      const jobs: Array<{ path: string; hash: string; relPath: string }> = [];
      for (const f of index.filesNeedingImageEmbed(limit)) {
        if (!f.hash) continue;
        const ext = f.path.slice(f.path.lastIndexOf('.')).toLowerCase();
        const abs = IMAGE_EMBED_EXTS.has(ext) ? safeJoin(workspaceDir, f.path) : null;
        if (!abs) {
          // No pure-JS decoder for the format (or an unresolvable path):
          // terminal for this hash, cheap — the embedder never runs.
          index.markImageEmbedUnsupported(f.hash, f.path);
          files++;
          continue;
        }
        jobs.push({ path: abs, hash: f.hash, relPath: f.path });
      }
      if (jobs.length === 0) return { files, embedded, unavailable: false };
      const embedFn = embed ?? (await import('../memory/image-embeddings.js')).embedImageFiles;
      let outcomes: ImageEmbedOutcome[];
      try {
        outcomes = await embedFn(jobs.map(({ path, hash }) => ({ path, hash })));
      } catch {
        // Model unloadable / cooldown — process-wide, not these files' fault.
        // One capped attempt on the first job for poison-input safety (the
        // embedOnlyFile discipline), then tell the caller to stop the drain.
        const first = jobs[0]!;
        index.markImageEmbedAttempt(first.hash, first.relPath);
        return { files, embedded, unavailable: true };
      }
      const byHash = new Map(jobs.map((j) => [j.hash, j]));
      for (const outcome of outcomes) {
        const job = byHash.get(outcome.hash);
        if (!job) continue;
        files++;
        if ('vector' in outcome) {
          index.putImageVector(job.hash, job.relPath, outcome.vector);
          index.markImageEmbedOk(job.hash, job.relPath);
          embedded++;
        } else if ('skip' in outcome) {
          index.markImageEmbedUnsupported(job.hash, job.relPath);
        } else {
          index.markImageEmbedAttempt(job.hash, job.relPath);
        }
      }
      return { files, embedded, unavailable: false };
    } finally {
      index.close();
    }
  }

  /**
   * Download the pinned face models if missing (~261 MB, sha256-verified).
   * Called by the enrichment manager once the biometric opt-in is on —
   * {@link faceIndex} itself never touches the network.
   */
  async ensureFaceModelsInstalled(): Promise<boolean> {
    return (await ensureFaceModels(this.home)) !== null;
  }

  /**
   * Run one batch of the face tier (lane B, biometric opt-in — the CALLER
   * checks `config.faceRecognition.enabled` and has already ensured the
   * models are installed): detect faces, embed them, cluster incrementally,
   * and refresh Person entities. `deps` is the test seam for both the
   * detector and the model paths.
   */
  async faceIndex(
    projectId: string,
    limit = 5,
    deps?: {
      detect?: (jobs: ImageEmbedJob[], models: FaceModelPaths) => Promise<FaceDetectOutcome[]>;
      models?: FaceModelPaths;
    },
  ): Promise<{ files: number; faces: number; unavailable: boolean } | null> {
    const opened = await this.open(projectId);
    if (!opened) return null;
    const { index, workspaceDir } = opened;
    try {
      const candidates = index.filesNeedingFaceIndex(limit);
      if (candidates.length === 0) return { files: 0, faces: 0, unavailable: false };
      // Never downloads: the manager's opt-in path calls
      // ensureFaceModelsInstalled() first, so a missing install here is a
      // fast, network-free "unavailable".
      const models = deps?.models ?? installedFaceModels(this.home);
      if (!models) return { files: 0, faces: 0, unavailable: true };

      let files = 0;
      let faces = 0;
      const jobs: Array<{ path: string; hash: string; relPath: string }> = [];
      for (const f of candidates) {
        if (!f.hash) continue;
        const ext = f.path.slice(f.path.lastIndexOf('.')).toLowerCase();
        const abs = IMAGE_EMBED_EXTS.has(ext) ? safeJoin(workspaceDir, f.path) : null;
        if (!abs) {
          index.markFaceUnsupported(f.hash, f.path);
          files++;
          continue;
        }
        jobs.push({ path: abs, hash: f.hash, relPath: f.path });
      }
      if (jobs.length === 0) return { files, faces, unavailable: false };

      const detectFn = deps?.detect ?? (await import('../memory/image-embeddings.js')).detectFaces;
      let outcomes: FaceDetectOutcome[];
      try {
        outcomes = await detectFn(
          jobs.map(({ path, hash }) => ({ path, hash })),
          models,
        );
      } catch {
        const first = jobs[0]!;
        index.markFaceAttempt(first.hash, first.relPath);
        return { files, faces, unavailable: true };
      }
      const byHash = new Map(jobs.map((j) => [j.hash, j]));
      let touchedClusters = false;
      for (const outcome of outcomes) {
        const job = byHash.get(outcome.hash);
        if (!job) continue;
        files++;
        if ('faces' in outcome) {
          clusterNewFaces(index, job.hash, job.relPath, outcome.faces);
          index.markFaceOk(job.hash, job.relPath, outcome.faces.length);
          faces += outcome.faces.length;
          if (outcome.faces.length > 0) touchedClusters = true;
        } else if ('skip' in outcome) {
          index.markFaceUnsupported(job.hash, job.relPath);
        } else {
          index.markFaceAttempt(job.hash, job.relPath);
        }
      }
      if (touchedClusters) {
        mergeFaceClusters(index);
        syncPersonEntities(index);
      }
      return { files, faces, unavailable: false };
    } finally {
      index.close();
    }
  }

  /**
   * Run one batch of the AI-shadow tier: describe images / transcribe audio
   * into `artifacts/shadow/` sidecars. Runs BEFORE the summary tier so a
   * produced shadow immediately joins the enrichment work-list. No-op when
   * neither producer is wired (no vision model / no STT configured).
   */
  async aiShadows(
    projectId: string,
    deps: AiShadowDeps,
    limit = 3,
  ): Promise<{ files: number; produced: number; called: number } | null> {
    if (!deps.describeImage && !deps.transcribeAudio) return { files: 0, produced: 0, called: 0 };
    const opened = await this.open(projectId);
    if (!opened) return null;
    const { index, workspaceDir, artifactsDir } = opened;
    try {
      const files = index.filesNeedingAiShadow(limit);
      let produced = 0;
      let called = 0;
      let handled = 0;
      for (const file of files) {
        const r = await aiShadowFile(index, workspaceDir, artifactsDir, file, deps);
        if (r.skipped) continue;
        handled++;
        if (r.produced) produced++;
        if (r.called) called++;
      }
      return { files: handled, produced, called };
    } finally {
      index.close();
    }
  }

  /**
   * Cheap existence probe — true when a content index db is on disk for
   * this project. File-stat only; never opens (an open would CREATE the
   * db). Recall consults it before paying the query-embed cost.
   */
  async hasIndex(projectId: string): Promise<boolean> {
    if (projectStorageScope(this.home, projectId) !== 'machine-shared') {
      try {
        const workspaceDir = await this.store.projectWorkspaceDir(projectId);
        if (existsSync(projectLocalIndexDbFile(workspaceDir))) return true;
      } catch {
        /* fall through to the home-scoped fallback */
      }
    }
    return existsSync(join(fallbackProjectIndexDir(this.home, projectId), 'index.db'));
  }

  /**
   * The deep-pass architecture note alone — one indexed row, no file walk.
   * The cheap read for cross-project rollups (projects listing, Meester
   * awareness); use mapRepo when the full gestalt is wanted.
   */
  async architectureNote(projectId: string): Promise<string | null> {
    const opened = await this.open(projectId);
    if (!opened) return null;
    try {
      return opened.index.getAreaSummary(ARCHITECTURE_KEY)?.summaryMd ?? null;
    } finally {
      opened.index.close();
    }
  }

  /**
   * Query the deep-pass folder/project rollups without another embedding or
   * schema migration. These are a small corpus (usually tens of rows), so a
   * deterministic token-overlap rank is cheaper and easier to keep current
   * than a second FTS mirror.
   */
  async searchAreaSummaries(
    projectId: string,
    query: string,
    maxResults = 5,
  ): Promise<Array<{ areaPath: string; summary: string; score: number }>> {
    const opened = await this.open(projectId);
    if (!opened) return [];
    try {
      const queryTokens = searchTokens(query);
      if (queryTokens.size === 0) return [];
      return opened.index
        .allAreaSummaries()
        .map((area) => {
          const haystack = searchTokens(`${area.areaPath} ${area.summaryMd}`);
          let matches = 0;
          for (const token of queryTokens) {
            if (haystack.has(token)) matches++;
          }
          const coverage = matches / queryTokens.size;
          const density = matches / Math.max(1, Math.min(12, haystack.size));
          return {
            areaPath: area.areaPath,
            summary: area.summaryMd,
            score: Math.min(1, coverage * 0.8 + density * 0.2),
          };
        })
        .filter((area) => area.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, maxResults);
    } finally {
      opened.index.close();
    }
  }

  /**
   * Deep-pass tier 2: folder + architecture rollups from existing file
   * summaries. Cheap when nothing changed (hash-gated per area); intended to
   * run once a project's file tier has drained. Null when no index exists.
   */
  async enrichAreas(projectId: string, deps: EnrichDeps): Promise<AreaPassResult | null> {
    const opened = await this.open(projectId);
    if (!opened) return null;
    try {
      return await runAreaPass(opened.index, deps);
    } finally {
      opened.index.close();
    }
  }

  /**
   * Run one batch of the review pass (cliffs notes + issues + health) for a
   * project. Intended to run strictly AFTER the enrichment tier drains.
   * `files` counts non-empty outcomes only (reviews stored + attempts burned)
   * so an engine outage reads as "no work possible", not progress; three
   * consecutive empty replies abort the batch (a dead engine must not chew a
   * whole night budget in timeouts). Rubrics can be injected (one resolve per
   * manager tick; also the test seam). Null when no index exists.
   */
  async review(
    projectId: string,
    deps: EnrichDeps,
    limit = 5,
    rubrics?: Map<string, ResolvedRubric>,
    opts?: EnrichDriveOpts,
  ): Promise<{ files: number; reviewed: number } | null> {
    if (!deps.review || !deps.model) return { files: 0, reviewed: 0 };
    const resolved = rubrics ?? (await resolveRubrics(this.store));
    if (resolved.size === 0) return { files: 0, reviewed: 0 };
    const opened = await this.open(projectId);
    if (!opened) return null;
    const { index, workspaceDir, artifactsDir } = opened;
    try {
      let files = 0;
      let reviewed = 0;
      // Wedged-model breaker: three empty replies with no success in
      // between (completion order under concurrency, dispatch order when
      // serial) stop NEW dispatches; in-flight reviews finish.
      let emptySinceSuccess = 0;
      let wedged = false;
      const drain = opts?.drain;
      for (const rubric of resolved.values()) {
        if ((!drain && files >= limit) || wedged) break;
        // Same in-flight/retry guard as enrich: a file is only marked after
        // its review completes, so drain refills must not re-select it.
        const seen = new Set<string>();
        const select = (n: number) =>
          index
            .filesNeedingReview(rubric.kind, rubric.hash, n, MAX_REVIEW_ATTEMPTS)
            .filter((f) => f.hash !== null && !seen.has(f.hash));
        let queue = select(drain ? limit : limit - files);
        for (const f of queue) if (f.hash) seen.add(f.hash);
        let exhausted = false;
        const next = async (): Promise<(typeof queue)[number] | undefined> => {
          if (queue.length === 0 && drain && !exhausted) {
            if (await drain.shouldStop?.()) return undefined;
            const fresh = select(limit + seen.size);
            if (fresh.length === 0) {
              exhausted = true;
              return undefined;
            }
            queue = fresh.slice(0, limit);
            for (const f of queue) if (f.hash) seen.add(f.hash);
            drain.onProgress?.({ files });
          }
          return queue.shift();
        };
        await runPooled(
          next,
          opts?.concurrency ?? (() => 1),
          async (file) => {
            const r = await reviewFile(index, workspaceDir, artifactsDir, file, rubric, deps);
            if (r.reviewed || r.attempted) files++;
            if (r.reviewed) reviewed++;
            if (r.emptyReply) {
              emptySinceSuccess++;
              if (emptySinceSuccess >= 3) wedged = true;
            } else {
              emptySinceSuccess = 0;
            }
          },
          () => wedged,
        );
        if (wedged) break;
      }
      if (reviewed > 0) {
        await this.store.observeProjectBoekwachterReviews(
          projectId,
          index.currentFileReviewIssues(),
        );
      }
      return { files, reviewed };
    } finally {
      index.close();
    }
  }

  /** Review coverage counts under the active rubrics (null when no index). */
  async reviewCounts(projectId: string): Promise<{
    eligible: number;
    reviewed: number;
    stale: number;
    pending: number;
  } | null> {
    const rubrics = await resolveRubrics(this.store);
    const opened = await this.open(projectId);
    if (!opened) return null;
    try {
      return opened.index.reviewCounts(rubricKeys(rubrics), MAX_REVIEW_ATTEMPTS);
    } finally {
      opened.index.close();
    }
  }

  /**
   * Indexing work this project recorded in `[since, until)` — summaries,
   * reviews, and AI shadows, from the tiers' own stamps. Null when the
   * project has no index (or it's momentarily unavailable); callers tally
   * across projects and treat that as "nothing to add", never as zero work.
   */
  async workCountsSince(
    projectId: string,
    since: string,
    until: string,
  ): Promise<{ summarized: number; reviewed: number; described: number } | null> {
    const opened = await this.open(projectId);
    if (!opened) return null;
    try {
      return opened.index.workCountsSince(since, until);
    } finally {
      opened.index.close();
    }
  }

  /** One file's boekwachter review (`file_review` tool). */
  async fileReview(projectId: string, relPath: string): Promise<FileReviewResponse> {
    const opened = await this.open(projectId);
    if (!opened) {
      const trackedIssues = (await this.store.listProjectBoekwachterIssues(projectId))
        .filter((record) => record.path === relPath)
        .map((record) => toBoekwachterIssueWire(record, null));
      return {
        path: relPath,
        found: false,
        ...(trackedIssues.length > 0 ? { trackedIssues } : {}),
      };
    }
    try {
      const fileRec = opened.index.getFile(relPath);
      const currentHash = await currentIndexedHash(opened.index, opened.workspaceDir, relPath);
      // Only this file's observation: the caller asked about one path, and the
      // whole-project materialization belongs to the review pass that produced
      // the rows (see `reviewPass`), not to opening a file in the UI.
      await this.store.observeProjectBoekwachterReviews(
        projectId,
        opened.index.currentFileReviewIssuesForPath(relPath),
      );
      const trackedIssues = await this.boekwachterIssuesForPath(projectId, relPath, currentHash);
      if (!fileRec?.hash) {
        return {
          path: relPath,
          found: false,
          ...(trackedIssues.length > 0 ? { trackedIssues } : {}),
        };
      }
      const row = currentHash ? opened.index.getFileReview(currentHash) : undefined;
      if (row) {
        return {
          path: relPath,
          found: true,
          review: toReviewWire(row),
          ...(trackedIssues.length > 0 ? { trackedIssues } : {}),
        };
      }
      // `pending` is a promise ("the boekwachter studies files when idle") —
      // only make it for files a rubric will actually reach. Everything else
      // (data/other kinds, images, trivial blobs, reviews disabled) reports
      // eligible:false so surfaces stop implying a review that never comes.
      const rubrics = await resolveRubrics(this.store);
      const eligible =
        !fileRec.trivial &&
        REVIEWABLE_MODALITIES.has(fileRec.modality ?? '') &&
        rubrics.has(fileRec.kind ?? '');
      if (!eligible) {
        return {
          path: relPath,
          found: false,
          eligible: false,
          ...(trackedIssues.length > 0 ? { trackedIssues } : {}),
        };
      }
      return {
        path: relPath,
        found: false,
        pending: true,
        eligible: true,
        ...(trackedIssues.length > 0 ? { trackedIssues } : {}),
      };
    } finally {
      opened.index.close();
    }
  }

  /** Flat issue query across current-hash reviews (`list_file_issues` tool). */
  async listFileIssues(
    projectId: string,
    req: ListFileIssuesRequest,
  ): Promise<ListFileIssuesResponse> {
    const empty: ListFileIssuesResponse = {
      issues: [],
      counts: { total: 0, bySeverity: {}, byCategory: {} },
      truncated: false,
      indexed: false,
      reviewedFiles: 0,
      eligibleFiles: 0,
    };
    const rubrics = await resolveRubrics(this.store);
    const opened = await this.open(projectId);
    if (!opened) {
      const limit = Math.min(req.maxResults ?? 200, 1000);
      const matching = filterAndSortBoekwachterIssues(
        (await this.store.listProjectBoekwachterIssues(projectId)).map((record) =>
          toBoekwachterIssueWire(record, null),
        ),
        req,
      );
      return {
        ...empty,
        issues: matching.slice(0, limit),
        counts: {
          total: matching.length,
          bySeverity: tallyBoekwachterIssues(matching, (issue) => issue.severity),
          byCategory: tallyBoekwachterIssues(matching, (issue) => issue.category),
        },
        truncated: matching.length > limit,
      };
    }
    const { index } = opened;
    try {
      const limit = Math.min(req.maxResults ?? 200, 1000);
      await this.store.observeProjectBoekwachterReviews(projectId, index.currentFileReviewIssues());
      const { reviewers } = index.fileIssues({
        ...(req.severity ? { severity: req.severity } : {}),
        ...(req.category ? { category: req.category } : {}),
        ...(req.path ? { pathPrefix: req.path } : {}),
        limit: 1,
      });
      const records = await this.store.listProjectBoekwachterIssues(projectId);
      // Findings cluster on the same files, so resolve each path's live hash
      // once rather than per record — a stat + index read per finding is
      // thousands of syscalls on a repo-sized backlog.
      const hashByPath = new Map<string, Promise<string | null>>();
      const matching = filterAndSortBoekwachterIssues(
        await Promise.all(
          records.map(async (record) => {
            let hash = hashByPath.get(record.path);
            if (!hash) {
              hash = currentIndexedHash(index, opened.workspaceDir, record.path);
              hashByPath.set(record.path, hash);
            }
            return toBoekwachterIssueWire(record, await hash);
          }),
        ),
        req,
      );
      const counts = {
        total: matching.length,
        bySeverity: tallyBoekwachterIssues(matching, (issue) => issue.severity),
        byCategory: tallyBoekwachterIssues(matching, (issue) => issue.category),
      };
      const rc = index.reviewCounts(rubricKeys(rubrics), MAX_REVIEW_ATTEMPTS);
      return {
        issues: matching.slice(0, limit),
        counts,
        truncated: matching.length > limit,
        indexed: index.fileCount() > 0,
        reviewedFiles: rc.reviewed,
        eligibleFiles: rc.eligible,
        ...(reviewers.length > 0 ? { reviewers } : {}),
      };
    } finally {
      index.close();
    }
  }

  async getBoekwachterIssue(projectId: string, ref: string): Promise<BoekwachterIssue | null> {
    const opened = await this.open(projectId);
    if (!opened) {
      const record = await this.store.getProjectBoekwachterIssue(projectId, ref);
      return record ? toBoekwachterIssueWire(record, null) : null;
    }
    try {
      // A ref names a record that already exists, so reconcile only its file.
      // Falling back to the whole project keeps a ref that has not been
      // materialized yet resolvable.
      const known = await this.store.getProjectBoekwachterIssue(projectId, ref);
      await this.store.observeProjectBoekwachterReviews(
        projectId,
        known
          ? opened.index.currentFileReviewIssuesForPath(known.path)
          : opened.index.currentFileReviewIssues(),
      );
      const record = await this.store.getProjectBoekwachterIssue(projectId, ref);
      return record
        ? toBoekwachterIssueWire(
            record,
            await currentIndexedHash(opened.index, opened.workspaceDir, record.path),
          )
        : null;
    } finally {
      opened.index.close();
    }
  }

  async updateBoekwachterIssue(
    projectId: string,
    ref: string,
    patch: {
      status?: BoekwachterIssueStatus;
      seen?: boolean;
      taskRef?: string;
      dismissalReason?: BoekwachterIssueDismissalReason;
    },
  ): Promise<BoekwachterIssue | null> {
    const record = await this.store.updateProjectBoekwachterIssue(projectId, ref, patch);
    if (!record) return null;
    const opened = await this.open(projectId);
    try {
      return toBoekwachterIssueWire(
        record,
        opened ? await currentIndexedHash(opened.index, opened.workspaceDir, record.path) : null,
      );
    } finally {
      opened?.index.close();
    }
  }

  async settleBoekwachterIssuesForTask(
    projectId: string,
    taskRef: string,
    outcome: 'complete' | 'canceled',
  ): Promise<number> {
    return this.store.settleProjectBoekwachterIssuesForTask(projectId, taskRef, outcome);
  }

  private async boekwachterIssuesForPath(
    projectId: string,
    path: string,
    currentHash: string | null,
  ): Promise<BoekwachterIssue[]> {
    return (await this.store.listProjectBoekwachterIssues(projectId))
      .filter((record) => record.path === path)
      .map((record) => toBoekwachterIssueWire(record, currentHash));
  }

  // ── doc-intel ────────────────────────────────────────────────────────────

  async searchDocs(projectId: string, query: string, maxResults = 20): Promise<SearchDocsResponse> {
    const opened = await this.open(projectId);
    if (!opened) return { results: [], engine: 'unavailable', truncated: false };
    const { index, artifactsDir } = opened;
    try {
      if (!index.ftsAvailable) return { results: [], engine: 'unavailable', truncated: false };
      const hits = index.searchDocs(query, maxResults + 1);
      const truncated = hits.length > maxResults;
      return {
        results: hits.slice(0, maxResults).map((h) => {
          const shadow = shadowDocFilesPaths(artifactsDir, h.filePath);
          return {
            sourcePath: h.filePath,
            markdownPath: shadow ? `artifacts/${shadow.mdRel}` : h.filePath,
            lineStart: h.lineStart,
            lineEnd: h.lineEnd,
            snippet: h.snippet,
          };
        }),
        engine: 'fts',
        truncated,
      };
    } finally {
      index.close();
    }
  }

  /**
   * Content search over the shared document library.
   *
   * The library is a project, so this is the ordinary hybrid searcher
   * (embeddings + keyword) reshaped to document identity: callers name a
   * document by the path the user filed it under, never by the converted
   * markdown the snippet happened to come from. That mapping is why this
   * exists rather than callers using `searchCode` directly.
   */
  async searchLibrary(
    projectId: string,
    query: string,
    opts: { maxResults?: number; queryVector?: number[]; skipColdEmbedder?: boolean } = {},
  ): Promise<SearchDocumentsResponse> {
    const maxResults = opts.maxResults ?? 10;
    const code = await this.searchCode(projectId, query, {
      maxResults,
      ...(opts.queryVector ? { queryVector: opts.queryVector } : {}),
      ...(opts.skipColdEmbedder ? { skipColdEmbedder: true } : {}),
    });
    if (code.engine === 'unavailable') return { results: [], engine: 'unavailable' };
    const artifactsDir = this.store.projectArtifactsDir(projectId);
    return {
      results: code.results.map((hit) => {
        const shadow = shadowDocFilesPaths(artifactsDir, hit.path);
        return {
          path: hit.path,
          lineStart: hit.lineStart,
          lineEnd: hit.lineEnd,
          snippet: hit.snippet,
          score: hit.score,
          // Kept, not dropped: a vector-arm hit is a related document, not a
          // document that says what the user typed, and only the arm knows.
          source: hit.source,
          kind: hit.kind,
          ...(shadow && isConvertibleDoc(hit.path.split('.').pop() ?? '')
            ? { markdownPath: `artifacts/${shadow.mdRel}` }
            : {}),
        };
      }),
      engine: code.engine,
    };
  }

  /**
   * One-line descriptions for library documents, keyed by path.
   *
   * Two sources, in precedence order: the document's own frontmatter
   * `description`/`title` — the user said what this is, so nothing should
   * outrank it — then the Boekwachter's generated summary. Absent entries
   * simply have no description; a listing renders the bare path.
   */
  async libraryDescriptions(projectId: string): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const opened = await this.open(projectId);
    if (!opened) return out;
    const { index } = opened;
    try {
      const authored = index.metadataValuesForKeys(['description', 'title']);
      for (const file of index.allFiles()) {
        const own = authored.get(file.path);
        const stated = own?.description ?? own?.title;
        if (stated?.trim()) {
          out.set(file.path, stated.trim());
          continue;
        }
        const summary = file.hash ? index.getSummary(file.hash) : undefined;
        if (summary?.trim()) out.set(file.path, summary.trim());
      }
    } finally {
      index.close();
    }
    return out;
  }

  async readDocAsMarkdown(projectId: string, relPath: string): Promise<ReadDocAsMarkdownResponse> {
    let workspaceDir: string;
    try {
      workspaceDir = await this.store.projectWorkspaceDir(projectId);
    } catch {
      return { found: false, truncated: false };
    }
    if (!workspaceDir) return { found: false, truncated: false };
    const absSource = safeJoin(workspaceDir, relPath);
    if (!absSource) return { found: false, truncated: false };

    // Reuse the same freshness + sandboxed-conversion path as indexing and
    // the References viewer so every document consumer agrees on sidecars.
    const artifactsDir = this.store.projectArtifactsDir(projectId);
    const ensured = await ensureShadowDocSidecar(absSource, artifactsDir, relPath);
    const md = ensured?.markdown ?? null;
    if (md == null || !ensured) return { found: false, sourcePath: relPath, truncated: false };
    const truncated = md.length > MAX_READ_BYTES;
    return {
      found: true,
      sourcePath: relPath,
      markdownPath: `artifacts/${ensured.paths.mdRel}`,
      markdown: truncated ? `${md.slice(0, MAX_READ_BYTES)}\n…(truncated)` : md,
      truncated,
    };
  }

  // ── artifacts corpora (connector records under artifacts/data/**) ────────

  /**
   * Schedule a rebuild of the project's artifacts-corpus index. Debounced per
   * project: calls landing within the window join the same pass, so a burst
   * of connector syncs costs one walk; passes for a project never overlap.
   * This is the only artifacts-index method that CREATES the database.
   */
  refreshArtifacts(projectId: string): Promise<ArtifactsIndexStats | null> {
    const pending = this.artifactsRefreshPending.get(projectId);
    if (pending) return pending;
    const prior = this.artifactsRefreshLast.get(projectId) ?? Promise.resolve();
    const run = (async () => {
      await sleep(this.artifactsDebounceMs);
      this.artifactsRefreshPending.delete(projectId);
      await prior.catch(() => {});
      if (!(await this.store.projectIndexingEnabled(projectId).catch(() => true))) return null;
      return indexProjectArtifacts(this.store, this.home, projectId);
    })();
    this.artifactsRefreshPending.set(projectId, run);
    this.artifactsRefreshLast.set(
      projectId,
      run.catch(() => {}),
    );
    return run;
  }

  /** Docs-FTS over the project's artifacts corpora. Empty until a refresh has built the index. */
  async searchArtifacts(
    projectId: string,
    query: string,
    maxResults = 20,
  ): Promise<{
    results: Array<{ path: string; lineStart: number; lineEnd: number; snippet: string }>;
    truncated: boolean;
  }> {
    const index = await this.openArtifacts(projectId);
    if (!index) return { results: [], truncated: false };
    try {
      if (!index.ftsAvailable) return { results: [], truncated: false };
      const hits = index.searchDocs(query, maxResults + 1);
      return {
        results: hits.slice(0, maxResults).map((h) => ({
          path: h.filePath,
          lineStart: h.lineStart,
          lineEnd: h.lineEnd,
          snippet: h.snippet,
        })),
        truncated: hits.length > maxResults,
      };
    } finally {
      index.close();
    }
  }

  /** Indexed artifact record paths (artifacts-relative), for the search catalog. */
  async listArtifactIndexFiles(projectId: string, cap = 2000): Promise<string[]> {
    const index = await this.openArtifacts(projectId);
    if (!index) return [];
    try {
      return index.allFilePaths().slice(0, cap);
    } finally {
      index.close();
    }
  }

  /**
   * Open the artifacts-corpus collection for a READ. Stat-first — opening a
   * missing db would create it (same discipline as {@link hasIndex}), so pure
   * reads return null until {@link refreshArtifacts} has built one.
   */
  private async openArtifacts(projectId: string): Promise<IndexStore | null> {
    try {
      const dbPath = projectArtifactsIndexDbFile(this.home, projectId);
      if (!existsSync(dbPath)) return null;
      return await IndexStore.open(dbPath, {
        collectionId: artifactsCollectionId(projectId),
        kind: 'generic',
        rootPath: this.store.projectArtifactsDir(projectId),
      });
    } catch {
      return null;
    }
  }

  // ── image-intel ──────────────────────────────────────────────────────────

  async searchImages(
    projectId: string,
    query: string,
    maxResults = 20,
  ): Promise<SearchImagesResponse> {
    const opened = await this.open(projectId);
    if (!opened) return { results: [], engine: 'unavailable', truncated: false };
    const { index } = opened;
    try {
      if (!index.ftsAvailable) return { results: [], engine: 'unavailable', truncated: false };
      // Over-fetch from the shared doc FTS, then keep only image-modality hits.
      const hits = index.searchDocs(query, maxResults * 4);
      const results: SearchImagesResponse['results'] = [];
      for (const h of hits) {
        const f = index.getFile(h.filePath);
        if (f?.modality !== 'image') continue;
        const md = index.getMetadata(h.filePath);
        const summary = f.hash ? index.getSummary(f.hash) : undefined;
        results.push({
          path: h.filePath,
          ...(md.width ? { width: Number(md.width) } : {}),
          ...(md.height ? { height: Number(md.height) } : {}),
          ...(md.format ? { format: md.format } : {}),
          ...(summary ? { caption: summary } : {}),
          score: 0.5,
        });
        if (results.length >= maxResults + 1) break;
      }
      const truncated = results.length > maxResults;
      return { results: results.slice(0, maxResults), engine: 'fts', truncated };
    } finally {
      index.close();
    }
  }

  async findSimilarImages(
    projectId: string,
    relPath: string,
    maxResults = 12,
  ): Promise<FindSimilarImagesResponse> {
    const opened = await this.open(projectId);
    if (!opened) return { results: [], engine: 'unavailable', truncated: false };
    const { index } = opened;
    try {
      const hash = index.getFile(relPath)?.hash;
      const target = hash ? index.imageVectorByHash(hash) : null;
      // Mid-migration remnants with a different dim can't be compared.
      const all = target
        ? index.allImageVectors().filter((v) => v.vec.length === target.vec.length)
        : [];
      if (!target || all.length <= 1) {
        // No image embeddings yet (the embed tier hasn't reached this file, or
        // no embedder is available) → can't do visual similarity. Degrades
        // honestly.
        return { results: [], engine: 'unavailable', truncated: false };
      }
      const scored = all
        .filter((v) => v.filePath !== relPath)
        .map((v) => ({ path: v.filePath, score: cosine(target.vec, v.vec) }))
        .sort((a, b) => b.score - a.score);
      const truncated = scored.length > maxResults;
      return { results: scored.slice(0, maxResults), engine: 'vector', truncated };
    } finally {
      index.close();
    }
  }

  async describeFolder(projectId: string, prefix?: string): Promise<DescribeFolderResponse> {
    const opened = await this.open(projectId);
    if (!opened) {
      return {
        path: prefix ?? '',
        imageCount: 0,
        formats: [],
        dimensions: null,
        samples: [],
        captioned: 0,
      };
    }
    const { index } = opened;
    try {
      const images = index.imageFiles(prefix);
      const formatCounts = new Map<string, number>();
      let minW = Number.POSITIVE_INFINITY;
      let maxW = 0;
      let minH = Number.POSITIVE_INFINITY;
      let maxH = 0;
      let haveDims = false;
      let captioned = 0;
      for (const img of images) {
        const md = index.getMetadata(img.path);
        const fmt = md.format ?? img.path.split('.').pop() ?? 'unknown';
        formatCounts.set(fmt, (formatCounts.get(fmt) ?? 0) + 1);
        if (md.width && md.height) {
          haveDims = true;
          const w = Number(md.width);
          const h = Number(md.height);
          minW = Math.min(minW, w);
          maxW = Math.max(maxW, w);
          minH = Math.min(minH, h);
          maxH = Math.max(maxH, h);
        }
        if (img.hash && index.getSummary(img.hash)) captioned++;
      }
      return {
        path: prefix ?? '',
        imageCount: images.length,
        formats: [...formatCounts.entries()]
          .map(([format, count]) => ({ format, count }))
          .sort((a, b) => b.count - a.count),
        dimensions: haveDims
          ? { minWidth: minW, maxWidth: maxW, minHeight: minH, maxHeight: maxH }
          : null,
        samples: images.slice(0, 20).map((i) => i.path),
        captioned,
      };
    } finally {
      index.close();
    }
  }

  // ── entity-intel (meta-boekwachter) ────────────────────────────────────────

  async findEntity(
    projectId: string,
    opts: { query?: string; kind?: string; maxResults?: number } = {},
  ): Promise<FindEntityResponse> {
    const opened = await this.open(projectId);
    if (!opened) return { entities: [], engine: 'unavailable' };
    try {
      const entities = opened.index.findEntities(opts.query, {
        ...(opts.kind ? { kind: opts.kind } : {}),
        limit: opts.maxResults ?? 50,
      });
      return { entities, engine: 'index' };
    } finally {
      opened.index.close();
    }
  }

  // ── people (face lane) ─────────────────────────────────────────────────────

  /** Person clusters with counts + sample images for the People UI. */
  async listPeople(projectId: string, maxSamples = 4): Promise<ListPeopleResponse> {
    const opened = await this.open(projectId);
    if (!opened) return { people: [], available: false };
    const { index } = opened;
    try {
      const membersByCluster = new Map<string, ReturnType<IndexStore['faceVectors']>>();
      for (const v of index.faceVectors()) {
        if (!v.clusterId) continue;
        const list = membersByCluster.get(v.clusterId) ?? [];
        list.push(v);
        membersByCluster.set(v.clusterId, list);
      }
      const people: ListPeopleResponse['people'] = [];
      for (const entity of index.findEntities(undefined, { kind: 'person', limit: 200 })) {
        const members = membersByCluster.get(entity.canonical) ?? [];
        const cluster = index.faceClusters().find((c) => c.id === entity.canonical);
        const exemplarMember = cluster?.exemplarHash
          ? members.find(
              (m) => m.contentHash === cluster.exemplarHash && m.faceIndex === cluster.exemplarFace,
            )
          : undefined;
        const toSample = (m: (typeof members)[number]) => {
          const region = parseRegionJson(m.region);
          return { path: m.filePath, ...(region ? { region } : {}) };
        };
        people.push({
          entityId: entity.id,
          label: entity.label,
          clusterId: entity.canonical,
          count: members.length,
          ...(exemplarMember ? { exemplar: toSample(exemplarMember) } : {}),
          samples: members.slice(0, maxSamples).map(toSample),
        });
      }
      people.sort((a, b) => b.count - a.count);
      return { people, available: true };
    } finally {
      index.close();
    }
  }

  /** Rename a person entity ("Who is this?" → user-assigned label). */
  async renamePerson(projectId: string, entityId: number, label: string): Promise<boolean> {
    const opened = await this.open(projectId);
    if (!opened) return false;
    try {
      const entity = opened.index.entityById(entityId);
      if (!entity || entity.kind !== 'person') return false;
      opened.index.updateEntityLabel(entityId, label);
      return true;
    } finally {
      opened.index.close();
    }
  }

  /**
   * Forget a person: delete the entity + mentions, tombstone the cluster so
   * new photos of them are absorbed silently instead of resurrecting as a
   * fresh "Person N". This is "stop showing me this person" — data erasure
   * is {@link wipeAllFaceData}.
   */
  async forgetPerson(projectId: string, entityId: number): Promise<boolean> {
    const opened = await this.open(projectId);
    if (!opened) return false;
    try {
      const entity = opened.index.entityById(entityId);
      if (!entity || entity.kind !== 'person') return false;
      opened.index.deleteEntity(entityId);
      opened.index.markFaceClusterForgotten(entity.canonical);
      return true;
    } finally {
      opened.index.close();
    }
  }

  /** Data erasure: face vectors, clusters, gates, and person entities everywhere. */
  async wipeAllFaceData(projectIds: string[]): Promise<number> {
    let wiped = 0;
    for (const projectId of projectIds) {
      const opened = await this.open(projectId).catch(() => null);
      if (!opened) continue;
      try {
        opened.index.wipeFaceData();
        wiped++;
      } finally {
        opened.index.close();
      }
    }
    return wiped;
  }

  async listEntityMentions(
    projectId: string,
    entity: string,
    maxResults = 100,
  ): Promise<ListEntityMentionsResponse> {
    const opened = await this.open(projectId);
    if (!opened) return { found: false, mentions: [] };
    const { index } = opened;
    try {
      const match = index.findEntities(entity, { limit: 1 })[0];
      if (!match) return { found: false, mentions: [] };
      const mentions = index.entityMentions(match.id, maxResults).map((m) => {
        const date = index.getMetadata(m.filePath).date;
        const region = parseRegionJson(m.region);
        return {
          path: m.filePath,
          ...(m.line != null ? { line: m.line } : {}),
          ...(date ? { date } : {}),
          ...(region ? { region } : {}),
          ...(m.confidence != null ? { confidence: m.confidence } : {}),
        };
      });
      // Order by date when available (the entity_timeline view).
      mentions.sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));
      return { found: true, entity: { kind: match.kind, label: match.label }, mentions };
    } finally {
      index.close();
    }
  }

  /**
   * Aggregate file-shape profile for a project — extension + modality
   * histograms over the indexed `files`. Feeds project-type detection.
   * Returns null when the project has no index yet.
   */
  async languageProfile(projectId: string): Promise<{
    fileCount: number;
    extensions: Record<string, number>;
    modalities: Record<string, number>;
  } | null> {
    const opened = await this.open(projectId);
    if (!opened) return null;
    try {
      return {
        fileCount: opened.index.fileCount(),
        extensions: opened.index.extensionCounts(),
        modalities: opened.index.modalityCounts(),
      };
    } finally {
      opened.index.close();
    }
  }

  /** Rebuild entities on demand (also runs automatically during refresh). */
  async buildEntities(projectId: string): Promise<{ entities: number; mentions: number } | null> {
    const opened = await this.open(projectId);
    if (!opened) return null;
    try {
      return buildEntitiesFromMetadata(opened.index);
    } finally {
      opened.index.close();
    }
  }

  // ── internals ──────────────────────────────────────────────────────────

  /**
   * Convert tabular files the interactive pass deferred for being too large.
   *
   * Same drain, night budgets. A 2 GB CSV is refused during indexing because a
   * user is waiting on that pass; at night nobody is, so the size ceiling and
   * the per-run cap both lift. Returns null when the project has nothing to do
   * or has opted out.
   */
  async drainWorkspaceTablesAtNight(projectId: string): Promise<DrainResult | null> {
    if (!this.duck) return null;
    let allowed = false;
    try {
      const meta = await this.store.getProject(projectId);
      allowed = meta != null && meta.indexingEnabled !== false && projectAllowsWorkspaceTables(meta);
    } catch {
      allowed = false;
    }
    if (!allowed) return null;

    const opened = await this.open(projectId);
    if (!opened) return null;
    try {
      return await drainWorkspaceTables({
        store: opened.index,
        duck: this.duck,
        storageDir: opened.artifactsDir,
        workspaceDir: opened.workspaceDir,
        maxTables: NIGHT_MAX_TABLES_PER_DRAIN,
        maxInlineBytes: NIGHT_MAX_INLINE_BYTES,
      });
    } finally {
      opened.index.close();
    }
  }

  private async open(projectId: string): Promise<{
    index: IndexStore;
    workspaceDir: string;
    artifactsDir: string;
    dbPath: string;
    isLibrary: boolean;
  } | null> {
    let workspaceDir: string;
    try {
      workspaceDir = await this.store.projectWorkspaceDir(projectId);
    } catch {
      return null;
    }
    if (!workspaceDir) return null;
    const artifactsDir = this.store.projectArtifactsDir(projectId);

    const open = (dbPath: string) =>
      IndexStore.open(dbPath, {
        collectionId: projectId,
        kind: 'workspace',
        rootPath: workspaceDir,
      });

    // A machine-shared workspace is a collaborative content tree, not a safe
    // home for a mutable SQLite database opened by every account daemon.
    // Build the same derived index independently in each account's sidecar.
    // The shared library's workspace is the user's documents folder, which
    // may be cloud-synced: its database stays home-side regardless.
    // Method-guarded, not just catch-wrapped: a narrow store double without
    // `getProject` would throw synchronously and fail the whole open.
    const meta =
      typeof this.store.getProject === 'function'
        ? await this.store.getProject(projectId).catch(() => null)
        : null;
    const isLibrary = meta ? isSharedLibraryProject(meta) : false;
    let dbPath = projectContentIndexDbFile(this.home, projectId, workspaceDir, {
      ...(isLibrary ? { forceHomeSide: true } : {}),
    });
    let index: IndexStore | null;
    try {
      index = await open(dbPath);
    } catch (error) {
      // A busy/locked primary EXISTS and is mid-write (the static worker
      // holds long transactions during a full pass). Falling back would mint
      // an empty home-side db whose zero counts masquerade as real status —
      // report "unavailable this call" and let the next poll succeed.
      if (isTransientIndexError(error)) return null;
      index = null;
    }
    if (!index) {
      // Workspace `.gezel/` not writable — fall back to the home-local dir.
      dbPath = join(fallbackProjectIndexDir(this.home, projectId), 'index.db');
      index = await open(dbPath).catch(() => null);
    }
    if (index) await this.syncFindingLifecycle(projectId, index, false);
    return index ? { index, workspaceDir, artifactsDir, dbPath, isLibrary } : null;
  }

  private async syncFindingLifecycle(
    projectId: string,
    index: IndexStore,
    reconcile: boolean,
  ): Promise<void> {
    if (typeof this.store.readProjectFindingLifecycle !== 'function') return;
    if (reconcile && typeof this.store.reconcileProjectFindingLifecycle === 'function') {
      await this.store.reconcileProjectFindingLifecycle(
        projectId,
        index.securityFindingFingerprints(),
      );
    }
    const lifecycle = await this.store.readProjectFindingLifecycle(projectId);
    index.syncSecurityFindingLifecycle(lifecycle);
  }
}

function toSym(h: {
  id: string;
  name: string;
  kind: string;
  lineStart: number;
  lineEnd: number;
  signature?: string;
  parent?: string;
}): {
  id: string;
  name: string;
  kind: string;
  lineStart: number;
  lineEnd: number;
  signature?: string;
  parent?: string;
} {
  return {
    id: h.id,
    name: h.name,
    kind: h.kind,
    lineStart: h.lineStart,
    lineEnd: h.lineEnd,
    ...(h.signature ? { signature: h.signature } : {}),
    ...(h.parent ? { parent: h.parent } : {}),
  };
}

function readSpan(
  content: string,
  path: string,
  name: string,
  kind: string,
  lineStart: number,
  lineEnd: number,
  signature?: string,
): ReadSymbolResponse {
  const lines = content.split(/\r?\n/);
  const slice = lines.slice(lineStart - 1, lineEnd).join('\n');
  const source =
    slice.length > MAX_READ_BYTES ? `${slice.slice(0, MAX_READ_BYTES)}\n…(truncated)` : slice;
  return {
    found: true,
    path,
    name,
    kind,
    lineStart,
    lineEnd,
    ...(signature ? { signature } : {}),
    source,
  };
}

/** Unref'd delay — must never hold the daemon open through a debounce window. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    (t as { unref?: () => void }).unref?.();
  });
}

/** Cosine similarity between two equal-length vectors. */
/** Tolerant parse of a face_vectors/entity_mentions region JSON column. */
function parseRegionJson(raw: string | null): ImageRegion | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ImageRegion> | null;
    if (
      parsed &&
      typeof parsed.x === 'number' &&
      typeof parsed.y === 'number' &&
      typeof parsed.w === 'number' &&
      typeof parsed.h === 'number'
    ) {
      return { x: parsed.x, y: parsed.y, w: parsed.w, h: parsed.h };
    }
  } catch {
    /* stored by us, but stay tolerant of hand-edited dbs */
  }
  return null;
}

function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

// ── security-intel helpers ──────────────────────────────────────────────────

const EMPTY_COUNTS = { total: 0, bySeverity: {}, byCategory: {}, bySource: {} };

/**
 * The persisted provenance of the last security_scan, as a spreadable
 * optional field. Absent (empty object) on pre-provenance databases and on
 * unparseable values — the renderer treats absence as "provenance unknown".
 */
function maybeScanProvenance(index: IndexStore): { provenance?: SecurityScanProvenance } {
  const raw = index.getMeta('security_scan_provenance');
  if (!raw) return {};
  try {
    return { provenance: SecurityScanProvenanceSchema.parse(JSON.parse(raw)) };
  } catch {
    return {};
  }
}

const ENTRY_RE =
  /(^|\/)(index|main|app|server|cli|worker|handler)\.(ts|tsx|js|mjs|cjs|py|go|rs|rb|php|java)$/i;
const ROUTE_PATH_RE = /(^|\/)(routes?|controllers?|handlers?|endpoints?|api|resolvers?)\//i;
const AUTH_PATH_RE =
  /(^|\/)(auth|authn|authz|middleware|guards?|permissions?|rbac|acl|session|login|oauth)([./]|$)/i;
const SECRET_PATH_RE = /(^|\/)(\.env|config|secrets?|credentials?|keys?)([./]|$)/i;
const SINK_CATEGORIES = new Set([
  'injection',
  'command-injection',
  'xss',
  'ssrf',
  'path-traversal',
  'deserialization',
  'crypto',
]);

interface AttackSurface {
  entryPoints: string[];
  routes: string[];
  authBoundaries: string[];
  secretTouchpoints: string[];
  taintSources: Array<{ path: string; count: number }>;
}

/** Derive the attack surface from file paths + persisted findings (no content read). */
function computeAttackSurface(files: string[], findings: SecurityFindingRow[]): AttackSurface {
  const routes = new Set<string>();
  const auth = new Set<string>();
  const secrets = new Set<string>();
  const entry: string[] = [];
  for (const p of files) {
    if (ENTRY_RE.test(p)) entry.push(p);
    if (ROUTE_PATH_RE.test(p)) routes.add(p);
    if (AUTH_PATH_RE.test(p)) auth.add(p);
    if (SECRET_PATH_RE.test(p)) secrets.add(p);
  }
  const sourceCount = new Map<string, number>();
  for (const f of findings) {
    if (f.category === 'taint-source') {
      if (f.ruleId === 'source.http-input') routes.add(f.filePath);
      if (f.ruleId === 'source.process-env') secrets.add(f.filePath);
      sourceCount.set(f.filePath, (sourceCount.get(f.filePath) ?? 0) + 1);
    }
    if (f.category === 'secret') secrets.add(f.filePath);
    if (f.category === 'auth') auth.add(f.filePath);
  }
  const cap = (s: Iterable<string>) => [...s].sort().slice(0, 100);
  return {
    entryPoints: entry.sort().slice(0, 50),
    routes: cap(routes),
    authBoundaries: cap(auth),
    secretTouchpoints: cap(secrets),
    taintSources: [...sourceCount.entries()]
      .map(([path, count]) => ({ path, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 100),
  };
}

function toContextFinding(r: SecurityFindingRow): FileContextFinding {
  return {
    ruleId: r.ruleId,
    category: r.category,
    severity: r.severity,
    line: r.line,
    title: r.title,
    source: r.source,
  };
}

function toWireFinding(r: SecurityFindingRow): SecurityFindingWire {
  return {
    fingerprint: r.fingerprint,
    path: r.filePath,
    line: r.line,
    ruleId: r.ruleId,
    category: r.category,
    severity: r.severity,
    source: r.source,
    title: r.title,
    ...(r.evidence ? { evidence: r.evidence } : {}),
    status: r.status,
    ...(r.taskRef ? { taskRef: r.taskRef } : {}),
  };
}

function toReviewWire(row: FileReviewRow): FileReviewWire {
  return {
    notesMd: row.notesMd,
    issues: row.issues,
    health: row.health,
    healthReason: row.healthReason,
    model: row.model,
    provider: row.provider,
    gezelId: row.gezelId,
    gezelName: row.gezelName,
    appVersion: row.appVersion,
    reviewedAt: row.reviewedAt,
  };
}

function toBoekwachterIssueWire(
  record: ProjectBoekwachterIssueRecord,
  currentContentHash: string | null,
): BoekwachterIssue {
  return {
    id: record.id,
    ref: record.ref,
    fingerprint: record.fingerprint,
    path: record.path,
    severity: record.severity,
    category: record.category,
    message: record.message,
    ...(record.line !== undefined ? { line: record.line } : {}),
    status: record.status,
    seen: record.seenAt !== undefined,
    stale: currentContentHash === null || currentContentHash !== record.lastSeenContentHash,
    ...(record.taskRef ? { taskRef: record.taskRef } : {}),
    ...(record.dismissalReason ? { dismissalReason: record.dismissalReason } : {}),
    createdAt: record.createdAt,
    lastSeenAt: record.lastSeenAt,
    ...(record.lastCheckedAt ? { lastCheckedAt: record.lastCheckedAt } : {}),
    ...(record.seenAt ? { seenAt: record.seenAt } : {}),
    ...(record.resolvedAt ? { resolvedAt: record.resolvedAt } : {}),
    ...(record.dismissedAt ? { dismissedAt: record.dismissedAt } : {}),
  };
}

/**
 * The indexer updates asynchronously after a save. Compare its cheap change
 * gate with the live file before trusting the indexed hash so a freshly edited
 * file marks old BW anchors stale immediately, not one index tick later.
 */
async function currentIndexedHash(
  index: IndexStore,
  workspaceDir: string,
  path: string,
): Promise<string | null> {
  const indexed = index.getFile(path);
  if (!indexed?.hash) return null;
  const absolute = safeJoin(workspaceDir, path);
  if (!absolute) return null;
  const live = await stat(absolute).catch(() => null);
  if (!live || !live.isFile()) return null;
  return live.size === indexed.size && live.mtimeMs === indexed.mtimeMs ? indexed.hash : null;
}

function issueSeverityRank(severity: FileReviewIssueSeverity): number {
  return severity === 'major' ? 0 : severity === 'minor' ? 1 : 2;
}

function tallyBoekwachterIssues(
  issues: readonly BoekwachterIssue[],
  key: (issue: BoekwachterIssue) => string,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const issue of issues) {
    const value = key(issue);
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

function filterAndSortBoekwachterIssues(
  issues: BoekwachterIssue[],
  req: ListFileIssuesRequest,
): BoekwachterIssue[] {
  return issues
    .filter((issue) => {
      if (!req.includeClosed && issue.status !== 'open' && issue.status !== 'in_progress') {
        return false;
      }
      if (req.status && issue.status !== req.status) return false;
      if (req.severity && issue.severity !== req.severity) return false;
      if (req.category && issue.category !== req.category) return false;
      if (req.path && !issue.path.startsWith(req.path)) return false;
      return true;
    })
    .sort(
      (a, b) =>
        issueSeverityRank(a.severity) - issueSeverityRank(b.severity) ||
        a.ref.localeCompare(b.ref, undefined, { numeric: true }),
    );
}

function rubricKeys(rubrics: Map<string, ResolvedRubric>): Array<{ kind: string; hash: string }> {
  return [...rubrics.values()].map((r) => ({ kind: r.kind, hash: r.hash }));
}

/** Breadth-first reachable set from `start` over `adj`, bounded by hops + a cap. */
function bfsReach(adj: Map<string, string[]>, start: string, maxHops: number): string[] {
  const seen = new Set<string>([start]);
  let frontier = [start];
  const out: string[] = [];
  for (let hop = 0; hop < maxHops && frontier.length; hop++) {
    const next: string[] = [];
    for (const node of frontier) {
      for (const nb of adj.get(node) ?? []) {
        if (seen.has(nb)) continue;
        seen.add(nb);
        out.push(nb);
        next.push(nb);
        if (out.length >= 200) return out;
      }
    }
    frontier = next;
  }
  return out;
}

const SEVERITY_ORDER: SecuritySeverity[] = ['info', 'low', 'medium', 'high', 'critical'];
function severityRank(s: SecuritySeverity): number {
  return SEVERITY_ORDER.indexOf(s);
}
function maxSeverity(a: SecuritySeverity, b: SecuritySeverity): SecuritySeverity {
  return severityRank(b) > severityRank(a) ? b : a;
}

const SEARCH_STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'for',
  'how',
  'in',
  'is',
  'of',
  'on',
  'or',
  'the',
  'to',
  'with',
]);

function searchTokens(text: string): Set<string> {
  const tokens =
    text
      .normalize('NFKC')
      .toLocaleLowerCase()
      .match(/[\p{L}\p{N}_]+/gu) ?? [];
  return new Set(
    tokens
      .filter((token) => !SEARCH_STOP_WORDS.has(token))
      .map((token) => (token.length > 4 && token.endsWith('s') ? token.slice(0, -1) : token)),
  );
}
