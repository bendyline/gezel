/**
 * Real-model image-embed coverage, self-skipping like content-enrich.test's
 * realEmbed(): when the CLIP model can't load in this environment (offline,
 * no transformers peer), the tests return early instead of failing. First run
 * downloads the q8 vision tower (~88 MB) into the shared test HF cache.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ImageEmbedJob, ImageEmbedOutcome } from './image-embeddings.js';

const cjsRequire = createRequire(import.meta.url);
type UpngModule = typeof import('@pdf-lib/upng');
const UPNG = (() => {
  const mod = cjsRequire('@pdf-lib/upng') as { default?: UpngModule } & UpngModule;
  return mod.default ?? mod;
})();

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gezel-imgembed-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function pngPattern(edge: number, pixel: (x: number, y: number) => [number, number, number]) {
  const rgba = new Uint8Array(edge * edge * 4);
  for (let y = 0; y < edge; y++) {
    for (let x = 0; x < edge; x++) {
      const [r, g, b] = pixel(x, y);
      rgba.set([r, g, b, 255], (y * edge + x) * 4);
    }
  }
  return Buffer.from(UPNG.encode([rgba.buffer as ArrayBuffer], edge, edge, 0));
}

async function writeFixture(name: string, buf: Buffer): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, buf);
  return path;
}

type EmbedFn = (images: ImageEmbedJob[]) => Promise<ImageEmbedOutcome[]>;

/** Load + warm the real embedder; null (→ test self-skips) when unavailable. */
async function realImageEmbed(): Promise<EmbedFn | null> {
  try {
    const { embedImageFiles } = await import('./image-embeddings.js');
    const warmPath = await writeFixture(
      'warm.png',
      pngPattern(8, () => [128, 128, 128]),
    );
    const [outcome] = await embedImageFiles([{ path: warmPath, hash: 'warm' }]);
    if (!outcome || !('vector' in outcome)) return null;
    return embedImageFiles;
  } catch {
    return null;
  }
}

const cosine = (a: number[], b: number[]) => a.reduce((sum, v, i) => sum + v * b[i]!, 0);

describe('image-embed core (real model, self-skipping)', () => {
  it(
    'produces 512-d unit vectors that separate structurally different images',
    { timeout: 300_000 },
    async () => {
      const embed = await realImageEmbed();
      if (!embed) return;

      const red = await writeFixture(
        'red.png',
        pngPattern(64, () => [220, 30, 30]),
      );
      const red2 = await writeFixture(
        'red2.png',
        pngPattern(64, (x) => (x === 0 ? [210, 40, 40] : [220, 30, 30])),
      );
      const checker = await writeFixture(
        'checker.png',
        pngPattern(64, (x, y) => (((x >> 3) + (y >> 3)) % 2 === 0 ? [0, 0, 0] : [255, 255, 255])),
      );

      const results = await embed([
        { path: red, hash: 'red' },
        { path: red2, hash: 'red2' },
        { path: checker, hash: 'checker' },
      ]);
      const vectors = new Map<string, number[]>();
      for (const r of results) {
        expect('vector' in r, `expected a vector for ${r.hash}`).toBe(true);
        if ('vector' in r) vectors.set(r.hash, r.vector);
      }

      for (const v of vectors.values()) {
        expect(v).toHaveLength(512);
        expect(cosine(v, v)).toBeCloseTo(1, 4); // unit norm
      }
      const redVec = vectors.get('red')!;
      const nearDupe = cosine(redVec, vectors.get('red2')!);
      const different = cosine(redVec, vectors.get('checker')!);
      expect(nearDupe).toBeGreaterThan(different);
      expect(nearDupe).toBeGreaterThan(0.9);
    },
  );

  it('returns terminal skips as data, not throws', { timeout: 300_000 }, async () => {
    const embed = await realImageEmbed();
    if (!embed) return;
    const gifPath = await writeFixture(
      'anim.gif',
      Buffer.concat([
        Buffer.from('GIF89a', 'ascii'),
        Buffer.from([16, 0, 16, 0]),
        Buffer.alloc(20),
      ]),
    );
    const [outcome] = await embed([{ path: gifPath, hash: 'gif' }]);
    expect(outcome).toMatchObject({ hash: 'gif', skip: 'unsupported' });
  });
});
