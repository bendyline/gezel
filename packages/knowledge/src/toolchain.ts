import { createRequire } from 'node:module';
import type { KnowledgeCatalogManifest } from '@bendyline/gezk';

const nodeRequire = createRequire(import.meta.url);

/**
 * Provenance stamped into every manifest this package compiles. Only the
 * package identity: node/platform details would make two builds of the same
 * inputs differ by machine, and the format promises byte-identical archives
 * for identical inputs and toolchain.
 */
export const KNOWLEDGE_TOOLCHAIN: NonNullable<KnowledgeCatalogManifest['toolchain']> = {
  name: '@bendyline/gezel-knowledge',
  version: (nodeRequire('../package.json') as { version: string }).version,
};
