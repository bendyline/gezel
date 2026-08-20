/**
 * `gezel knowledge` — the offline `.gezk` toolchain (init/build/validate/
 * inspect/search). No daemon: catalogs are ordinary files. This module is
 * loaded through the variable-dynamic-import seam in bin/gezel.ts (the
 * handboek-export pattern) so `@bendyline/gezel-knowledge` — and, on build/
 * semantic search, the transformers runtime — never load for ordinary CLI
 * startup.
 */

import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import type { CatalogDocument, KnowledgeCatalogManifest } from '@bendyline/gezel';
import { KnowledgeIdSchema, formatKnowledgeUri } from '@bendyline/gezel';
import type { ProfileEmbedder } from '@bendyline/gezel-knowledge';
import {
  CatalogHandle,
  EmbedderUnavailableError,
  GEZEL_MARKDOWN_CHUNKS_2,
  KNOWLEDGE_EMBEDDING_PROFILES,
  compileKnowledgeCatalog,
  createProfileEmbedder,
  extractGezkVerified,
  knowledgeEmbeddingProfile,
  loadMarkdownCatalog,
  readGezkManifest,
  signManifest,
  validateExtractedCatalog,
} from '@bendyline/gezel-knowledge';
import { CliError } from './connection.js';

const CATALOG_JSON = 'catalog.json';
const CONTENT_DIR = 'content';

interface CatalogConfig {
  id: string;
  version: string;
  name: string;
  description?: string;
  language: string;
  publisher: { id: string; name: string; url?: string };
  license: { name: string; noticePath?: string; attributionRequired: boolean };
  profile?: string;
  createdAt?: string;
}

/** Test seam: build/search accept an injected embedder factory. */
export interface KnowledgeCommandDeps {
  createEmbedder?: (profileId: string) => Promise<ProfileEmbedder>;
}

function hfCacheDir(): string {
  if (process.env.GEZEL_HF_CACHE_DIR) return process.env.GEZEL_HF_CACHE_DIR;
  const home = process.env.GEZEL_HOME ?? join(homedir(), '.gezel');
  return join(home, 'engines', 'hf-cache');
}

async function defaultCreateEmbedder(profileId: string): Promise<ProfileEmbedder> {
  const profile = knowledgeEmbeddingProfile(profileId);
  if (!profile) {
    throw new CliError(
      `unknown embedding profile '${profileId}' — registered: ${KNOWLEDGE_EMBEDDING_PROFILES.map((p) => p.id).join(', ')}`,
    );
  }
  try {
    return await createProfileEmbedder(profile, { cacheDir: hfCacheDir() });
  } catch (err) {
    if (err instanceof EmbedderUnavailableError) throw new CliError(err.message);
    throw err;
  }
}

// ── init ────────────────────────────────────────────────────────────────────

export async function runKnowledgeInit(dir: string): Promise<void> {
  const root = resolve(dir);
  const configPath = join(root, CATALOG_JSON);
  const exists = await stat(configPath).then(
    () => true,
    () => false,
  );
  if (exists) throw new CliError(`${configPath} already exists`);
  await mkdir(join(root, CONTENT_DIR, 'Getting Started'), { recursive: true });
  const id = sanitizeCatalogId(basename(root));
  const config: CatalogConfig = {
    id,
    version: '1.0.0',
    name: basename(root),
    description: '',
    language: 'en',
    publisher: { id, name: basename(root) },
    license: { name: 'All rights reserved', attributionRequired: false },
    profile: 'gezel-bge-small-en-v1.5@1',
  };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  await writeFile(
    join(root, CONTENT_DIR, 'Getting Started', 'welcome.md'),
    '# Welcome\n\nPut Markdown files under content/ — folders become the table of contents.\n',
    'utf8',
  );
  console.log(`Initialized knowledge catalog at ${root}`);
  console.log(`  ${CATALOG_JSON} — identity, license, embedding profile`);
  console.log(`  ${CONTENT_DIR}/ — Markdown content (folders become topics)`);
  console.log(`Build with: gezel knowledge build ${dir}`);
}

function sanitizeCatalogId(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{Mark}/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
  return KnowledgeIdSchema.safeParse(slug).success ? slug : 'my-catalog';
}

// ── build ───────────────────────────────────────────────────────────────────

export async function runKnowledgeBuild(
  dir: string,
  opts: { out?: string; signKey?: string },
  deps: KnowledgeCommandDeps = {},
): Promise<void> {
  const root = resolve(dir);
  const config = await readCatalogConfig(root);
  const contentDir = join(root, CONTENT_DIR);
  const hasContentDir = await stat(contentDir).then(
    (s) => s.isDirectory(),
    () => false,
  );
  const source = await loadMarkdownCatalog(hasContentDir ? contentDir : root, {
    language: config.language,
  });
  const profileId = config.profile ?? 'gezel-bge-small-en-v1.5@1';
  const profile = knowledgeEmbeddingProfile(profileId);
  if (!profile) {
    throw new CliError(
      `catalog.json names unknown profile '${profileId}' — registered: ${KNOWLEDGE_EMBEDDING_PROFILES.map((p) => p.id).join(', ')}`,
    );
  }
  console.log(
    `Building ${config.id}@${config.version}: ${source.documents.length} documents, profile ${profileId}`,
  );
  console.log('Loading the embedding model (first run downloads it)…');
  const embedder = await (deps.createEmbedder ?? defaultCreateEmbedder)(profileId);

  const signKeyPem = opts.signKey ? await readFile(resolve(opts.signKey), 'utf8') : null;
  const outputPath = resolve(opts.out ?? join(root, `${config.id}-${config.version}.gezk`));
  const workDir = await mkdtemp(join(tmpdir(), 'gezk-build-'));
  try {
    let lastPct = -1;
    const report = await compileKnowledgeCatalog({
      catalog: {
        id: config.id,
        version: config.version,
        name: config.name,
        ...(config.description ? { description: config.description } : {}),
        language: config.language,
        publisher: config.publisher,
        createdAt: config.createdAt ?? new Date().toISOString(),
        license: config.license,
      },
      topics: source.topics,
      documents: (async function* (): AsyncIterable<CatalogDocument> {
        for (const doc of source.documents) yield doc;
      })(),
      outputPath,
      embeddingProfile: embedder.profile,
      chunkingProfile: GEZEL_MARKDOWN_CHUNKS_2,
      embed: (texts) => embedder.embed(texts),
      countTokens: (text) => embedder.countTokens(text),
      workDir,
      ...(signKeyPem ? { finalizeManifest: (manifest) => signManifest(manifest, signKeyPem) } : {}),
      onProgress: ({ done, total }) => {
        if (!process.stderr.isTTY || total === 0) return;
        const pct = Math.floor((done / total) * 100);
        if (pct !== lastPct) {
          lastPct = pct;
          process.stderr.write(`\rEmbedding chunks: ${done}/${total} (${pct}%)`);
        }
      },
    });
    if (process.stderr.isTTY && lastPct >= 0) process.stderr.write('\n');
    console.log(
      `Wrote ${outputPath} — ${report.documents} documents, ${report.chunks} chunks, ` +
        `${report.shards} shard${report.shards === 1 ? '' : 's'}, ${formatBytes(report.archiveBytes)}` +
        `${report.manifest.signature ? `, signed (key ${report.manifest.signature.keyId})` : ''}`,
    );
  } finally {
    await embedder.dispose().catch(() => {});
    await rm(workDir, { recursive: true, force: true });
  }
}

async function readCatalogConfig(root: string): Promise<CatalogConfig> {
  const configPath = join(root, CATALOG_JSON);
  let raw: string;
  try {
    raw = await readFile(configPath, 'utf8');
  } catch {
    throw new CliError(`no ${CATALOG_JSON} in ${root} — run 'gezel knowledge init ${root}' first`);
  }
  const parsed = JSON.parse(raw) as CatalogConfig;
  for (const field of ['id', 'version', 'name', 'language', 'publisher', 'license'] as const) {
    if (!parsed[field]) throw new CliError(`${CATALOG_JSON} is missing '${field}'`);
  }
  return parsed;
}

// ── validate ────────────────────────────────────────────────────────────────

export async function runKnowledgeValidate(path: string, opts: { deep?: boolean }): Promise<void> {
  const { rootDir, cleanup } = await materializeCatalog(path);
  try {
    const report = await validateExtractedCatalog(rootDir, { deep: opts.deep });
    for (const check of report.checks) {
      const mark = check.ok ? 'ok  ' : 'FAIL';
      console.log(`  ${mark}  ${check.name}${check.detail ? ` — ${check.detail}` : ''}`);
    }
    if (!report.ok) throw new CliError(`${basename(path)} failed validation`);
    console.log(
      `${basename(path)} is valid: ${report.manifest?.counts.documents} documents, ` +
        `${report.manifest?.counts.chunks} chunks${opts.deep ? ' (deep)' : ''}`,
    );
  } finally {
    await cleanup();
  }
}

// ── inspect ─────────────────────────────────────────────────────────────────

export async function runKnowledgeInspect(path: string): Promise<void> {
  const manifest = await manifestFor(resolve(path));
  const rows: Array<[string, string]> = [
    ['catalog', `${manifest.id}@${manifest.version} — ${manifest.name}`],
    ['publisher', `${manifest.publisher.name} (${manifest.publisher.id})`],
    ['language', manifest.language],
    ['license', manifest.license.name],
    ['created', manifest.createdAt],
    [
      'counts',
      `${manifest.counts.documents} documents, ${manifest.counts.chunks} chunks, ${manifest.counts.shards} shard${manifest.counts.shards === 1 ? '' : 's'}`,
    ],
    ['topics', manifest.topics.map((t) => t.name).join(', ')],
    ['profile', `${manifest.embedding.id} (${manifest.embedding.model.repo})`],
    ['chunking', manifest.chunking.id],
    ['signature', manifest.signature ? `ed25519, key ${manifest.signature.keyId}` : 'unsigned'],
    [
      'files',
      `${manifest.files.length} (${formatBytes(manifest.files.reduce((s, f) => s + f.sizeBytes, 0))} extracted)`,
    ],
  ];
  if (manifest.description) rows.splice(1, 0, ['description', manifest.description]);
  const width = Math.max(...rows.map(([k]) => k.length));
  for (const [key, value] of rows) console.log(`${key.padEnd(width)}  ${value}`);
}

// ── search ──────────────────────────────────────────────────────────────────

export async function runKnowledgeSearch(
  path: string,
  query: string,
  opts: { semantic?: boolean; limit?: number },
  deps: KnowledgeCommandDeps = {},
): Promise<void> {
  const limit = Math.min(50, Math.max(1, opts.limit ?? 10));
  const { rootDir, cleanup } = await materializeCatalog(path);
  try {
    const manifest = JSON.parse(
      await readFile(join(rootDir, 'manifest.json'), 'utf8'),
    ) as KnowledgeCatalogManifest;
    const handle = CatalogHandle.open(rootDir);
    try {
      const docHits = handle.searchDocumentsFts(query, limit);
      if (docHits.length > 0) {
        console.log('Documents:');
        for (const hit of docHits) {
          const doc = handle.getDocument(hit.documentId);
          console.log(
            `  ${doc?.title ?? hit.documentId}  ${formatKnowledgeUri({ catalogId: manifest.id, documentId: hit.documentId })}`,
          );
        }
      }

      let chunkHits = handle.searchChunksFts(
        query,
        handle.shards.map((s) => s.id),
        Math.ceil(limit / Math.max(1, handle.shards.length)),
      );
      if (opts.semantic) {
        const embedder = await (deps.createEmbedder ?? defaultCreateEmbedder)(
          manifest.embedding.id,
        );
        try {
          const vector = await embedder.embedQuery(query);
          chunkHits = [...handle.searchSemantic(vector, { finalK: limit }), ...chunkHits];
        } finally {
          await embedder.dispose().catch(() => {});
        }
      }
      const seen = new Set<string>();
      const deduped = chunkHits.filter((h) => !seen.has(h.chunkUid) && seen.add(h.chunkUid));
      if (deduped.length > 0) {
        console.log(opts.semantic ? 'Passages (semantic + full-text):' : 'Passages (full-text):');
        for (const hit of deduped.slice(0, limit)) {
          const uri = formatKnowledgeUri({
            catalogId: manifest.id,
            documentId: hit.documentId,
            fragment: { chunk: hit.chunkUid },
          });
          const score = hit.cosine !== undefined ? ` (${hit.cosine.toFixed(3)})` : '';
          console.log(`  ${hit.title}${score}  ${uri}`);
          console.log(`    ${excerpt(hit.text)}`);
        }
      }
      if (docHits.length === 0 && deduped.length === 0) {
        console.log(`No results for "${query}".`);
        process.exitCode = 1;
      }
    } finally {
      handle.close();
    }
  } finally {
    await cleanup();
  }
}

// ── shared ──────────────────────────────────────────────────────────────────

/** Accepts a `.gezk` archive (verified extract to tmp) or an extracted dir. */
async function materializeCatalog(
  path: string,
): Promise<{ rootDir: string; cleanup: () => Promise<void> }> {
  const abs = resolve(path);
  const info = await stat(abs).catch(() => null);
  if (!info) throw new CliError(`no such file or directory: ${abs}`);
  if (info.isDirectory()) {
    const hasManifest = await stat(join(abs, 'manifest.json')).then(
      () => true,
      () => false,
    );
    if (!hasManifest) throw new CliError(`${abs} has no manifest.json — not an extracted catalog`);
    return { rootDir: abs, cleanup: async () => {} };
  }
  const dest = await mkdtemp(join(tmpdir(), 'gezk-cli-'));
  try {
    await extractGezkVerified(abs, dest);
  } catch (err) {
    await rm(dest, { recursive: true, force: true });
    throw new CliError(
      `archive verification failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return { rootDir: dest, cleanup: () => rm(dest, { recursive: true, force: true }) };
}

async function manifestFor(abs: string): Promise<KnowledgeCatalogManifest> {
  const info = await stat(abs).catch(() => null);
  if (!info) throw new CliError(`no such file or directory: ${abs}`);
  if (info.isDirectory()) {
    return JSON.parse(await readFile(join(abs, 'manifest.json'), 'utf8'));
  }
  return readGezkManifest(abs);
}

function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 160 ? `${flat.slice(0, 159)}…` : flat;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** Kept for parity with other command modules' hash-stamp helpers. */
export function contentSha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
