/**
 * Catalog validation (gezk-format-v1.md §6.3) over an EXTRACTED catalog
 * directory: manifest parse, per-file hash reconciliation, read-only opens,
 * count reconciliation, and — in deep mode — SQLite quick_check, per-shard
 * vector-table alignment, the embedder-free self-KNN smoke, and the
 * manifest's own smoke queries against fts_documents. Never mutates the
 * catalog; every failure is a named check, not an exception.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { KnowledgeCatalogManifest } from '@bendyline/gezel';
import { KnowledgeCatalogManifestSchema } from '@bendyline/gezel';
import { MANIFEST_PATH, ROUTER_DB_PATH } from '../format/constants.js';
import { CatalogHandle } from './catalog-handle.js';
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
      const bytes = await readFile(join(rootDir, file.path));
      const sha = createHash('sha256').update(bytes).digest('hex');
      if (sha !== file.sha256) {
        check(`file:${file.path}`, false, `sha256 mismatch (expected ${file.sha256}, got ${sha})`);
      } else if (bytes.length !== file.sizeBytes) {
        check(
          `file:${file.path}`,
          false,
          `size mismatch (expected ${file.sizeBytes}, got ${bytes.length})`,
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

    // counts
    const topics = handle.topics();
    check('toc-present', topics.length >= 1, `${topics.length} topics`);
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
      for (const shard of handle.shards) {
        // A dedicated read-only connection per shard (immutable files share
        // fine), closed here — the handle's own connections are its to close.
        const conn = openCatalogDatabase(join(rootDir, shard.path));
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
            (db.prepare('SELECT COUNT(*) AS n FROM vec_chunks').get() as { n: number | bigint }).n,
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
        } finally {
          conn.close();
        }
        check(`self-knn:${shard.id}`, handle.selfKnnSmoke(shard.id));
      }

      for (const smoke of manifest.smokeQueries ?? []) {
        const hits = handle.searchDocumentsFts(smoke.query, 10).map((h) => h.documentId);
        const missing = smoke.expectedDocumentIds.filter((id) => !hits.includes(id));
        check(
          `smoke:${smoke.query}`,
          missing.length === 0,
          missing.length > 0 ? `missing ${missing.join(', ')}` : undefined,
        );
      }
    }
  } finally {
    handle.close();
  }

  return report(manifest);
}
