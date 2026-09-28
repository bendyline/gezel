import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { estimateVideoWorkingSet, videoWorkingSetBytes } from './working-set.js';

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

describe('estimateVideoWorkingSet', () => {
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
    const ws = await estimateVideoWorkingSet({
      modelDir: dir,
      family: 'ltx2',
      accelerator: 'mps',
      vaeDtype: 'float32',
    });
    expect(ws.weightBytes).toBe(1000 * 2 + 1000 * 2 + 100 * 4);
    expect(ws.bytes).toBe(videoWorkingSetBytes(ws.weightBytes));
  });

  it('halves the VAE too when the model does not force it to float32', async () => {
    const ws = await estimateVideoWorkingSet({ modelDir: dir, family: 'ltx', accelerator: 'cuda' });
    expect(ws.weightBytes).toBe(1000 * 2 + 1000 * 2 + 100 * 2);
  });

  it('always keeps the WAN VAE at float32, as the server does', async () => {
    const ws = await estimateVideoWorkingSet({ modelDir: dir, family: 'wan', accelerator: 'mps' });
    expect(ws.weightBytes).toBe(1000 * 2 + 1000 * 2 + 100 * 4);
  });

  it('prices everything at float32 on CPU', async () => {
    const ws = await estimateVideoWorkingSet({ modelDir: dir, family: 'ltx2', accelerator: 'cpu' });
    expect(ws.weightBytes).toBe((1000 + 1000 + 100) * 4);
  });

  it('skips an unsharded duplicate that the directory index does not load', async () => {
    await writeSafetensors(join(dir, 'connectors', 'shard-1.safetensors'), 'BF16', 500);
    await writeSafetensors(join(dir, 'connectors', 'unsharded.safetensors'), 'BF16', 500);
    await writeFile(
      join(dir, 'connectors', 'diffusion_pytorch_model.safetensors.index.json'),
      JSON.stringify({ weight_map: { 'x.weight': 'shard-1.safetensors' } }),
    );
    const ws = await estimateVideoWorkingSet({ modelDir: dir, family: 'ltx2', accelerator: 'mps' });
    expect(ws.weightBytes).toBe(1000 * 2 + 1000 * 2 + 100 * 2 + 500 * 2);
  });

  it('keeps non-float tensors at their stored size', async () => {
    await writeSafetensors(join(dir, 'scheduler', 'ids.safetensors'), 'I64', 10);
    const ws = await estimateVideoWorkingSet({ modelDir: dir, family: 'ltx', accelerator: 'mps' });
    expect(ws.weightBytes).toBe(1000 * 2 + 1000 * 2 + 100 * 2 + 10 * 8);
  });

  it('prices an unreadable safetensors file by its size on disk', async () => {
    await mkdir(join(dir, 'broken'), { recursive: true });
    await writeFile(join(dir, 'broken', 'x.safetensors'), Buffer.alloc(64, 0xff));
    const ws = await estimateVideoWorkingSet({ modelDir: dir, family: 'ltx', accelerator: 'mps' });
    expect(ws.weightBytes).toBe(1000 * 2 + 1000 * 2 + 100 * 2 + 64);
  });
});
