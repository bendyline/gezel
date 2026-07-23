#!/usr/bin/env node
/**
 * Generate a chat-model manifest.json that may carry up to three
 * provider blocks (Ollama tag, llama.cpp GGUF, MLX directory).
 *
 * Reads a config JSON of editorial fields plus the per-provider
 * source pointers, fetches what it can from the Hugging Face Hub
 * API, and writes
 * `data/chat-models/<prefix>/<id>/manifest.json` under the catalog
 * package root.
 *
 * Config shape:
 *
 *   {
 *     "id": "qwen3.5-9b",
 *     "name": "Qwen 3.5 (9B)",
 *     "description": "...",
 *     "tags": ["alibaba", "multimodal", "vision", "tools"],
 *     "category": "general",
 *     "maintainer": { "name": "Alibaba", "url": "..." },
 *     "version": "1.0.0",
 *     "updatedAt": "2026-04-26T00:00:00Z",
 *     "license": "Apache-2.0",
 *     "parameterSize": "9B",
 *     "approxSizeBytes": 6600000000,    // top-level rough estimate for UI display
 *     "supportsTools": true,
 *     "contextWindow": 256000,
 *     "upstream": "https://...",
 *
 *     "ollama":   { "tag": "qwen3.5:9b" },
 *     "llamaCpp": { "huggingfaceRepo": "...-GGUF", "filename": "...gguf", "quantization": "Q4_K_M" },
 *     "mlx":      { "huggingfaceRepo": "mlx-community/...", "quantization": "4bit" }
 *   }
 *
 * Any of the three provider blocks may be omitted. The generator:
 *   - copies `ollama` verbatim (just a tag — Ollama owns lifecycle)
 *   - looks up the GGUF in the HF tree to fill in sha256 + size
 *   - walks the MLX repo tree, selects install files, hashes the
 *     non-LFS configs, builds the per-file sha256 list
 *
 * Rebuilds are non-lossy: when a manifest already exists on disk it stays
 * authoritative for the tuning/behaviour fields (`style`, `behaviors`,
 * `tuning`, `evalHints`) that eval runs evolve in place, and for the
 * `revision` pins that `pin-revisions.ts` owns. Only the provider file data
 * (sha256 / size / file lists) is refreshed from HF. Pass `--reseed` to let
 * the config overwrite base + editorial fields on purpose. See
 * `src/manifest-assembly.ts`.
 *
 * Usage (run via tsx — this imports the shared TS assembly module):
 *   pnpm --filter @bendyline/gezel-catalog build-manifest \
 *     --config scripts/manifest-configs/qwen3.5-9b.json
 *   # or directly:
 *   tsx packages/catalog/scripts/build-manifest.mjs \
 *     --config packages/catalog/scripts/manifest-configs/qwen3.5-9b.json [--reseed]
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assembleManifest } from '../src/manifest-assembly.js';
import { requireGildeCheckout } from './gilde-checkout.js';

const HF_HUB_BASE = 'https://huggingface.co';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const GILDE_DATA_DIR = requireGildeCheckout().dataDir;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--config') out.config = argv[++i];
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--reseed') out.reseed = true;
  }
  if (!out.config) {
    console.error('usage: build-manifest.mjs --config <file> [--dry-run] [--reseed]');
    process.exit(2);
  }
  return out;
}

async function fetchTree(repo, rev = 'main') {
  const out = [];
  async function walk(subpath) {
    const url = `${HF_HUB_BASE}/api/models/${repo}/tree/${rev}${subpath ? `/${subpath}` : ''}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`HF tree fetch ${url} failed: ${res.status} ${res.statusText}`);
    }
    const entries = await res.json();
    for (const e of entries) {
      if (e.type === 'directory') {
        await walk(e.path);
        continue;
      }
      if (e.type !== 'file') continue;
      const lfsOid = e.lfs?.oid;
      const sha256 = lfsOid ?? e.oid ?? '';
      if (!sha256) continue;
      out.push({
        path: e.path,
        sizeBytes: e.size ?? 0,
        sha256,
        lfsBacked: Boolean(lfsOid),
      });
    }
  }
  await walk('');
  return out;
}

async function fetchAndHash(repo, path, rev = 'main') {
  const url = `${HF_HUB_BASE}/${repo}/resolve/${rev}/${path}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HF resolve ${url} failed: ${res.status} ${res.statusText}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return { sha256: createHash('sha256').update(buf).digest('hex'), sizeBytes: buf.length };
}

const MLX_KEEP = [
  /\.safetensors(\.index\.json)?$/,
  /^(?:config|generation_config|preprocessor_config|processor_config|video_preprocessor_config|tokenizer_config|special_tokens_map)\.json$/,
  /^tokenizer\.json$/,
  /^tokenizer\.model$/,
  /^vocab\.json$/,
  /^merges\.txt$/,
  /^chat_template\.jinja$/,
];

function selectMlxFiles(files) {
  return files.filter((f) => MLX_KEEP.some((re) => re.test(f.path)));
}

async function buildLlamaCppBlock(cfg) {
  const {
    huggingfaceRepo,
    filename,
    shardsDir,
    shardsPrefix,
    quantization,
    mmprojFilename,
    residentBytes,
  } = cfg;
  const shardForms = [shardsDir, shardsPrefix].filter(Boolean).length;
  if (!filename && shardForms === 0) {
    throw new Error('llamaCpp config must set one of `filename`, `shardsDir`, or `shardsPrefix`');
  }
  if (filename && shardForms > 0) {
    throw new Error(
      'llamaCpp config must set only one of `filename`, `shardsDir`, or `shardsPrefix`',
    );
  }
  if (shardForms > 1) {
    throw new Error('llamaCpp config must set only one of `shardsDir` or `shardsPrefix`');
  }
  console.log(`[hf] fetching tree for llama.cpp source ${huggingfaceRepo}…`);
  const tree = await fetchTree(huggingfaceRepo);

  let mmproj;
  if (mmprojFilename) {
    const f = tree.find((e) => e.path === mmprojFilename);
    if (!f) {
      throw new Error(`mmproj file ${mmprojFilename} not found in ${huggingfaceRepo}`);
    }
    if (!f.lfsBacked) {
      throw new Error(`mmproj file ${mmprojFilename} is not LFS-backed; sha256 unavailable`);
    }
    mmproj = { filename: mmprojFilename, sha256: f.sha256, sizeBytes: f.sizeBytes };
  }

  if (shardsDir || shardsPrefix) {
    const matcher = shardsDir
      ? (path) => path.startsWith(`${shardsDir.replace(/\/$/, '')}/`)
      : (path) => path.startsWith(shardsPrefix) && !path.slice(shardsPrefix.length).includes('/');
    const shards = tree
      .filter((f) => matcher(f.path) && f.path.endsWith('.gguf'))
      .sort((a, b) => a.path.localeCompare(b.path));
    if (shards.length < 2) {
      const where = shardsDir
        ? `${huggingfaceRepo}/${shardsDir}`
        : `${huggingfaceRepo} (prefix=${shardsPrefix})`;
      throw new Error(`expected >= 2 GGUF shards in ${where}, found ${shards.length}`);
    }
    for (const s of shards) {
      if (!s.lfsBacked) {
        throw new Error(`shard ${s.path} is not LFS-backed; sha256 unavailable`);
      }
    }
    const approxSizeBytes = shards.reduce((sum, s) => sum + s.sizeBytes, 0);
    return {
      huggingfaceRepo,
      shards: shards.map((s) => ({
        name: s.path,
        sha256: s.sha256,
        sizeBytes: s.sizeBytes,
      })),
      approxSizeBytes,
      ...(quantization ? { quantization } : {}),
      ...(residentBytes ? { residentBytes } : {}),
      ...(mmproj ? { mmproj } : {}),
    };
  }

  const file = tree.find((f) => f.path === filename);
  if (!file) {
    throw new Error(`GGUF file ${filename} not found in ${huggingfaceRepo}`);
  }
  if (!file.lfsBacked) {
    throw new Error(`GGUF file ${filename} is not LFS-backed; sha256 unavailable`);
  }
  return {
    huggingfaceRepo,
    filename,
    sha256: file.sha256,
    approxSizeBytes: file.sizeBytes,
    ...(quantization ? { quantization } : {}),
    ...(residentBytes ? { residentBytes } : {}),
    ...(mmproj ? { mmproj } : {}),
  };
}

async function buildMlxBlock(cfg) {
  const { huggingfaceRepo, quantization, chatTemplate, residentBytes } = cfg;
  console.log(`[hf] fetching tree for MLX source ${huggingfaceRepo}…`);
  const tree = await fetchTree(huggingfaceRepo);
  const installFiles = selectMlxFiles(tree);
  if (installFiles.length === 0) {
    throw new Error(`no MLX install files found in ${huggingfaceRepo}`);
  }
  const nonLfs = installFiles.filter((f) => !f.lfsBacked);
  if (nonLfs.length > 0) {
    console.log(`[hf]   hashing ${nonLfs.length} non-LFS file(s) for SHA-256…`);
    for (const f of nonLfs) {
      const { sha256, sizeBytes } = await fetchAndHash(huggingfaceRepo, f.path);
      f.sha256 = sha256;
      f.sizeBytes = sizeBytes;
      f.lfsBacked = true;
    }
  }
  const approxSizeBytes = installFiles.reduce((s, f) => s + f.sizeBytes, 0);
  return {
    huggingfaceRepo,
    ...(quantization ? { quantization } : {}),
    approxSizeBytes,
    files: installFiles.map((f) => ({
      name: f.path,
      sha256: f.sha256,
      sizeBytes: f.sizeBytes,
    })),
    ...(residentBytes ? { residentBytes } : {}),
    ...(chatTemplate ? { chatTemplate } : {}),
  };
}

function deriveSubdir(id) {
  return id.slice(0, 2).toLowerCase();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const configPath = resolve(args.config);
  const cfg = JSON.parse(await readFile(configPath, 'utf-8'));

  const REQUIRED = [
    'id',
    'name',
    'description',
    'tags',
    'category',
    'maintainer',
    'version',
    'updatedAt',
    'license',
    'parameterSize',
    'approxSizeBytes',
    'supportsTools',
    'contextWindow',
    'upstream',
  ];
  for (const k of REQUIRED) {
    if (!(k in cfg)) throw new Error(`config missing required field: ${k}`);
  }

  if (!cfg.ollama && !cfg.llamaCpp && !cfg.mlx) {
    throw new Error(
      'config must include at least one of {ollama, llamaCpp, mlx} blocks (got none)',
    );
  }

  // Fetch fresh provider blocks (sha256 / size / file lists) from HF.
  const providerBlocks = {};
  if (cfg.ollama) providerBlocks.ollama = { tag: cfg.ollama.tag };
  if (cfg.llamaCpp) providerBlocks.llamaCpp = await buildLlamaCppBlock(cfg.llamaCpp);
  if (cfg.mlx) providerBlocks.mlx = await buildMlxBlock(cfg.mlx);

  const subdir = deriveSubdir(cfg.id);
  const outPath = resolve(GILDE_DATA_DIR, 'chat-models', subdir, cfg.id, 'manifest.json');

  // The manifest on disk is authoritative for tuning/behaviour fields (eval
  // runs evolve them in place) and for the `revision` pins (pin-revisions.ts
  // owns those). assembleManifest preserves both so a rebuild only refreshes
  // provider file data — never silently drops a tuning block. `--reseed`
  // flips precedence so the config can deliberately overwrite editorial.
  let existing = null;
  if (existsSync(outPath)) {
    existing = JSON.parse(await readFile(outPath, 'utf-8'));
  }
  const { manifest, preservedFromManifest, carriedRevisions } = assembleManifest({
    cfg,
    providerBlocks,
    existing,
    reseed: Boolean(args.reseed),
  });

  if (existing && preservedFromManifest.length > 0) {
    const how = args.reseed
      ? 'kept (config had no value)'
      : 'preserved over config (use --reseed to override)';
    console.log(`[merge] ${how}: ${preservedFromManifest.join(', ')}`);
  }
  if (carriedRevisions.length > 0) {
    console.log(`[merge] carried revision pin: ${carriedRevisions.join(', ')}`);
  }

  if (args.dryRun) {
    console.log('--dry-run; would write to', outPath);
    console.log(JSON.stringify(manifest, null, 2));
    return;
  }

  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
  const blocks = ['ollama', 'llamaCpp', 'mlx'].filter((b) => Boolean(manifest[b]));
  console.log(`[hf] wrote ${outPath} (${blocks.join(', ')})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
