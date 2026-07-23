/**
 * Write the two hand-authored guardrail craftbooks to the catalog:
 *
 *   pnpm --filter @bendyline/gezel-catalog exec tsx scripts/write-guardrail-books.ts
 *   pnpm --filter @bendyline/gezel-catalog run build-index
 *
 * The book definitions (and the rationale) live in
 * src/guardrail-books.ts so the regen test pins the same source.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type CraftbookDoc,
  CraftbookDocSchema,
  craftbookFromDoc,
  formatCraftbookDocErrors,
  serializeCraftbookDoc,
} from '@bendyline/gezel';
import {
  CAREFUL_MODE,
  FREEZE_SCOPE,
  GUARDRAIL_RELEASED_AT,
  GUARDRAIL_VERSION,
} from '../src/guardrail-books.js';
import { requireGildeCheckout } from './gilde-checkout.js';

const dataRoot = join(requireGildeCheckout().dataDir, 'craftbook-templates');

async function writeBook(doc: CraftbookDoc): Promise<void> {
  const parsed = CraftbookDocSchema.parse(doc);
  const runtime = craftbookFromDoc(parsed, { now: GUARDRAIL_RELEASED_AT });
  if (!runtime.ok) {
    throw new Error(
      `${doc.id}: guardrail book failed validation:\n${formatCraftbookDocErrors(runtime.errors)}`,
    );
  }
  const id = parsed.id!;
  const shard = id.slice(0, 2).toLowerCase();
  const bookDir = join(dataRoot, shard, id);
  await mkdir(join(bookDir, 'versions', GUARDRAIL_VERSION), { recursive: true });
  const identity = {
    schemaVersion: 1,
    kind: 'craftbook-template',
    id,
    name: parsed.name,
    description: parsed.description!.split('. ')[0]!,
    tags: ['guardrail', 'safety'],
    maintainer: { name: 'Gezel' },
    license: 'MIT',
    yankedVersions: [],
  };
  await writeFile(join(bookDir, 'manifest.json'), `${JSON.stringify(identity, null, 2)}\n`);
  await writeFile(
    join(bookDir, 'versions', GUARDRAIL_VERSION, 'craftbook.json'),
    serializeCraftbookDoc(parsed, 'json'),
  );
  console.log(
    `  \u2713 ${id} (${parsed.steps.length} step(s), ${parsed.hooks?.length ?? 0} hook(s))`,
  );
}

async function main(): Promise<void> {
  await writeBook(CAREFUL_MODE);
  await writeBook(FREEZE_SCOPE);
  console.log('Next: pnpm --filter @bendyline/gezel-catalog run build-index');
}

// Import-safe: tests import the docs from src without running the writer.
if (process.argv[1]?.endsWith('write-guardrail-books.ts')) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
