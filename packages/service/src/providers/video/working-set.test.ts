import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { videoWorkingBytes } from '@bendyline/gezel';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { estimateVideoRequirement } from './working-set.js';

/** A minimal safetensors file: one tensor of `elements` values in `dtype`. */
async function writeSafetensors(path: string, dtype: string, elements: number): Promise<void> {
  const width = { F32: 4, BF16: 2, F16: 2, I64: 8 }[dtype] ?? 4;
  const header = Buffer.from(
    JSON.stringify({
      __metadata__: { format: 'pt' },
      weight: { dtype, shape: [elements], data_offsets: [0, elements * width] },
    }),
  );
  const length = Buffer.alloc(8);
  length.writeBigUInt64LE(BigInt(header.length));
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, Buffer.concat([length, header, Buffer.alloc(elements * width)]));
}

describe('estimateVideoRequirement', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gezel-video-ws-'));
    // bf16 transformer, float32 text encoder, float32 VAE — the LTX-2.x layout.
    await writeSafetensors(join(dir, 'transformer', 'a.safetensors'), 'BF16', 1000);
    await writeSafetensors(join(dir, 'text_encoder', 'b.safetensors'), 'F32', 1000);
    await writeSafetensors(join(dir, 'vae', 'c.safetensors'), 'F32', 100);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('prices float tensors at bfloat16 on an accelerator, keeping a float32 VAE', async () => {
    const req = await estimateVideoRequirement({
      modelDir: dir,
      family: 'ltx2',
      accelerator: 'mps',
      pool: 'unified',
      vaeDtype: 'float32',
    });
    expect(req.weightBytes).toBe(1000 * 2 + 1000 * 2 + 100 * 4);
    expect(req.bytes).toBe(Math.ceil(req.weightBytes + videoWorkingBytes(req.weightBytes)));
    expect(req.gpuBytes).toBe(req.bytes);
    expect(req.exact).toBe(true);
  });

  it('halves the VAE too when the model does not force it to float32', async () => {
    const req = await estimateVideoRequirement({
      modelDir: dir,
      family: 'ltx',
      accelerator: 'cuda',
      pool: 'discrete',
    });
    expect(req.weightBytes).toBe(1000 * 2 + 1000 * 2 + 100 * 2);
    // Moved whole onto the card: every weight is on it.
    expect(req.gpuBytes).toBe(req.weightBytes);
  });

  it('holds only the heaviest component on a CUDA card for a streaming LTX-2 pipeline', async () => {
    const req = await estimateVideoRequirement({
      modelDir: dir,
      family: 'ltx2',
      accelerator: 'cuda',
      pool: 'discrete',
      vaeDtype: 'float32',
    });
    expect(req.gpuBytes).toBe(1000 * 2);
  });

  it('always keeps the WAN VAE at float32, as the server does', async () => {
    const req = await estimateVideoRequirement({
      modelDir: dir,
      family: 'wan',
      accelerator: 'mps',
      pool: 'unified',
    });
    expect(req.weightBytes).toBe(1000 * 2 + 1000 * 2 + 100 * 4);
  });

  it('prices everything at float32 on CPU, with nothing on a card', async () => {
    const req = await estimateVideoRequirement({
      modelDir: dir,
      family: 'ltx2',
      accelerator: 'cpu',
      pool: 'cpu',
    });
    expect(req.weightBytes).toBe((1000 + 1000 + 100) * 4);
    expect(req.gpuBytes).toBe(0);
  });

  it('skips an unsharded duplicate that the directory index does not load', async () => {
    await writeSafetensors(join(dir, 'connectors', 'shard-1.safetensors'), 'BF16', 500);
    await writeSafetensors(join(dir, 'connectors', 'unsharded.safetensors'), 'BF16', 500);
    await writeFile(
      join(dir, 'connectors', 'diffusion_pytorch_model.safetensors.index.json'),
      JSON.stringify({ weight_map: { 'x.weight': 'shard-1.safetensors' } }),
    );
    const req = await estimateVideoRequirement({
      modelDir: dir,
      family: 'ltx2',
      accelerator: 'mps',
      pool: 'unified',
    });
    expect(req.weightBytes).toBe(1000 * 2 + 1000 * 2 + 100 * 2 + 500 * 2);
  });

  it('keeps non-float tensors at their stored size', async () => {
    await writeSafetensors(join(dir, 'scheduler', 'ids.safetensors'), 'I64', 10);
    const req = await estimateVideoRequirement({
      modelDir: dir,
      family: 'ltx',
      accelerator: 'mps',
      pool: 'unified',
    });
    expect(req.weightBytes).toBe(1000 * 2 + 1000 * 2 + 100 * 2 + 10 * 8);
  });

  it('prices an unreadable safetensors file by its size on disk, and says it is unread', async () => {
    await mkdir(join(dir, 'broken'), { recursive: true });
    await writeFile(join(dir, 'broken', 'x.safetensors'), Buffer.alloc(64, 0xff));
    const req = await estimateVideoRequirement({
      modelDir: dir,
      family: 'ltx',
      accelerator: 'mps',
      pool: 'unified',
    });
    expect(req.weightBytes).toBe(1000 * 2 + 1000 * 2 + 100 * 2 + 64);
    expect(req.exact).toBe(false);
  });
});
