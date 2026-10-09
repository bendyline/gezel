/**
 * The pinned files a profile load reads, and getting the weight sidecars into
 * the cache before transformers.js goes looking for them.
 *
 * transformers.js 4.3.1 fetches `.onnx_data` sidecars inside
 * `new Promise(async (resolve) => { await getModelFile(…) })`. When the file
 * is missing (a `local_files_only` load of an incomplete install) or its
 * download fails, the rejection escapes the executor as an unhandled
 * rejection and the load's promise never settles: a hang, not an error. So a
 * local-only load checks the cache first, and a networked load downloads the
 * sidecars itself, hash-verified, before handing over.
 */

import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { KnowledgeEmbeddingProfile } from '@bendyline/gezk';
import { embeddingProfileArtifacts } from '@bendyline/gezk';
import { mediaEncoderPins, transformersCachePath } from './artifact-verify.js';

export interface PinnedLoadFile {
  path: string;
  /** `sha256:<hex>` when the profile pins it. */
  digest?: string;
}

type MediaModality = 'image' | 'video' | 'audio';

/** `onnx/model.onnx_data`, `onnx/model.onnx_data_1`: weights stored beside a graph. */
export function isExternalDataFile(path: string): boolean {
  return /\.onnx_data(_\d+)?$/.test(path);
}

/** Every file the profile pins for its text session and, with `modalities`, its media encoders. */
export function pinnedLoadFiles(
  profile: KnowledgeEmbeddingProfile,
  modalities: readonly MediaModality[] = [],
): PinnedLoadFile[] {
  const artifacts = embeddingProfileArtifacts(profile);
  const files: PinnedLoadFile[] = [
    {
      path: artifacts.onnxFile,
      ...(artifacts.onnxDigest ? { digest: artifacts.onnxDigest } : {}),
    },
    {
      path: artifacts.tokenizerFile,
      ...(artifacts.tokenizerDigest ? { digest: artifacts.tokenizerDigest } : {}),
    },
    ...artifacts.files.map((f) => ({ path: f.path, ...(f.digest ? { digest: f.digest } : {}) })),
    ...mediaEncoderPins(profile, modalities).map((p) => ({ path: p.file, digest: p.expected })),
  ];
  const seen = new Set<string>();
  return files.filter((f) => !seen.has(f.path) && seen.add(f.path));
}

async function isFile(path: string): Promise<boolean> {
  return stat(path)
    .then((s) => s.isFile())
    .catch(() => false);
}

/** The pinned files of a load that are not in the transformers.js cache. */
export async function missingPinnedFiles(
  profile: KnowledgeEmbeddingProfile,
  opts: { cacheDir: string; modalities?: readonly MediaModality[]; revision?: string },
): Promise<string[]> {
  const revision = opts.revision ?? profile.model.revision;
  const missing: string[] = [];
  for (const file of pinnedLoadFiles(profile, opts.modalities)) {
    const path = transformersCachePath(opts.cacheDir, profile.model.repo, revision, file.path);
    if (!(await isFile(path))) missing.push(file.path);
  }
  return missing;
}

/**
 * Download the profile's missing weight sidecars into the cache, each to a
 * `.partial`, hashed against its pin and renamed, so the load that follows
 * finds them cached. Throws on an HTTP error or a digest mismatch.
 */
export async function prefetchExternalData(
  profile: KnowledgeEmbeddingProfile,
  opts: {
    cacheDir: string;
    modalities?: readonly MediaModality[];
    revision?: string;
    fetchImpl?: typeof fetch;
  },
): Promise<string[]> {
  const revision = opts.revision ?? profile.model.revision;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const fetched: string[] = [];
  for (const file of pinnedLoadFiles(profile, opts.modalities)) {
    if (!isExternalDataFile(file.path)) continue;
    const dest = transformersCachePath(opts.cacheDir, profile.model.repo, revision, file.path);
    if (await isFile(dest)) continue;
    const url = `https://huggingface.co/${profile.model.repo}/resolve/${revision}/${file.path}`;
    const res = await fetchImpl(url);
    if (!res.ok || !res.body) throw new Error(`${file.path}: download failed (HTTP ${res.status})`);
    await mkdir(dirname(dest), { recursive: true });
    const partial = `${dest}.partial`;
    const hash = createHash('sha256');
    try {
      const out = createWriteStream(partial);
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        hash.update(value);
        if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()));
      }
      await new Promise<void>((resolve, reject) => {
        out.on('error', reject);
        out.end(() => resolve());
      });
      const digest = `sha256:${hash.digest('hex')}`;
      if (file.digest && digest !== file.digest) {
        throw new Error(`${file.path}: downloaded ${digest}, profile pins ${file.digest}`);
      }
      await rename(partial, dest);
    } catch (err) {
      await rm(partial, { force: true });
      throw err;
    }
    fetched.push(file.path);
  }
  return fetched;
}
