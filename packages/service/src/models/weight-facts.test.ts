import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ImageModelManifest, VideoModelManifest } from '@bendyline/gezel';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  imageCatalogWeightFiles,
  readLocalWeightTensors,
  safetensorsHeaderLength,
  videoCatalogWeightFiles,
} from './weight-facts.js';

const SHA = 'a'.repeat(64);
const TENSORS = { floatElements: { F32: 1000 }, otherBytes: 16 };

/** The bytes of a safetensors file: length prefix, header, then `bodyBytes` of weights. */
function safetensors(header: object, bodyBytes: number): Uint8Array {
  const json = Buffer.from(JSON.stringify(header));
  const prefix = Buffer.alloc(8);
  prefix.writeBigUInt64LE(BigInt(json.length));
  return Buffer.concat([prefix, json, Buffer.alloc(bodyBytes)]);
}

const HEADER = {
  __metadata__: { format: 'pt' },
  weight: { dtype: 'F32', shape: [1000], data_offsets: [0, 4000] },
  ids: { dtype: 'I64', shape: [2], data_offsets: [4000, 4016] },
};

describe('safetensorsHeaderLength', () => {
  it('rejects a length larger than the file', () => {
    const file = safetensors(HEADER, 0);
    expect(safetensorsHeaderLength(file, file.byteLength)).toBeGreaterThan(0);
    expect(safetensorsHeaderLength(file, 16)).toBeNull();
  });
});

describe('readLocalWeightTensors', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gezel-weight-facts-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads the same facts gilde pins for the published file', async () => {
    const path = join(dir, 'w.safetensors');
    await writeFile(path, safetensors(HEADER, 4016));
    expect(await readLocalWeightTensors(path)).toEqual(TENSORS);
  });

  it('answers undefined for a file that is not safetensors', async () => {
    const path = join(dir, 'junk.safetensors');
    await writeFile(path, new Uint8Array(1024).fill(0xff));
    expect(await readLocalWeightTensors(path)).toBeUndefined();
  });
});

describe('catalog weight files', () => {
  it('lists a diffusers tree by component, carrying each file’s pinned facts', () => {
    const files = videoCatalogWeightFiles({
      source: {
        huggingfaceRepo: 'Org/Repo',
        revision: 'abc123',
        files: [
          { name: 'model_index.json', sha256: SHA, sizeBytes: 10 },
          {
            name: 'transformer/diffusion_pytorch_model.safetensors',
            sha256: SHA,
            sizeBytes: 4100,
            tensors: TENSORS,
          },
          { name: 'vae/diffusion_pytorch_model.safetensors', sha256: SHA, sizeBytes: 50 },
        ],
        approxSizeBytes: 4160,
      },
    } as unknown as VideoModelManifest);
    expect(files).toEqual([
      { component: 'transformer', sizeBytes: 4100, format: 'safetensors', tensors: TENSORS },
      { component: 'vae', sizeBytes: 50, format: 'safetensors' },
    ]);
  });

  it('lists an sd-cpp model by the flag each file rides on, skipping the tokenizer', () => {
    const files = imageCatalogWeightFiles({
      id: 'm',
      weightsKind: 'diffusion-model',
      downloadUrl: 'https://huggingface.co/a/b/resolve/main/model.gguf',
      sha256: SHA,
      approxSizeBytes: 100,
      auxiliaryFiles: [
        {
          role: 'vae',
          downloadUrl: 'https://huggingface.co/a/b/resolve/main/ae.safetensors',
          sha256: SHA,
          approxSizeBytes: 4100,
          tensors: TENSORS,
        },
        {
          role: 'tokenizer',
          downloadUrl: 'https://huggingface.co/a/b/resolve/main/tokenizer.json',
          sha256: SHA,
          approxSizeBytes: 1,
        },
      ],
    } as unknown as ImageModelManifest);
    expect(files).toEqual([
      { component: 'diffusion_model', sizeBytes: 100, format: 'gguf' },
      { component: 'vae', sizeBytes: 4100, format: 'safetensors', tensors: TENSORS },
    ]);
  });
});
