/**
 * export-schemas — emit the format's JSON Schemas from the Zod definitions
 * into the sibling bendyline/gezk checkout's `schemas/` directory.
 *
 * The Zod schemas are the source of truth; the JSON Schemas are what other
 * implementations validate against. `z.toJSONSchema` drops refinements
 * (the Windows-device-name rule on versions, NFC on document ids), so the
 * published schemas are deliberately looser than this implementation's
 * parse — a conforming reader may be stricter, never looser.
 *
 * Usage: pnpm --filter @bendyline/gezk export-schemas
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import {
  CatalogDocumentSchema,
  GEZK_FORMAT_VERSION,
  KnowledgeCatalogManifestSchema,
  KnowledgeChunkingProfileSchema,
  KnowledgeEmbeddingProfileSchema,
  KnowledgeRegistryIndexSchema,
  SourceNoticesSchema,
} from '../src/index.js';
import { requireGezkCheckout } from './gezk-checkout.js';

const SCHEMA_ID_BASE = 'https://bendyline.github.io/gezk/schemas';

export const GEZK_SCHEMA_EXPORTS: ReadonlyArray<[filename: string, schema: z.ZodType]> = [
  ['catalog-manifest.schema.json', KnowledgeCatalogManifestSchema],
  ['registry-index.schema.json', KnowledgeRegistryIndexSchema],
  ['source-notices.schema.json', SourceNoticesSchema],
  ['embedding-profile.schema.json', KnowledgeEmbeddingProfileSchema],
  ['chunking-profile.schema.json', KnowledgeChunkingProfileSchema],
  ['catalog-document.schema.json', CatalogDocumentSchema],
];

export function renderSchema(filename: string, schema: z.ZodType): string {
  const json = z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input' }) as Record<
    string,
    unknown
  >;
  const withId = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `${SCHEMA_ID_BASE}/${filename}`,
    ...json,
  };
  withId.$schema = 'https://json-schema.org/draft/2020-12/schema';
  return `${JSON.stringify(withId, null, 2)}\n`;
}

const README = `# gezk ${GEZK_FORMAT_VERSION} JSON Schemas

Generated from the \`@bendyline/gezk\` Zod definitions by
\`pnpm --filter @bendyline/gezk export-schemas\` in the gezel repository —
do not edit by hand. Refinements that JSON Schema cannot express (the
Windows reserved-name rule on versions, NFC normalization of document ids)
are enforced by conforming readers on top of these schemas.

| File | Validates |
| --- | --- |
| \`catalog-manifest.schema.json\` | \`manifest.json\` inside a \`.gezk\` |
| \`registry-index.schema.json\` | A publisher's registry \`index.json\` |
| \`source-notices.schema.json\` | \`LICENSES/source-notices.json\` |
| \`embedding-profile.schema.json\` | The \`embedding\` block of a manifest |
| \`chunking-profile.schema.json\` | The \`chunking\` block of a manifest |
| \`catalog-document.schema.json\` | One normalized document fed to a compiler |
`;

function main(): void {
  const root = requireGezkCheckout();
  const outDir = join(root, 'schemas');
  mkdirSync(outDir, { recursive: true });
  for (const [filename, schema] of GEZK_SCHEMA_EXPORTS) {
    writeFileSync(join(outDir, filename), renderSchema(filename, schema));
    console.log(`[schemas] wrote ${filename}`);
  }
  writeFileSync(join(outDir, 'README.md'), README);
  console.log(`[schemas] ${GEZK_SCHEMA_EXPORTS.length} schemas written to ${outDir}`);
}

main();
