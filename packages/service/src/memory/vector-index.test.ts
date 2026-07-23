/**
 * Memory vector store (sqlite-vec backed, Phase 4). Uses the real local
 * embedder; self-skips if unavailable.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addToIndex, rebuildIndex, searchIndex } from './vector-index.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gezel-mem-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function embeddingsWork(): Promise<boolean> {
  try {
    const { embed } = await import('./embeddings.js');
    await embed('warmup');
    return true;
  } catch {
    return false;
  }
}

describe('memory vector-index (sqlite-vec)', () => {
  it('adds entries and ranks the most similar first', async () => {
    if (!(await embeddingsWork())) return;
    await addToIndex(dir, {
      text: 'The cat sat on the warm mat by the fire',
      scope: 'gezel',
      id: 'g1',
      day: '2026-06-06',
      at: '2026-06-06T10:00:00Z',
    });
    await addToIndex(dir, {
      text: 'Postgres database indexing strategies for large tables',
      scope: 'gezel',
      id: 'g1',
      day: '2026-06-06',
      at: '2026-06-06T11:00:00Z',
    });

    const hits = await searchIndex(dir, 'a feline resting on a rug', 5);
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]?.text).toContain('cat');
    // cosine similarity, higher is better, within 0..1-ish.
    expect(hits[0]!.score).toBeGreaterThan(hits[hits.length - 1]!.score - 1e-9);
    expect(hits[0]!.score).toBeLessThanOrEqual(1.0001);
  });

  it('rebuilds from a full entry set', async () => {
    if (!(await embeddingsWork())) return;
    await rebuildIndex(dir, [
      { text: 'apples and oranges', scope: 'project', id: 'p1', day: 'd', at: 'd' },
      { text: 'quantum chromodynamics', scope: 'project', id: 'p1', day: 'd', at: 'd' },
    ]);
    const hits = await searchIndex(dir, 'fruit', 5);
    expect(hits[0]?.text).toBe('apples and oranges');

    // Rebuild replaces, doesn't append.
    await rebuildIndex(dir, [
      { text: 'only entry', scope: 'project', id: 'p1', day: 'd', at: 'd' },
    ]);
    const after = await searchIndex(dir, 'anything', 10);
    expect(after).toHaveLength(1);
  });
});
