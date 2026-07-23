import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../fs/store.js';
import { runLessonsDistillation } from './lessons.js';
import { MemoryManager } from './manager.js';

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

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-memlessons-'));
  store = new Store({ home });
  await store.ensureLayout();
  await store.ensureDefaultProject();
  memory = new MemoryManager(store);
  await store.createGezel({ name: 'Learner' });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true }).catch(() => {});
});

/**
 * Seed enough gezel-scope notes to clear the min-input gate (~400 chars).
 * Appends markdown directly — save()'s near-dup check would collapse
 * these similar fixtures under the mock embedder, and dedup isn't what's
 * under test here.
 */
async function seedNotes(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await store.appendMemory(
      'gezel',
      'learner',
      `Lesson source note number ${i}: user consistently asked for single-file deliverables without external dependencies in round ${i}.`,
      'pref',
    );
  }
}

function args(oneShot: (prompt: string) => Promise<string>, config = {}) {
  return {
    store,
    memory,
    oneShot: async (prompt: string, _t: number, _o: { useKlerk: true; jobLabel: string }) =>
      oneShot(prompt),
    config,
    gezelId: 'learner',
  };
}

describe('runLessonsDistillation', () => {
  it('writes lessons.md from distilled output', async () => {
    await seedNotes();
    const { updated } = await runLessonsDistillation(
      args(async () => '- Prefer single-file deliverables without external dependencies.'),
    );
    expect(updated).toBe(true);
    const content = await store.readMemoryLessons('learner');
    expect(content).toContain('single-file deliverables');
  });

  it('rewrites (not appends) on subsequent runs and feeds the current doc back in', async () => {
    await seedNotes();
    await runLessonsDistillation(args(async () => '- First lesson.'));
    let sawCurrent = false;
    await runLessonsDistillation(
      args(async (prompt) => {
        sawCurrent = prompt.includes('- First lesson.');
        return '- Replacement lesson.';
      }),
    );
    const content = await store.readMemoryLessons('learner');
    expect(sawCurrent).toBe(true);
    expect(content).toContain('Replacement lesson');
    expect(content).not.toContain('First lesson');
  });

  it('hard-truncates oversize output at 1.2× maxChars on a line boundary', async () => {
    await seedNotes();
    const oversize = Array.from({ length: 100 }, (_, i) => `- Bullet number ${i} padding.`).join(
      '\n',
    );
    await runLessonsDistillation(
      args(async () => oversize, { memory: { lessons: { maxChars: 200 } } }),
    );
    const content = await store.readMemoryLessons('learner');
    expect(content.length).toBeLessThanOrEqual(241); // 200 * 1.2 + trailing newline
    expect(content.endsWith('.\n')).toBe(true); // cut on a line boundary
  });

  it('leaves the previous document untouched on NONE, empty, or a thrown one-shot', async () => {
    await seedNotes();
    await runLessonsDistillation(args(async () => '- Keep me.'));
    for (const behave of [
      async () => 'NONE',
      async () => '',
      async () => {
        throw new Error('klerk down');
      },
    ]) {
      const { updated } = await runLessonsDistillation(args(behave));
      expect(updated).toBe(false);
      expect(await store.readMemoryLessons('learner')).toContain('Keep me');
    }
  });

  it('skips below the min-input gate and when disabled by config', async () => {
    let called = false;
    const stub = async () => {
      called = true;
      return '- x';
    };
    // No notes seeded → under the gate.
    expect((await runLessonsDistillation(args(stub))).updated).toBe(false);
    expect(called).toBe(false);

    await seedNotes();
    expect(
      (await runLessonsDistillation(args(stub, { memory: { lessons: { enabled: false } } })))
        .updated,
    ).toBe(false);
    expect(called).toBe(false);
  });

  it('forbids project facts and completion status in the prompt', async () => {
    await seedNotes();
    let prompt = '';
    await runLessonsDistillation(
      args(async (p) => {
        prompt = p;
        return 'NONE';
      }),
    );
    expect(prompt).toContain('FORBIDDEN: project-specific facts');
    expect(prompt).toContain('completion status');
    expect(prompt).toContain('REWRITE the document from scratch');
  });
});
