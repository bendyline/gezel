import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  type CraftbookStep,
  collapseCraftbookForTier,
  validateCraftbookGraph,
} from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { gildeDataDir } from './gilde-data.js';

/**
 * Sweep every bundled craftbook template through the tiny-tier collapse.
 * Lives here (not in core) because it reads the gilde content package —
 * core cannot depend on catalog/gilde. The unit tests for the collapse
 * itself stay in packages/core/src/craftbook-collapse.test.ts.
 */
describe('collapseCraftbookForTier — catalog sweep', () => {
  it('every bundled template either collapses to a valid ≤3-step gated chain or skips clean', () => {
    const root = join(gildeDataDir(), 'craftbook-templates');
    const books: Array<{ id: string; steps: CraftbookStep[]; entryStepId: string }> = [];
    for (const shard of readdirSync(root)) {
      const shardDir = join(root, shard);
      if (!statSync(shardDir).isDirectory()) continue;
      for (const id of readdirSync(shardDir)) {
        const versionsDir = join(shardDir, id, 'versions');
        let versions: string[] = [];
        try {
          versions = readdirSync(versionsDir);
        } catch {
          continue;
        }
        for (const version of versions) {
          const bookPath = join(versionsDir, version, 'craftbook.json');
          try {
            const raw = JSON.parse(readFileSync(bookPath, 'utf8')) as {
              steps?: CraftbookStep[];
              entryStepId?: string;
            };
            if (raw.steps && raw.entryStepId) {
              books.push({
                id: `${id}@${version}`,
                steps: raw.steps,
                entryStepId: raw.entryStepId,
              });
            }
          } catch {
            // No craftbook.json at this version — skip.
          }
        }
      }
    }
    expect(books.length).toBeGreaterThan(20);
    for (const book of books) {
      const result = collapseCraftbookForTier(book, { tier: 'tiny' });
      if (!result.changed) continue;
      expect(result.steps.length, book.id).toBeLessThanOrEqual(3);
      expect(
        validateCraftbookGraph({ steps: result.steps, entryStepId: result.entryStepId }),
        book.id,
      ).toEqual([]);
      for (const step of result.steps) {
        expect(step.gate, `${book.id} step ${step.id}`).toBeDefined();
      }
    }
  });
});
