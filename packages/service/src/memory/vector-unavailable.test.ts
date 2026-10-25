/**
 * Where sqlite-vec does not load (it publishes no Windows ARM64 build), the
 * memory index keeps its text rows but no vectors. Search must fall back to
 * the saved text rather than answer "nothing matched", which is how every
 * memory search on that platform came back empty.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../fs/store.js';
import { MemoryManager } from './manager.js';
import { VectorSearchUnavailableError, searchByVector } from './vector-index.js';

vi.mock('../index-store/sqlite-driver.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../index-store/sqlite-driver.js')>();
  return {
    ...actual,
    openIndexDatabase: async (...args: Parameters<typeof actual.openIndexDatabase>) => {
      const db = await actual.openIndexDatabase(...args);
      return db && { ...db, vecAvailable: false };
    },
  };
});

vi.mock('@bendyline/gezel-inference/internal/memory/embeddings', () => {
  const vectorFor = (text: string): number[] => {
    const vector = new Array<number>(16).fill(0);
    for (let i = 0; i < text.length; i++) {
      vector[i % vector.length]! += text.charCodeAt(i) / 255;
    }
    const magnitude = Math.hypot(...vector) || 1;
    return vector.map((v) => v / magnitude);
  };
  return {
    embed: async (text: string) => vectorFor(text),
    embedQuery: async (text: string) => vectorFor(text),
    embedBatch: async (texts: string[]) => texts.map(vectorFor),
  };
});

let home: string;
let store: Store;
let memory: MemoryManager;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-memnovec-'));
  store = new Store({ home });
  await store.ensureLayout();
  await store.ensureDefaultProject();
  memory = new MemoryManager(store);
  await store.createGezel({ name: 'Recaller' });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('memory search without sqlite-vec', () => {
  it('saves to the index and refuses a vector query instead of returning nothing', async () => {
    const outcome = await memory.save('gezel', 'recaller', 'The user prefers concise answers.');
    expect(outcome.status).toBe('saved');
    expect(memory.hasIndex('gezel', 'recaller')).toBe(true);

    await expect(
      searchByVector(store.memoryIndexDir('gezel', 'recaller'), new Array(16).fill(0.25)),
    ).rejects.toBeInstanceOf(VectorSearchUnavailableError);
  });

  it('finds a saved memory through the lexical fallback', async () => {
    await memory.save('gezel', 'recaller', 'The user prefers concise answers.');
    await memory.save('project', 'default', 'Deploys go out on Thursdays.');

    const outcome = await memory.searchAllDetailed('recaller', 'default', 'concise answers');
    expect(outcome.mode).toBe('lexical');
    expect(outcome.degraded?.code).toBe('semantic_search_unavailable');
    expect(outcome.results.map((r) => r.text)).toContain('The user prefers concise answers.');

    const single = await memory.search('project', 'default', 'Thursdays deploys');
    expect(single.map((r) => r.text)).toContain('Deploys go out on Thursdays.');
  });
});
