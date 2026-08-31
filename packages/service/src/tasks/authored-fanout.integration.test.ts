import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { craftbookFromDoc, parseCraftbookDoc, validateCraftbookGraph } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { Store } from '../fs/store.js';

/**
 * The chain a MODEL actually takes to create a fanning-out recipe:
 *
 *   craftbook_write(create: true, content)   -- a whole document
 *     -> parseCraftbookDoc -> craftbookFromDoc
 *     -> POST /api/craftbooks/document (no projectId)
 *     -> Store.writeLocalCraftbookTemplate
 *     -> invoke -> the task snapshot carries craftbook.spawn
 *     -> the spawnFanout step fans out one child per item
 *
 * `fanout.integration.test.ts` covers the runtime end using the BUNDLED
 * invoice-run book, which is loaded from the catalog and never passes
 * through the document codec or the local-template writer. So every link
 * that a model-authored book depends on was untested — and every one of
 * them was broken:
 *
 *   - `docFromCraftbook`/`craftbookFromDoc` dropped `spawn` entirely, so a
 *     document declaring a fanout was accepted, returned 201, and produced
 *     a craftbook without one.
 *   - `Store.writeLocalCraftbookTemplate` dropped it again at rest.
 *   - The markdown arm rejected the document outright with
 *     `unknown key "spawn"`.
 *
 * Net effect: authoring a fanout recipe was impossible for any model, and
 * the failure was silent at every layer. This test walks the whole chain.
 */

const FANOUT_DOC = {
  name: 'Store Health Sweep',
  description: 'One health write-up per store.',
  entryStepId: 'sweep',
  spawn: {
    overFile: 'data/stores.json',
    entryStepId: 'store',
    steps: [
      {
        id: 'store',
        name: 'Write one store report',
        prompt: 'Write the health write-up for {{slug}} to out/{{slug}}-health.md',
        terminal: true,
      },
    ],
  },
  steps: [
    {
      id: 'sweep',
      name: 'Read the store list',
      prompt: 'Read data/stores.json so the per-store work can fan out.',
      spawnFanout: true,
      next: 'wrap',
    },
    { id: 'wrap', name: 'Wrap up', prompt: 'Summarise the sweep.', terminal: true },
  ],
};

describe('a model-authored fanout craftbook survives the whole write path', () => {
  it.each(['json', 'markdown'] as const)('through the %s document codec', async (format) => {
    const home = await mkdtemp(join(tmpdir(), 'gezel-authored-fanout-'));
    try {
      const store = new Store({ home });
      await store.ensureLayout();

      // 1. The model emits a whole document and craftbook_write parses it.
      const serialized =
        format === 'json'
          ? JSON.stringify(FANOUT_DOC, null, 2)
          : (await import('@bendyline/gezel')).serializeCraftbookDoc(
              FANOUT_DOC as never,
              'markdown',
            );
      const parsed = parseCraftbookDoc(serialized, format);
      expect(
        parsed.ok,
        parsed.ok ? '' : parsed.errors.map((e) => `${e.where}: ${e.message}`).join(' | '),
      ).toBe(true);
      if (!parsed.ok) return;

      // 2. It becomes a runtime craftbook.
      const built = craftbookFromDoc(parsed.doc, {
        id: 'store-health-sweep',
        now: '2026-01-01T00:00:00.000Z',
      });
      expect(built.ok, built.ok ? '' : JSON.stringify(built.errors)).toBe(true);
      if (!built.ok) return;
      expect(built.craftbook.spawn?.overFile).toBe('data/stores.json');
      expect(validateCraftbookGraph(built.craftbook)).toEqual([]);

      // 3. `create: true` with no projectId lands in the LOCAL writer.
      await store.writeLocalCraftbookTemplate(built.craftbook);

      // 4. Invoking reads it back — this is where the fanout used to vanish.
      const read = await store.getLocalCraftbookTemplate('store-health-sweep');
      expect(read).not.toBeNull();
      expect(
        read?.spawn,
        'the spawn block must survive persistence — without it the spawnFanout step fans out over nothing and no child task is ever created',
      ).toEqual(built.craftbook.spawn);

      // 5. The step that triggers the fanout must survive too: a spawn block
      //    with no `spawnFanout` step is just as inert as a missing one.
      expect(read?.steps.find((step) => step.id === 'sweep')?.spawnFanout).toBe(true);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
