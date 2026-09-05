/**
 * Catalog validation (the gezk spec §3.3 and §5) over an EXTRACTED catalog
 * directory: manifest parse, per-file hash reconciliation, read-only opens,
 * count reconciliation, and — in deep mode — SQLite quick_check, per-shard
 * vector-table alignment, the embedder-free self-KNN smoke, and the
 * manifest's own smoke queries against fts_documents. Never mutates the
 * catalog; every failure is a named check, not an exception.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { KnowledgeCatalogManifest } from '@bendyline/gezk';
import {
  KnowledgeCatalogManifestSchema,
  MAX_KNOWLEDGE_ASSETS_TOTAL_BYTES,
  MAX_KNOWLEDGE_ASSET_BYTES,
  MAX_KNOWLEDGE_ASSET_COUNT,
  assetExtension,
  assetKindForExtension,
  isKnowledgeAssetPath,
  sniffAssetType,
  svgInertnessProblem,
} from '@bendyline/gezk';
import { GEZK_ARCHIVE_LIMITS } from '../archive/read.js';
import {
  MANIFEST_PATH,
  MAX_KNOWLEDGE_DOCUMENT_BYTES,
  MAX_KNOWLEDGE_DOCUMENT_META_BYTES,
  MAX_KNOWLEDGE_TOPIC_DEPTH,
  ROUTER_DB_PATH,
} from '../format/constants.js';
import { hashFileStreaming } from '../format/file-hash.js';
import { CatalogHandle } from './catalog-handle.js';
import { SMOKE_QUERY_TOP_N } from './fts-query.js';
import { openCatalogDatabase } from './open.js';

export interface CatalogCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface CatalogValidationReport {
  ok: boolean;
  manifest: KnowledgeCatalogManifest | null;
  checks: CatalogCheck[];
}

export interface ValidateCatalogOptions {
  /** quick_check + vector alignment + self-KNN + smoke queries. */
  deep?: boolean;
}

export async function validateExtractedCatalog(
  rootDir: string,
  opts: ValidateCatalogOptions = {},
): Promise<CatalogValidationReport> {
  const checks: CatalogCheck[] = [];
  const check = (name: string, ok: boolean, detail?: string): boolean => {
    checks.push({ name, ok, ...(detail ? { detail } : {}) });
    return ok;
  };
  const report = (manifest: KnowledgeCatalogManifest | null): CatalogValidationReport => ({
    ok: checks.every((c) => c.ok),
    manifest,
    checks,
  });

  // manifest
  let manifest: KnowledgeCatalogManifest;
  try {
    manifest = KnowledgeCatalogManifestSchema.parse(
      JSON.parse(await readFile(join(rootDir, MANIFEST_PATH), 'utf8')),
    );
    check('manifest-parse', true);
  } catch (err) {
    check('manifest-parse', false, err instanceof Error ? err.message : String(err));
    return report(null);
  }

  // declared files: existence + sha256 + size
  for (const file of manifest.files) {
    try {
      const actual = await hashFileStreaming(
        join(rootDir, file.path),
        GEZK_ARCHIVE_LIMITS.maxEntryBytes,
      );
      if (actual.sha256 !== file.sha256) {
        check(
          `file:${file.path}`,
          false,
          `sha256 mismatch (expected ${file.sha256}, got ${actual.sha256})`,
        );
      } else if (actual.sizeBytes !== file.sizeBytes) {
        check(
          `file:${file.path}`,
          false,
          `size mismatch (expected ${file.sizeBytes}, got ${actual.sizeBytes})`,
        );
      } else {
        check(`file:${file.path}`, true);
      }
    } catch (err) {
      check(`file:${file.path}`, false, err instanceof Error ? err.message : String(err));
    }
  }
  if (!checks.every((c) => c.ok)) return report(manifest);

  // read-only open + meta echo
  let handle: CatalogHandle;
  try {
    handle = CatalogHandle.open(rootDir);
    check('router-open', true);
  } catch (err) {
    check('router-open', false, err instanceof Error ? err.message : String(err));
    return report(manifest);
  }

  try {
    check(
      'meta-echo',
      handle.meta.catalog_id === manifest.id && handle.meta.catalog_version === manifest.version,
      `router meta says ${handle.meta.catalog_id}@${handle.meta.catalog_version}`,
    );
    check(
      'meta-profile',
      handle.meta.embedding_profile_id === manifest.embedding.id,
      `router meta profile ${handle.meta.embedding_profile_id}`,
    );
    check(
      'meta-format',
      handle.formatVersion === manifest.formatVersion &&
        handle.schemaVersion === manifest.indexSchemaVersion,
      `router says format ${handle.formatVersion} / schema ${handle.schemaVersion}, manifest says ${manifest.formatVersion} / ${manifest.indexSchemaVersion}`,
    );

    // counts
    const topics = handle.topics();
    check('toc-present', topics.length >= 1, `${topics.length} topics`);
    check('topics-tree', ...topicTreeProblem(topics));
    const undeclared = handle.documentsWithUndeclaredTopic();
    check(
      'documents-topic-declared',
      undeclared === 0,
      `${undeclared} documents are filed under a topic the router does not declare`,
    );
    const assetFiles = manifest.files.filter((f) => f.path.startsWith('assets/'));
    if (manifest.formatVersion === '0.5') {
      check(
        'assets-not-in-0.5',
        assetFiles.length === 0,
        `${assetFiles.length} assets/ entries in a 0.5 catalog`,
      );
    } else {
      const badPaths = assetFiles.filter((f) => !isKnowledgeAssetPath(f.path)).map((f) => f.path);
      check('assets-paths', badPaths.length === 0, `invalid asset paths: ${badPaths.join(', ')}`);
      const oversize = assetFiles.filter((f) => f.sizeBytes > MAX_KNOWLEDGE_ASSET_BYTES);
      const totalBytes = assetFiles.reduce((sum, f) => sum + f.sizeBytes, 0);
      check(
        'assets-limits',
        assetFiles.length <= MAX_KNOWLEDGE_ASSET_COUNT &&
          oversize.length === 0 &&
          totalBytes <= MAX_KNOWLEDGE_ASSETS_TOTAL_BYTES,
        `${assetFiles.length} assets, ${totalBytes} bytes, ${oversize.length} over the per-asset limit`,
      );
      check(
        'counts-assets',
        (manifest.counts.assets ?? 0) === assetFiles.length,
        `manifest counts ${manifest.counts.assets ?? 0} assets, files declare ${assetFiles.length}`,
      );
    }
    check(
      'license-notice',
      manifest.files.some((f) => f.path === manifest.license.noticePath),
      `manifest.files lacks the declared notice ${manifest.license.noticePath}`,
    );
    const topicDocSum = topics.reduce((sum, t) => sum + t.documentCount, 0);
    check(
      'counts-documents',
      handle.documentsPage({ limit: 1 }).total === manifest.counts.documents &&
        topicDocSum === manifest.counts.documents,
      `documents table ${handle.documentsPage({ limit: 1 }).total}, topic sum ${topicDocSum}, manifest ${manifest.counts.documents}`,
    );
    check(
      'counts-shards',
      handle.shards.length === manifest.counts.shards,
      `shards table ${handle.shards.length}, manifest ${manifest.counts.shards}`,
    );
    const shardChunkSum = handle.shards.reduce((sum, s) => sum + s.chunkCount, 0);
    check(
      'counts-chunks',
      shardChunkSum === manifest.counts.chunks,
      `shard rows sum ${shardChunkSum}, manifest ${manifest.counts.chunks}`,
    );

    if (opts.deep) {
      const routerQuick = handle.routerQuickCheck();
      check('quick-check:index/router.db', routerQuick === 'ok', routerQuick);
      const bodies = handle.documentBodyProfile();
      check(
        'document-body-codecs',
        bodies.unknownCodecs === 0,
        `${bodies.unknownCodecs} documents use an unknown body codec`,
      );
      check(
        'document-body-raw-limit',
        bodies.maxRawBytes <= MAX_KNOWLEDGE_DOCUMENT_BYTES,
        `largest raw body is ${bodies.maxRawBytes} bytes`,
      );
      check(
        'document-body-compressed-limit',
        bodies.maxCompressedBytes <= MAX_KNOWLEDGE_DOCUMENT_BYTES + 1024,
        `largest compressed body is ${bodies.maxCompressedBytes} bytes`,
      );
      for (const shard of handle.shards) {
        // A dedicated read-only connection per shard (immutable files share
        // fine), closed here — the handle's own connections are its to close.
        const conn = openCatalogDatabase(handle.resolveCatalogPath(shard.path));
        const db = conn.db;
        try {
          const quick = db.prepare('PRAGMA quick_check').get() as { quick_check?: string };
          check(
            `quick-check:${shard.path}`,
            quick.quick_check === 'ok',
            quick.quick_check ?? 'no result',
          );
          const chunkCount = Number(
            (db.prepare('SELECT COUNT(*) AS n FROM chunks').get() as { n: number | bigint }).n,
          );
          const vecCount = Number(
            (
              db.prepare('SELECT COUNT(*) AS n FROM chunk_vectors_bit').get() as {
                n: number | bigint;
              }
            ).n,
          );
          const int8Count = Number(
            (
              db.prepare('SELECT COUNT(*) AS n FROM chunk_vectors_int8').get() as {
                n: number | bigint;
              }
            ).n,
          );
          check(
            `vectors-aligned:${shard.path}`,
            chunkCount === shard.chunkCount && vecCount === chunkCount && int8Count === chunkCount,
            `chunks ${chunkCount}, vec ${vecCount}, int8 ${int8Count}, shards row ${shard.chunkCount}`,
          );
          const dims = manifest.embedding.dimensions;
          const badBit = Number(
            (
              db
                .prepare('SELECT COUNT(*) AS n FROM chunk_vectors_bit WHERE length(v) != ?')
                .get(Math.ceil(dims / 8)) as { n: number | bigint }
            ).n,
          );
          const badInt8 = Number(
            (
              db
                .prepare('SELECT COUNT(*) AS n FROM chunk_vectors_int8 WHERE length(v) != ?')
                .get(dims) as { n: number | bigint }
            ).n,
          );
          check(
            `vector-widths:${shard.path}`,
            badBit === 0 && badInt8 === 0,
            `${badBit} bit rows and ${badInt8} int8 rows have the wrong width for ${dims} dimensions`,
          );
          const span = db.prepare('SELECT MIN(id) AS lo, MAX(id) AS hi FROM chunks').get() as {
            lo: number | bigint | null;
            hi: number | bigint | null;
          };
          check(
            `chunk-ids-dense:${shard.path}`,
            chunkCount === 0 || (Number(span.lo) === 1 && Number(span.hi) === chunkCount),
            `ids span ${String(span.lo)}..${String(span.hi)} for ${chunkCount} chunks`,
          );
        } finally {
          conn.close();
        }
        check(`self-knn:${shard.id}`, handle.selfKnnSmoke(shard.id));
      }

      if (handle.schemaVersion >= 3) {
        const meta = handle.checkDocumentMeta(MAX_KNOWLEDGE_DOCUMENT_META_BYTES);
        check(
          'document-meta-json',
          meta.invalid.length === 0 && meta.oversize.length === 0,
          `${meta.invalid.length > 0 ? `not a JSON object: ${meta.invalid.join(', ')}` : ''}${meta.oversize.length > 0 ? ` over ${MAX_KNOWLEDGE_DOCUMENT_META_BYTES} bytes: ${meta.oversize.join(', ')}` : ''}`.trim(),
        );
        const declared = new Set(assetFiles.map((f) => f.path));
        for (const file of assetFiles) {
          const ext = assetExtension(file.path);
          if (!ext) continue;
          const bytes = await readFile(join(rootDir, file.path));
          const kind = sniffAssetType(bytes);
          check(
            `asset-type:${file.path}`,
            kind === assetKindForExtension(ext),
            `leading bytes say ${kind ?? 'unknown'}, the extension says ${assetKindForExtension(ext)}`,
          );
          if (ext === 'svg') {
            const problem = svgInertnessProblem(bytes);
            check(`asset-svg-inert:${file.path}`, problem === null, problem ?? undefined);
          }
        }
        if (declared.size > 0) {
          const missing: string[] = [];
          for (const doc of handle.documentBodies()) {
            for (const target of assetReferences(doc.markdown)) {
              if (!declared.has(target)) missing.push(`${doc.id} → ${target}`);
              if (missing.length >= 5) break;
            }
            if (missing.length >= 5) break;
          }
          check(
            'document-asset-refs',
            missing.length === 0,
            `undeclared asset references: ${missing.join('; ')}`,
          );
        }
      }

      for (const smoke of manifest.smokeQueries ?? []) {
        const hits = handle
          .searchDocumentsFts(smoke.query, SMOKE_QUERY_TOP_N)
          .map((h) => h.documentId);
        const missing = smoke.expectedDocumentIds.filter((id) => !hits.includes(id));
        check(
          `smoke:${smoke.query}`,
          missing.length === 0,
          missing.length > 0
            ? `the catalog's built-in sanity query "${smoke.query}" did not return its expected document${missing.length > 1 ? 's' : ''} (${missing.join(', ')}) in the top ${SMOKE_QUERY_TOP_N} results — the search index cannot answer queries the publisher recorded as guaranteed, so the archive is corrupt or was built by a broken toolchain; re-download it or report it to the publisher`
            : undefined,
        );
      }
    }
  } finally {
    handle.close();
  }

  return report(manifest);
}

/** `[…](assets/…)` and `![…](assets/…)` targets in a body, deduplicated. */
export function assetReferences(markdown: string): string[] {
  const found = new Set<string>();
  for (const match of markdown.matchAll(/\]\(\s*<?(assets\/[^)\s>]+)/g)) {
    const target = match[1];
    if (target) found.add(target);
  }
  return [...found];
}

/**
 * The topic forest must be acyclic, every parent declared, and no deeper
 * than MAX_KNOWLEDGE_TOPIC_DEPTH. Returns `[ok, detail]` for `check`.
 */
function topicTreeProblem(
  topics: Array<{ id: string; parentId: string | null }>,
): [boolean, string | undefined] {
  const byId = new Map(topics.map((t) => [t.id, t]));
  for (const topic of topics) {
    if (topic.parentId !== null && !byId.has(topic.parentId)) {
      return [false, `topic '${topic.id}' names an undeclared parent '${topic.parentId}'`];
    }
  }
  const depthOf = new Map<string, number>();
  for (const topic of topics) {
    const seen = new Set<string>();
    let depth = 0;
    let current: { id: string; parentId: string | null } | undefined = topic;
    while (current) {
      if (seen.has(current.id)) return [false, `topic '${topic.id}' sits in a parent cycle`];
      seen.add(current.id);
      depth += 1;
      if (depth > MAX_KNOWLEDGE_TOPIC_DEPTH) {
        return [false, `topic '${topic.id}' is deeper than ${MAX_KNOWLEDGE_TOPIC_DEPTH}`];
      }
      current = current.parentId === null ? undefined : byId.get(current.parentId);
    }
    depthOf.set(topic.id, depth);
  }
  return [true, `${topics.length} topics, max depth ${Math.max(0, ...depthOf.values())}`];
}
