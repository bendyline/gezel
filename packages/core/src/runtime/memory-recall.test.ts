import { describe, expect, it } from 'vitest';
import { MEMORY_NOTES_HEADER } from '../memory-notes.js';
import { estimateTokens } from '../retrieval-budget.js';
import { readBackupZip } from './backup-zip.js';
import { USER_MEMORY_ID, parseMemoryDay } from './memory-markdown.js';
import { memoryRecallTerms } from './memory-recall.js';
import { portableFixture } from './test-files.js';

describe('phone memory recall', () => {
  it('keeps only the words worth searching for', () => {
    expect(memoryRecallTerms('Can you tell me about checkers?')).toEqual(['checkers']);
    expect(memoryRecallTerms('can you help me with this')).toEqual([]);
  });

  it('recalls the person’s and the project’s memories that share a word, this project’s first', async () => {
    const { store } = portableFixture();
    await store.ensureLayout();
    const gezelId = (await store.readConfig()).meesterGezelId!;
    await store.saveMemory({
      scope: 'user',
      id: USER_MEMORY_ID,
      text: 'Plays checkers with their daughter on Sundays.',
      source: { project: 'elsewhere', gezel: gezelId },
    });
    await store.saveMemory({
      scope: 'user',
      id: USER_MEMORY_ID,
      kind: 'pref',
      text: 'Likes checkers puzzles that end in a double jump.',
      source: { project: 'default', gezel: gezelId },
    });
    await store.saveMemory({ scope: 'project', id: 'default', text: 'The board is 8x8.' });

    const recall = await store.recallMemories({
      gezelId,
      projectId: 'default',
      text: 'Give me a checkers puzzle',
      contextWindow: 8192,
    });
    expect(recall?.hits.map((hit) => [hit.scope, hit.text])).toEqual([
      ['user', 'Likes checkers puzzles that end in a double jump.'],
      ['user', 'Plays checkers with their daughter on Sundays.'],
    ]);
    expect(recall?.block).toContain('- About the person (pref, ');
    expect(recall?.block.split('\n')[0]).toBe(MEMORY_NOTES_HEADER);

    expect(
      await store.recallMemories({
        gezelId,
        projectId: 'default',
        text: 'can you help me with this',
      }),
    ).toBeNull();
  });

  it('stays inside a 4K window’s retrieval ceiling', async () => {
    const { store } = portableFixture();
    await store.ensureLayout();
    const gezelId = (await store.readConfig()).meesterGezelId!;
    for (let i = 0; i < 6; i++)
      await store.saveMemory({
        scope: 'project',
        id: 'default',
        text: `Checkers note ${i}: ${'a long remark about openings and endgames '.repeat(4)}`,
      });
    const recall = await store.recallMemories({
      gezelId,
      projectId: 'default',
      text: 'checkers',
      contextWindow: 4096,
    });
    expect(recall).not.toBeNull();
    expect(estimateTokens(recall!.block)).toBeLessThanOrEqual(160);
  });

  it('backs the person’s memories up and merges them into the ones already here', async () => {
    const source = portableFixture();
    await source.store.ensureLayout();
    await source.store.saveMemory({ scope: 'user', id: USER_MEMORY_ID, text: 'Lives in Utrecht.' });
    const exported = await source.store.exportBackup();
    expect([...(await readBackupZip(exported.bytes)).keys()]).toContain(
      'memories/daily/2026-09-20.md',
    );

    const target = portableFixture();
    await target.store.ensureLayout();
    await target.store.saveMemory({ scope: 'user', id: USER_MEMORY_ID, text: 'Cycles to work.' });
    const review = await target.store.scanRestore(exported.bytes);
    const memoryItem = review.items.find((item) => item.kind === 'memory-root');
    expect(memoryItem?.conflict).toBe('none');
    await target.store.confirmRestore(review.restoreId, {
      items: [{ kind: 'memory-root', id: 'memories', action: 'add' }],
      settings: false,
    });
    const day = await target.store.readMemoryDay('user', USER_MEMORY_ID, '2026-09-20');
    expect(parseMemoryDay(day).map((block) => block.text)).toEqual([
      'Cycles to work.',
      'Lives in Utrecht.',
    ]);
  });
});
