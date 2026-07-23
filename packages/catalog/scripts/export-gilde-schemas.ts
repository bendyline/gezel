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
 * runtime Zod parse. `unrepresentable` stays at its default ('throw') so
 * a future transform in a published schema fails this export loudly
 * instead of silently weakening gilde validation.
 *
 * Usage: pnpm --filter @bendyline/gezel-catalog export-gilde-schemas
 *        (or from the repo root: pnpm gilde:export-schemas)
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ChatModelIdentitySchema,
  ChatModelVersionManifestSchema,
  ConnectorTypeIdentitySchema,
  ConnectorTypeVersionManifestSchema,
  CraftbookDocSchema,
  CraftbookTemplateIdentitySchema,
  CraftbookTemplateVersionManifestSchema,
  CraftbookTestSpecSchema,
  GezelTemplateIdentitySchema,
  GezelTemplateVersionManifestSchema,
  ImageModelIdentitySchema,
  ImageModelVersionManifestSchema,
  ProjectTypeIdentitySchema,
  ProjectTypeVersionManifestSchema,
  ToolsetIdentitySchema,
  ToolsetVersionManifestSchema,
  VideoModelIdentitySchema,
  VideoModelVersionManifestSchema,
} from '@bendyline/gezel';
import { z } from 'zod';
import { requireGildeCheckout } from './gilde-checkout.js';

const EXPORTS: Array<[filename: string, schema: z.ZodType]> = [
  ['toolset-identity.schema.json', ToolsetIdentitySchema],
  ['toolset-version.schema.json', ToolsetVersionManifestSchema],
  ['gezel-template-identity.schema.json', GezelTemplateIdentitySchema],
  ['gezel-template-version.schema.json', GezelTemplateVersionManifestSchema],
  ['craftbook-template-identity.schema.json', CraftbookTemplateIdentitySchema],
  ['craftbook-template-version.schema.json', CraftbookTemplateVersionManifestSchema],
  ['project-type-identity.schema.json', ProjectTypeIdentitySchema],
  ['project-type-version.schema.json', ProjectTypeVersionManifestSchema],
  ['connector-type-identity.schema.json', ConnectorTypeIdentitySchema],
  ['connector-type-version.schema.json', ConnectorTypeVersionManifestSchema],
  ['chat-model-identity.schema.json', ChatModelIdentitySchema],
  ['chat-model-version.schema.json', ChatModelVersionManifestSchema],
  ['image-model-identity.schema.json', ImageModelIdentitySchema],
  ['image-model-version.schema.json', ImageModelVersionManifestSchema],
  ['video-model-identity.schema.json', VideoModelIdentitySchema],
  ['video-model-version.schema.json', VideoModelVersionManifestSchema],
  ['craftbook-doc.schema.json', CraftbookDocSchema],
  ['craftbook-test.schema.json', CraftbookTestSpecSchema],
];

/**
 * The per-kind index.json shape is produced by gilde's own
 * tools/build-index.mjs, not by a Zod schema — hand-maintained here so
 * gilde can validate its generated indexes too.
 */
const CATALOG_INDEX_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://gezelgilde.com/schemas/catalog-index.schema.json',
  type: 'object',
  properties: {
    schemaVersion: { type: 'number', const: 1 },
    kind: { type: 'string' },
    count: { type: 'number', minimum: 0 },
    entries: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          manifest: { type: 'object' },
          iconSvg: { type: 'string' },
        },
        required: ['manifest'],
      },
    },
  },
  required: ['schemaVersion', 'kind', 'count', 'entries'],
};

const README = `# schemas/

JSON Schemas for every content file in \`data/\`, consumed by
\`tools/validate.mjs\`.

**Generated — do not edit.** These are exported from the Zod schemas in
gezel core (\`packages/core/src/schemas/\`), which remain the source of
truth. Regenerate from a gezel checkout with:

\`\`\`
pnpm gilde:export-schemas
\`\`\`

Note: Zod refinements do not survive the export, so validation here is
slightly looser than gezel's runtime parse. Layout and cross-reference
rules that matter are re-implemented in \`tools/validate.mjs\`.
`;

function main(): void {
  const { root } = requireGildeCheckout();
  const outDir = join(root, 'schemas');
  mkdirSync(outDir, { recursive: true });

  for (const [filename, schema] of EXPORTS) {
    const json = z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input' }) as Record<
      string,
      unknown
    >;
    const withId = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: `https://gezelgilde.com/schemas/${filename}`,
      ...json,
    };
    withId.$schema = 'https://json-schema.org/draft/2020-12/schema';
    writeFileSync(join(outDir, filename), `${JSON.stringify(withId, null, 2)}\n`);
    console.log(`[schemas] wrote ${filename}`);
  }

  writeFileSync(
    join(outDir, 'catalog-index.schema.json'),
    `${JSON.stringify(CATALOG_INDEX_SCHEMA, null, 2)}\n`,
  );
  console.log('[schemas] wrote catalog-index.schema.json');

  writeFileSync(join(outDir, 'README.md'), README);
  console.log(`[schemas] wrote README.md (${EXPORTS.length + 1} schemas total)`);
}

main();
