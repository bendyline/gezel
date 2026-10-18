import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SuggestVectorCache } from './suggest-vector-cache.js';

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gezel-suggest-vectors-'));
  file = join(dir, 'index', 'suggest-vectors.json');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('SuggestVectorCache', () => {
  it('keeps vectors across instances for the same embedder', async () => {
    const first = new SuggestVectorCache({ file, profile: () => 'bge|d3', saveDelayMs: 1 });
    await first.ready();
    first.set('Arcade game. build a playable arcade game', [0.5, -0.25, 1]);
    await first.flush();

    const second = new SuggestVectorCache({ file, profile: () => 'bge|d3' });
    await second.ready();
    expect(second.get('Arcade game. build a playable arcade game')).toEqual([0.5, -0.25, 1]);
    expect(second.get('Arcade game. a different description')).toBeUndefined();
  });

  it('discards vectors from another embedder', async () => {
    const first = new SuggestVectorCache({ file, profile: () => 'bge|d3', saveDelayMs: 1 });
    first.set('text', [1, 0, 0]);
    await first.flush();

    const swapped = new SuggestVectorCache({ file, profile: () => 'e5|d3' });
    await swapped.ready();
    expect(swapped.get('text')).toBeUndefined();
  });

  it('starts empty on a corrupt file, and replaces it on the next save', async () => {
    await mkdir(join(dir, 'index'), { recursive: true });
    await writeFile(file, '{not json');
    const cache = new SuggestVectorCache({ file, profile: () => 'bge|d3', saveDelayMs: 1 });
    await cache.ready();
    expect(cache.get('text')).toBeUndefined();

    cache.set('text', [0, 1, 0]);
    await cache.flush();
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ profile: 'bge|d3' });
  });

  it('writes nothing without a file', async () => {
    const cache = new SuggestVectorCache({ profile: () => 'bge|d3', saveDelayMs: 1 });
    cache.set('text', [1, 0, 0]);
    await cache.flush();
    expect(cache.get('text')).toEqual([1, 0, 0]);
    await expect(readFile(file, 'utf8')).rejects.toThrow();
  });
});
