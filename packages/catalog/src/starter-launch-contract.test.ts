import { appendFileSync } from 'node:fs';
import {
  STARTER_CRAFTBOOK_IDS,
  craftbookInputParams,
  createLogger,
  launchFormParamSchema,
  mainContentParamKey,
  pathLikeLaunchFields,
  planLaunchFormSchema,
  starterCraftbookIds,
} from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { CatalogService } from './service.js';

describe('starter launch contract', () => {
  it('offers a nonempty starter set and never shows a filesystem field', async () => {
    const catalog = new CatalogService();
    const books = (await catalog.list('craftbook-template')).flatMap((item) =>
      item.manifest.kind === 'craftbook-template' ? [item.manifest] : [],
    );
    const ids = new Set(starterCraftbookIds(books));
    expect(ids.size).toBeGreaterThan(0);
    const warnings: string[] = [];
    for (const book of books) {
      const tagged = book.tags?.includes('starter');
      const paths = pathLikeLaunchFields(
        tagged ? launchFormParamSchema(book.paramSchema) : planLaunchFormSchema(book),
      );
      if (ids.has(book.id)) {
        expect(paths, `${book.id}: visible filesystem fields`).toEqual([]);
        expect(
          craftbookInputParams(book.paramSchema).filter((input) => input.required),
          `${book.id}: required source input`,
        ).toEqual([]);
        expect(
          await catalog.getCraftbookTestSpec(book.id),
          `${book.id}: eval sidecar`,
        ).toBeTruthy();
        if (tagged)
          expect(
            mainContentParamKey(book.paramSchema),
            `${book.id}: main content field`,
          ).toBeTruthy();
      } else if (paths.length) warnings.push(`${book.id}: ${paths.join(', ')}`);
    }
    if (warnings.length) {
      const report = `Non-starter launch path fields (${warnings.length} plans):\n${warnings.join('\n')}`;
      createLogger('starter-launch-contract').warn(report);
      if (process.env.GITHUB_STEP_SUMMARY)
        appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n${report}\n`);
    }
    if (!books.some((book) => book.tags?.includes('starter'))) {
      expect([...ids].sort()).toEqual([...STARTER_CRAFTBOOK_IDS].sort());
    }
  });
});
