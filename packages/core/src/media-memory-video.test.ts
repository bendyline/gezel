import { describe, expect, it } from 'vitest';
import {
  videoMemoryCoefficientCandidates,
  videoMemoryCoefficients,
} from './media-memory-coefficients.js';
import {
  type MediaWeightFile,
  chooseVideoVaeDecode,
  componentPhase,
  largestVideoFrames,
  sdCppVideoDecoder,
  sdCppVideoMemoryRequirement,
  sdCppVideoVaeDecode,
  videoMemoryRequirement,
  videoWorkingBytes,
} from './media-memory.js';
import {
  VIDEO_ARCHITECTURES,
  type VideoRenderSize,
  snapVideoFrames,
  snapVideoSide,
  videoLatentTokens,
  videoSizeMultiple,
} from './video-geometry.js';

const GiB = 1024 ** 3;

function read(component: string, dtype: string, elements: number): MediaWeightFile {
  const stored = { F32: 4, BF16: 2, F16: 2 }[dtype] as number;
  return {
    component,
    sizeBytes: elements * stored,
    format: 'safetensors',
    tensors: { floatElements: { [dtype]: elements }, otherBytes: 0 },
  };
}

function gguf(component: string, bytes: number): MediaWeightFile {
  return { component, sizeBytes: bytes, format: 'gguf' };
}

/** Wan2.2 TI2V-5B as the diffusers tree publishes it. */
const WAN_5B_DIFFUSERS: MediaWeightFile[] = [
  read('text_encoder', 'BF16', 5.68e9),
  read('transformer', 'F32', 5.0e9),
  read('vae', 'F32', 0.7e9),
];

/** The same model as the sd.cpp entry ships it: Q4 GGUFs and the Comfy VAE. */
const WAN_5B_Q4: MediaWeightFile[] = [
  gguf('diffusion_model', 3.43e9),
  gguf('t5xxl', 3.66e9),
  read('vae', 'F32', 0.35e9),
];

const WAN_DEFAULT: VideoRenderSize = { width: 1280, height: 704, numFrames: 121 };

describe('video geometry', () => {
  it('counts the tokens each architecture attends over', () => {
    expect(
      videoLatentTokens(VIDEO_ARCHITECTURES['ltx-2'], { width: 768, height: 512, numFrames: 121 }),
    ).toBe(6_144);
    expect(videoLatentTokens(VIDEO_ARCHITECTURES['wan2.2-ti2v-5b'], WAN_DEFAULT)).toBe(27_280);
    expect(
      videoLatentTokens(VIDEO_ARCHITECTURES['wan2.1-1.3b'], {
        width: 832,
        height: 480,
        numFrames: 81,
      }),
    ).toBe(32_760);
  });

  it('snaps sizes to the token span and frames to the VAE grid', () => {
    const wan5b = VIDEO_ARCHITECTURES['wan2.2-ti2v-5b'];
    const ltx = VIDEO_ARCHITECTURES['ltx-2'];
    expect(videoSizeMultiple(wan5b)).toBe(32);
    expect(videoSizeMultiple(VIDEO_ARCHITECTURES['wan2.1-1.3b'])).toBe(16);
    expect(snapVideoSide(wan5b, 700)).toBe(704);
    expect(snapVideoSide(wan5b, 3)).toBe(32);
    expect(snapVideoFrames(wan5b, 120)).toBe(117);
    expect(snapVideoFrames(ltx, 120)).toBe(113);
    expect(snapVideoFrames(ltx, 0)).toBe(1);
  });
});

describe('videoMemoryRequirement at a size', () => {
  it('keeps the legacy price at the default size while nothing is measured', () => {
    const legacy = videoMemoryRequirement({
      files: WAN_5B_DIFFUSERS,
      family: 'wan',
      accelerator: 'mps',
      pool: 'unified',
    });
    const sized = videoMemoryRequirement({
      files: WAN_5B_DIFFUSERS,
      family: 'wan',
      accelerator: 'mps',
      pool: 'unified',
      size: WAN_DEFAULT,
      defaultSize: WAN_DEFAULT,
    });
    expect(sized.bytes).toBe(legacy.bytes);
    expect(sized.calibration).toBe('provisional');
    expect(sized.size).toEqual(WAN_DEFAULT);
    expect(sized.breakdown?.components.map((c) => [c.component, c.phase])).toEqual([
      ['text_encoder', 'encode'],
      ['transformer', 'sample'],
      ['vae', 'decode'],
    ]);
  });

  it('never prices a larger clip below a smaller one', () => {
    const priceAt = (size: VideoRenderSize) =>
      videoMemoryRequirement({
        files: WAN_5B_DIFFUSERS,
        family: 'ltx2',
        accelerator: 'mps',
        pool: 'unified',
        architecture: 'ltx-2',
        size,
        defaultSize: { width: 768, height: 512, numFrames: 121 },
        guidanceScale: 3,
      }).bytes;
    for (const [w, h] of [
      [512, 512],
      [768, 512],
      [1024, 576],
      [1280, 704],
    ] as const) {
      let prior = 0;
      for (let frames = 9; frames <= 241; frames += 8) {
        const bytes = priceAt({ width: w, height: h, numFrames: frames });
        expect(bytes).toBeGreaterThanOrEqual(prior);
        prior = bytes;
      }
    }
    for (let side = 256; side <= 1280; side += 32) {
      expect(priceAt({ width: side + 32, height: 512, numFrames: 121 })).toBeGreaterThanOrEqual(
        priceAt({ width: side, height: 512, numFrames: 121 }),
      );
    }
  });

  it('decodes LTX-2 whichever way is smaller off CUDA, as the server used to by threshold', () => {
    const at = (family: string, accelerator: 'mps' | 'cuda', width: number, height: number) =>
      chooseVideoVaeDecode({ family, accelerator, size: { width, height, numFrames: 121 } });
    expect(at('ltx2', 'mps', 768, 512)).toBe('untiled');
    expect(at('ltx2', 'mps', 1280, 704)).toBe('spatial');
    expect(at('wan', 'mps', 1280, 704)).toBe('untiled');
    expect(at('wan', 'cuda', 512, 512)).toBe('spatial');
    expect(
      chooseVideoVaeDecode({
        engine: 'sd-cpp',
        family: 'wan',
        accelerator: 'mps',
        size: { width: 832, height: 480, numFrames: 81 },
        configured: 'temporal',
      }),
    ).toBe('temporal');
  });

  it('prices sd.cpp GGUF weights at their size and keeps the default anchor where unmeasured', () => {
    const req = sdCppVideoMemoryRequirement({
      files: WAN_5B_Q4,
      family: 'wan',
      architecture: 'wan2.2-ti2v-5b',
      accelerator: 'cuda',
      backend: 'vulkan',
      pool: 'unified',
      defaultSize: WAN_DEFAULT,
    });
    expect(req.weightBytes).toBe(Math.ceil(3.43e9 + 3.66e9 + 0.35e9 * 4));
    expect(req.engine).toBe('sd-cpp');
    expect(req.backend).toBe('vulkan');
    expect(req.calibration).toBe('provisional');
    expect(req.bytes).toBe(Math.ceil(req.weightBytes + videoWorkingBytes(req.weightBytes)));
  });

  it('prices animating a picture as its own phase, which only a short clip feels', () => {
    const files: MediaWeightFile[] = [
      { component: 'diffusion_model', sizeBytes: 3.44e9, format: 'gguf' },
      { component: 't5xxl', sizeBytes: 3.66e9, format: 'gguf' },
      { component: 'tae', sizeBytes: 0.023e9, format: 'gguf' },
    ];
    const price = (size: VideoRenderSize, animatesPicture: boolean) =>
      sdCppVideoMemoryRequirement({
        files,
        family: 'wan',
        architecture: 'wan2.2-ti2v-5b',
        accelerator: 'mps',
        backend: 'metal',
        pool: 'unified',
        size,
        defaultSize: WAN_DEFAULT,
        guidanceScale: 1,
        vaeDecode: 'tiny',
        animatesPicture,
      });
    const short = { width: 1280, height: 704, numFrames: 33 };
    const fromPicture = price(short, true);
    expect(fromPicture.bytes).toBeGreaterThan(price(short, false).bytes);
    expect(fromPicture.breakdown?.peakPhase).toBe('encode');
    // At the default clip sampling outweighs it: Turbo held 12.82 GiB from a
    // picture and 12.69 from words.
    expect(price(WAN_DEFAULT, true).bytes).toBe(price(WAN_DEFAULT, false).bytes);
  });

  it('prices Wan2.2 on Metal from what sd-server measured', () => {
    // The tiny decoder in place of the VAE, as Metal loads it.
    const files: MediaWeightFile[] = [
      { component: 'diffusion_model', sizeBytes: 3.43e9, format: 'gguf' },
      { component: 't5xxl', sizeBytes: 3.66e9, format: 'gguf' },
      { component: 'tae', sizeBytes: 0.023e9, format: 'gguf' },
    ];
    const price = (size: VideoRenderSize) =>
      sdCppVideoMemoryRequirement({
        files,
        family: 'wan',
        architecture: 'wan2.2-ti2v-5b',
        accelerator: 'mps',
        backend: 'metal',
        pool: 'unified',
        size,
        defaultSize: WAN_DEFAULT,
        guidanceScale: 5,
        vaeDecode: 'tiny',
      });
    // Peaks with GPU-held memory counted, M5 Max, 2026-11-10: the largest of
    // repeat renders (they differ by up to 0.5 GiB).
    for (const [size, peakGiB] of [
      [{ width: 512, height: 512, numFrames: 17 }, 8.46],
      [{ width: 640, height: 512, numFrames: 33 }, 8.27],
      [{ width: 1280, height: 704, numFrames: 33 }, 9.51],
    ] as const) {
      const req = price(size);
      expect(req.calibration).toBe('measured');
      expect(req.bytes).toBeGreaterThan(peakGiB * GiB);
      expect(req.bytes).toBeLessThan(Math.max(peakGiB * GiB * 1.15, (peakGiB + 1.5) * GiB));
    }
  });

  it('prices the layers sd-server widens to float32 beyond the file', () => {
    const req = sdCppVideoMemoryRequirement({
      files: [
        { component: 'diffusion_model', sizeBytes: 14_194_441_248, format: 'gguf' },
        { component: 'llm', sizeBytes: 7_300_778_336, format: 'gguf' },
      ],
      family: 'ltx2',
      architecture: 'ltx-2',
      accelerator: 'mps',
      backend: 'metal',
      pool: 'unified',
      defaultSize: { width: 768, height: 512, numFrames: 121 },
    });
    // sd-server reported 815 MiB over the GGUF: the bf16 AdaLN linears at float32.
    const diffusion = req.breakdown?.components.find((c) => c.component === 'diffusion_model');
    expect(diffusion?.bytes).toBe(14_194_441_248 + 854_589_440);
  });

  it('prices a decoder tile by its area, and never the frames it writes out', () => {
    const decodeAt = (vaeTileSizePx: number | undefined, size: VideoRenderSize) =>
      sdCppVideoMemoryRequirement({
        files: [
          { component: 'diffusion_model', sizeBytes: 2.84e9, format: 'gguf' },
          { component: 't5xxl', sizeBytes: 6.04e9, format: 'gguf' },
          { component: 'tae', sizeBytes: 0.023e9, format: 'gguf' },
        ],
        family: 'wan',
        architecture: 'wan2.1-1.3b',
        accelerator: 'mps',
        backend: 'metal',
        pool: 'unified',
        size,
        defaultSize: { width: 832, height: 480, numFrames: 81 },
        guidanceScale: 6,
        vaeDecode: 'tiny',
        vaeTileSizePx,
      }).breakdown?.phases.find((p) => p.phase === 'decode')?.workingBytes ?? 0;
    const clip = { width: 480, height: 480, numFrames: 81 };
    const frames = 15 * 480 * 480 * 81;
    // Wan2.1's tiny decoder at 128-pixel tiles held a quarter of what it held at 256.
    expect(decodeAt(128, clip) - frames).toBeCloseTo((decodeAt(undefined, clip) - frames) / 4, -3);
    expect(decodeAt(256, clip)).toBe(decodeAt(undefined, clip));
    expect(decodeAt(128, clip) / GiB).toBeGreaterThan(2.22);
  });

  it('holds only --max-vram of an sd.cpp model on a discrete card', () => {
    const req = sdCppVideoMemoryRequirement({
      files: WAN_5B_Q4,
      family: 'wan',
      architecture: 'wan2.2-ti2v-5b',
      accelerator: 'cuda',
      backend: 'vulkan',
      pool: 'discrete',
      defaultSize: WAN_DEFAULT,
      gpuLimitBytes: 4 * GiB,
    });
    expect(req.gpuBytes).toBe(4 * GiB);
    expect(req.gpuPeakBytes).toBe(4 * GiB);
    expect(req.floor.gpuBytes).toBe(4 * GiB);
    expect(req.bytes).toBeGreaterThan(req.weightBytes);
  });

  it('falls back to the legacy price for a family this build does not know', () => {
    const req = videoMemoryRequirement({
      files: WAN_5B_DIFFUSERS,
      family: 'mochi',
      accelerator: 'mps',
      pool: 'unified',
      size: WAN_DEFAULT,
    });
    expect(req.bytes).toBe(Math.ceil(req.weightBytes + videoWorkingBytes(req.weightBytes)));
    expect(req.breakdown).toBeUndefined();
  });
});

describe('largestVideoFrames', () => {
  it('finds the longest clip on the frame grid whose price is accepted', () => {
    const priceAt = (numFrames: number) =>
      videoMemoryRequirement({
        files: WAN_5B_DIFFUSERS,
        family: 'wan',
        accelerator: 'mps',
        pool: 'unified',
        size: { width: 1280, height: 704, numFrames },
        defaultSize: WAN_DEFAULT,
      });
    const cap = priceAt(81).bytes;
    const frames = largestVideoFrames(
      'wan2.2-ti2v-5b',
      { min: 25, max: 161 },
      priceAt,
      (r) => r.bytes <= cap,
    );
    expect(frames).toBeGreaterThanOrEqual(81);
    expect(((frames as number) - 1) % 4).toBe(0);
    expect(priceAt(frames as number).bytes).toBeLessThanOrEqual(cap);
    if ((frames as number) + 4 <= 161)
      expect(priceAt((frames as number) + 4).bytes).toBeGreaterThan(cap);
  });

  it('answers null when even the shortest clip does not fit', () => {
    expect(
      largestVideoFrames(
        'ltx-2',
        { min: 9, max: 241 },
        () =>
          videoMemoryRequirement({
            files: WAN_5B_DIFFUSERS,
            family: 'ltx2',
            accelerator: 'mps',
            pool: 'unified',
          }),
        () => false,
      ),
    ).toBeNull();
  });
});

describe('coefficients', () => {
  it('uses a measured set, else borrows the costliest sibling, else stays provisional', () => {
    for (const arch of ['wan2.2-ti2v-5b', 'wan2.1-1.3b', 'lingbot-video-1.3b', 'ltx-2'] as const) {
      expect(videoMemoryCoefficients('sd-cpp', 'metal', arch).status).toBe('measured');
    }
    // LTX-Video 0.9 decodes whole clips like LTX-2, so it borrows LTX-2's set.
    const ltx09 = videoMemoryCoefficients('sd-cpp', 'metal', 'ltx-video-0.9');
    expect(ltx09.status).toBe('borrowed');
    expect(ltx09.source).toBe('borrowed from sd-cpp:metal:ltx-2');
    expect(videoMemoryCoefficients('sd-cpp', 'vulkan', 'wan2.2-ti2v-5b').status).toBe(
      'provisional',
    );
    expect(videoMemoryCoefficients('diffusers', 'mps', 'wan2.2-ti2v-5b').status).toBe(
      'provisional',
    );
  });

  it('prices an unmeasured backend with the same architecture measured elsewhere too', () => {
    const candidates = videoMemoryCoefficientCandidates('sd-cpp', 'vulkan', 'wan2.2-ti2v-5b');
    expect(candidates.map((c) => c.status)).toEqual(['provisional', 'borrowed']);
    expect(candidates[1]?.source).toBe('borrowed from sd-cpp:metal:wan2.2-ti2v-5b');
    expect(
      videoMemoryCoefficientCandidates('sd-cpp', 'metal', 'wan2.2-ti2v-5b').map((c) => c.status),
    ).toEqual(['measured']);
  });

  it('assigns each component to the phase that uses it', () => {
    expect(componentPhase('text_encoder_2')).toBe('encode');
    expect(componentPhase('t5xxl')).toBe('encode');
    expect(componentPhase('embeddings_connectors')).toBe('encode');
    expect(componentPhase('diffusion_model')).toBe('sample');
    expect(componentPhase('high_noise_diffusion_model')).toBe('sample');
    expect(componentPhase('vae')).toBe('decode');
    expect(componentPhase('audio_vae')).toBe('audio');
  });
});

describe('the decoder an sd.cpp video model loads', () => {
  it('uses the tiny decoder on Metal, where the full Wan VAE takes hours', () => {
    expect(sdCppVideoDecoder(['vae', 'tae'], 'metal')).toBe('tae');
    expect(sdCppVideoVaeDecode(undefined, 'tae')).toBe('tiny');
  });

  it('uses the full VAE elsewhere, and whichever one an entry ships alone', () => {
    expect(sdCppVideoDecoder(['vae', 'tae'], 'vulkan')).toBe('vae');
    expect(sdCppVideoDecoder(['vae'], 'metal')).toBe('vae');
    expect(sdCppVideoDecoder(['tae'], 'cuda')).toBe('tae');
  });

  it('decodes as the entry tiles its full VAE', () => {
    expect(sdCppVideoVaeDecode({ vaeTiling: { spatial: true, temporal: true } })).toBe('temporal');
    expect(sdCppVideoVaeDecode({ vaeTiling: { spatial: false, temporal: false } })).toBe('untiled');
    expect(sdCppVideoVaeDecode(undefined)).toBe('spatial');
  });
});
