/**
 * `gezel knowledge` — the offline `.gezk` toolchain (init/build/validate/
 * inspect/search). No daemon: catalogs are ordinary files. This module is
 * loaded through the variable-dynamic-import seam in bin/gezel.ts (the
 * handboek-export pattern) so `@bendyline/gezel-knowledge` — and, on build/
 * semantic search, the transformers runtime — never load for ordinary CLI
 * startup.
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { CatalogDocument, KnowledgeCatalogManifest } from '@bendyline/gezel';
import {
  KnowledgeIdSchema,
  type KnowledgeRadius,
  KnowledgeRadiusSchema,
  formatKnowledgeUri,
} from '@bendyline/gezel';
import type {
  CompileAsset,
  KnowledgeEmbeddingProfile,
  MediaEmbedder,
  ProfileEmbedder,
  TableOfContentsFormat,
} from '@bendyline/gezel-knowledge';
import {
  CatalogHandle,
  EmbedderUnavailableError,
  KNOWLEDGE_EMBEDDING_PROFILES,
  MARKDOWN_CHUNKS_2,
  TRANSFORMERS_PEER_RANGE,
  compileKnowledgeCatalog,
  createProfileEmbedder,
  detectTableOfContents,
  extractGezkVerified,
  knowledgeEmbeddingProfile,
  loadMarkdownCatalog,
  readGezkManifest,
  readMkdocsDocsDir,
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
  license: { name: string; spdx?: string; noticePath?: string; attributionRequired: boolean };
  profile?: string;
  createdAt?: string;
  /** Content root relative to the catalog folder; default `content/` when present, else the folder. */
  content?: string;
  /** Content-relative Markdown files to leave out of the catalog. */
  ignore?: string[];
  /** Where the table of contents comes from; detected from the tree when absent. */
  toc?: { format: TableOfContentsFormat; path?: string };
  /**
   * Per-asset attribution (license, author, source URL, …), keyed by the
   * archive path (`assets/…`) or the content-relative path. Shipped photos,
   * video and audio usually carry their own terms; readers show these beside
   * the media row.
   */
  assets?: Record<string, Record<string, string>>;
}

/** Test seam: build/search accept an injected embedder factory. */
export interface KnowledgeCommandDeps {
  createEmbedder?: (profileId: string) => Promise<ProfileEmbedder>;
  /** Test seam: the media embedder for profiles that describe media encoders. */
  createMediaEmbedder?: (profile: KnowledgeEmbeddingProfile) => Promise<CatalogMediaEmbedder>;
}

interface CatalogMediaEmbedder {
  embedMedia: MediaEmbedder;
  dispose(): Promise<void>;
}

async function defaultCreateMediaEmbedder(
  profile: KnowledgeEmbeddingProfile,
): Promise<CatalogMediaEmbedder> {
  const { createCatalogMediaEmbedder } = await import('@bendyline/gezel-service/media');
  return createCatalogMediaEmbedder(profile, {
    cacheDir: hfCacheDir(),
    onWarning: (message) => console.warn(`warning: ${message}`),
  });
}

/** Attach catalog.json's per-asset attribution to the assets the adapter found. */
function withAssetAttribution(
  assets: CompileAsset[],
  attribution: CatalogConfig['assets'],
): CompileAsset[] {
  if (!attribution) return assets;
  const known = new Set(assets.map((a) => a.path));
  for (const key of Object.keys(attribution)) {
    const path = key.startsWith('assets/') ? key : `assets/${key}`;
    if (!known.has(path))
      console.warn(`warning: catalog.json assets: '${key}' is not an asset of this catalog`);
  }
  return assets.map((asset) => {
    const entry = attribution[asset.path] ?? attribution[asset.path.replace(/^assets\//, '')];
    return entry ? { ...asset, attribution: entry } : asset;
  });
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
    if (err instanceof EmbedderUnavailableError) {
      // A missing runtime is the one unavailability with a known fix; keep the
      // library's own message for the others (a profile it cannot serve).
      throw new CliError(err.runtimeMissing ? embeddingRuntimeMissingMessage() : err.message);
    }
    throw err;
  }
}

/**
 * What a person can do when the embedding runtime is missing. The npm packages
 * leave `@huggingface/transformers` out on purpose (docs/npm-release.md), so a
 * plain npm install of the CLI builds no catalog until it is added where Gezel
 * is installed. Only building and `--semantic` search need it.
 */
export function embeddingRuntimeMissingMessage(): string {
  const spec = `@huggingface/transformers@${TRANSFORMERS_PEER_RANGE}`;
  return [
    'Building a catalog and --semantic search need the embedding runtime, which an npm install of Gezel leaves out.',
    'Add it where Gezel is installed:',
    `  npm install -g ${spec}    if you installed gezel with npm install -g`,
    `  npm install ${spec}       in the project where you installed gezel`,
    'The Gezel desktop app already includes it, and full-text search works without it.',
  ].join('\n');
}

// ── init ────────────────────────────────────────────────────────────────────

/**
 * Whether the folder already holds Markdown: a documentation tree to catalog
 * in place. Scaffolding `content/` there would shadow the whole tree, since
 * build prefers `content/` when it exists.
 */
async function holdsMarkdown(dir: string): Promise<boolean> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const visible = entries.filter((e) => !e.name.startsWith('.') && e.name !== 'node_modules');
  if (visible.some((e) => e.isFile() && /\.(md|markdown)$/i.test(e.name))) return true;
  for (const entry of visible) {
    if (entry.isDirectory() && (await holdsMarkdown(join(dir, entry.name)))) return true;
  }
  return false;
}

export async function runKnowledgeInit(dir: string): Promise<void> {
  const root = resolve(dir);
  const configPath = join(root, CATALOG_JSON);
  const exists = await stat(configPath).then(
    () => true,
    () => false,
  );
  if (exists) throw new CliError(`${configPath} already exists`);
  const inPlace = await holdsMarkdown(root);
  await mkdir(inPlace ? root : join(root, CONTENT_DIR, 'Getting Started'), { recursive: true });
  const id = sanitizeCatalogId(basename(root));
  const config: CatalogConfig = {
    id,
    version: '1.0.0',
    name: basename(root),
    description: '',
    language: 'en',
    publisher: { id, name: basename(root) },
    license: { name: 'All rights reserved', attributionRequired: false },
    profile: 'bge-small-en-v1.5@1',
  };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  if (!inPlace) {
    await writeFile(
      join(root, CONTENT_DIR, 'Getting Started', 'welcome.md'),
      '# Welcome\n\nPut Markdown files under content/ — folders become the table of contents.\n',
      'utf8',
    );
  }
  console.log(`Initialized knowledge catalog at ${root}`);
  console.log(`  ${CATALOG_JSON} — identity, license, embedding profile`);
  if (inPlace) {
    const toc = await detectTableOfContents(root);
    console.log(
      `  The Markdown already in this folder is the content (table of contents: ${describeToc(toc, root)})`,
    );
  } else {
    console.log(`  ${CONTENT_DIR}/ — Markdown content (folders become topics)`);
  }
  console.log(
    '  An outline the tree already has is honored: SUMMARY.md, an mkdocs.yml nav, _toc.yml, docfx toc.yml files, or Hugo _index.md pages',
  );
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

async function isDirectory(path: string): Promise<boolean> {
  return stat(path).then(
    (s) => s.isDirectory(),
    () => false,
  );
}

/**
 * Where the Markdown lives: `content` from catalog.json, else `content/`,
 * else — for an MkDocs project pointed at directly — its `docs_dir`, else
 * the catalog folder itself.
 */
async function resolveContentRoot(root: string, config: CatalogConfig): Promise<string> {
  if (config.content) {
    const dir = resolve(root, config.content);
    if (!(await isDirectory(dir))) {
      throw new CliError(
        `${CATALOG_JSON} names content '${config.content}', which is not a directory`,
      );
    }
    return dir;
  }
  const contentDir = join(root, CONTENT_DIR);
  if (await isDirectory(contentDir)) return contentDir;
  if (config.toc === undefined || config.toc.format === 'mkdocs') {
    const mkdocs = config.toc?.path
      ? resolve(root, config.toc.path)
      : [join(root, 'mkdocs.yml'), join(root, 'mkdocs.yaml')].find((p) => existsSync(p));
    if (mkdocs && existsSync(mkdocs)) {
      const docsDir = await readMkdocsDocsDir(mkdocs);
      if (await isDirectory(docsDir)) return docsDir;
    }
  }
  return root;
}

/** A path relative to the catalog folder when it lies inside, else absolute. */
function displayPath(root: string, path: string): string {
  const rel = relative(root, path);
  if (rel === '') return '.';
  return rel.startsWith('..') || isAbsolute(rel) ? path : rel;
}

function describeToc(toc: { format: TableOfContentsFormat; path?: string }, root: string): string {
  const source =
    toc.format === 'folders'
      ? 'folders'
      : toc.format === 'hugo'
        ? 'Hugo conventions (_index.md, weight)'
        : toc.format;
  return toc.path ? `${source} (${displayPath(root, toc.path)})` : source;
}

export async function runKnowledgeBuild(
  dir: string,
  opts: { out?: string; signKey?: string; skipImages?: boolean },
  deps: KnowledgeCommandDeps = {},
): Promise<void> {
  const root = resolve(dir);
  const config = await readCatalogConfig(root);
  const contentRoot = await resolveContentRoot(root, config);
  const toc = config.toc ?? (await detectTableOfContents(contentRoot, root));
  const source = await loadMarkdownCatalog(contentRoot, {
    language: config.language,
    uri: { publisherId: config.publisher.id, catalogId: config.id },
    ...(config.ignore ? { ignore: config.ignore } : {}),
    toc,
    skipImages: opts.skipImages ?? false,
    onWarning: (message) => console.warn(`warning: ${message}`),
  });
  console.log(`Content: ${displayPath(root, contentRoot)}`);
  console.log(`Table of contents: ${describeToc(source.toc, root)}`);
  const profileId = config.profile ?? 'bge-small-en-v1.5@1';
  const profile = knowledgeEmbeddingProfile(profileId);
  if (!profile) {
    throw new CliError(
      `catalog.json names unknown profile '${profileId}' — registered: ${KNOWLEDGE_EMBEDDING_PROFILES.map((p) => p.id).join(', ')}`,
    );
  }
  console.log(
    `Building ${config.id}@${config.version}: ${source.documents.length} documents, ${source.assets.length} assets, profile ${profileId}`,
  );
  console.log('Loading the embedding model (first run downloads it)…');
  const embedder = await (deps.createEmbedder ?? defaultCreateEmbedder)(profileId);
  const media = profile.media
    ? await (deps.createMediaEmbedder ?? defaultCreateMediaEmbedder)(profile)
    : null;

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
      chunkingProfile: MARKDOWN_CHUNKS_2,
      embed: (texts) => embedder.embed(texts),
      countTokens: (text) => embedder.countTokens(text),
      workDir,
      assets: withAssetAttribution(source.assets, config.assets),
      ...(media ? { embedMedia: media.embedMedia } : {}),
      invalidAssets: 'warn',
      onWarning: (message) => console.warn(`warning: ${message}`),
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
    const mediaRows = report.media.image + report.media.video + report.media.audio;
    console.log(
      `Wrote ${outputPath} — ${report.documents} documents, ${report.chunks} chunks, ` +
        `${mediaRows > 0 ? `${mediaRows} media rows, ` : ''}` +
        `${report.shards} shard${report.shards === 1 ? '' : 's'}, ${formatBytes(report.archiveBytes)}` +
        `${report.manifest.signature ? `, signed (key ${report.manifest.signature.keyId})` : ''}`,
    );
  } finally {
    await embedder.dispose().catch(() => {});
    await media?.dispose().catch(() => {});
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
  opts: {
    semantic?: boolean;
    limit?: number;
    latitude?: number;
    longitude?: number;
    radiusMeters?: number;
  },
  deps: KnowledgeCommandDeps = {},
): Promise<void> {
  const supplied = [opts.latitude, opts.longitude, opts.radiusMeters].filter(
    (value) => value !== undefined,
  ).length;
  if (supplied !== 0 && supplied !== 3)
    throw new CliError('Provide --latitude, --longitude and --radius-meters together.');
  const spatial = supplied
    ? KnowledgeRadiusSchema.parse({
        latitude: opts.latitude,
        longitude: opts.longitude,
        radiusMeters: opts.radiusMeters,
      })
    : undefined;
  const limit = Math.min(50, Math.max(1, opts.limit ?? 10));
  const { rootDir, cleanup } = await materializeCatalog(path);
  try {
    const manifest = JSON.parse(
      await readFile(join(rootDir, 'manifest.json'), 'utf8'),
    ) as KnowledgeCatalogManifest;
    const handle = CatalogHandle.open(rootDir);
    try {
      const allowed = spatial ? new Set(handle.spatialMatches(spatial).keys()) : undefined;
      const docHits = handle.searchDocumentsFts(query, limit, allowed);
      if (docHits.length > 0) {
        console.log('Documents:');
        for (const hit of docHits) {
          const doc = handle.getDocument(hit.documentId);
          console.log(
            `  ${doc?.title ?? hit.documentId}  ${formatKnowledgeUri({ publisherId: manifest.publisher.id, catalogId: manifest.id, documentId: hit.documentId })}`,
          );
        }
      }

      let chunkHits = handle.searchChunksFts(
        query,
        handle.shards.map((s) => s.id),
        Math.ceil(limit / Math.max(1, handle.shards.length)),
        allowed,
      );
      if (opts.semantic) {
        const embedder = await (deps.createEmbedder ?? defaultCreateEmbedder)(
          manifest.embedding.id,
        );
        try {
          const vector = await embedder.embedQuery(query);
          chunkHits = [
            ...handle.searchSemantic(vector, { finalK: limit, allowedDocumentIds: allowed, query }),
            ...chunkHits,
          ];
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
            publisherId: manifest.publisher.id,
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

/**
 * Write the Parquet companion of a catalog — the same documents, chunks and
 * embeddings as columnar tables for DuckDB, pandas, Polars or `datasets`.
 * Uses the DuckDB CLI gezel installs for its data features (or
 * `GEZEL_DUCKDB_BIN` / `--duckdb`), pinned to the release Parquet bytes are
 * reproducible against.
 */
export async function runKnowledgeExportParquet(
  path: string,
  opts: { out?: string; duckdb?: string },
): Promise<void> {
  const { DUCKDB_VERSION, duckdbInstalledBinary } = await import('@bendyline/gezel/native');
  const { exportCatalogParquet, findDuckdbBinary } = await import('@bendyline/gezel-knowledge');
  const resolved = resolve(path);
  const info = await stat(resolved).catch(() => null);
  if (!info) throw new CliError(`no such catalog: ${resolved}`);
  const source = info.isDirectory() ? { rootDir: resolved } : { archivePath: resolved };
  const outDir = opts.out
    ? resolve(opts.out)
    : join(dirname(resolved), `${basename(resolved).replace(/\.gezk$/i, '')}-parquet`);

  const installed = duckdbInstalledBinary(process.env.GEZEL_HOME ?? join(homedir(), '.gezel'));
  const binaryPath =
    opts.duckdb ??
    process.env.GEZEL_DUCKDB_BIN?.trim() ??
    ((await stat(installed).catch(() => null)) ? installed : await findDuckdbBinary());
  if (!binaryPath) {
    throw new CliError(
      `no DuckDB CLI found — open a data feature in gezel once (it installs DuckDB ${DUCKDB_VERSION}), install DuckDB yourself, or pass --duckdb <binary>`,
    );
  }

  const report = await exportCatalogParquet({
    source,
    outDir,
    duckdb: { binaryPath, ...(opts.duckdb ? {} : { expectedVersion: DUCKDB_VERSION }) },
    onProgress: (event) => {
      if (!process.stderr.isTTY) return;
      if (event.phase === 'extract') process.stderr.write('extracting the archive…\n');
      else if (event.phase === 'stage') {
        process.stderr.write(
          `staged ${event.table}${event.shardId !== undefined ? ` shard ${event.shardId}` : ''}: ${event.rows} rows\n`,
        );
      } else process.stderr.write(`writing ${event.file}\n`);
    },
  });
  console.log(`Parquet companion of ${report.catalogId}@${report.version} → ${outDir}`);
  for (const file of report.files) {
    console.log(
      `  ${file.path.padEnd(24)} ${String(file.rows).padStart(9)} rows ${(file.sizeBytes / (1024 * 1024)).toFixed(1).padStart(8)} MB  ${file.sha256.slice(0, 16)}…`,
    );
  }
  console.log(
    `  written with DuckDB ${report.duckdbVersion}; report in ${join(outDir, 'parquet-manifest.json')}`,
  );
}

/** File-based radius discovery, usable offline for both typed and legacy regional archives. */
export async function runKnowledgeNearby(
  path: string,
  radius: KnowledgeRadius,
  opts: { limit?: number; json?: boolean } = {},
): Promise<void> {
  const spatial = KnowledgeRadiusSchema.parse(radius);
  const { rootDir, cleanup } = await materializeCatalog(path);
  try {
    const manifest = JSON.parse(
      await readFile(join(rootDir, 'manifest.json'), 'utf8'),
    ) as KnowledgeCatalogManifest;
    const handle = CatalogHandle.open(rootDir);
    try {
      const result = handle.nearbyDocuments(spatial, { limit: opts.limit });
      if (opts.json) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(
          `${result.total} articles within ${(spatial.radiusMeters / 1000).toFixed(1)} km`,
        );
        for (const doc of result.documents)
          console.log(
            `  ${(doc.distanceMeters / 1000).toFixed(2)} km  ${doc.title}  ${formatKnowledgeUri({ publisherId: manifest.publisher.id, catalogId: manifest.id, documentId: doc.id })}`,
          );
      }
    } finally {
      handle.close();
    }
  } finally {
    await cleanup();
  }
}
