import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../fs/store.js';
import { MemoryCompactor } from './compaction.js';
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

const dayStamp = (daysAgo: number) =>
  new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-memcompact-'));
  store = new Store({ home });
  await store.ensureLayout();
  await store.ensureDefaultProject();
  memory = new MemoryManager(store);
  await store.createGezel({ name: 'Compactee' });
  // Small gate so fixtures stay readable; default is 30.
  await store.writeConfig({ memory: { maintenance: { minEntries: 3 } } });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true }).catch(() => {});
});

function block(time: string, kind: string, text: string): string {
  return `\n## ${time} [${kind}]\n\n${text}\n`;
}

/** Seed three aged days (20/19/18 days old) with 2 entries each + today's file. */
async function seedAgedCorpus(): Promise<{ aged: string[]; today: string }> {
  const aged = [dayStamp(20), dayStamp(19), dayStamp(18)];
  for (const [i, day] of aged.entries()) {
    await store.writeMemoryDay(
      'gezel',
      'compactee',
      day,
      block('09:00', 'fact', `Fact number ${i} about the system.`) +
        block('10:00', 'status', `Status note ${i}, in progress.`),
    );
  }
  await store.appendMemory('gezel', 'compactee', 'Fresh entry from today.', 'fact');
  return { aged, today: dayStamp(0) };
}

function compactor(
  oneShot: (prompt: string) => Promise<string>,
  history?: { log: (e: unknown) => Promise<void> },
): MemoryCompactor {
  return new MemoryCompactor({
    memory,
    store,
    oneShot: async (prompt, _timeoutMs, _opts) => oneShot(prompt),
    // biome-ignore lint/suspicious/noExplicitAny: minimal test stub
    history: history as any,
  });
}

describe('MemoryCompactor', () => {
  it('rewrites aged days from validated LLM output, archives originals, leaves today alone', async () => {
    const { aged, today } = await seedAgedCorpus();
    const events: unknown[] = [];
    const c = compactor(
      async () =>
        `${aged[0]} [fact] Facts zero through two about the system, merged.\n${aged[2]} [status] Status note two, in progress.\n`,
      { log: async (e) => void events.push(e) },
    );

    const result = await c.sweep();
    expect(result.compacted).toBe(1);

    const days = await store.listMemoryDays('gezel', 'compactee');
    expect(days).toContain(today);
    expect(days).toContain(aged[0]);
    expect(days).toContain(aged[2]);
    expect(days).not.toContain(aged[1]); // no survivors on that day → deleted

    const rewritten = await store.readMemoryDay('gezel', 'compactee', aged[0]!);
    expect(rewritten).toContain('merged');
    expect(rewritten).toMatch(/^## 00:00 \[fact\]$/m);
    const todayContent = await store.readMemoryDay('gezel', 'compactee', today);
    expect(todayContent).toContain('Fresh entry from today.');

    // Originals archived.
    const archiveRoot = join(home, 'gezels', 'compactee', 'memories', 'archive');
    const runs = await readdir(archiveRoot);
    expect(runs).toHaveLength(1);
    const archived = await readdir(join(archiveRoot, runs[0]!));
    expect(archived.sort()).toEqual(aged.map((d) => `${d}.md`).sort());

    // Index rebuilt to match the new corpus: 2 survivors + 1 today.
    expect(await countIndexed(store.memoryIndexDir('gezel', 'compactee'))).toBe(3);

    // History event.
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'memory.compacted', gezelId: 'compactee' });
  });

  it('preserves kind tags through the rewrite', async () => {
    const { aged } = await seedAgedCorpus();
    const c = compactor(
      async () => `${aged[0]} [pref] Prefers terse replies.\n${aged[0]} [decision] Chose sqlite.`,
    );
    await c.sweep();
    const rewritten = await store.readMemoryDay('gezel', 'compactee', aged[0]!);
    expect(rewritten).toMatch(/^## 00:00 \[pref\]$/m);
    expect(rewritten).toMatch(/^## 00:00 \[decision\]$/m);
  });

  it('leaves the corpus untouched when the LLM throws', async () => {
    const { aged } = await seedAgedCorpus();
    const before = await Promise.all(aged.map((d) => store.readMemoryDay('gezel', 'compactee', d)));
    const c = compactor(async () => {
      throw new Error('klerk down');
    });
    const result = await c.sweep();
    expect(result.compacted).toBe(0);
    const after = await Promise.all(aged.map((d) => store.readMemoryDay('gezel', 'compactee', d)));
    expect(after).toEqual(before);
    const archiveRoot = join(home, 'gezels', 'compactee', 'memories', 'archive');
    await expect(readdir(archiveRoot)).rejects.toThrow();
  });

  it('aborts on NONE and on a survivor count below the ratio guard', async () => {
    const { aged } = await seedAgedCorpus();
    for (const reply of ['NONE', '']) {
      const c = compactor(async () => reply);
      const result = await c.sweep();
      expect(result.compacted).toBe(0);
    }
    // 6 entries in → 0 parseable survivors (garbage output) → abort.
    const garbage = compactor(async () => 'I think these memories are all unimportant.');
    expect((await garbage.sweep()).compacted).toBe(0);
    const intact = await store.readMemoryDay('gezel', 'compactee', aged[1]!);
    expect(intact).toContain('Fact number 1');
  });

  it('is idempotent — an unchanged window is not re-fed to the LLM', async () => {
    const { aged } = await seedAgedCorpus();
    let calls = 0;
    const c = compactor(async () => {
      calls++;
      return `${aged[0]} [fact] Everything merged into one.`;
    });
    await c.sweep();
    expect(calls).toBe(1);
    await c.sweep();
    expect(calls).toBe(1); // input hash unchanged → skip
  });

  it('skips scopes under the minEntries gate', async () => {
    await store.writeMemoryDay(
      'gezel',
      'compactee',
      dayStamp(20),
      block('09:00', 'fact', 'Lonely fact.'),
    );
    let called = false;
    const c = compactor(async () => {
      called = true;
      return 'NONE';
    });
    await c.sweep();
    expect(called).toBe(false);
  });

  it('never touches days inside the olderThanDays horizon', async () => {
    // Yesterday + today only — nothing is ≥2 days old, nothing eligible.
    await store.writeMemoryDay(
      'gezel',
      'compactee',
      dayStamp(1),
      block('09:00', 'fact', 'A.') + block('09:01', 'fact', 'B.') + block('09:02', 'fact', 'C.'),
    );
    await store.appendMemory('gezel', 'compactee', 'Today entry.', 'fact');
    let called = false;
    const c = compactor(async () => {
      called = true;
      return 'NONE';
    });
    await c.sweep();
    expect(called).toBe(false);
  });

  it('invokes the growth engine per gezel scope, failure-isolated', async () => {
    const refreshed: string[] = [];
    const c = new MemoryCompactor({
      memory,
      store,
      oneShot: async () => 'NONE',
      growth: {
        refresh: async (gezelId: string) => {
          refreshed.push(gezelId);
          throw new Error('growth blew up'); // must not break the sweep
        },
      },
    });
    const result = await c.sweep();
    expect(refreshed).toContain('compactee');
    expect(result.checked).toBeGreaterThan(0);
  });

  it('no-ops when maintenance is disabled or engagement is not proactive', async () => {
    await seedAgedCorpus();
    let called = false;
    const stub = async () => {
      called = true;
      return 'NONE';
    };

    await store.writeConfig({ memory: { maintenance: { enabled: false, minEntries: 3 } } });
    await compactor(stub).sweep();
    expect(called).toBe(false);

    await store.writeConfig({
      aiEngagementMode: 'reactive',
      memory: { maintenance: { minEntries: 3 } },
    });
    await compactor(stub).sweep();
    expect(called).toBe(false);
  });
});
