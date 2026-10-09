/**
 * The media-search model: EmbeddingGemma 2's text session plus its vision
 * and audio encoders, at the revision the knowledge profile pins. Files land
 * in the transformers cache under the pinned-revision key — exactly where
 * `createProfileEmbedder` (catalog queries) and `loadMediaEncoder` (workspace
 * media) read them — so the daemon keeps one verified copy, never two.
 *
 * Every file streams to a `.partial`, is sha256-checked, then renamed; a
 * marker written last records which encoders are complete. The audio
 * encoder (340 MB) installs only when audio or video work first needs it.
 */

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { transformersCachePath } from '@bendyline/gezel-knowledge';
import { downloadWithSha256 } from '../providers/audio/whisper-cpp.js';
import { HF_CACHE_DIR_ENV, transformersCacheDir } from '../transformers-cache.js';

import { MEDIA_SEARCH_PROFILE } from './profile.js';

export { MEDIA_SEARCH_PROFILE };

export type MediaModelPart = 'text' | 'vision' | 'audio';

export interface MediaModelFile {
  path: string;
  sha256: string;
  bytes: number;
  part: MediaModelPart;
}

/**
 * Every file a load reads at the pinned revision, by part. The text part also
 * carries the processor configs and chat template the multimodal processor
 * fetches, so a `local_files_only` load never reaches for the network.
 */
export const MEDIA_MODEL_FILES: readonly MediaModelFile[] = [
  {
    part: 'text',
    path: 'config.json',
    bytes: 5031,
    sha256: '8d011bfe08b5e345bbe0b81e5c6fd02c381920b345b986047bc2a33ce7b90d1d',
  },
  {
    part: 'text',
    path: 'tokenizer.json',
    bytes: 32_170_510,
    sha256: '4d777ef5bdc1aa36227abdfb77c3e49e7b9c892d16e1b6bda41c393504828be4',
  },
  {
    part: 'text',
    path: 'tokenizer_config.json',
    bytes: 1599,
    sha256: '17bd5d6e9364ca49a534e1502076593317c298d4a663623091ed45388f004874',
  },
  {
    part: 'text',
    path: 'processor_config.json',
    bytes: 1788,
    sha256: '168f6a08522f3ce5dea596d94d003af2fd691742d4f41fe1f9d8cce76bfbf69c',
  },
  {
    part: 'text',
    path: 'preprocessor_config.json',
    bytes: 560,
    sha256: '9344893f8d0573a46ebb2ca54c03f56d044cea194c8dcfb1f4d652240ac21daa',
  },
  {
    part: 'text',
    path: 'chat_template.jinja',
    bytes: 1016,
    sha256: '4b852efc0b9960283e735363331e6f325b33bc74bdbaa076f595bc4e9b94d85e',
  },
  {
    part: 'text',
    path: 'onnx/model_quantized.onnx',
    bytes: 495_165,
    sha256: 'd06edd601f851c633a2519304cbeb8dc6170d7ceb61b436625c17fb9b6e74953',
  },
  {
    part: 'text',
    path: 'onnx/model_quantized.onnx_data',
    bytes: 313_724_928,
    sha256: '278a7ff1248c3618e4bd11a607fc54f7bdc7778854230f3956d3f86bd9db4f3b',
  },
  {
    part: 'vision',
    path: 'onnx/vision_encoder_quantized.onnx',
    bytes: 162_495,
    sha256: 'bb0de2df53a2448a32dc7908a187c168c8afd514d4d6f674f7f46024875fa4e3',
  },
  {
    part: 'vision',
    path: 'onnx/vision_encoder_quantized.onnx_data',
    bytes: 195_228_672,
    sha256: '3dabd69c0a36e9a8771ad82030dde74daa5a0e02b7047a5d3f3382b1137bab89',
  },
  {
    part: 'audio',
    path: 'onnx/audio_encoder_quantized.onnx',
    bytes: 249_330,
    sha256: '04a9a9094ba76fb169e4c69be45a4b621580188654d6be59eab860eadcd42d3c',
  },
  {
    part: 'audio',
    path: 'onnx/audio_encoder_quantized.onnx_data',
    bytes: 340_058_624,
    sha256: 'aa6361d898e1f1d6303f8dd2b5fabf4fd3629e15fd709e9cb06ac5cb9416a030',
  },
];

const MARKER = '.gezel-media-installed.json';

/** The transformers cache the daemon pins (`GEZEL_HF_CACHE_DIR` wins). */
export function mediaModelCacheDir(home: string): string {
  return process.env[HF_CACHE_DIR_ENV]?.trim() || transformersCacheDir(home);
}

function filePath(cacheDir: string, path: string): string {
  const { repo, revision } = MEDIA_SEARCH_PROFILE.model;
  return transformersCachePath(cacheDir, repo, revision, path);
}

function markerPath(cacheDir: string): string {
  return filePath(cacheDir, MARKER);
}

/** Bytes a set of parts downloads. */
export function mediaModelBytes(parts: readonly MediaModelPart[]): number {
  return MEDIA_MODEL_FILES.filter((f) => parts.includes(f.part)).reduce((s, f) => s + f.bytes, 0);
}

/** The parts already complete: listed by the marker AND every file at its pinned size. */
export async function installedMediaParts(cacheDir: string): Promise<Set<MediaModelPart>> {
  const done = new Set<MediaModelPart>();
  let listed: MediaModelPart[] = [];
  try {
    const marker = JSON.parse(await readFile(markerPath(cacheDir), 'utf8')) as {
      revision?: string;
      parts?: MediaModelPart[];
    };
    if (marker.revision !== MEDIA_SEARCH_PROFILE.model.revision) return done;
    listed = marker.parts ?? [];
  } catch {
    return done;
  }
  for (const part of listed) {
    let complete = true;
    for (const file of MEDIA_MODEL_FILES.filter((f) => f.part === part)) {
      try {
        if ((await stat(filePath(cacheDir, file.path))).size !== file.bytes) complete = false;
      } catch {
        complete = false;
      }
    }
    if (complete) done.add(part);
  }
  return done;
}

export type MediaInstallEvent =
  | { type: 'progress'; bytesDone: number; bytesTotal: number }
  | { type: 'done'; parts: MediaModelPart[] }
  | { type: 'error'; error: string };

let inflight: Promise<void> | null = null;

/**
 * Download and verify the requested parts (text is always included). One
 * install at a time; a second caller waits for the first, then installs
 * whatever is still missing. Downloads are the caller's to gate on the
 * security policy's `allowAppNetwork`.
 */
export async function* installMediaModel(
  cacheDir: string,
  wanted: readonly MediaModelPart[],
  opts: { fetchImpl?: typeof fetch } = {},
): AsyncGenerator<MediaInstallEvent> {
  while (inflight) await inflight.catch(() => {});
  let finish = (): void => {};
  inflight = new Promise<void>((resolve) => {
    finish = resolve;
  });
  try {
    const parts = [...new Set<MediaModelPart>(['text', ...wanted])];
    const have = await installedMediaParts(cacheDir);
    const missing = parts.filter((p) => !have.has(p));
    if (missing.length === 0) {
      yield { type: 'done', parts: [...have] };
      return;
    }
    const files = MEDIA_MODEL_FILES.filter((f) => missing.includes(f.part));
    const total = files.reduce((sum, f) => sum + f.bytes, 0);
    const { repo, revision } = MEDIA_SEARCH_PROFILE.model;
    let written = 0;
    for (const file of files) {
      const dest = filePath(cacheDir, file.path);
      const present = await stat(dest)
        .then((s) => s.size === file.bytes)
        .catch(() => false);
      if (present) {
        written += file.bytes;
        continue;
      }
      await mkdir(dirname(dest), { recursive: true });
      const download = downloadWithSha256(opts.fetchImpl ?? fetch, {
        url: `https://huggingface.co/${repo}/resolve/${revision}/${file.path}`,
        destPath: dest,
        expectedSha256: file.sha256,
        approxSizeBytes: file.bytes,
        writtenSoFar: written,
        totalAllBytes: total,
      });
      for (;;) {
        const next = await download.next();
        if (next.done) {
          if (next.value.kind === 'error') {
            yield { type: 'error', error: `${file.path}: ${next.value.error}` };
            return;
          }
          written = next.value.writtenAll;
          break;
        }
        if (next.value.type === 'progress') {
          yield { type: 'progress', bytesDone: next.value.bytesWritten, bytesTotal: total };
        }
      }
    }
    const complete = [...new Set([...have, ...missing])];
    await mkdir(dirname(markerPath(cacheDir)), { recursive: true });
    await writeFile(
      markerPath(cacheDir),
      `${JSON.stringify({ revision, parts: complete, installedAt: new Date().toISOString() }, null, 2)}\n`,
    );
    yield { type: 'done', parts: complete };
  } finally {
    inflight = null;
    finish();
  }
}

/** The cache-relative folder the media model occupies (for display and removal). */
export function mediaModelDir(cacheDir: string): string {
  const { repo, revision } = MEDIA_SEARCH_PROFILE.model;
  return join(cacheDir, repo, revision);
}
