import { describe, expect, it } from 'vitest';
import { isPermissive, normalizeSpdx, parseGitHubOwnerRepo } from './license-resolver.js';

describe('parseGitHubOwnerRepo', () => {
  it('extracts owner/repo from a typical https URL', () => {
    expect(parseGitHubOwnerRepo('https://github.com/acme/widget')).toEqual({
      owner: 'acme',
      repo: 'widget',
    });
  });

  it('strips a trailing .git', () => {
    expect(parseGitHubOwnerRepo('https://github.com/acme/widget.git')).toEqual({
      owner: 'acme',
      repo: 'widget',
    });
  });

  it('handles ssh-style urls', () => {
    expect(parseGitHubOwnerRepo('git@github.com:acme/widget.git')).toEqual({
      owner: 'acme',
      repo: 'widget',
    });
  });

  it('returns null for non-github urls', () => {
    expect(parseGitHubOwnerRepo('https://gitlab.com/acme/widget')).toBeNull();
    expect(parseGitHubOwnerRepo(undefined)).toBeNull();
  });
});

describe('normalizeSpdx', () => {
  it('returns the canonical id for common shapes', () => {
    expect(normalizeSpdx('MIT')).toBe('MIT');
    expect(normalizeSpdx('mit')).toBe('MIT');
    expect(normalizeSpdx('Apache-2.0')).toBe('Apache-2.0');
    expect(normalizeSpdx('apache-2.0')).toBe('Apache-2.0');
  });

  it('extracts the first id from compound expressions', () => {
    expect(normalizeSpdx('(MIT OR Apache-2.0)')).toBe('MIT');
  });

  it('returns null on garbage', () => {
    expect(normalizeSpdx('')).toBeNull();
    expect(normalizeSpdx('   ')).toBeNull();
  });
});

describe('isPermissive', () => {
  it('accepts the expected SPDX ids', () => {
    for (const id of [
      'MIT',
      'Apache-2.0',
      'BSD-2-Clause',
      'BSD-3-Clause',
      'ISC',
      '0BSD',
      'MPL-2.0',
    ]) {
      expect(isPermissive(id)).toBe(true);
    }
  });

  it('rejects copyleft and unknown', () => {
    for (const id of ['GPL-3.0', 'AGPL-3.0', 'SSPL-1.0', 'BUSL-1.1', 'NOASSERTION', '']) {
      expect(isPermissive(id)).toBe(false);
    }
  });
});
