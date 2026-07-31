import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
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
  ListDependenciesResponse,
  ListEntityMentionsResponse,
  ListFileIssuesRequest,
  ListFileIssuesResponse,
  MapAttackSurfaceResponse,
  MapRepoResponse,
  OutlineFileResponse,
  ReadDocAsMarkdownResponse,
  ReadSymbolResponse,
  ScanFindingsRequest,
  ScanFindingsResponse,
  SearchCodeResponse,
  SearchDocsResponse,
  SearchImagesResponse,
  SecurityFindingWire,
  SecurityOverviewResponse,
  SecurityScanResponse,
  SymbolContext,
  TraceTaintResponse,
} from '@bendyline/gezel';
import { nowIso } from '@bendyline/gezel';
import {
  fallbackProjectIndexDir,
  fallbackProjectVillageFile,
  projectLocalIndexDbFile,
  projectLocalVillageFile,
} from '@bendyline/gezel/paths';
import {
  resolveImportEdges,
  resolveImportEdgesDetailed,
  resolveSpecifier,
} from '../filemap/affinity.js';
import { buildFileMap } from '../filemap/build.js';
import { VillageFileStore } from '../filemap/village-file.js';
import { safeJoin } from '../fs/safe-paths.js';
import type { Store } from '../fs/store.js';
import { runSecurityScan } from '../security/scan.js';
import { ARCHITECTURE_KEY, type AreaPassResult, runAreaPass } from './area-pass.js';
import { classifyFile } from './classify.js';
import { type ContentIndexStats, indexWorkspaceContent } from './content-indexer.js';
import { convertDocToMarkdown, docFilesPaths, writeConvertedMarkdown } from './docs.js';
import { type EnrichDeps, enrichFile } from './enrich.js';
import { buildEntitiesFromMetadata } from './entities.js';
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

// file-context caps — keep worst-case responses small and bounded.
const CTX_MAX_SYMBOLS = 200;
const CTX_MAX_IMPORTED_BY_PER_SYMBOL = 25;
const CTX_MAX_FILE_IMPORTED_BY = 100;
const CTX_MAX_USES = 50;
const CTX_MAX_USED_IN_FILE_BY = 50;

export class ContentIndex {
  /** Per-project village-file stores (they cache last-written content so
   *  no-change builds skip touching the user's repo). */
  private readonly cityStores = new Map<string, VillageFileStore>();

  constructor(
    private readonly store: Store,
    private readonly home: string,
  ) {}

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
    try {
      await ensureIndexGitignore(opened.workspaceDir);
      const stats = await indexWorkspaceContent(opened.index, opened.workspaceDir);
      // Scanner rows are rebuildable; lifecycle is durable Store state. A
      // completed refresh prunes lifecycle for findings that truly vanished,
      // then mirrors the surviving states back into SQLite for fast queries.
      await this.syncFindingLifecycle(projectId, opened.index, true);
      // Deterministic meta-boekwachter: rebuild entities from the metadata the
      // scan just refreshed (cheap; no model).
      buildEntitiesFromMetadata(opened.index);
      // Git churn/last-commit for the map's signals — before the map build so
      // the same tick that ingests churn also refreshes the persisted map.
      // Never throws; degrades to 'unavailable' without git.
      await refreshGitStats(opened.index, opened.workspaceDir);
      // Refresh the persisted city-map layout so it grows with the code. Failure
      // here must not break indexing — the map is a derived, regenerable view.
      try {
        await buildFileMap(opened.index, opened.workspaceDir, {
          persist: true,
          villageFile: this.cityStoreFor(projectId, opened.workspaceDir),
          userFacing: false,
        });
      } catch {
        /* layout build is best-effort */
      }
      return stats;
    } finally {
      opened.index.close();
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
            const { embedQuery } = await import('../memory/embeddings.js');
            queryVector = await embedQuery(query);
          } catch {
            queryVector = null; // embeddings disabled → keyword only
          }
        }
      }

      const hits = index.searchCodeHybrid(
        mode === 'keyword' ? null : queryVector,
        query,
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
    pending: number;
    embedModel?: string;
  } | null> {
    const opened = await this.open(projectId);
    if (!opened) return null;
    try {
      return opened.index.enrichmentCounts();
    } finally {
      opened.index.close();
    }
  }

  async enrich(
    projectId: string,
    deps: EnrichDeps,
    limit = 5,
  ): Promise<{ files: number; summarized: number; embedded: number } | null> {
    const opened = await this.open(projectId);
    if (!opened) return null;
    const { index, workspaceDir } = opened;
    try {
      const files = index.filesNeedingEnrichment(limit);
      let summarized = 0;
      let embedded = 0;
      for (const file of files) {
        const r = await enrichFile(index, workspaceDir, file, deps);
        if (r.summarized) summarized++;
        embedded += r.embedded;
      }
      return { files: files.length, summarized, embedded };
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
    try {
      const workspaceDir = await this.store.projectWorkspaceDir(projectId);
      if (existsSync(projectLocalIndexDbFile(workspaceDir))) return true;
    } catch {
      /* fall through to the home-scoped fallback */
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
  ): Promise<{ files: number; reviewed: number } | null> {
    if (!deps.review || !deps.model) return { files: 0, reviewed: 0 };
    const resolved = rubrics ?? (await resolveRubrics(this.store));
    if (resolved.size === 0) return { files: 0, reviewed: 0 };
    const opened = await this.open(projectId);
    if (!opened) return null;
    const { index, workspaceDir } = opened;
    try {
      let files = 0;
      let reviewed = 0;
      let consecutiveEmpty = 0;
      for (const rubric of resolved.values()) {
        if (files >= limit) break;
        const batch = index.filesNeedingReview(
          rubric.kind,
          rubric.hash,
          limit - files,
          MAX_REVIEW_ATTEMPTS,
        );
        for (const file of batch) {
          const r = await reviewFile(index, workspaceDir, file, rubric, deps);
          if (r.reviewed || r.attempted) files++;
          if (r.reviewed) reviewed++;
          if (r.emptyReply) {
            consecutiveEmpty++;
            if (consecutiveEmpty >= 3) return { files, reviewed };
          } else {
            consecutiveEmpty = 0;
          }
        }
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

  /** One file's boekwachter review (`file_review` tool). */
  async fileReview(projectId: string, relPath: string): Promise<FileReviewResponse> {
    const opened = await this.open(projectId);
    if (!opened) return { path: relPath, found: false };
    try {
      const fileRec = opened.index.getFile(relPath);
      if (!fileRec?.hash) return { path: relPath, found: false };
      const row = opened.index.getFileReview(fileRec.hash);
      if (!row) return { path: relPath, found: false, pending: true };
      return { path: relPath, found: true, review: toReviewWire(row) };
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
    if (!opened) return empty;
    const { index } = opened;
    try {
      const limit = Math.min(req.maxResults ?? 200, 1000);
      const { issues, counts } = index.fileIssues({
        ...(req.severity ? { severity: req.severity } : {}),
        ...(req.category ? { category: req.category } : {}),
        ...(req.path ? { pathPrefix: req.path } : {}),
        limit: limit + 1,
      });
      const rc = index.reviewCounts(rubricKeys(rubrics), MAX_REVIEW_ATTEMPTS);
      return {
        issues: issues.slice(0, limit).map((i) => ({
          path: i.path,
          severity: toIssueSeverity(i.severity),
          category: i.category,
          message: i.message,
          ...(i.line !== undefined ? { line: i.line } : {}),
        })),
        counts,
        truncated: issues.length > limit,
        indexed: index.fileCount() > 0,
        reviewedFiles: rc.reviewed,
        eligibleFiles: rc.eligible,
      };
    } finally {
      index.close();
    }
  }

  // ── doc-intel ────────────────────────────────────────────────────────────

  async searchDocs(projectId: string, query: string, maxResults = 20): Promise<SearchDocsResponse> {
    const opened = await this.open(projectId);
    if (!opened) return { results: [], engine: 'unavailable', truncated: false };
    const { index, workspaceDir } = opened;
    try {
      if (!index.ftsAvailable) return { results: [], engine: 'unavailable', truncated: false };
      const hits = index.searchDocs(query, maxResults + 1);
      const truncated = hits.length > maxResults;
      return {
        results: hits.slice(0, maxResults).map((h) => ({
          sourcePath: h.filePath,
          markdownPath: docFilesPaths(workspaceDir, h.filePath).mdRel,
          lineStart: h.lineStart,
          snippet: h.snippet,
        })),
        engine: 'fts',
        truncated,
      };
    } finally {
      index.close();
    }
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

    const paths = docFilesPaths(workspaceDir, relPath);
    let md = await readFile(paths.mdPath, 'utf8').catch(() => null);
    if (md == null) {
      // Convert on demand if the _files markdown isn't there yet.
      const conv = await convertDocToMarkdown(absSource);
      md = conv.markdown;
      if (md != null) await writeConvertedMarkdown(workspaceDir, relPath, md).catch(() => {});
    }
    if (md == null) return { found: false, sourcePath: relPath, truncated: false };
    const truncated = md.length > MAX_READ_BYTES;
    return {
      found: true,
      sourcePath: relPath,
      markdownPath: paths.mdRel,
      markdown: truncated ? `${md.slice(0, MAX_READ_BYTES)}\n…(truncated)` : md,
      truncated,
    };
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
      const chunkId = index.imageChunkId(relPath);
      const all = index.allImageVectors();
      const target = chunkId != null ? all.find((v) => v.chunkId === chunkId) : undefined;
      if (!target || all.length <= 1) {
        // No CLIP embeddings yet (boekwachter hasn't captioned images) → can't
        // do visual similarity. Degrades honestly.
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
        return {
          path: m.filePath,
          ...(m.line != null ? { line: m.line } : {}),
          ...(date ? { date } : {}),
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

  private async open(
    projectId: string,
  ): Promise<{ index: IndexStore; workspaceDir: string } | null> {
    let workspaceDir: string;
    try {
      workspaceDir = await this.store.projectWorkspaceDir(projectId);
    } catch {
      return null;
    }
    if (!workspaceDir) return null;

    const open = (dbPath: string) =>
      IndexStore.open(dbPath, {
        collectionId: projectId,
        kind: 'workspace',
        rootPath: workspaceDir,
      }).catch(() => null);

    let index = await open(projectLocalIndexDbFile(workspaceDir));
    if (!index) {
      // Workspace `.gezel/` not writable — fall back to the home-local dir.
      index = await open(join(fallbackProjectIndexDir(this.home, projectId), 'index.db'));
    }
    if (index) await this.syncFindingLifecycle(projectId, index, false);
    return index ? { index, workspaceDir } : null;
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

/** Cosine similarity between two equal-length vectors. */
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
    reviewedAt: row.reviewedAt,
  };
}

function rubricKeys(rubrics: Map<string, ResolvedRubric>): Array<{ kind: string; hash: string }> {
  return [...rubrics.values()].map((r) => ({ kind: r.kind, hash: r.hash }));
}

function toIssueSeverity(s: string): FileReviewIssueSeverity {
  return s === 'major' || s === 'minor' || s === 'info' ? s : 'info';
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
