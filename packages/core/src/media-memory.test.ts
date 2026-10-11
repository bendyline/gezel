import { describe, expect, it } from 'vitest';
import {
  IMAGE_UNTILED_VAE_BYTES,
  type MediaCapacity,
  type MediaWeightFile,
  assessMediaFit,
  imageMemoryRequirement,
  tallySafetensorsHeader,
  videoMemoryRequirement,
  videoWorkingBytes,
  weightFileFormat,
} from './media-memory.js';

const GiB = 1024 ** 3;

/** A weight file whose header has been read: every float in one stored dtype. */
function read(component: string, dtype: string, loadedAt2Bytes: number): MediaWeightFile {
  const stored = { F32: 4, BF16: 2, F16: 2, F8_E4M3: 1 }[dtype] as number;
  const elements = loadedAt2Bytes / 2;
  return {
    component,
    sizeBytes: elements * stored,
    format: 'safetensors',
    tensors: { floatElements: { [dtype]: elements }, otherBytes: 0 },
  };
}

/** WAN 2.2 TI2V-5B as published: bf16 UMT5, fp32 transformer, fp32 VAE. */
const WAN_5B: MediaWeightFile[] = [
  read('text_encoder', 'BF16', 10.6 * GiB),
  read('transformer', 'F32', 9.3 * GiB),
  read('vae', 'F32', 1.3 * GiB),
];

function mac(ramGiB: number, budgetGiB: number): MediaCapacity {
  return {
    pool: 'unified',
    budgetBytes: budgetGiB * GiB,
    gpuBudgetBytes: Math.min(budgetGiB, ramGiB * 0.75) * GiB,
    totalRamBytes: ramGiB * GiB,
  };
}

function card(vramGiB: number, ramGiB: number): MediaCapacity {
  return {
    pool: 'discrete',
    budgetBytes: (ramGiB * 0.6 + vramGiB * 0.95) * GiB,
    gpuBudgetBytes: vramGiB * 0.95 * GiB,
    totalRamBytes: ramGiB * GiB,
    gpuDeviceBytes: vramGiB * GiB,
  };
}

describe('tallySafetensorsHeader', () => {
  // The same fixture and answer as gilde's tools/test/safetensors.test.mjs,
  // whose twin of this function pins the `tensors` facts the catalog carries.
  // The two must agree, or a model is priced differently before and after
  // it is downloaded.
  it('counts float elements by dtype and keeps other tensors at their stored size', () => {
    expect(
      tallySafetensorsHeader({
        __metadata__: { format: 'pt' },
        a: { dtype: 'F32', shape: [10, 10], data_offsets: [0, 400] },
        b: { dtype: 'BF16', shape: [5], data_offsets: [400, 410] },
        c: { dtype: 'F32', shape: [3], data_offsets: [410, 422] },
        ids: { dtype: 'I64', shape: [4], data_offsets: [422, 454] },
      }),
    ).toEqual({ floatElements: { F32: 103, BF16: 5 }, otherBytes: 32 });
  });

  it('rejects a header that is not an object', () => {
    expect(() => tallySafetensorsHeader([])).toThrow();
  });
});

describe('weightFileFormat', () => {
  it('names weight files and nothing else', () => {
    expect(weightFileFormat('transformer/diffusion_pytorch_model-00001-of-00005.safetensors')).toBe(
      'safetensors',
    );
    expect(weightFileFormat('flux1-schnell-Q4_K_S.gguf')).toBe('gguf');
    expect(weightFileFormat('text_encoder/config.json')).toBeNull();
    expect(weightFileFormat('model.safetensors.index.json')).toBeNull();
    expect(weightFileFormat('tokenizer.json')).toBeNull();
  });
});

describe('videoMemoryRequirement', () => {
  it('loads a float32 transformer at half its published size on an accelerator', () => {
    const req = videoMemoryRequirement({
      files: WAN_5B,
      family: 'wan',
      accelerator: 'mps',
      pool: 'unified',
    });
    // UMT5 stays bf16, the fp32 transformer halves, WAN's VAE stays fp32.
    expect(req.weightBytes / GiB).toBeCloseTo(10.6 + 9.3 + 2.6, 5);
    expect(req.bytes).toBe(Math.ceil(req.weightBytes + videoWorkingBytes(req.weightBytes)));
    expect(req.exact).toBe(true);
    expect(req.floor).toEqual({
      weightBytes: req.weightBytes,
      bytes: req.bytes,
      gpuBytes: req.gpuBytes,
    });
  });

  it('puts the whole pipeline on a card unless it streams components', () => {
    const whole = videoMemoryRequirement({
      files: WAN_5B,
      family: 'wan',
      accelerator: 'cuda',
      pool: 'discrete',
    });
    expect(whole.gpuBytes).toBe(whole.weightBytes);

    const streaming = videoMemoryRequirement({
      files: [read('text_encoder', 'F32', 22.7 * GiB), read('transformer', 'BF16', 35.4 * GiB)],
      family: 'ltx2',
      accelerator: 'cuda',
      pool: 'discrete',
    });
    expect(streaming.gpuBytes).toBe(Math.ceil(35.4 * GiB));
  });

  it('prices an unread file by its likely size and floors it at its smallest plausible load', () => {
    const req = videoMemoryRequirement({
      files: [{ component: 'text_encoder', sizeBytes: 20 * GiB, format: 'safetensors' }],
      family: 'ltx',
      accelerator: 'cuda',
      pool: 'discrete',
    });
    expect(req.exact).toBe(false);
    expect(req.weightBytes).toBe(20 * GiB); // as if stored bf16
    expect(req.floor.weightBytes).toBe(10 * GiB); // as if stored float32
  });
});

describe('imageMemoryRequirement', () => {
  it('keeps GGUF at its size, widens FP8 to f16, and charges an untiled VAE decode', () => {
    const files: MediaWeightFile[] = [
      { component: 'diffusion_model', sizeBytes: 6 * GiB, format: 'gguf' },
      {
        component: 't5xxl',
        sizeBytes: 4 * GiB,
        format: 'safetensors',
        tensors: { floatElements: { F8_E4M3: 4 * GiB }, otherBytes: 0 },
      },
    ];
    const tiled = imageMemoryRequirement({ files, pool: 'unified', vaeDecode: 'tiled' });
    expect(tiled.weightBytes).toBe(14 * GiB);
    const untiled = imageMemoryRequirement({ files, pool: 'unified', vaeDecode: 'untiled' });
    expect(untiled.bytes - tiled.bytes).toBe(IMAGE_UNTILED_VAE_BYTES);
  });

  it('converts only the named component to bf16', () => {
    const req = imageMemoryRequirement({
      files: [
        read('diffusion_model', 'F32', 5.6 * GiB),
        { component: 'llm', sizeBytes: 2.3 * GiB, format: 'gguf' },
      ],
      pool: 'unified',
      vaeDecode: 'none',
      bf16Components: ['diffusion_model'],
    });
    expect(req.weightBytes / GiB).toBeCloseTo(5.6 + 2.3, 5);
  });
});

describe('assessMediaFit', () => {
  const wanOnMac = videoMemoryRequirement({
    files: WAN_5B,
    family: 'wan',
    accelerator: 'mps',
    pool: 'unified',
  });

  it('will not run WAN on a 32 GB Mac, whose ledger admits about 22 GB', () => {
    const fit = assessMediaFit(wanOnMac, mac(32, 22.4));
    expect(fit.verdict).toBe('wont-run');
    expect(fit.reason).toMatch(/Gezel can use about 22 GB/);
  });

  it('runs WAN on a 64 GB Mac', () => {
    expect(assessMediaFit(wanOnMac, mac(64, 48)).verdict).toBe('fits');
  });

  it('says over-limit, not wont-run, when only the person’s memory limit is in the way', () => {
    const fit = assessMediaFit(wanOnMac, {
      ...mac(64, 48),
      limit: { budgetBytes: 30 * GiB, gpuBudgetBytes: 30 * GiB },
    });
    expect(fit.verdict).toBe('over-limit');
  });

  it('refuses a card its weights cannot fit, and only warns when just the working memory may not', () => {
    const lt13b = videoMemoryRequirement({
      files: [
        read('text_encoder', 'F32', 8.9 * GiB),
        read('transformer', 'BF16', 24.3 * GiB),
        read('vae', 'F32', 1.2 * GiB),
      ],
      family: 'ltx',
      accelerator: 'cuda',
      pool: 'discrete',
    });
    const on32 = assessMediaFit(lt13b, card(32, 64));
    expect(on32.verdict).toBe('wont-run');
    expect(on32.reason).toMatch(/graphics memory/);

    const wanOnCuda = videoMemoryRequirement({
      files: WAN_5B,
      family: 'wan',
      accelerator: 'cuda',
      pool: 'discrete',
    });
    expect(assessMediaFit(wanOnCuda, card(32, 64)).verdict).toBe('tight');
  });

  it('uses the single card, not the sum, for a one-device engine', () => {
    const req = videoMemoryRequirement({
      files: WAN_5B,
      family: 'wan',
      accelerator: 'cuda',
      pool: 'discrete',
    });
    const twoTwelves: MediaCapacity = { ...card(24, 64), gpuDeviceBytes: 12 * GiB };
    expect(assessMediaFit(req, twoTwelves).verdict).toBe('wont-run');
  });

  it('never hides a model whose precision is unknown unless even its floor is refused', () => {
    const unread = videoMemoryRequirement({
      files: [{ component: 'transformer', sizeBytes: 40 * GiB, format: 'safetensors' }],
      family: 'ltx',
      accelerator: 'mps',
      pool: 'unified',
    });
    // Likely 40 GB of weights; could be 20 if published as float32.
    expect(assessMediaFit(unread, mac(64, 48)).verdict).toBe('may-not-run');
    expect(assessMediaFit(unread, mac(16, 11.2)).verdict).toBe('wont-run');
  });

  it('refuses weights larger than physical memory on the processor', () => {
    const req = videoMemoryRequirement({
      files: WAN_5B,
      family: 'wan',
      accelerator: 'cpu',
      pool: 'cpu',
    });
    const fit = assessMediaFit(req, {
      pool: 'cpu',
      budgetBytes: 200 * GiB,
      gpuBudgetBytes: 0,
      totalRamBytes: 32 * GiB,
    });
    expect(fit.verdict).toBe('wont-run');
  });
});
