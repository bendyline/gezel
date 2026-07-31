import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { lastArgValue, readLlamaCppBuildMetadata } from './build-metadata.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('llama.cpp build metadata', () => {
  it('reads the build sidecar next to the binary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gezel-llama-build-'));
    roots.push(root);
    const binary = join(root, 'gezel-llama-server');
    await writeFile(binary, '');
    await writeFile(
      join(root, 'gezel-llama-build.json'),
      JSON.stringify({
        schemaVersion: 1,
        engine: 'llama-cpp',
        revision: '1a064ab0',
        platform: 'linux-arm64',
        backend: 'cuda',
        cudaArchitectures: ['121a-real'],
        cudaToolkit: '12.9',
      }),
    );

    await expect(readLlamaCppBuildMetadata(binary)).resolves.toMatchObject({
      backend: 'cuda',
      cudaArchitectures: ['121a-real'],
      cudaToolkit: '12.9',
    });
  });

  it('returns null for a legacy bundle without a sidecar', async () => {
    await expect(readLlamaCppBuildMetadata('/does/not/exist')).resolves.toBeNull();
  });

  it('uses the last duplicate CLI flag value', () => {
    expect(lastArgValue(['--ubatch-size', '512', '--ubatch-size', '128'], '--ubatch-size')).toBe(
      '128',
    );
  });
});
