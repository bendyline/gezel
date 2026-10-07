/**
 * The `embedMedia` a catalog build hands the compiler: images through the
 * profile's vision encoder, audio and video cut into windows by the system
 * ffmpeg and embedded window by window. Returns raw model output; the
 * compiler projects it through the profile.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KnowledgeEmbeddingProfile } from '@bendyline/gezel';
import type { MediaEmbedRequest, MediaEmbedResult } from '@bendyline/gezel-knowledge';
import { ImageDecodeError, decodeImage, rgbaToRgb } from '../memory/image-pixels.js';
import {
  type MediaEncoder,
  type MediaModality,
  loadMediaEncoder,
} from '../memory/media-embed-core.js';
import { locateFfmpeg } from './ffmpeg.js';
import { decodeAudioWindows, decodeVideoWindows } from './segment.js';

export interface CatalogMediaEmbedder {
  embedMedia(request: MediaEmbedRequest): Promise<MediaEmbedResult[]>;
  dispose(): Promise<void>;
}

/**
 * Build the embedder for a profile. Encoders load on first use, per
 * modality; a modality the profile does not describe, an image the pure-JS
 * decoders cannot read, or audio/video without an ffmpeg yields no rows
 * (with a warning) rather than failing the build.
 */
export function createCatalogMediaEmbedder(
  profile: KnowledgeEmbeddingProfile,
  opts: {
    cacheDir?: string;
    localFilesOnly?: boolean;
    onWarning?: (message: string) => void;
  } = {},
): CatalogMediaEmbedder {
  const encoders = new Map<string, Promise<MediaEncoder>>();
  const encoder = (modalities: MediaModality[]): Promise<MediaEncoder> => {
    const key = modalities.join('+');
    let pending = encoders.get(key);
    if (!pending) {
      pending = loadMediaEncoder(profile, {
        modalities,
        ...(opts.cacheDir ? { cacheDir: opts.cacheDir } : {}),
        ...(opts.localFilesOnly ? { localFilesOnly: true } : {}),
      });
      encoders.set(key, pending);
    }
    return pending;
  };
  const warn = (message: string) => opts.onWarning?.(message);

  const withTempFile = async <T>(request: MediaEmbedRequest, fn: (path: string) => Promise<T>) => {
    const dir = await mkdtemp(join(tmpdir(), 'gezel-media-'));
    try {
      const path = join(dir, request.path.slice(request.path.lastIndexOf('/') + 1));
      await writeFile(path, request.bytes);
      return await fn(path);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };

  return {
    async embedMedia(request) {
      if (request.modality === 'image') {
        let rgb: ReturnType<typeof rgbaToRgb>;
        try {
          rgb = rgbaToRgb(decodeImage(request.bytes));
        } catch (err) {
          if (err instanceof ImageDecodeError) {
            warn(`${request.path}: ${err.message}; no media row`);
            return [];
          }
          throw err;
        }
        const vector = await (await encoder(['image'])).embedImage(rgb);
        return [{ vector, width: rgb.width, height: rgb.height }];
      }
      const ffmpeg = await locateFfmpeg();
      if (!ffmpeg) {
        warn(
          `${request.path}: no ffmpeg found (GEZEL_FFMPEG, SQUISQ_FFMPEG or PATH); no media rows`,
        );
        return [];
      }
      return withTempFile(request, async (path) => {
        if (request.modality === 'audio') {
          const windows = await decodeAudioWindows(ffmpeg.path, path, profile);
          const audio = await encoder(['audio']);
          const out: MediaEmbedResult[] = [];
          for (const w of windows) {
            out.push({
              vector: await audio.embedAudio(w.data),
              startMs: w.startMs,
              endMs: w.endMs,
            });
          }
          return out;
        }
        const windows = await decodeVideoWindows(ffmpeg.path, path, profile);
        const video = await encoder(['video']);
        const out: MediaEmbedResult[] = [];
        for (const w of windows) {
          out.push({
            vector: await video.embedVideo(w.data, (w.endMs - w.startMs) / 1000),
            startMs: w.startMs,
            endMs: w.endMs,
          });
        }
        return out;
      });
    },
    async dispose() {
      for (const pending of encoders.values())
        await pending.then((e) => e.dispose()).catch(() => {});
      encoders.clear();
    },
  };
}
