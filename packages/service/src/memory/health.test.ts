import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../fs/store.js';
import { MemoryHealthMonitor } from './health.js';
import { MemoryManager } from './manager.js';
import { countIndexed } from './vector-index.js';

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

  return {
    EmbeddingsDisabledError,
    embeddingsDisabledReason: () => null,
    embed: async (text: string) => vectorFor(text),
    embedQuery: async (text: string) => vectorFor(text),
    embedBatch: async (texts: string[]) => texts.map(vectorFor),
  };
});

let home: string;
let store: Store;
let memory: MemoryManager;
let monitor: MemoryHealthMonitor;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-memhealth-'));
  store = new Store({ home });
  await store.ensureLayout();
  await store.ensureDefaultProject();
  memory = new MemoryManager(store);
  monitor = new MemoryHealthMonitor({ memory, store });
});

afterEach(async () => {
  monitor.stop();
  await rm(home, { recursive: true, force: true }).catch(() => {});
});

describe('MemoryHealthMonitor', () => {
  it('rebuilds an empty vector index when markdown has entries', async () => {
    await store.createGezel({ name: 'Sweeper' });
    // Append markdown directly (source of truth) WITHOUT indexing — simulates a
    // fresh/empty vector cache (or the cutover from the old Vectra store).
    await store.appendMemory('gezel', 'sweeper', 'first memory');
    await store.appendMemory('gezel', 'sweeper', 'second memory');
    expect(await countIndexed(store.memoryIndexDir('gezel', 'sweeper'))).toBe(0);

    const result = await monitor.sweep();
    expect(result.rebuilt).toBeGreaterThanOrEqual(1);
    expect(await countIndexed(store.memoryIndexDir('gezel', 'sweeper'))).toBe(2);
  });

  it('does not rebuild when index is already in sync', async () => {
    await store.createGezel({ name: 'Synced' });
    await memory.save('gezel', 'synced', 'one');

    // Sweep twice — second sweep should find nothing to do.
    await monitor.sweep();
    const result = await monitor.sweep();
    expect(result.rebuilt).toBe(0);
  });

  it('does nothing for a scope with no markdown memories', async () => {
    await store.createGezel({ name: 'Empty' });
    const result = await monitor.sweep();
    expect(result.rebuilt).toBe(0);
  });

  it('rebuilds when vector has fewer entries than markdown', async () => {
    await store.createGezel({ name: 'Drifty' });
    // One indexed entry, one markdown-only entry → vector (1) < markdown (2).
    await memory.save('gezel', 'drifty', 'first');
    await store.appendMemory('gezel', 'drifty', 'second');
    expect(await countIndexed(store.memoryIndexDir('gezel', 'drifty'))).toBe(1);

    const result = await monitor.sweep();
    expect(result.rebuilt).toBeGreaterThanOrEqual(1);
    expect(await countIndexed(store.memoryIndexDir('gezel', 'drifty'))).toBe(2);
  });
});
