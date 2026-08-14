import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../fs/store.js';
import { parseMemoryDay } from './daily-markdown.js';
import { MemoryHealthMonitor } from './health.js';
import { MemoryManager } from './manager.js';
import { countIndexed } from './vector-index.js';

/**
 * Deterministic char-frequency embeddings (same shape as health.test.ts),
 * extended with a disable toggle + call counter so the dedup paths can be
 * exercised: identical text → identical vector (similarity 1.0); a tiny
 * suffix ("." on a longer sentence) → similarity ≳0.99; a short word vs a
 * long sentence → well below the 0.9 threshold.
 */
vi.mock('./embeddings.js', () => {
  const vectorFor = (text: string): number[] => {
    const vector = new Array<number>(16).fill(0);
    for (let i = 0; i < text.length; i++) {
      vector[i % vector.length]! += text.charCodeAt(i) / 255;
    }
    const magnitude = Math.hypot(...vector) || 1;
    return vector.map((v) => v / magnitude);
  };

  class EmbeddingsDisabledError extends Error {
    readonly code = 'EMBEDDINGS_DISABLED';
  }

  let disabled = false;
  let embedCalls = 0;

  return {
    EmbeddingsDisabledError,
    embeddingsDisabledReason: () => (disabled ? 'mock-disabled' : null),
    embed: async (text: string) => {
      if (disabled) throw new EmbeddingsDisabledError('mock-disabled');
      embedCalls++;
      return vectorFor(text);
    },
    embedQuery: async (text: string) => {
      if (disabled) throw new EmbeddingsDisabledError('mock-disabled');
      embedCalls++;
      return vectorFor(text);
    },
    embedBatch: async (texts: string[]) => texts.map(vectorFor),
    __setDisabled: (v: boolean) => {
      disabled = v;
    },
    __embedCalls: () => embedCalls,
  };
});

const embeddingsMock = (await import('./embeddings.js')) as unknown as {
  __setDisabled(v: boolean): void;
  __embedCalls(): number;
};

let home: string;
let store: Store;
let memory: MemoryManager;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-memdedup-'));
  store = new Store({ home });
  await store.ensureLayout();
  await store.ensureDefaultProject();
  memory = new MemoryManager(store);
  await store.createGezel({ name: 'Deduper' });
  embeddingsMock.__setDisabled(false);
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true }).catch(() => {});
});

const today = () => new Date().toISOString().slice(0, 10);

describe('MemoryManager.save dedup', () => {
  it('skips an identical re-save: one markdown block, one index row', async () => {
    const first = await memory.save('gezel', 'deduper', 'User prefers tabs over spaces.');
    expect(first.status).toBe('saved');

    const second = await memory.save('gezel', 'deduper', 'User prefers tabs over spaces.');
    expect(second.status).toBe('duplicate');
    expect(second.match?.via).toBe('exact');
    expect(second.match?.score).toBe(1);

    const content = await store.readMemoryDay('gezel', 'deduper', today());
    expect(parseMemoryDay(content)).toHaveLength(1);
    expect(await countIndexed(store.memoryIndexDir('gezel', 'deduper'))).toBe(1);
  });

  it('exact path tolerates whitespace and skips the embed call', async () => {
    await memory.save('gezel', 'deduper', 'Exact text here.');
    const callsBefore = embeddingsMock.__embedCalls();
    const outcome = await memory.save('gezel', 'deduper', '  Exact text here.  ');
    expect(outcome.status).toBe('duplicate');
    expect(outcome.match?.via).toBe('exact');
    expect(embeddingsMock.__embedCalls()).toBe(callsBefore);
  });

  it('catches near-duplicates via vector similarity', async () => {
    await memory.save('gezel', 'deduper', 'The project uses sqlite-vec for the memory index');
    const outcome = await memory.save(
      'gezel',
      'deduper',
      'The project uses sqlite-vec for the memory index.',
    );
    expect(outcome.status).toBe('duplicate');
    expect(outcome.match?.via).toBe('vector');
    expect(outcome.match?.score).toBeGreaterThanOrEqual(0.9);
    expect(await countIndexed(store.memoryIndexDir('gezel', 'deduper'))).toBe(1);
  });

  it('saves distinct texts', async () => {
    const a = await memory.save('gezel', 'deduper', 'cat');
    const b = await memory.save('gezel', 'deduper', 'quantum entanglement lecture notes draft');
    expect(a.status).toBe('saved');
    expect(b.status).toBe('saved');
    expect(await countIndexed(store.memoryIndexDir('gezel', 'deduper'))).toBe(2);
  });

  it('persists the kind through markdown and index', async () => {
    await memory.save('gezel', 'deduper', 'Prefers PRs under 300 lines.', 'pref');
    const content = await store.readMemoryDay('gezel', 'deduper', today());
    expect(content).toMatch(/^## \d{2}:\d{2} \[pref\]$/m);
    const entries = await memory.allEntries('gezel', 'deduper');
    expect(entries[0]?.kind).toBe('pref');
  });

  it('embeddings disabled: saves Markdown with deferred indexing; identical re-save dedups', async () => {
    embeddingsMock.__setDisabled(true);
    const first = await memory.save('gezel', 'deduper', 'Degraded-mode fact.');
    expect(first).toMatchObject({
      status: 'saved',
      indexed: false,
      degraded: { code: 'semantic_index_unavailable' },
    });
    const content = await store.readMemoryDay('gezel', 'deduper', today());
    expect(parseMemoryDay(content)).toHaveLength(1);

    const second = await memory.save('gezel', 'deduper', 'Degraded-mode fact.');
    expect(second.status).toBe('duplicate');
    expect(second.match?.via).toBe('exact');
    expect(parseMemoryDay(await store.readMemoryDay('gezel', 'deduper', today()))).toHaveLength(1);
  });

  it('dup-skip keeps markdown and index in lockstep — health sweep rebuilds nothing', async () => {
    await memory.save('gezel', 'deduper', 'Lockstep fact one.');
    await memory.save('gezel', 'deduper', 'Lockstep fact one.');
    const monitor = new MemoryHealthMonitor({ memory, store });
    const result = await monitor.sweep();
    monitor.stop();
    expect(result.rebuilt).toBe(0);
  });

  it('honors a custom dedup threshold', async () => {
    const strict = new MemoryManager(store, { dedupThreshold: 1.01 });
    await strict.save('gezel', 'deduper', 'The project uses sqlite-vec for the memory index');
    const outcome = await strict.save(
      'gezel',
      'deduper',
      'The project uses sqlite-vec for the memory index.',
    );
    expect(outcome.status).toBe('saved');
    expect(await countIndexed(store.memoryIndexDir('gezel', 'deduper'))).toBe(2);
  });
});

describe('MemoryManager search degradation', () => {
  it('does not initialize the embedder when neither scope has an index', async () => {
    const callsBefore = embeddingsMock.__embedCalls();

    const outcome = await memory.searchAllDetailed('deduper', 'default', 'anything at all');

    expect(outcome).toEqual({ results: [], mode: 'lexical' });
    expect(embeddingsMock.__embedCalls()).toBe(callsBefore);
  });

  it('falls back to source Markdown when semantic search is unavailable', async () => {
    await memory.save('gezel', 'deduper', 'The launch checklist requires a rollback plan.');
    embeddingsMock.__setDisabled(true);

    const outcome = await memory.searchAllDetailed('deduper', 'default', 'rollback plan');

    expect(outcome.mode).toBe('lexical');
    expect(outcome.degraded?.code).toBe('semantic_search_unavailable');
    expect(outcome.results).toEqual([
      expect.objectContaining({
        text: 'The launch checklist requires a rollback plan.',
        scope: 'gezel',
      }),
    ]);
  });

  it('embeds once and reuses the query vector across both indexed scopes', async () => {
    await memory.save('gezel', 'deduper', 'The release uses a blue-green deployment.');
    await memory.save('project', 'default', 'The project rollback window is fifteen minutes.');
    const callsBefore = embeddingsMock.__embedCalls();

    const outcome = await memory.searchAllDetailed('deduper', 'default', 'release rollback');

    expect(outcome.mode).toBe('semantic');
    expect(embeddingsMock.__embedCalls()).toBe(callsBefore + 1);
  });
});
