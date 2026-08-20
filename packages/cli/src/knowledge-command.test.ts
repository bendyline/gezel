import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KnowledgeEmbeddingProfile } from '@bendyline/gezel';
import type { ProfileEmbedder } from '@bendyline/gezel-knowledge';
import {
  generateKnowledgeSigningKeyPair,
  readGezkManifest,
  verifyManifestSignature,
} from '@bendyline/gezel-knowledge';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  runKnowledgeBuild,
  runKnowledgeInit,
  runKnowledgeInspect,
  runKnowledgeSearch,
  runKnowledgeValidate,
} from './knowledge-command.js';

const FAKE_PROFILE: KnowledgeEmbeddingProfile = {
  id: 'gezel-bge-small-en-v1.5@1',
  model: { repo: 'test/hash', revision: 'fixture' },
  tokenizer: { kind: 'whitespace' },
  pooling: 'mean',
  normalized: true,
  dimensions: 384,
  maxTokens: 512,
  queryInstruction: '',
  passageInstruction: '',
  vectorEncoding: 'bit384+int8',
  distance: { stage1: 'hamming', stage2: 'cosine' },
  quantization: {
    int8: { method: 'symmetric-linear', scale: 127 },
    binary: { method: 'sign', threshold: 0, packing: 'lsb-first' },
  },
};

function hashVector(text: string): number[] {
  const dims = 384;
  const out = new Array<number>(dims);
  let hash = createHash('sha256').update(text, 'utf8').digest();
  let offset = 0;
  for (let i = 0; i < dims; i++) {
    if (offset >= hash.length) {
      hash = createHash('sha256').update(hash).digest();
      offset = 0;
    }
    out[i] = (hash.readInt8(offset) + 0.5) / 128;
    offset++;
  }
  return out;
}

const fakeEmbedder: ProfileEmbedder = {
  profile: FAKE_PROFILE,
  embed: async (texts) => texts.map(hashVector),
  embedQuery: async (text) => Float32Array.from(hashVector(text)),
  countTokens: (text) => (text.trim() ? text.trim().split(/\s+/).length : 0),
  dispose: async () => {},
};

const deps = { createEmbedder: async () => fakeEmbedder };

let dir: string;
let catalogDir: string;
let archivePath: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gezel-knowledge-cli-'));
  catalogDir = join(dir, 'field-notes');
  await runKnowledgeInit(catalogDir);
  await mkdir(join(catalogDir, 'content', 'Joinery'), { recursive: true });
  await writeFile(
    join(catalogDir, 'content', 'Joinery', 'dovetails.md'),
    '# Dovetail Joints\n\nTails and pins interlock for a mechanically strong corner.\n',
  );
  await runKnowledgeBuild(catalogDir, {}, deps);
  archivePath = join(catalogDir, 'field-notes-1.0.0.gezk');
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('gezel knowledge (offline)', () => {
  it('init scaffolds once and refuses to overwrite', async () => {
    expect((await stat(join(catalogDir, 'catalog.json'))).isFile()).toBe(true);
    await expect(runKnowledgeInit(catalogDir)).rejects.toThrow(/already exists/);
  });

  it('build produced a verifiable archive', async () => {
    expect((await stat(archivePath)).size).toBeGreaterThan(0);
    const manifest = await readGezkManifest(archivePath);
    expect(manifest.id).toBe('field-notes');
    expect(manifest.counts.documents).toBe(2);
    expect(manifest.topics.length).toBeGreaterThanOrEqual(2);
    expect(manifest.signature).toBeUndefined();
  });

  it('validate --deep passes on the built archive', async () => {
    await expect(runKnowledgeValidate(archivePath, { deep: true })).resolves.toBeUndefined();
  });

  it('validate fails loudly on a tampered archive', async () => {
    const tamperedPath = join(dir, 'tampered.gezk');
    const bytes = Buffer.from(await readFile(archivePath));
    bytes[Math.floor(bytes.length / 2)] = (bytes[Math.floor(bytes.length / 2)] as number) ^ 0xff;
    await writeFile(tamperedPath, bytes);
    await expect(runKnowledgeValidate(tamperedPath, {})).rejects.toThrow(/verification failed/);
  });

  it('inspect prints the catalog summary', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runKnowledgeInspect(archivePath);
    const output = log.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(output).toContain('field-notes@1.0.0');
    expect(output).toContain('unsigned');
    expect(output).toContain('gezel-bge-small-en-v1.5@1');
  });

  it('search finds documents and cites knowledge:// URIs', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runKnowledgeSearch(archivePath, 'dovetail', { limit: 5 }, deps);
    const output = log.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(output).toContain('Dovetail Joints');
    expect(output).toContain('knowledge://field-notes/');
  });

  it('semantic search reranks through the vector path', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runKnowledgeSearch(
      archivePath,
      'Tails and pins interlock for a mechanically strong corner.',
      { semantic: true, limit: 5 },
      deps,
    );
    const output = log.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(output).toContain('semantic');
    expect(output).toContain('#chunk=');
  });

  it('build --sign-key produces a verifiable signed manifest', async () => {
    const keys = generateKnowledgeSigningKeyPair();
    const keyPath = join(dir, 'signing-key.pem');
    await writeFile(keyPath, keys.privateKeyPem, 'utf8');
    const signedPath = join(dir, 'signed.gezk');
    await runKnowledgeBuild(catalogDir, { out: signedPath, signKey: keyPath }, deps);
    const manifest = await readGezkManifest(signedPath);
    expect(manifest.signature?.keyId).toBe(keys.keyId);
    expect(
      verifyManifestSignature(manifest, [{ keyId: keys.keyId, publicKeyPem: keys.publicKeyPem }]),
    ).toEqual({ ok: true, keyId: keys.keyId });
  });
});
