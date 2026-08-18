import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatModelManifest } from '@bendyline/gezel';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type CatalogPayload,
  catalogPayloadFingerprint,
  comparePayloadIdentity,
  describeCatalogPayload,
} from './catalog-payload-identity.js';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHA_C = 'c'.repeat(64);

function manifest(overrides: Partial<ChatModelManifest>): ChatModelManifest {
  return {
    schemaVersion: 1,
    kind: 'chat-model',
    id: 'fixture',
    name: 'Fixture',
    description: 'fixture',
    tags: [],
    maintainer: { name: 'Test' },
    version: '1.0.0',
    releasedAt: '2026-01-01T00:00:00Z',
    availableVersions: ['1.0.0'],
    parameterSize: '2B',
    approxSizeBytes: 1024,
    supportsTools: true,
    ...overrides,
  } as ChatModelManifest;
}

const payload: CatalogPayload = {
  huggingfaceRepo: 'test-org/test-repo',
  files: [
    { name: 'model.safetensors', sha256: SHA_A, sizeBytes: 100 },
    { name: 'config.json', sha256: SHA_B, sizeBytes: 10 },
  ],
};

describe('catalogPayloadFingerprint', () => {
  it('is stable across file ordering and hash casing', () => {
    const reordered: CatalogPayload = {
      huggingfaceRepo: payload.huggingfaceRepo,
      files: [
        { name: 'config.json', sha256: SHA_B.toUpperCase(), sizeBytes: 10 },
        { name: 'model.safetensors', sha256: SHA_A, sizeBytes: 100 },
      ],
    };
    expect(catalogPayloadFingerprint(reordered)).toBe(catalogPayloadFingerprint(payload));
  });

  it('ignores file sizes but not hashes, names, or the repo', () => {
    const resized = {
      ...payload,
      files: payload.files.map((file) => ({ ...file, sizeBytes: 999 })),
    };
    expect(catalogPayloadFingerprint(resized)).toBe(catalogPayloadFingerprint(payload));

    const rehashed = {
      ...payload,
      files: [{ ...payload.files[0]!, sha256: SHA_C }, payload.files[1]!],
    };
    expect(catalogPayloadFingerprint(rehashed)).not.toBe(catalogPayloadFingerprint(payload));

    const moved = { ...payload, huggingfaceRepo: 'other-org/test-repo' };
    expect(catalogPayloadFingerprint(moved)).not.toBe(catalogPayloadFingerprint(payload));
  });
});

describe('describeCatalogPayload', () => {
  it('marks the llama.cpp vision projector optional and the draft companion required', () => {
    const described = describeCatalogPayload(
      manifest({
        llamaCpp: {
          huggingfaceRepo: 'test-org/gguf',
          filename: 'weights/model.gguf',
          sha256: SHA_A,
          approxSizeBytes: 100,
          mmproj: { filename: 'mmproj.gguf', sha256: SHA_B, sizeBytes: 20 },
          draftModel: { filename: 'draft.gguf', sha256: SHA_C, sizeBytes: 30 },
        },
      } as Partial<ChatModelManifest>),
      'llama-cpp',
    );
    // Repo subdirectories flatten to a basename on disk.
    expect(described?.files.map((file) => file.name)).toEqual([
      'model.gguf',
      'draft.gguf',
      'mmproj.gguf',
    ]);
    expect(described?.files.find((file) => file.name === 'mmproj.gguf')?.optional).toBe(true);
    expect(described?.files.find((file) => file.name === 'draft.gguf')?.optional).toBeUndefined();
  });

  it('marks MLX tokenizer_config as transformed only when a template may be injected', () => {
    const plain = describeCatalogPayload(
      manifest({
        mlx: {
          huggingfaceRepo: 'mlx-community/fixture',
          files: [{ name: 'tokenizer_config.json', sha256: SHA_A, sizeBytes: 10 }],
          approxSizeBytes: 10,
        },
      } as Partial<ChatModelManifest>),
      'mlx',
    );
    expect(plain?.files[0]?.transformed).toBeUndefined();

    const pinned = describeCatalogPayload(
      manifest({
        mlx: {
          huggingfaceRepo: 'mlx-community/fixture',
          files: [{ name: 'tokenizer_config.json', sha256: SHA_A, sizeBytes: 10 }],
          approxSizeBytes: 10,
          chatTemplate: '{{ messages }}',
        },
      } as Partial<ChatModelManifest>),
      'mlx',
    );
    expect(pinned?.files[0]?.transformed).toBe(true);
  });

  it('returns null when the engine has no source block', () => {
    expect(describeCatalogPayload(manifest({}), 'mlx')).toBeNull();
  });
});

describe('comparePayloadIdentity', () => {
  it('answers from the recorded fingerprint when there is one', async () => {
    const fingerprint = catalogPayloadFingerprint(payload);
    await expect(
      comparePayloadIdentity({ catalog: payload, installed: { payloadFingerprint: fingerprint } }),
    ).resolves.toMatchObject({ identity: 'same', basis: 'fingerprint', provenByHash: true });

    await expect(
      comparePayloadIdentity({
        catalog: { ...payload, huggingfaceRepo: 'other/repo' },
        installed: { payloadFingerprint: fingerprint },
      }),
    ).resolves.toMatchObject({ identity: 'changed', basis: 'fingerprint' });
  });

  it('compares recorded hashes file by file', async () => {
    const installed = {
      huggingfaceRepo: 'test-org/test-repo',
      fileSha256: { 'model.safetensors': SHA_A, 'config.json': SHA_B },
    };
    await expect(comparePayloadIdentity({ catalog: payload, installed })).resolves.toMatchObject({
      identity: 'same',
      basis: 'hashes',
      provenByHash: true,
    });

    const rehashed = {
      ...payload,
      files: [{ ...payload.files[0]!, sha256: SHA_C }, payload.files[1]!],
    };
    await expect(comparePayloadIdentity({ catalog: rehashed, installed })).resolves.toMatchObject({
      identity: 'changed',
      basis: 'hashes',
    });
  });

  it('treats an added catalog file as changed but tolerates a missing optional one', async () => {
    const installed = { fileSha256: { 'model.safetensors': SHA_A, 'config.json': SHA_B } };
    const withRequired: CatalogPayload = {
      ...payload,
      files: [...payload.files, { name: 'draft.gguf', sha256: SHA_C, sizeBytes: 5 }],
    };
    await expect(
      comparePayloadIdentity({ catalog: withRequired, installed }),
    ).resolves.toMatchObject({ identity: 'changed' });

    const withOptional: CatalogPayload = {
      ...payload,
      files: [
        ...payload.files,
        { name: 'mmproj.gguf', sha256: SHA_C, sizeBytes: 5, optional: true },
      ],
    };
    await expect(
      comparePayloadIdentity({ catalog: withOptional, installed }),
    ).resolves.toMatchObject({ identity: 'same' });
  });

  it('requires a transformed file to be present but not to match', async () => {
    const catalog: CatalogPayload = {
      huggingfaceRepo: 'test-org/test-repo',
      chatTemplate: '{{ messages }}',
      files: [{ name: 'tokenizer_config.json', sha256: SHA_A, sizeBytes: 10, transformed: true }],
    };
    // Install rewrote it after verifying it, so the recorded hash is ours.
    await expect(
      comparePayloadIdentity({
        catalog,
        installed: { fileSha256: { 'tokenizer_config.json': SHA_C } },
      }),
    ).resolves.toMatchObject({ identity: 'same' });

    await expect(
      comparePayloadIdentity({ catalog, installed: { fileSha256: { 'other.json': SHA_C } } }),
    ).resolves.toMatchObject({ identity: 'changed' });
  });

  it('calls a repo swap changed before looking at any file', async () => {
    await expect(
      comparePayloadIdentity({
        catalog: payload,
        installed: { huggingfaceRepo: 'someone-else/test-repo', fileSha256: {} },
      }),
    ).resolves.toMatchObject({ identity: 'changed', basis: 'repo' });
  });

  describe('with no recorded hashes', () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'gezel-identity-'));
    });
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('falls back to on-disk sizes without claiming hash proof', async () => {
      writeFileSync(join(dir, 'model.safetensors'), Buffer.alloc(100));
      writeFileSync(join(dir, 'config.json'), Buffer.alloc(10));
      const result = await comparePayloadIdentity({
        catalog: payload,
        installed: {},
        modelDir: dir,
      });
      expect(result).toMatchObject({ identity: 'same', basis: 'sizes' });
      expect(result.provenByHash).toBeUndefined();
    });

    it('reports changed when a pinned file is the wrong size or missing', async () => {
      writeFileSync(join(dir, 'model.safetensors'), Buffer.alloc(99));
      writeFileSync(join(dir, 'config.json'), Buffer.alloc(10));
      await expect(
        comparePayloadIdentity({ catalog: payload, installed: {}, modelDir: dir }),
      ).resolves.toMatchObject({ identity: 'changed', basis: 'sizes' });

      rmSync(join(dir, 'model.safetensors'));
      await expect(
        comparePayloadIdentity({ catalog: payload, installed: {}, modelDir: dir }),
      ).resolves.toMatchObject({ identity: 'changed', basis: 'sizes' });
    });

    it('admits it cannot tell when there is nothing to compare', async () => {
      await expect(
        comparePayloadIdentity({ catalog: payload, installed: {} }),
      ).resolves.toMatchObject({ identity: 'unknown' });
    });
  });
});
