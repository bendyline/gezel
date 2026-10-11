import {
  type ImageModelManifest,
  MEDIA_MODEL_WONT_RUN_CODE,
  type MediaFitAssessment,
  type VideoModelManifest,
} from '@bendyline/gezel';
import { CatalogService } from '@bendyline/gezel-catalog';
import { describe, expect, it } from 'vitest';
import {
  imageMediaPool,
  sdServerRequirement,
  videoMediaPool,
  wontRunRefusal,
} from './media-fit.js';
import { imageCatalogWeightFiles, videoCatalogWeightFiles } from './weight-facts.js';

describe('the pinned catalog', () => {
  async function pinnedMediaFiles() {
    const catalog = new CatalogService();
    const videos = await catalog.list('video-model');
    const images = await catalog.list('image-model');
    return [
      ...videos.map((item) => ({
        id: item.manifest.id,
        files: videoCatalogWeightFiles(item.manifest as VideoModelManifest),
      })),
      ...images.map((item) => ({
        id: item.manifest.id,
        files: imageCatalogWeightFiles(item.manifest as ImageModelManifest),
      })),
    ];
  }

  // A model whose files the pricing does not recognize as weights would price
  // at zero and fit every machine. Fail at the pin bump instead.
  it('gives every image and video model weight files to price', async () => {
    const models = await pinnedMediaFiles();
    expect(models.length).toBeGreaterThan(0);
    for (const model of models) expect(model.files.length, model.id).toBeGreaterThan(0);
  });

  // Without pinned facts a model is priced by its plausible range and can
  // only be warned about, never hidden. Gilde's validator requires them on a
  // new version; this holds the pin to it once the catalog carries any.
  it('pins the stored precision of every safetensors weight file', async () => {
    const models = await pinnedMediaFiles();
    const safetensors = models.flatMap((m) =>
      m.files.filter((f) => f.format === 'safetensors').map((f) => ({ id: m.id, file: f })),
    );
    if (!safetensors.some((s) => s.file.tensors)) return;
    expect(safetensors.filter((s) => !s.file.tensors).map((s) => s.id)).toEqual([]);
  });
});

const GiB = 1024 ** 3;

describe('media engine placement', () => {
  it('puts video on the card it runs on, and in shared memory on unified hosts', () => {
    expect(videoMediaPool('cuda', 'discrete-gpu')).toBe('discrete');
    expect(videoMediaPool('cuda', 'unified')).toBe('unified'); // DGX Spark
    expect(videoMediaPool('mps', 'unified')).toBe('unified');
    // An AMD card does not help the video engine, which only knows CUDA.
    expect(videoMediaPool('cpu', 'discrete-gpu')).toBe('cpu');
  });

  it('follows the one sd-server binary each platform ships', () => {
    expect(imageMediaPool('unified', { platform: 'darwin', arch: 'arm64' })).toBe('unified');
    expect(imageMediaPool('system-ram', { platform: 'darwin', arch: 'x64' })).toBe('cpu');
    expect(imageMediaPool('discrete-gpu', { platform: 'win32', arch: 'arm64' })).toBe('cpu');
    expect(imageMediaPool('discrete-gpu', { platform: 'win32', arch: 'x64' })).toBe('discrete');
    expect(imageMediaPool('system-ram', { platform: 'linux', arch: 'x64' })).toBe('cpu');
  });
});

describe('sdServerRequirement', () => {
  it('prices Iris diffusion weights at bf16 with no VAE decode, as its launch converts them', () => {
    const req = sdServerRequirement({
      modelId: 'iris-3b-f32',
      weightsKind: 'diffusion-model',
      pool: 'unified',
      files: [
        {
          component: 'diffusion_model',
          sizeBytes: 8 * GiB,
          format: 'safetensors',
          tensors: { floatElements: { F32: 2 * GiB }, otherBytes: 0 },
        },
      ],
    });
    expect(req.weightBytes).toBe(4 * GiB);
  });

  it('charges the untiled VAE decode for models that cannot tile', () => {
    const files = [{ component: 'diffusion_model', sizeBytes: 6 * GiB, format: 'gguf' as const }];
    const krea = sdServerRequirement({
      modelId: 'krea-2-turbo-q4',
      weightsKind: 'diffusion-model',
      pool: 'unified',
      files,
    });
    const flux = sdServerRequirement({
      modelId: 'flux-1-schnell-q4',
      weightsKind: 'diffusion-model',
      pool: 'unified',
      files,
    });
    expect(krea.bytes).toBeGreaterThan(flux.bytes);
  });
});

describe('wontRunRefusal', () => {
  const fit = (verdict: MediaFitAssessment['verdict']): MediaFitAssessment => ({
    verdict,
    pool: 'unified',
    weightBytes: 0,
    bytes: 0,
    gpuBytes: 0,
    exact: true,
    neededBytes: 39 * GiB,
    availableBytes: 22 * GiB,
    reason: 'It needs about 39 GB.',
  });

  it('refuses only a model that will not run', async () => {
    expect(await wontRunRefusal(async () => fit('wont-run'))).toEqual({
      error: 'This model is too large for this machine. It needs about 39 GB.',
      code: MEDIA_MODEL_WONT_RUN_CODE,
    });
    expect(await wontRunRefusal(async () => fit('may-not-run'))).toBeNull();
    expect(await wontRunRefusal(async () => null)).toBeNull();
  });

  it('lets the pull start when the assessment itself fails', async () => {
    expect(
      await wontRunRefusal(async () => {
        throw new Error('catalog unavailable');
      }),
    ).toBeNull();
  });
});
