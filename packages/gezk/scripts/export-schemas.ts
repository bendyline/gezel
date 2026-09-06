/**
 * export-schemas — emit the format's JSON Schemas from the Zod definitions
 * into the sibling bendyline/gezk checkout, under `schemas/<version>/`.
 *
 * The Zod schemas are the source of truth; the JSON Schemas are what other
 * implementations validate against. `z.toJSONSchema` drops refinements
 * (the Windows-device-name rule on versions, NFC on document ids), so the
 * published schemas are deliberately looser than this implementation's
 * parse — a conforming reader may be stricter, never looser.
 *
 * One directory per format version: the schemas a catalog line was
 * published against stay exactly as they were once that line stops being
 * written, so a reader validating an older manifest picks the directory its
 * `formatVersion` names. The top-level `schemas/README.md` is regenerated
 * from the directories present.
 *
 * Usage: pnpm --filter @bendyline/gezk export-schemas
 */

import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
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
import { requireGezkCheckout, resolveSiteCheckout } from './gezk-checkout.js';

/**
 * A schema's `$id` is a public contract the moment it is served: catalogs
 * published under a line point at it forever, and 0.x may change the format
 * incompatibly (spec §1). So the path carries the format version, and the
 * site mirror is derived from the same constant — a schema always lands at
 * exactly the address it claims.
 */
const SCHEMA_ID_PATH = `gezk/${GEZK_FORMAT_VERSION}/schemas`;
const SCHEMA_ID_BASE = `https://bendyline.com/${SCHEMA_ID_PATH}`;
const VERSION_DIRECTORY = /^\d+\.\d+$/;

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

Each file's \`$id\` is its address on bendyline.com, which serves the same
bytes:

<${SCHEMA_ID_BASE}/>

The path carries the format version, so a later line never overwrites the
schemas that catalogs published under ${GEZK_FORMAT_VERSION} point at.

| File | Validates |
| --- | --- |
| \`catalog-manifest.schema.json\` | \`manifest.json\` inside a \`.gezk\` |
| \`registry-index.schema.json\` | A publisher's registry \`index.json\` |
| \`source-notices.schema.json\` | \`LICENSES/source-notices.json\` |
| \`embedding-profile.schema.json\` | The \`embedding\` block of a manifest |
| \`chunking-profile.schema.json\` | The \`chunking\` block of a manifest |
| \`catalog-document.schema.json\` | One normalized document fed to a compiler |
`;

function compareVersions(a: string, b: string): number {
  const [aMajor = 0, aMinor = 0] = a.split('.').map(Number);
  const [bMajor = 0, bMinor = 0] = b.split('.').map(Number);
  return aMajor - bMajor || aMinor - bMinor;
}

export function renderIndexReadme(versions: readonly string[]): string {
  const rows = [...versions]
    .sort(compareVersions)
    .map((v) => `| [\`${v}/\`](${v}/) | <https://bendyline.com/gezk/${v}/schemas/> |`)
    .join('\n');
  return `# gezk JSON Schemas

One directory per format version, each generated from the \`@bendyline/gezk\`
Zod definitions of that line by \`pnpm --filter @bendyline/gezk export-schemas\`
in the gezel repository — do not edit by hand. A catalog's \`manifest.json\`
names its \`formatVersion\`; validate it against that directory. Every file's
\`$id\` is its address on bendyline.com, which serves the same bytes, and the
path carries the version, so a later line never overwrites the schemas that
catalogs published under an earlier one point at.

| Version | Served at |
| --- | --- |
${rows}

The current line is \`${GEZK_FORMAT_VERSION}\`. An earlier directory is frozen once its line
stops being written; the specification for each lives in \`spec/\`.
`;
}

function main(): void {
  const rendered = GEZK_SCHEMA_EXPORTS.map(
    ([filename, schema]) => [filename, renderSchema(filename, schema)] as const,
  );

  const schemasRoot = join(requireGezkCheckout(), 'schemas');
  const outDir = join(schemasRoot, GEZK_FORMAT_VERSION);
  mkdirSync(outDir, { recursive: true });
  for (const [filename, body] of rendered) {
    writeFileSync(join(outDir, filename), body);
    console.log(`[schemas] wrote ${GEZK_FORMAT_VERSION}/${filename}`);
  }
  writeFileSync(join(outDir, 'README.md'), README);
  console.log(`[schemas] ${rendered.length} schemas written to ${outDir}`);

  const versions = readdirSync(schemasRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && VERSION_DIRECTORY.test(entry.name))
    .map((entry) => entry.name);
  writeFileSync(join(schemasRoot, 'README.md'), renderIndexReadme(versions));
  console.log(`[schemas] index lists ${versions.sort(compareVersions).join(', ')}`);

  // The $id of every schema is a bendyline.com URL, so the site checkout holds
  // the copy those URLs actually resolve to. Mirroring here keeps a published
  // schema from drifting behind the Zod definition it was generated from.
  const site = resolveSiteCheckout();
  if (!site) {
    console.log('[schemas] no bendyline.github.io checkout found; $id URLs not refreshed');
    return;
  }
  const siteDir = join(site, ...SCHEMA_ID_PATH.split('/'));
  mkdirSync(siteDir, { recursive: true });
  for (const [filename, body] of rendered) writeFileSync(join(siteDir, filename), body);
  console.log(`[schemas] mirrored ${rendered.length} schemas to ${siteDir}`);
}

main();
