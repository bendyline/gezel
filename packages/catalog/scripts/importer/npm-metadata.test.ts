import { describe, expect, it } from 'vitest';
import { extractLicense, pickEntry } from './npm-metadata.js';

describe('pickEntry', () => {
  it('prefers a string `bin`', () => {
    expect(pickEntry({ name: 'x', version: '1', bin: './bin/cli.js', main: 'index.js' })).toBe(
      'bin/cli.js',
    );
  });

  it('uses the alphabetically-first key of an object `bin` for stability', () => {
    expect(
      pickEntry({
        name: 'x',
        version: '1',
        bin: { 'z-alias': 'bin/z.js', 'a-cli': 'bin/a.js' },
      }),
    ).toBe('bin/a.js');
  });

  it('falls back to main, then module', () => {
    expect(pickEntry({ name: 'x', version: '1', main: 'dist/index.js' })).toBe('dist/index.js');
    expect(pickEntry({ name: 'x', version: '1', module: 'dist/esm/index.js' })).toBe(
      'dist/esm/index.js',
    );
  });

  it('returns null when no entry is declared', () => {
    expect(pickEntry({ name: 'x', version: '1' })).toBeNull();
  });
});

describe('extractLicense', () => {
  it('handles string and {type} object shapes', () => {
    expect(extractLicense('MIT')).toBe('MIT');
    expect(extractLicense({ type: 'Apache-2.0' })).toBe('Apache-2.0');
  });

  it('returns null when missing', () => {
    expect(extractLicense(undefined)).toBeNull();
    expect(extractLicense({})).toBeNull();
  });
});
