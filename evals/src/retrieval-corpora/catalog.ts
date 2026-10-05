import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CatalogDocument } from '@bendyline/gezel';
import type { GezelClient } from '@bendyline/gezel-client/node';
import { KNOWLEDGE_EMBEDDING_PROFILES, compileKnowledgeCatalog } from '@bendyline/gezel-knowledge';
import { embedBatch, embedModelId } from '@bendyline/gezel-service';
import { waitForKnowledgeInstall } from '../knowledge-install.ts';

/**
 * Compile a `.gezk` with the DAEMON'S OWN embedder and install it over HTTP.
 * The catalog carries the registered, pinned profile of that model, so the
 * mount recognizes it as the daemon's vector space and the two-stage
 * semantic path runs — an ad-hoc profile (revision `daemon`, unpinned
 * tokenizer) mounts keyword-only since profiles became digest-pinned.
 * Throws when the mount is not vector-compatible, because a bench measuring
 * FTS while claiming to measure semantic search is worse than no bench.
 */
export async function compileAndInstallCatalog(
  client: GezelClient,
  spec: {
    publisherId: string;
    catalogId: string;
    version: string;
    name: string;
    description: string;
    topics: Array<{ id: string; name: string }>;
    documents: CatalogDocument[];
  },
  log: (line: string) => void,
): Promise<{ embedModel: string }> {
  const work = await mkdtemp(join(tmpdir(), `${spec.catalogId}-`));
  try {
    const archivePath = join(work, `${spec.catalogId}-${spec.version}.gezk`);
    const modelId = embedModelId();
    const profile = KNOWLEDGE_EMBEDDING_PROFILES.find((p) => p.model.repo === modelId);
    if (!profile) {
      throw new Error(
        `no registered knowledge embedding profile for the daemon embedder ${modelId} — catalog vectors would not share its space`,
      );
    }
    log(`[catalog] compiling ${spec.documents.length} documents with ${profile.id}`);
    await compileKnowledgeCatalog({
      catalog: {
        id: spec.catalogId,
        version: spec.version,
        name: spec.name,
        description: spec.description,
        language: 'en',
        publisher: { id: spec.publisherId, name: 'Gezel Bench' },
        createdAt: '2026-01-01T00:00:00.000Z',
        license: { name: 'MIT', attributionRequired: false },
      },
      topics: spec.topics,
      documents: (async function* () {
        for (const doc of spec.documents) yield doc;
      })(),
      outputPath: archivePath,
      embeddingProfile: profile,
      chunkingProfile: {
        id: 'markdown-chunks@2',
        unit: 'tokens',
        tokenizer: 'profile',
        target: 420,
        overlap: 64,
        contextHeader: { max: 64 },
      },
      embed: (texts) => embedBatch(texts),
      countTokens: (text) => (text.trim() ? text.trim().split(/\s+/).length : 0),
      workDir: join(work, 'staging'),
    });

    const { jobId } = await client.installKnowledgeCatalog({
      source: { kind: 'file', path: archivePath },
    });
    await waitForKnowledgeInstall(client, jobId, {
      label: spec.catalogId,
      log,
    });
    const { catalogs } = await client.listKnowledgeCatalogs();
    const status = catalogs.find((c) => c.ref.catalogId === spec.catalogId);
    if (!status?.mounted) throw new Error(`catalog ${spec.catalogId} did not mount`);
    if (status.vectorCompatible === false) {
      throw new Error(
        `catalog profile did not match the daemon embedder (${modelId}) — the bench would measure FTS, not the two-stage path`,
      );
    }
    log(`[catalog] ${spec.catalogId} installed and mounted (vector-compatible)`);
    return { embedModel: modelId };
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}
