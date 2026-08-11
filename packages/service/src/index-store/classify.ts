import { basename, extname } from 'node:path';
import type { Modality } from './index-store.js';

/**
 * Cheap, deterministic file classification — language, a coarse `kind`, the
 * `modality` that routes the indexing pipeline, and a `trivial` flag for files
 * we never index (lockfiles, minified bundles, binaries). No I/O beyond the path
 * + size the caller already has from the walk.
 */

export interface FileClass {
  lang: string | null;
  kind: string;
  modality: Modality;
  /** When true, skip all content indexing (still recorded in `files`). */
  trivial: boolean;
}

/** Files we never index regardless of extension. */
const TRIVIAL_BASENAMES = new Set([
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'cargo.lock',
  'poetry.lock',
  'composer.lock',
  'gemfile.lock',
  'go.sum',
  '.ds_store',
]);

/** ext → language id (also implies modality=code). */
const CODE_LANGS: Record<string, string> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  hpp: 'cpp',
  cs: 'c_sharp',
  php: 'php',
  swift: 'swift',
  kt: 'kotlin',
  scala: 'scala',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  lua: 'lua',
  sql: 'sql',
};

const MARKDOWN_EXTS = new Set(['md', 'mdx', 'markdown']);
const DOC_EXTS = new Set(['docx', 'pptx', 'xlsx', 'pdf', 'odt', 'odp', 'ods', 'rtf']);
const IMAGE_EXTS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'tiff',
  'tif',
  'svg',
  'ico',
]);
const CONFIG_EXTS = new Set(['json', 'yaml', 'yml', 'toml', 'ini', 'env', 'xml', 'properties']);
const DATA_EXTS = new Set(['csv', 'tsv']);
const TEXT_EXTS = new Set(['txt', 'rst', 'text', 'log']);

/** Non-text payloads we can't structurally index in the code/text tiers. */
const BINARY_EXTS = new Set([
  'zip',
  'tar',
  'gz',
  'tgz',
  'bz2',
  'xz',
  '7z',
  'rar',
  'exe',
  'dll',
  'so',
  'dylib',
  'bin',
  'o',
  'a',
  'lib',
  'obj',
  'class',
  'pyc',
  'pyo',
  'jar',
  'wasm',
  'woff',
  'woff2',
  'ttf',
  'otf',
  'eot',
  'mp4',
  'mov',
  'avi',
  'mkv',
  'webm',
  'db',
  'sqlite',
  'lock',
]);

/**
 * Audio gets its own modality (was lumped into trivial binary): the AI-shadow
 * tier can transcribe these via the local STT stack, making recordings
 * searchable and summarizable like any document.
 */
const AUDIO_EXTS = new Set(['mp3', 'wav', 'flac', 'ogg', 'oga', 'm4a', 'aac', 'opus']);

/** Anything larger than this in the text/code tiers is treated as trivial. */
export const MAX_INDEXABLE_BYTES = 512 * 1024;

const DENSE_BLOB_MIN_BYTES = 100 * 1024;
const DENSE_BLOB_BYTES_PER_LINE = 1_000;

/**
 * Machine-generated blob detector: a big file whose average line exceeds
 * ~1KB is minified/generated data (icon path tables, bundled JS), not prose
 * or code a model can summarize. Needs the line count, so it runs at the
 * indexer's content-read site rather than in {@link classifyFile}. Dense
 * blobs are recorded `trivial` — no symbols, no chunks, no enrichment call.
 */
export function isDenseBlob(size: number, lineCount: number): boolean {
  return size > DENSE_BLOB_MIN_BYTES && size / Math.max(lineCount, 1) > DENSE_BLOB_BYTES_PER_LINE;
}

export function classifyFile(path: string, size: number): FileClass {
  const base = basename(path).toLowerCase();
  const ext = extname(path).slice(1).toLowerCase();

  if (TRIVIAL_BASENAMES.has(base)) return triv('config');
  if (/\.min\.(js|css|mjs|cjs)$/i.test(base) || base.endsWith('.map')) return triv('code');

  if (ext in CODE_LANGS) {
    const trivial = size > MAX_INDEXABLE_BYTES;
    return { lang: CODE_LANGS[ext]!, kind: 'code', modality: 'code', trivial };
  }
  if (MARKDOWN_EXTS.has(ext)) {
    return {
      lang: 'markdown',
      kind: 'markdown',
      modality: 'text',
      trivial: size > MAX_INDEXABLE_BYTES,
    };
  }
  if (DOC_EXTS.has(ext)) return { lang: null, kind: 'doc', modality: 'doc', trivial: false };
  if (IMAGE_EXTS.has(ext)) return { lang: null, kind: 'image', modality: 'image', trivial: false };
  if (AUDIO_EXTS.has(ext)) return { lang: null, kind: 'audio', modality: 'audio', trivial: false };
  if (CONFIG_EXTS.has(ext)) {
    return { lang: ext, kind: 'config', modality: 'text', trivial: size > MAX_INDEXABLE_BYTES };
  }
  if (DATA_EXTS.has(ext)) {
    return { lang: ext, kind: 'data', modality: 'text', trivial: size > MAX_INDEXABLE_BYTES };
  }
  if (TEXT_EXTS.has(ext)) {
    return { lang: 'text', kind: 'text', modality: 'text', trivial: size > MAX_INDEXABLE_BYTES };
  }
  if (BINARY_EXTS.has(ext)) return triv('binary');

  // Unknown extension: treat as small text if tiny, else trivial.
  return { lang: null, kind: 'other', modality: 'text', trivial: size > MAX_INDEXABLE_BYTES };
}

function triv(kind: string): FileClass {
  return { lang: null, kind, modality: 'text', trivial: true };
}
