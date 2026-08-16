import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatModelManifest } from '@bendyline/gezel';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { evaluateCatalogDrift, resetPayloadFingerprintHealsForTest } from './catalog-drift.js';
import { catalogPayloadFingerprint, describeCatalogPayload } from './catalog-payload-identity.js';

const WEIGHTS_SHA = 'a'.repeat(64);
const REBUILT_SHA = 'b'.repeat(64);

function catalogManifest(version: string, sha = WEIGHTS_SHA): ChatModelManifest {
  return {
    schemaVersion: 1,
    kind: 'chat-model',
    id: 'fixture-7b-q4',
    name: 'Fixture 7B',
    description: 'fixture',
    tags: [],
    maintainer: { name: 'Test' },
    version,
    releasedAt: '2026-01-01T00:00:00Z',
    availableVersions: [version],
    parameterSize: '7B',
    approxSizeBytes: 128,
    supportsTools: true,
    llamaCpp: {
      huggingfaceRepo: 'test-org/gguf',
      filename: 'fixture.gguf',
      sha256: sha,
      approxSizeBytes: 128,
      quantization: 'Q4_K_M',
    },
  } as ChatModelManifest;
}

let home: string;
let modelDir: string;

function writeInstalled(extra: Record<string, unknown> = {}): void {
  writeFileSync(
    join(modelDir, 'manifest.json'),
    JSON.stringify({
      id: 'fixture-7b-q4',
      name: 'Fixture 7B',
      weightsFilename: 'fixture.gguf',
      installedAt: '2026-01-01T00:00:00Z',
      catalogId: 'fixture-7b-q4',
      catalogVersion: '1.0.0',
      huggingfaceRepo: 'test-org/gguf',
      chatTemplatePresent: true,
      fileSha256: { 'fixture.gguf': WEIGHTS_SHA },
      ...extra,
    }),
  );
}

beforeEach(() => {
  resetPayloadFingerprintHealsForTest();
  home = mkdtempSync(join(tmpdir(), 'gezel-drift-'));
  modelDir = join(home, 'fixture-7b-q4');
  mkdirSync(modelDir, { recursive: true });
  writeFileSync(join(modelDir, 'fixture.gguf'), Buffer.alloc(128));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('evaluateCatalogDrift', () => {
  it('offers no update for a catalog bump that left the payload alone', async () => {
    writeInstalled();
    const status = await evaluateCatalogDrift({
      engine: 'llama-cpp',
      id: 'fixture-7b-q4',
      modelDir,
      installedVersion: '1.0.0',
      installed: {
        huggingfaceRepo: 'test-org/gguf',
        fileSha256: { 'fixture.gguf': WEIGHTS_SHA },
      },
      manifest: catalogManifest('1.0.1'),
      healable: true,
    });
    expect(status).toEqual({ updateAvailable: false });
  });

  it('records the fingerprint so the next check is a string compare', async () => {
    writeInstalled();
    const manifest = catalogManifest('1.0.1');
    await evaluateCatalogDrift({
      engine: 'llama-cpp',
      id: 'fixture-7b-q4',
      modelDir,
      installedVersion: '1.0.0',
      installed: { fileSha256: { 'fixture.gguf': WEIGHTS_SHA } },
      manifest,
      healable: true,
    });
    const onDisk = JSON.parse(readFileSync(join(modelDir, 'manifest.json'), 'utf8'));
    expect(onDisk.payloadFingerprint).toBe(
      catalogPayloadFingerprint(describeCatalogPayload(manifest, 'llama-cpp')!),
    );
    // The version this copy was downloaded against is left alone: the
    // `.gezmodel` exporter and model-fitness records both key off it.
    expect(onDisk.catalogVersion).toBe('1.0.0');
  });

  it('offers the update when the catalog rotates the weights', async () => {
    writeInstalled();
    const status = await evaluateCatalogDrift({
      engine: 'llama-cpp',
      id: 'fixture-7b-q4',
      modelDir,
      installedVersion: '1.0.0',
      installed: { fileSha256: { 'fixture.gguf': WEIGHTS_SHA } },
      manifest: catalogManifest('1.1.0', REBUILT_SHA),
      healable: true,
    });
    expect(status.updateAvailable).toBe(true);
    expect(status.availableVersion).toBe('1.1.0');
    expect(status.reason).toContain('fixture.gguf');
    expect(
      JSON.parse(readFileSync(join(modelDir, 'manifest.json'), 'utf8')).payloadFingerprint,
    ).toBeUndefined();
  });

  it('says nothing when the versions match', async () => {
    writeInstalled();
    await expect(
      evaluateCatalogDrift({
        engine: 'llama-cpp',
        id: 'fixture-7b-q4',
        modelDir,
        installedVersion: '1.0.0',
        installed: { fileSha256: { 'fixture.gguf': WEIGHTS_SHA } },
        manifest: catalogManifest('1.0.0'),
        healable: true,
      }),
    ).resolves.toEqual({ updateAvailable: false });
  });

  it('clears an install that predates per-file hashes on sizes alone, without claiming proof', async () => {
    // What a copy installed before the `fileSha256` map looks like: the files
    // are all there at the pinned length, so a metadata bump must not send it
    // back to Hugging Face — but a size match is evidence, not proof, so
    // nothing is written down as though it were.
    writeInstalled({ fileSha256: undefined });
    const status = await evaluateCatalogDrift({
      engine: 'llama-cpp',
      id: 'fixture-7b-q4',
      modelDir,
      installedVersion: '1.0.0',
      installed: { huggingfaceRepo: 'test-org/gguf' },
      manifest: catalogManifest('1.0.1'),
      healable: true,
    });
    expect(status).toEqual({ updateAvailable: false });
    expect(
      JSON.parse(readFileSync(join(modelDir, 'manifest.json'), 'utf8')).payloadFingerprint,
    ).toBeUndefined();
  });

  it('flags a copy whose files are gone rather than guessing it is current', async () => {
    writeInstalled({ fileSha256: undefined });
    rmSync(join(modelDir, 'fixture.gguf'));
    const status = await evaluateCatalogDrift({
      engine: 'llama-cpp',
      id: 'fixture-7b-q4',
      modelDir,
      installedVersion: '1.0.0',
      installed: { huggingfaceRepo: 'test-org/gguf' },
      manifest: catalogManifest('1.0.1'),
      healable: true,
    });
    expect(status.updateAvailable).toBe(true);
    expect(status.availableVersion).toBe('1.0.1');
  });

  it('suppresses the badge without writing when the copy is not healable', async () => {
    writeInstalled();
    const status = await evaluateCatalogDrift({
      engine: 'llama-cpp',
      id: 'fixture-7b-q4',
      modelDir,
      installedVersion: '1.0.0',
      installed: { fileSha256: { 'fixture.gguf': WEIGHTS_SHA } },
      manifest: catalogManifest('1.0.1'),
      healable: false,
    });
    expect(status).toEqual({ updateAvailable: false });
    expect(
      JSON.parse(readFileSync(join(modelDir, 'manifest.json'), 'utf8')).payloadFingerprint,
    ).toBeUndefined();
  });

  it('still answers when the manifest cannot be written', async () => {
    writeInstalled();
    chmodSync(modelDir, 0o500);
    try {
      await expect(
        evaluateCatalogDrift({
          engine: 'llama-cpp',
          id: 'fixture-7b-q4',
          modelDir,
          installedVersion: '1.0.0',
          installed: { fileSha256: { 'fixture.gguf': WEIGHTS_SHA } },
          manifest: catalogManifest('1.0.1'),
          healable: true,
        }),
      ).resolves.toEqual({ updateAvailable: false });
    } finally {
      chmodSync(modelDir, 0o700);
    }
  });
});
