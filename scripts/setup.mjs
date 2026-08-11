#!/usr/bin/env node
/**
 * One-shot environment setup. Today: warms the @huggingface/transformers
 * embedder cache (Xenova/all-MiniLM-L6-v2) so the first chat turn
 * doesn't block on a ~25 MB HuggingFace download — that's what blows
 * up service tests on a fresh clone (auto-recall stalls past the
 * Vitest timeout). Idempotent: returns immediately if the model
 * weights are already on disk.
 *
 * Resolves @huggingface/transformers through packages/service's node_modules
 * because the root package doesn't depend on it directly.
 */
import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, '..');
const serviceRoot = join(repoRoot, 'packages', 'service');

const serviceRequire = createRequire(join(serviceRoot, 'package.json'));

let transformersIndex;
try {
  transformersIndex = serviceRequire.resolve('@huggingface/transformers');
} catch (err) {
  console.error(
    '[setup] could not resolve @huggingface/transformers from packages/service. Run `pnpm deps:install` first.',
  );
  console.error(`[setup] underlying: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}

// .../node_modules/@huggingface/transformers/src/transformers.js (or dist) →
// climb to the package root to land on the colocated `.cache/` dir.
const transformersPkgRoot = (() => {
  let dir = dirname(transformersIndex);
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    dir = dirname(dir);
  }
  return dirname(transformersIndex);
})();

const modelCacheDir = join(transformersPkgRoot, '.cache', 'Xenova', 'all-MiniLM-L6-v2');

function modelWeightsCached() {
  if (!existsSync(modelCacheDir)) return false;
  const onnxDir = join(modelCacheDir, 'onnx');
  if (existsSync(onnxDir)) {
    const onnxFiles = readdirSync(onnxDir).filter((f) => f.endsWith('.onnx'));
    if (onnxFiles.length > 0) return true;
  }
  const flatOnnx = readdirSync(modelCacheDir).filter((f) => f.endsWith('.onnx'));
  return flatOnnx.length > 0;
}

if (modelWeightsCached()) {
  console.log(`[setup] embedder already cached at ${modelCacheDir} — skipping.`);
  process.exit(0);
}

console.log('[setup] warming embedder cache (Xenova/all-MiniLM-L6-v2, ~25 MB)…');

const { pipeline } = await import(transformersIndex);
const embed = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
await embed('warmup', { pooling: 'mean', normalize: true });

console.log(`[setup] embedder cached at ${modelCacheDir}.`);
