import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveKnowledgeInstallSource } from './knowledge-install.js';

describe('resolveKnowledgeInstallSource', () => {
  it('resolves local catalog paths', () => {
    expect(resolveKnowledgeInstallSource('catalog.gezk')).toEqual({
      kind: 'file',
      path: resolve('catalog.gezk'),
    });
  });

  it('requires and normalizes an out-of-band digest for URL installs', () => {
    expect(
      resolveKnowledgeInstallSource('https://example.test/catalog.gezk', 'A'.repeat(64)),
    ).toEqual({
      kind: 'url',
      url: 'https://example.test/catalog.gezk',
      expectedSha256: 'a'.repeat(64),
    });
  });

  it('allows an unpinned URL install', () => {
    expect(resolveKnowledgeInstallSource('https://example.test/catalog.gezk')).toEqual({
      kind: 'url',
      url: 'https://example.test/catalog.gezk',
    });
  });

  it('rejects a malformed digest', () => {
    expect(() =>
      resolveKnowledgeInstallSource('https://example.test/catalog.gezk', 'not-a-digest'),
    ).toThrow('--sha256 must be exactly 64 hexadecimal characters.');
  });

  it('does not silently ignore a digest for a local file', () => {
    expect(() => resolveKnowledgeInstallSource('catalog.gezk', 'a'.repeat(64))).toThrow(
      '--sha256 is only valid for URL installs.',
    );
  });
});

describe('resolveKnowledgeInstallSource — catalog ids', () => {
  it('treats a bare id that is not a file as a gilde catalog entry', () => {
    expect(resolveKnowledgeInstallSource('wikipedia-physics')).toEqual({
      kind: 'catalog',
      id: 'wikipedia-physics',
    });
    expect(
      resolveKnowledgeInstallSource('wikipedia-physics', undefined, {
        version: '2026.9.1',
        privatePlacement: true,
      }),
    ).toEqual({
      kind: 'catalog',
      id: 'wikipedia-physics',
      version: '2026.9.1',
      placement: 'user',
    });
  });

  it('prefers a real file over a catalog id and keeps paths as files', () => {
    expect(resolveKnowledgeInstallSource('package.json')).toEqual({
      kind: 'file',
      path: resolve('package.json'),
    });
    expect(resolveKnowledgeInstallSource('./wikipedia-physics')).toEqual({
      kind: 'file',
      path: resolve('./wikipedia-physics'),
    });
  });

  it('refuses catalog-only options on file and URL installs', () => {
    expect(() =>
      resolveKnowledgeInstallSource('catalog.gezk', undefined, { version: '1.0.0' }),
    ).toThrow('--version is only valid for catalog ids');
    expect(() =>
      resolveKnowledgeInstallSource('https://example.test/catalog.gezk', undefined, {
        privatePlacement: true,
      }),
    ).toThrow('--private is only valid for catalog ids');
  });
});
