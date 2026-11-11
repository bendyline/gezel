#!/usr/bin/env node
/**
 * Regenerate the tables that say which models Gezel's pinned engines load:
 *
 * - packages/core/src/native/llama-cpp-gguf-support.ts, from the llama.cpp
 *   commit in native/engines/llama-cpp/VERSION (`src/llama-arch.cpp`
 *   LLM_ARCH_NAMES, `ggml/include/ggml.h` enum ggml_type);
 * - packages/core/src/native/mlx-model-support.ts, from the mlx-vlm release
 *   pinned as MLX_DEFAULT_PACKAGE_SPEC in providers/mlx/venv.ts (its
 *   `mlx_vlm/models/` packages and `MODEL_REMAPPING`).
 *
 * Models added from outside the catalog are checked against these before any
 * download (docs/model-imports.md), so a bump of either pin is a rerun of this
 * script, never a hand edit.
 *
 *   node scripts/sync-engine-model-support.mjs           # fetch + write
 *   node scripts/sync-engine-model-support.mjs --check   # exit 1 when stale
 *
 * Set GITHUB_TOKEN to lift the unauthenticated GitHub API limit.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const llamaVersionFile = join(root, 'native', 'engines', 'llama-cpp', 'VERSION');
const mlxVenvFile = join(root, 'packages', 'inference', 'src', 'providers', 'mlx', 'venv.ts');
const llamaOut = join(root, 'packages', 'core', 'src', 'native', 'llama-cpp-gguf-support.ts');
const mlxOut = join(root, 'packages', 'core', 'src', 'native', 'mlx-model-support.ts');

function readLlamaPin() {
  const text = readFileSync(llamaVersionFile, 'utf8');
  const field = (name) => {
    const match = text.match(new RegExp(`^${name}=(.+)$`, 'm'));
    if (!match) throw new Error(`${llamaVersionFile} has no ${name}= line`);
    return match[1].trim();
  };
  return { tag: field('tag'), commit: field('commit') };
}

function readMlxVlmVersion() {
  const text = readFileSync(mlxVenvFile, 'utf8');
  const match = text.match(/MLX_DEFAULT_PACKAGE_SPEC = 'mlx-vlm==([^']+)'/);
  if (!match) throw new Error(`${mlxVenvFile} has no pinned mlx-vlm spec`);
  return match[1];
}

async function fetchText(url) {
  const headers = { 'User-Agent': 'gezel-sync-engine-model-support' };
  if (process.env.GITHUB_TOKEN && url.startsWith('https://api.github.com/')) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`fetch ${url} failed: ${res.status} ${res.statusText}`);
  return res.text();
}

export function parseArchitectures(source) {
  const start = source.indexOf('LLM_ARCH_NAMES');
  if (start < 0) throw new Error('llama-arch.cpp has no LLM_ARCH_NAMES table');
  const end = source.indexOf('};', start);
  const block = source.slice(start, end);
  const names = [];
  for (const match of block.matchAll(/\{\s*LLM_ARCH_[A-Z0-9_]+\s*,\s*"([^"]+)"\s*\}/g)) {
    if (match[1] !== '(unknown)') names.push(match[1]);
  }
  if (names.length < 20) throw new Error(`parsed only ${names.length} architectures`);
  return [...new Set(names)].sort();
}

export function parseTensorTypes(header) {
  const start = header.indexOf('enum ggml_type {');
  if (start < 0) throw new Error('ggml.h has no enum ggml_type');
  const end = header.indexOf('};', start);
  const block = header.slice(start, end);
  const supported = {};
  const removed = {};
  for (const line of block.split('\n')) {
    const active = line.match(/^\s*GGML_TYPE_([A-Z0-9_]+)\s*=\s*(\d+)\s*,/);
    if (active && active[1] !== 'COUNT') {
      supported[Number(active[2])] = active[1];
      continue;
    }
    const gone = line.match(/^\s*\/\/\s*GGML_TYPE_([A-Z0-9_]+)\s*=\s*(\d+)/);
    if (gone) removed[Number(gone[2])] = gone[1];
  }
  if (Object.keys(supported).length < 20) throw new Error('parsed too few ggml types');
  return { supported, removed };
}

export function parseMlxModelTypes(treeJson) {
  const tree = JSON.parse(treeJson).tree ?? [];
  const types = tree
    .filter((entry) => entry.type === 'tree' && /^mlx_vlm\/models\/[^/]+$/.test(entry.path))
    .map((entry) => entry.path.slice('mlx_vlm/models/'.length))
    .filter((name) => !name.startsWith('_'));
  if (types.length < 20) throw new Error(`parsed only ${types.length} mlx-vlm model types`);
  return [...new Set(types)].sort();
}

export function parseMlxRemapping(utilsSource) {
  const start = utilsSource.indexOf('MODEL_REMAPPING = {');
  if (start < 0) throw new Error('mlx_vlm/utils.py has no MODEL_REMAPPING');
  const end = utilsSource.indexOf('}', start);
  const block = utilsSource.slice(start, end);
  const out = {};
  for (const match of block.matchAll(/"([^"]+)"\s*:\s*"([^"]+)"/g)) out[match[1]] = match[2];
  return out;
}

function quoteKey(key) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? key : `'${key}'`;
}

function renderLlama({ tag, commit, architectures, supported, removed }) {
  const entries = (map) =>
    Object.entries(map)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([id, name]) => `  ${id}: '${name}',`)
      .join('\n');
  return `// Generated by scripts/sync-engine-model-support.mjs from llama.cpp ${tag}
// (${commit}). Do not edit by hand: rerun the script after a native bump.

/** The llama.cpp commit this table was read from. */
export const LLAMA_CPP_GGUF_SUPPORT_COMMIT = '${commit}';

/** The llama.cpp release tag this table was read from. */
export const LLAMA_CPP_GGUF_SUPPORT_TAG = '${tag}';

/**
 * Every \`general.architecture\` value the pinned engine can load
 * (\`LLM_ARCH_NAMES\` in src/llama-arch.cpp). \`clip\` is listed upstream but
 * only names a multimodal projector, never a model you can chat with.
 */
export const LLAMA_CPP_ARCHITECTURES: readonly string[] = [
${architectures.map((name) => `  '${name}',`).join('\n')}
];

/** Tensor types the pinned engine reads (\`enum ggml_type\` in ggml.h). */
export const LLAMA_CPP_TENSOR_TYPES: Readonly<Record<number, string>> = {
${entries(supported)}
};

/** Tensor types upstream once had and has since dropped; a file using one will not load. */
export const LLAMA_CPP_REMOVED_TENSOR_TYPES: Readonly<Record<number, string>> = {
${entries(removed)}
};
`;
}

function renderMlx({ version, types, remapping }) {
  return `// Generated by scripts/sync-engine-model-support.mjs from mlx-vlm ${version}.
// Do not edit by hand: rerun the script after the MLX package pin moves.

/** The mlx-vlm release this table was read from (MLX_DEFAULT_PACKAGE_SPEC). */
export const MLX_VLM_SUPPORT_VERSION = '${version}';

/**
 * Every \`model_type\` the pinned mlx-vlm loads (its \`mlx_vlm/models/\`
 * packages). Gezel's MLX sidecar loads every model through mlx-vlm, so this
 * is the engine's own list. It includes embedding, detection and OCR models
 * that are not chat models; the conversation-format check catches those.
 */
export const MLX_MODEL_TYPES: readonly string[] = [
${types.map((name) => `  '${name}',`).join('\n')}
];

/** \`config.json\` model types mlx-vlm reads as another (\`MODEL_REMAPPING\`). */
export const MLX_MODEL_TYPE_ALIASES: Readonly<Record<string, string>> = {
${Object.entries(remapping)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([from, to]) => `  ${quoteKey(from)}: '${to}',`)
  .join('\n')}
};
`;
}

function readCurrent(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

async function main() {
  const check = process.argv.includes('--check');
  const pin = readLlamaPin();
  const mlxVersion = readMlxVlmVersion();
  const [arch, ggml, mlxTree, mlxUtils] = await Promise.all([
    fetchText(
      `https://raw.githubusercontent.com/ggml-org/llama.cpp/${pin.commit}/src/llama-arch.cpp`,
    ),
    fetchText(
      `https://raw.githubusercontent.com/ggml-org/llama.cpp/${pin.commit}/ggml/include/ggml.h`,
    ),
    fetchText(`https://api.github.com/repos/Blaizzy/mlx-vlm/git/trees/v${mlxVersion}?recursive=1`),
    fetchText(`https://raw.githubusercontent.com/Blaizzy/mlx-vlm/v${mlxVersion}/mlx_vlm/utils.py`),
  ]);
  const { supported, removed } = parseTensorTypes(ggml);
  const outputs = [
    [
      llamaOut,
      renderLlama({
        tag: pin.tag,
        commit: pin.commit,
        architectures: parseArchitectures(arch),
        supported,
        removed,
      }),
      `llama.cpp ${pin.tag}`,
    ],
    [
      mlxOut,
      renderMlx({
        version: mlxVersion,
        types: parseMlxModelTypes(mlxTree),
        remapping: parseMlxRemapping(mlxUtils),
      }),
      `mlx-vlm ${mlxVersion}`,
    ],
  ];
  let stale = false;
  for (const [path, next, label] of outputs) {
    const current = readCurrent(path);
    if (current === next) {
      console.log(`${label} support table is current.`);
      continue;
    }
    if (check) {
      console.error(`${path} is stale for ${label}.`);
      stale = true;
      continue;
    }
    writeFileSync(path, next, 'utf8');
    console.log(`wrote ${path} (${label})`);
  }
  if (stale) {
    console.error('Run: node scripts/sync-engine-model-support.mjs');
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
