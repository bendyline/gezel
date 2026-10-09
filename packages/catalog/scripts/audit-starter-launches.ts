import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  STARTER_CRAFTBOOK_IDS,
  craftbookInputParams,
  launchFormParamSchema,
  mainContentParamKey,
  pathLikeLaunchFields,
  planLaunchFormSchema,
  starterCraftbookIds,
} from '@bendyline/gezel';
import { CatalogService } from '../src/service.js';

const catalog = new CatalogService();
const items = await catalog.list('craftbook-template');
const books = items.flatMap((item) =>
  item.manifest.kind === 'craftbook-template' ? [item.manifest] : [],
);
const selected = new Set([...STARTER_CRAFTBOOK_IDS, ...starterCraftbookIds(books)]);
const lines = [
  '# Zero-prompt leg 2: starter launch audit',
  '',
  `Catalog: ${process.env.GEZEL_GILDE_DATA_DIR ?? 'installed @bendyline/gilde'}.`,
  'Generated with `GEZEL_GILDE_DATA_DIR=/Users/mike/gh/gilde/data pnpm --filter @bendyline/gezel-catalog exec tsx scripts/audit-starter-launches.ts --out ../../docs/plans/zero-prompt-leg-2-audit.md`.',
  '',
  '| Plan | Version | Main field | Visible fields | Required inputs | Optional pickers | Raw path fields | Effective path fields | Eval mode |',
  '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
];
for (const book of books.filter((book) => selected.has(book.id))) {
  const spec = await catalog.getCraftbookTestSpec(book.id);
  lines.push(
    `| ${book.id} | ${book.version} | ${mainContentParamKey(book.paramSchema) ?? 'description only'} | ${Object.keys(launchFormParamSchema(book.paramSchema)?.properties ?? {}).join(', ') || 'none'} | ${
      craftbookInputParams(book.paramSchema)
        .filter((input) => input.required)
        .map((input) => input.key)
        .join(', ') || 'none'
    } | ${
      craftbookInputParams(book.paramSchema)
        .filter((input) => !input.required)
        .map((input) => input.key)
        .join(', ') || 'none'
    } | ${pathLikeLaunchFields(launchFormParamSchema(book.paramSchema)).join(', ') || 'none'} | ${pathLikeLaunchFields(planLaunchFormSchema(book)).join(', ') || 'none'} | ${spec ? (spec.spec.mode ?? 'artifact-task') : 'MISSING'} |`,
  );
}
const report = `${lines.join('\n')}\n`;
const outIndex = process.argv.indexOf('--out');
if (outIndex >= 0 && process.argv[outIndex + 1])
  await writeFile(resolve(process.argv[outIndex + 1]!), report);
else process.stdout.write(report);
