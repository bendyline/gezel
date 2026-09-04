/**
 * add-knowledge-catalog — write (or update) a gilde `knowledge-catalog`
 * entry for a `.gezk` that is already uploaded to a Hugging Face dataset
 * repository.
 *
 * The entry pins the archive by commit sha + sha256, so the script resolves
 * the commit and reads the file's LFS digest from the Hub, then inspects the
 * operator's LOCAL copy of the archive for identity, counts, profile and
 * topics — and refuses when the local digest and the Hub's disagree. The
 * local copy is required on purpose: an authoring script that downloads
 * gigabytes it then throws away is the wrong shape, and the operator just
 * uploaded the file.
 *
 * Usage:
 *   pnpm --filter @bendyline/gezel-catalog add-knowledge-catalog -- \
 *     --repo Bendyline/wikipedia-physics --path releases/2026.9.1/wikipedia-physics-2026.9.1.gezk \
 *     --gezk /path/to/wikipedia-physics-2026.9.1.gezk [--revision main] [--parquet-dir parquet/2026.9.1] \
 *     [--min-gezel 1.26260] [--category encyclopedia] [--tags wikipedia,physics] [--upstream <url>]
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  KNOWLEDGE_EMBEDDING_PROFILE_IDS,
  type KnowledgeCatalogIdentity,
  KnowledgeCatalogIdentitySchema,
  type KnowledgeCatalogVersionManifest,
  KnowledgeCatalogVersionManifestSchema,
  type KnowledgeEmbeddingProfileId,
} from '@bendyline/gezel';
import { inspectGezkArchive } from '@bendyline/gezel-knowledge';
import { fetchHuggingfaceCommit, fetchHuggingfaceTree } from '../src/hf-api.js';
import { requireGildeCheckout } from './gilde-checkout.js';

async function sha256File(path: string): Promise<string> {
  const hasher = createHash('sha256');
  for await (const chunk of createReadStream(path)) hasher.update(chunk as Buffer);
  return hasher.digest('hex');
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      repo: { type: 'string' },
      path: { type: 'string' },
      gezk: { type: 'string' },
      revision: { type: 'string', default: 'main' },
      'parquet-dir': { type: 'string' },
      'min-gezel': { type: 'string' },
      category: { type: 'string' },
      tags: { type: 'string' },
      upstream: { type: 'string' },
    },
  });
  if (!values.repo || !values.path || !values.gezk) {
    throw new Error('--repo, --path and --gezk are required');
  }
  const { dataDir } = requireGildeCheckout();

  const inspection = await inspectGezkArchive(values.gezk);
  const manifest = inspection.manifest;
  if (!(KNOWLEDGE_EMBEDDING_PROFILE_IDS as readonly string[]).includes(manifest.embedding.id)) {
    throw new Error(
      `embedding profile ${manifest.embedding.id} is not one gezel can query (${KNOWLEDGE_EMBEDDING_PROFILE_IDS.join(', ')})`,
    );
  }
  const localSha = await sha256File(values.gezk);
  const localBytes = readFileSync(values.gezk).byteLength;

  const commit = await fetchHuggingfaceCommit(values.repo, {
    rev: values.revision,
    repoType: 'dataset',
  });
  const tree = await fetchHuggingfaceTree(values.repo, { rev: commit, repoType: 'dataset' });
  const entry = tree.find((f) => f.path === values.path);
  if (!entry) throw new Error(`${values.path} is not in ${values.repo}@${commit}`);
  if (!entry.lfsBacked) throw new Error(`${values.path} is not an LFS/Xet file on the Hub`);
  if (entry.sha256 !== localSha) {
    throw new Error(`local archive sha256 ${localSha} != Hub ${entry.sha256} for ${values.path}`);
  }
  if (entry.sizeBytes !== localBytes) {
    throw new Error(`local archive is ${localBytes} bytes, the Hub reports ${entry.sizeBytes}`);
  }

  const itemDir = join(dataDir, 'knowledge-catalogs', manifest.id.slice(0, 2), manifest.id);
  const identityPath = join(itemDir, 'manifest.json');
  const existing: Partial<KnowledgeCatalogIdentity> = existsSync(identityPath)
    ? (JSON.parse(readFileSync(identityPath, 'utf8')) as Partial<KnowledgeCatalogIdentity>)
    : {};
  const identity = KnowledgeCatalogIdentitySchema.parse({
    ...existing,
    schemaVersion: 1,
    kind: 'knowledge-catalog',
    id: manifest.id,
    name: manifest.name,
    description: manifest.description ?? existing.description ?? '',
    tags: values.tags
      ? values.tags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean)
      : (existing.tags ?? []),
    maintainer: {
      name: manifest.publisher.name,
      ...(manifest.publisher.url ? { url: manifest.publisher.url } : {}),
    },
    license: manifest.license.name,
    publisherId: manifest.publisher.id,
    language: manifest.language,
    ...(values.category ? { category: values.category } : {}),
    upstream:
      values.upstream ?? existing.upstream ?? `https://huggingface.co/datasets/${values.repo}`,
  });
  const version = KnowledgeCatalogVersionManifestSchema.parse({
    schemaVersion: 1,
    version: manifest.version,
    releasedAt: manifest.createdAt,
    ...(values['min-gezel'] ? { minGezelVersion: values['min-gezel'] } : {}),
    formatVersion: manifest.formatVersion,
    huggingface: { repo: values.repo, revision: commit, path: values.path },
    sha256: localSha,
    archiveBytes: localBytes,
    uncompressedBytes: inspection.totalUncompressedBytes,
    documents: manifest.counts.documents,
    chunks: manifest.counts.chunks,
    embeddingProfile: {
      id: manifest.embedding.id as KnowledgeEmbeddingProfileId,
      modelRepo: manifest.embedding.model.repo,
    },
    topics: manifest.topics,
    ...(manifest.sourceSnapshot ? { sourceSnapshot: manifest.sourceSnapshot } : {}),
    ...(values['parquet-dir']
      ? { parquet: { repo: values.repo, revision: commit, dir: values['parquet-dir'] } }
      : {}),
  } satisfies KnowledgeCatalogVersionManifest);

  const versionDir = join(itemDir, 'versions', version.version);
  const versionPath = join(versionDir, 'manifest.json');
  if (existsSync(versionPath) && readFileSync(versionPath, 'utf8') !== canonicalJson(version)) {
    throw new Error(`${versionPath} exists with different content; gilde versions are immutable`);
  }
  mkdirSync(versionDir, { recursive: true });
  writeFileSync(identityPath, canonicalJson(identity));
  writeFileSync(versionPath, canonicalJson(version));
  console.log(`[knowledge-catalog] wrote ${identityPath}`);
  console.log(`[knowledge-catalog] wrote ${versionPath}`);
  console.log(
    '[knowledge-catalog] next: cd ../gilde && npm run fix && npm run check, then open the gilde PR',
  );
}

main().catch((err) => {
  console.error(`[knowledge-catalog] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
