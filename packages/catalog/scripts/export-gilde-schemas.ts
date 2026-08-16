/**
 * export-gilde-schemas — emit JSON Schemas from the core Zod catalog
 * schemas into the sibling gilde checkout's `schemas/` directory.
 *
 * Why: gilde's PR validation must run without any dependency on gezel
 * packages (core isn't published), so it validates content with ajv
 * against these committed JSON Schema snapshots. The Zod schemas remain
 * the source of truth — rerun this whenever packages/core/src/schemas/*
 * changes, then PR the regenerated files to gilde.
 *
 * Fidelity caveat (documented in AGENTS.md): `z.toJSONSchema` drops
 * refinements/superRefines, so gilde CI is deliberately LOOSER than the
 * runtime Zod parse.
 *
 * Forgetting to rerun this is not a loud failure — gilde's build-index
 * strips undeclared properties out of the published index instead. The
 * payload lives in `src/gilde-schema-export.ts` so
 * `gilde-schema-freshness.test.ts` can gate exactly that drift.
 *
 * Usage: pnpm --filter @bendyline/gezel-catalog export-gilde-schemas
 *        (or from the repo root: pnpm gilde:export-schemas)
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderGildeSchemaFiles } from '../src/gilde-schema-export.js';
import { requireGildeCheckout } from './gilde-checkout.js';

function main(): void {
  const { root } = requireGildeCheckout();
  const outDir = join(root, 'schemas');
  mkdirSync(outDir, { recursive: true });

  const files = renderGildeSchemaFiles();
  for (const [filename, content] of files) {
    writeFileSync(join(outDir, filename), content);
    console.log(`[schemas] wrote ${filename}`);
  }
  console.log(`[schemas] ${files.length} files total`);
}

main();
