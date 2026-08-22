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
