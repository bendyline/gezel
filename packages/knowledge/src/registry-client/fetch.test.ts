import type { KnowledgeRegistryIndex } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { generateKnowledgeSigningKeyPair, signRegistryIndex } from '../signatures/signing.js';
import {
  KnowledgeRegistryFetchError,
  compareCatalogVersions,
  fetchKnowledgeRegistry,
  findRegistryEntry,
  newerRegistryEntries,
} from './fetch.js';

const registryFixture = (): KnowledgeRegistryIndex => ({
  kind: 'gezel-knowledge-registry',
  formatVersion: 1,
  publisher: { id: 'qualla', name: 'Qualla' },
  generatedAt: '2026-08-25T00:00:00.000Z',
  catalogs: [
    {
      catalogId: 'wikipedia-people',
      version: '2026.08.1',
      name: 'Wikipedia: People',
      language: 'en',
      documents: 177,
      archiveBytes: 5_233_521,
      contentDigest: 'a'.repeat(64),
      url: 'https://qualla.com/_knowledge/catalogs/wikipedia-people/2026.08.1/wikipedia-people-2026.08.1.gezk',
      license: { name: 'CC BY-SA 4.0', attributionRequired: true },
    },
    {
      catalogId: 'wikipedia-people',
      version: '2026.09.0',
      name: 'Wikipedia: People',
      language: 'en',
      documents: 180,
      archiveBytes: 5_400_000,
      contentDigest: 'b'.repeat(64),
      url: 'https://qualla.com/_knowledge/catalogs/wikipedia-people/2026.09.0/wikipedia-people-2026.09.0.gezk',
      license: { name: 'CC BY-SA 4.0', attributionRequired: true },
    },
  ],
});

const jsonResponse = (body: unknown, init?: ResponseInit): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });

describe('fetchKnowledgeRegistry', () => {
  it('returns a schema-parsed, signature-verified registry', async () => {
    const keys = generateKnowledgeSigningKeyPair();
    const signed = signRegistryIndex(registryFixture(), keys.privateKeyPem);
    const { registry, keyId } = await fetchKnowledgeRegistry('https://example.com/index.json', {
      anchors: [{ keyId: keys.keyId, publicKeyPem: keys.publicKeyPem }],
      fetchImpl: async () => jsonResponse(signed),
    });
    expect(keyId).toBe(keys.keyId);
    expect(registry.publisher.id).toBe('qualla');
    expect(registry.catalogs).toHaveLength(2);
  });

  it('never returns an unverified document: unknown key, tamper, unsigned', async () => {
    const keys = generateKnowledgeSigningKeyPair();
    const stranger = generateKnowledgeSigningKeyPair();
    const signed = signRegistryIndex(registryFixture(), keys.privateKeyPem);

    await expect(
      fetchKnowledgeRegistry('https://example.com/index.json', {
        anchors: [{ keyId: stranger.keyId, publicKeyPem: stranger.publicKeyPem }],
        fetchImpl: async () => jsonResponse(signed),
      }),
    ).rejects.toMatchObject({ code: 'unsigned-or-untrusted' });

    const tampered = {
      ...signed,
      catalogs: [{ ...signed.catalogs[0]!, contentDigest: 'f'.repeat(64) }, signed.catalogs[1]!],
    };
    await expect(
      fetchKnowledgeRegistry('https://example.com/index.json', {
        anchors: [{ keyId: keys.keyId, publicKeyPem: keys.publicKeyPem }],
        fetchImpl: async () => jsonResponse(tampered),
      }),
    ).rejects.toMatchObject({ code: 'unsigned-or-untrusted' });

    await expect(
      fetchKnowledgeRegistry('https://example.com/index.json', {
        anchors: [{ keyId: keys.keyId, publicKeyPem: keys.publicKeyPem }],
        fetchImpl: async () => jsonResponse(registryFixture()),
      }),
    ).rejects.toMatchObject({ code: 'unsigned-or-untrusted' });
  });

  it('rejects HTTP failures, oversize bodies, and non-registry documents', async () => {
    const anchors = [
      {
        keyId: generateKnowledgeSigningKeyPair().keyId,
        publicKeyPem: generateKnowledgeSigningKeyPair().publicKeyPem,
      },
    ];
    await expect(
      fetchKnowledgeRegistry('https://example.com/index.json', {
        anchors,
        fetchImpl: async () => new Response('nope', { status: 404 }),
      }),
    ).rejects.toMatchObject({ code: 'http' });

    await expect(
      fetchKnowledgeRegistry('https://example.com/index.json', {
        anchors,
        maxBytes: 16,
        fetchImpl: async () => jsonResponse(registryFixture()),
      }),
    ).rejects.toMatchObject({ code: 'too-large' });

    await expect(
      fetchKnowledgeRegistry('https://example.com/index.json', {
        anchors,
        fetchImpl: async () => jsonResponse({ kind: 'something-else' }),
      }),
    ).rejects.toMatchObject({ code: 'invalid' });

    await expect(
      fetchKnowledgeRegistry('https://example.com/index.json', {
        anchors,
        fetchImpl: async () => {
          throw new Error('ECONNREFUSED');
        },
      }),
    ).rejects.toBeInstanceOf(KnowledgeRegistryFetchError);
  });
});

describe('findRegistryEntry', () => {
  it('matches only on exact publisher, catalog, version, and digest', () => {
    const registry = registryFixture();
    const base = {
      publisherId: 'qualla',
      catalogId: 'wikipedia-people',
      version: '2026.08.1',
    };
    expect(findRegistryEntry(registry, base)?.contentDigest).toBe('a'.repeat(64));
    expect(findRegistryEntry(registry, { ...base, contentDigest: 'a'.repeat(64) })).not.toBeNull();
    expect(findRegistryEntry(registry, { ...base, contentDigest: 'c'.repeat(64) })).toBeNull();
    expect(findRegistryEntry(registry, { ...base, publisherId: 'stranger' })).toBeNull();
    expect(findRegistryEntry(registry, { ...base, version: '9999.01.0' })).toBeNull();
  });
});

describe('version ordering', () => {
  it('compares CalVer dotted numerics numerically', () => {
    expect(compareCatalogVersions('2026.08.1', '2026.08.2')).toBeLessThan(0);
    expect(compareCatalogVersions('2026.09.0', '2026.08.9')).toBeGreaterThan(0);
    expect(compareCatalogVersions('2026.10.0', '2026.9.0')).toBeGreaterThan(0);
    expect(compareCatalogVersions('2026.08.1', '2026.08.1')).toBe(0);
    expect(compareCatalogVersions('2026.08.1', '2026.08.1.1')).toBeLessThan(0);
  });

  it('newerRegistryEntries reports strictly newer rows, newest first', () => {
    const registry = registryFixture();
    const newer = newerRegistryEntries(registry, {
      catalogId: 'wikipedia-people',
      version: '2026.08.1',
    });
    expect(newer.map((e) => e.version)).toEqual(['2026.09.0']);
    expect(
      newerRegistryEntries(registry, { catalogId: 'wikipedia-people', version: '2026.09.0' }),
    ).toHaveLength(0);
    expect(newerRegistryEntries(registry, { catalogId: 'absent', version: '1.0.0' })).toHaveLength(
      0,
    );
  });
});
