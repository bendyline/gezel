import { readFile } from 'node:fs/promises';
import type { FileContextFinding, FileContextResponse, SymbolContext } from '@bendyline/gezel';
import { resolveImportEdgesDetailed, resolveSpecifier } from '../filemap/affinity.js';
import { safeJoin } from '../fs/safe-paths.js';
import { classifyFile } from './classify.js';
import type { SecurityFindingRow, SymbolHit } from './index-store-types.js';
import type { IndexStore } from './index-store.js';
import { toReviewWire } from './review-wire.js';
import { extractCodeSymbols, isCodeLangSupported } from './symbols.js';

// file-context caps — keep worst-case responses small and bounded.
const CTX_MAX_SYMBOLS = 200;
const CTX_MAX_IMPORTED_BY_PER_SYMBOL = 25;
const CTX_MAX_FILE_IMPORTED_BY = 100;
const CTX_MAX_USES = 50;
const CTX_MAX_USED_IN_FILE_BY = 50;

/**
 * Per-symbol intelligence for one file — the file viewer's context sections.
 * Structured facts only (hosts compose markdown): inbound importers via
 * named-binding matching, outbound `uses` + within-file `usedInFileBy` via a
 * single lexical identifier pass (honest, same stance as find-references),
 * findings assigned to the innermost containing symbol, and any LLM
 * one-liners the enrichment pass has produced for this content hash.
 */
export async function buildFileContext(
  index: IndexStore,
  workspaceDir: string,
  relPath: string,
): Promise<FileContextResponse> {
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

  const inRange = (line: number, s: SymbolHit): boolean => line >= s.lineStart && line <= s.lineEnd;

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
