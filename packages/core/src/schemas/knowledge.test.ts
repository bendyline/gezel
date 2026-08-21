import { describe, expect, it } from 'vitest';
import {
  KnowledgeCatalogRefSchema,
  KnowledgeInstallRequestSchema,
  KnowledgeVersionSchema,
  TrustedKnowledgeCoordinateSchema,
} from './knowledge.js';

describe('KnowledgeVersionSchema', () => {
  it.each(['1', '1.0.0', '2026.08-rc.1', 'v2_build+7'])(
    'accepts a portable version identity: %s',
    (version) => expect(KnowledgeVersionSchema.parse(version)).toBe(version),
  );

  it.each([
    '../outside',
    '..\\outside',
    'nested/version',
    'C:escape',
    '.',
    '..',
    '1.0.0.',
    '1.0.0 ',
    'CON',
    'nul.txt',
  ])('rejects a path-capable or non-portable version: %s', (version) => {
    expect(KnowledgeVersionSchema.safeParse(version).success).toBe(false);
    expect(
      KnowledgeCatalogRefSchema.safeParse({
        publisherId: 'publisher',
        catalogId: 'catalog',
        version,
        contentDigest: 'a'.repeat(64),
        storageScope: 'user',
      }).success,
    ).toBe(false);
    expect(
      TrustedKnowledgeCoordinateSchema.safeParse({
        publisherId: 'publisher',
        catalogId: 'catalog',
        version,
        expectedDigest: 'a'.repeat(64),
      }).success,
    ).toBe(false);
  });
});

describe('KnowledgeInstallRequestSchema', () => {
  it('requires an out-of-band SHA-256 identity for remote catalogs', () => {
    expect(
      KnowledgeInstallRequestSchema.safeParse({
        source: { kind: 'url', url: 'https://example.test/catalog.gezk' },
      }).success,
    ).toBe(false);
    expect(
      KnowledgeInstallRequestSchema.safeParse({
        source: {
          kind: 'url',
          url: 'https://example.test/catalog.gezk',
          expectedSha256: 'a'.repeat(64),
        },
      }).success,
    ).toBe(true);
  });
});
