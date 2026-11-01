#!/usr/bin/env node

/**
 * ONNX Runtime's telemetry must be off before it loads.
 *
 * onnxruntime-node 1.30 queues device-identifying events for Microsoft's
 * collector unless `ORT_DISABLE_TELEMETRY` is set when it first initializes
 * (2026-10-27 npm ship audit). `disableOnnxRuntimeTelemetry` in
 * packages/core/src/native/onnx-telemetry.ts sets it; this guard keeps every
 * path that loads ORT calling it.
 *
 * Two rules:
 *
 *   1. EVERY LOADER CALLS IT. A module that imports transformers, kokoro-js or
 *      onnxruntime-node calls the helper first, so library callers that never
 *      start a host are covered too.
 *
 *   2. HOSTS AND WORKER SPAWNS CALL IT. ORT reads the real environment, and a
 *      worker's `process.env` is a private copy native code never sees. A
 *      loader that runs inside a worker is therefore covered only by a call on
 *      the main thread: the host at start, and the module that spawns that
 *      worker. A new worker that loads ORT belongs in REQUIRED below.
 */

import { readFile, readdir } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_ROOTS = ['packages/inference/src', 'packages/service/src', 'packages/knowledge/src'];
const CALL = 'disableOnnxRuntimeTelemetry(';

const LOADER =
  /(?:import|require)\(\s*(?:'(?:@huggingface\/transformers|kokoro-js|onnxruntime-node)'|TRANSFORMERS_MODULE)\s*\)|\)\(\s*'onnxruntime-node'\s*\)|=\s*TRANSFORMERS_MODULE;/;

const REQUIRED = new Map([
  ['packages/service/src/service.ts', 'starts every product, engine and inference-only service'],
  ['packages/inference/src/inference-service.ts', 'starts the in-process inference host'],
  ['packages/inference/src/memory/embeddings.ts', 'spawns the text-embedding worker'],
  ['packages/inference/src/relevance/relevance-model.ts', 'spawns the relevance worker'],
  ['packages/inference/src/knowledge/worker-host.ts', 'spawns the knowledge search worker'],
  ['packages/service/src/memory/image-embeddings.ts', 'spawns the image and face worker'],
  ['packages/service/src/providers/audio/kokoro-worker-host.ts', 'spawns the speech worker'],
]);

async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(path)));
    else if (/\.[cm]?ts$/.test(entry.name) && !/\.(?:test|spec|d)\.[cm]?ts$/.test(entry.name)) {
      files.push(path);
    }
  }
  return files;
}

const rel = (p) => relative(root, p).replaceAll('\\', '/');
const withoutComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const failures = [];

for (const file of (
  await Promise.all(SOURCE_ROOTS.map((dir) => walk(resolve(root, dir))))
).flat()) {
  const source = withoutComments(await readFile(file, 'utf8'));
  if (LOADER.test(source) && !source.includes(CALL)) {
    failures.push(
      `${rel(file)}: loads ONNX Runtime without calling disableOnnxRuntimeTelemetry() first.`,
    );
  }
}

for (const [path, why] of REQUIRED) {
  const raw = await readFile(resolve(root, path), 'utf8').catch(() => null);
  const source = raw === null ? null : withoutComments(raw);
  if (source === null) failures.push(`${path}: listed in REQUIRED but missing; update the list.`);
  else if (!source.includes(CALL)) {
    failures.push(`${path}: ${why}, so it must call disableOnnxRuntimeTelemetry() first.`);
  }
}

if (failures.length > 0) {
  console.error('ONNX telemetry guard failed:\n');
  for (const failure of failures) console.error(`  - ${failure}\n`);
  process.exit(1);
}

console.log('ONNX telemetry guard passed.');
