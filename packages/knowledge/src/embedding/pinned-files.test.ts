import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { KnowledgeEmbeddingProfile } from '@bendyline/gezk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BGE_SMALL_EN_V15_1, EMBEDDINGGEMMA_2_512_1 } from '../profiles/registry.js';
import { transformersCachePath } from './artifact-verify.js';
import {
  isExternalDataFile,
  missingPinnedFiles,
  pinnedLoadFiles,
  prefetchExternalData,
} from './pinned-files.js';
import { EmbedderUnavailableError, preparePinnedLoad } from './profile-embedder.js';

const WEIGHTS = Buffer.from('pretend these are 314 MB of int8 weights');
const sha = (bytes: Buffer) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

/** The gemma profile with its sidecar pinned to bytes this test can serve. */
const PROFILE: KnowledgeEmbeddingProfile = {
  ...EMBEDDINGGEMMA_2_512_1,
  model: {
    ...EMBEDDINGGEMMA_2_512_1.model,
    files: [{ path: 'onnx/model_quantized.onnx_data', digest: sha(WEIGHTS) }],
  },
};

let cacheDir: string;
const cached = (file: string) =>
  transformersCachePath(cacheDir, PROFILE.model.repo, PROFILE.model.revision, file);
async function put(file: string, bytes: Buffer | string = 'x'): Promise<void> {
  await mkdir(dirname(cached(file)), { recursive: true });
  await writeFile(cached(file), bytes);
}

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), 'gezel-pinned-'));
});
afterEach(async () => {
  await rm(cacheDir, { recursive: true, force: true });
});

describe('pinned load files', () => {
  it('lists the text session, its sidecars, and the media encoders asked for', () => {
    const text = pinnedLoadFiles(EMBEDDINGGEMMA_2_512_1).map((f) => f.path);
    expect(text).toContain('onnx/model_quantized.onnx_data');
    expect(text).not.toContain('onnx/vision_encoder_quantized.onnx');
    const withVision = pinnedLoadFiles(EMBEDDINGGEMMA_2_512_1, ['video']).map((f) => f.path);
    expect(withVision).toContain('onnx/vision_encoder_quantized.onnx_data');
    expect(withVision).not.toContain('onnx/audio_encoder_quantized.onnx');
    expect(isExternalDataFile('onnx/model.onnx_data_2')).toBe(true);
    expect(isExternalDataFile('onnx/model.onnx')).toBe(false);
  });

  it('names what an incomplete install lacks, partial downloads included', async () => {
    await put('onnx/model_quantized.onnx');
    await put('tokenizer.json');
    await put('onnx/model_quantized.onnx_data.partial');
    expect(await missingPinnedFiles(PROFILE, { cacheDir })).toEqual([
      'onnx/model_quantized.onnx_data',
    ]);
  });
});

describe('preparing a load against the sidecar hang', () => {
  it('fails a local-only load fast when a sidecar is missing', async () => {
    await put('onnx/model_quantized.onnx');
    await put('tokenizer.json');
    await expect(preparePinnedLoad(PROFILE, { cacheDir, localFilesOnly: true })).rejects.toThrow(
      EmbedderUnavailableError,
    );
    await expect(preparePinnedLoad(PROFILE, { cacheDir, localFilesOnly: true })).rejects.toThrow(
      /missing: onnx\/model_quantized\.onnx_data/,
    );
  });

  it('leaves a profile without sidecars to load exactly as before', async () => {
    await expect(
      preparePinnedLoad(BGE_SMALL_EN_V15_1, { cacheDir, localFilesOnly: true }),
    ).resolves.toBeUndefined();
  });

  it('downloads a missing sidecar into the pinned-revision cache, verified', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      return new Response(WEIGHTS);
    }) as unknown as typeof fetch;
    await preparePinnedLoad(PROFILE, { cacheDir, fetchImpl });
    expect(urls).toEqual([
      `https://huggingface.co/${PROFILE.model.repo}/resolve/${PROFILE.model.revision}/onnx/model_quantized.onnx_data`,
    ]);
    expect(await readFile(cached('onnx/model_quantized.onnx_data'))).toEqual(WEIGHTS);
    // Already cached: nothing fetched again.
    expect(await prefetchExternalData(PROFILE, { cacheDir, fetchImpl })).toEqual([]);
  });

  it('refuses bytes that do not match the pin, or a failed download, and leaves nothing behind', async () => {
    const wrong = (async () => new Response('tampered')) as unknown as typeof fetch;
    await expect(prefetchExternalData(PROFILE, { cacheDir, fetchImpl: wrong })).rejects.toThrow(
      /profile pins/,
    );
    const failed = (async () => new Response('', { status: 503 })) as unknown as typeof fetch;
    await expect(prefetchExternalData(PROFILE, { cacheDir, fetchImpl: failed })).rejects.toThrow(
      /HTTP 503/,
    );
    const onnxDir = dirname(cached('onnx/model_quantized.onnx_data'));
    expect(await readdir(onnxDir).catch(() => [])).toEqual([]);
  });
});
