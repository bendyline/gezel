/**
 * Lane-A image-embed tier: gate semantics through ContentIndex.embedImages
 * with an injected mock embedder (the production path differs only in calling
 * the worker-backed embedder), and findSimilarImages ranking over the stored
 * vectors.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Store } from '../fs/store.js';
import type { ImageEmbedJob, ImageEmbedOutcome } from '../memory/image-embeddings.js';
import { ContentIndex } from './content-index.js';
import { runWorkspaceContentIndex } from './content-indexer.js';

let dir: string;
let home: string;
let artifacts: string;
let ci: ContentIndex;

// Minimal valid PNG header declaring 800x600 (same fixture as
// content-images.test.ts) — enough for the static indexer; the mock embedder
// never decodes.
const PNG_800x600 = Buffer.concat([
  Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x03, 0x20, 0x00, 0x00, 0x02, 0x58, 0x08, 0x02, 0x00, 0x00, 0x00,
  ]),
  Buffer.alloc(8),
]);

const GIF_16x16 = Buffer.concat([
  Buffer.from('GIF89a', 'ascii'),
  Buffer.from([16, 0, 16, 0]),
  Buffer.alloc(20),
]);

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gezel-imgtier-'));
  home = await mkdtemp(join(tmpdir(), 'gezel-imgtier-home-'));
  artifacts = join(home, 'artifacts');
  ci = new ContentIndex(
    {
      projectWorkspaceDir: async () => dir,
      projectArtifactsDir: () => artifacts,
    } as unknown as Store,
    home,
  );
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

const unitVec = (hot: number, lean = 0) => {
  const v = new Array(8).fill(0);
  v[hot] = 1;
  if (lean) {
    v[hot] = Math.SQRT1_2;
    v[lean] = Math.SQRT1_2;
  }
  return v;
};

function mockEmbedder(vectors: Map<string, number[]>) {
  const calls: ImageEmbedJob[][] = [];
  const embed = async (jobs: ImageEmbedJob[]): Promise<ImageEmbedOutcome[]> => {
    calls.push(jobs);
    return jobs.map((j) => {
      // Vectors are keyed by file basename for test readability.
      const name = j.path.replaceAll('\\', '/').split('/').pop()!;
      const vec = vectors.get(name);
      return vec ? { hash: j.hash, vector: vec } : { hash: j.hash, error: 'no fixture vector' };
    });
  };
  return { embed, calls };
}

describe('image-embed tier (mock embedder)', () => {
  it('embeds supported images, terminally skips undecodable formats without calling the embedder', async () => {
    await mkdir(join(dir, 'photos'), { recursive: true });
    await writeFile(join(dir, 'photos', 'a.png'), PNG_800x600);
    await writeFile(join(dir, 'photos', 'anim.gif'), GIF_16x16);
    await runWorkspaceContentIndex(dir, 'p', artifacts);

    const { embed, calls } = mockEmbedder(new Map([['a.png', unitVec(0)]]));
    const first = await ci.embedImages('p', 10, embed);
    expect(first).toMatchObject({ embedded: 1, unavailable: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.map((j) => j.path.split(/[\\/]/).pop())).toEqual(['a.png']);

    // Both hashes are now gated — a second batch finds no work at all.
    const second = await ci.embedImages('p', 10, embed);
    expect(second).toMatchObject({ files: 0, embedded: 0 });
    expect(calls).toHaveLength(1);
  });

  it('records a capped attempt for per-image errors and keeps the file in the work-list', async () => {
    await writeFile(join(dir, 'flaky.png'), PNG_800x600);
    await runWorkspaceContentIndex(dir, 'p', artifacts);

    const { embed } = mockEmbedder(new Map()); // every job → error outcome
    const r = await ci.embedImages('p', 10, embed);
    expect(r).toMatchObject({ files: 1, embedded: 0, unavailable: false });
    // Still retryable: the next batch offers the file again.
    const again = await ci.embedImages('p', 10, embed);
    expect(again?.files).toBe(1);
  });

  it('stops the drain on a pipeline-level failure instead of burning attempt budgets', async () => {
    await writeFile(join(dir, 'a.png'), PNG_800x600);
    await runWorkspaceContentIndex(dir, 'p', artifacts);

    const r = await ci.embedImages('p', 10, async () => {
      throw new Error('model unloadable');
    });
    expect(r).toMatchObject({ embedded: 0, unavailable: true });
  });

  it('find_similar_images ranks the planted near-duplicate first once vectors exist', async () => {
    await mkdir(join(dir, 'shots'), { recursive: true });
    // Distinct content per file → distinct hashes.
    await writeFile(join(dir, 'shots', 'a.png'), Buffer.concat([PNG_800x600, Buffer.from([1])]));
    await writeFile(join(dir, 'shots', 'b.png'), Buffer.concat([PNG_800x600, Buffer.from([2])]));
    await writeFile(join(dir, 'shots', 'c.png'), Buffer.concat([PNG_800x600, Buffer.from([3])]));
    await runWorkspaceContentIndex(dir, 'p', artifacts);

    const { embed } = mockEmbedder(
      new Map([
        ['a.png', unitVec(0)],
        ['b.png', unitVec(0, 1)], // cos(a,b) ≈ 0.707
        ['c.png', unitVec(2)], // cos(a,c) = 0
      ]),
    );
    const r = await ci.embedImages('p', 10, embed);
    expect(r?.embedded).toBe(3);

    const sim = await ci.findSimilarImages('p', 'shots/a.png');
    expect(sim.engine).toBe('vector');
    expect(sim.results.map((x) => x.path)).toEqual(['shots/b.png', 'shots/c.png']);
    expect(sim.results[0]!.score).toBeGreaterThan(sim.results[1]!.score);
  });
});
