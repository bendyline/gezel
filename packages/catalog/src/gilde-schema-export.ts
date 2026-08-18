/**
 * The gilde `schemas/` payload, defined once and consumed twice: the
 * `export-gilde-schemas` script writes it into a gilde checkout, and
 * `gilde-schema-freshness.test.ts` diffs it against the gilde this build
 * actually resolves.
 *
 * The two consumers resolve gilde differently on purpose. The script
 * writes to the sibling checkout (`GILDE_DIR`) because that is what you
 * PR; the test reads the RESOLVED package (`gildePackageRoot()`) because
 * that is what gezel ships against. With `pnpm link:gilde` they are the
 * same tree; without it, the test is checking the pinned tarball.
 *
 * Why the test exists: gilde's `build-index` normalizes every manifest
 * through these committed JSON Schemas, and a property the schema does
 * not declare is dropped from the published `index.json` — which is the
 * fast path `BundledSource` reads at runtime. So a core schema field
 * added without re-exporting does not fail anywhere; it is silently
 * erased from shipped content. Three craftbooks were shipping that way
 * (`pull-request-review` lost `corpusCoverage.artifact`,
 * `powerpoint-deck` lost `markdownHeadingsMatch.outlineArtifact`,
 * `invoice-run` lost `spawn.overArtifact`) before anyone noticed.
 */

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

export const GILDE_SCHEMA_EXPORTS: Array<[filename: string, schema: z.ZodType]> = [
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
export const CATALOG_INDEX_SCHEMA = {
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

export const GILDE_SCHEMAS_README = `# schemas/

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

/**
 * `unrepresentable` stays at its default ('throw') so a future transform
 * in a published schema fails loudly here instead of silently weakening
 * gilde validation.
 */
function renderSchema(filename: string, schema: z.ZodType): string {
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
  return `${JSON.stringify(withId, null, 2)}\n`;
}

/**
 * Every file the gilde `schemas/` directory should contain, as exact
 * file contents. Byte-for-byte what the exporter writes, so a test can
 * compare against the committed copies without reimplementing anything.
 */
export function renderGildeSchemaFiles(): Array<[filename: string, content: string]> {
  return [
    ...GILDE_SCHEMA_EXPORTS.map(
      ([filename, schema]) => [filename, renderSchema(filename, schema)] as [string, string],
    ),
    ['catalog-index.schema.json', `${JSON.stringify(CATALOG_INDEX_SCHEMA, null, 2)}\n`],
    ['README.md', GILDE_SCHEMAS_README],
  ];
}
