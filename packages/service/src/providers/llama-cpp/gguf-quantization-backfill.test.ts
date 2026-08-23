import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  backfillGgufQuantization,
  resetGgufQuantizationMemo,
} from './gguf-quantization-backfill.js';
import { writeSyntheticGguf } from './gguf-test-fixture.js';

let dir: string;

function seedModel(opts: { fileType?: number } = {}): { modelDir: string; manifestPath: string } {
  const modelDir = join(dir, 'muse-glimmer-30b-q4');
  rmSync(modelDir, { recursive: true, force: true });
  const manifestPath = join(modelDir, 'manifest.json');
  mkdirSync(modelDir, { recursive: true });
  writeSyntheticGguf(join(modelDir, 'weights.gguf'), {
    architecture: 'muse-glimmer',
    ...(opts.fileType !== undefined ? { fileType: opts.fileType } : {}),
  });
  writeFileSync(
    manifestPath,
    JSON.stringify({ id: 'muse-glimmer-30b-q4', quantization: 'K-Quant-17GB' }, null, 2),
  );
  return { modelDir, manifestPath };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gezel-quant-backfill-'));
  resetGgufQuantizationMemo();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('backfillGgufQuantization', () => {
  it('reads the file-declared tag when the catalog label names no bit depth', async () => {
    const { modelDir, manifestPath } = seedModel({ fileType: 15 });

    const tag = await backfillGgufQuantization({
      engine: 'llama-cpp',
      id: 'muse-glimmer-30b-q4',
      modelDir,
      weightsFilename: 'weights.gguf',
      catalogQuantization: 'K-Quant-17GB',
      writable: true,
    });

    expect(tag).toBe('Q4_K_M');
    // Written down, so the next listing is a manifest read again.
    expect(JSON.parse(readFileSync(manifestPath, 'utf8')).ggufQuantization).toBe('Q4_K_M');
  });

  it('leaves an informative catalog label alone without touching the weights', async () => {
    const { modelDir, manifestPath } = seedModel({ fileType: 15 });
    // Unreadable weights: reaching for them at all would throw.
    writeFileSync(join(modelDir, 'weights.gguf'), 'not a gguf');

    const tag = await backfillGgufQuantization({
      engine: 'llama-cpp',
      id: 'muse-glimmer-30b-q4',
      modelDir,
      weightsFilename: 'weights.gguf',
      catalogQuantization: 'Q4_K_M',
      writable: true,
    });

    expect(tag).toBeUndefined();
    expect(JSON.parse(readFileSync(manifestPath, 'utf8')).ggufQuantization).toBeUndefined();
  });

  it('reports the tag but writes nothing for a read-only overlay copy', async () => {
    const { modelDir, manifestPath } = seedModel({ fileType: 7 });

    const tag = await backfillGgufQuantization({
      engine: 'llama-cpp',
      id: 'muse-glimmer-30b-q4',
      modelDir,
      weightsFilename: 'weights.gguf',
      catalogQuantization: 'K-Quant-17GB',
      writable: false,
    });

    expect(tag).toBe('Q8_0');
    expect(JSON.parse(readFileSync(manifestPath, 'utf8')).ggufQuantization).toBeUndefined();
  });

  it('asks the file once per process', async () => {
    const { modelDir } = seedModel({ fileType: 15 });
    const call = () =>
      backfillGgufQuantization({
        engine: 'llama-cpp',
        id: 'muse-glimmer-30b-q4',
        modelDir,
        weightsFilename: 'weights.gguf',
        catalogQuantization: 'K-Quant-17GB',
        // A read-only copy can never write its answer down, so the memo is
        // the only thing standing between a polled inventory and a header
        // read per model per poll.
        writable: false,
      });

    expect(await call()).toBe('Q4_K_M');
    writeFileSync(join(modelDir, 'weights.gguf'), 'not a gguf');
    expect(await call()).toBe('Q4_K_M');
  });

  it('survives weights it cannot parse', async () => {
    const { modelDir } = seedModel({ fileType: 15 });
    writeFileSync(join(modelDir, 'weights.gguf'), 'not a gguf');

    await expect(
      backfillGgufQuantization({
        engine: 'llama-cpp',
        id: 'muse-glimmer-30b-q4',
        modelDir,
        weightsFilename: 'weights.gguf',
        catalogQuantization: 'K-Quant-17GB',
        writable: true,
      }),
    ).resolves.toBeUndefined();
  });
});
