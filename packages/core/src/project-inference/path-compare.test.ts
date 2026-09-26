import { describe, expect, it } from 'vitest';
import {
  ancestors,
  basenameOf,
  isAbsolutePath,
  isSameOrInside,
  isStrictlyInside,
  normalizePath,
  parentOf,
  parseRoot,
  pathsEqual,
  segmentsBelow,
  toInferencePlatform,
} from './path-compare.js';

describe('normalizePath', () => {
  it.each([
    ['linux', '/home/u/docs/', '/home/u/docs'],
    ['linux', '/home//u/./docs/../x', '/home/u/x'],
    ['linux', '/', '/'],
    ['darwin', '/Users/U/Docs///', '/Users/U/Docs'],
    ['win32', 'c:/Users/me/Docs/', 'C:\\Users\\me\\Docs'],
    ['win32', 'C:\\', 'C:\\'],
    ['win32', '\\\\?\\C:\\x\\y', 'C:\\x\\y'],
    ['win32', '\\\\?\\UNC\\srv\\share\\team', '\\\\srv\\share\\team'],
    ['win32', '\\\\srv\\share', '\\\\srv\\share\\'],
    ['win32', '\\\\srv', '\\\\srv'],
    ['win32', '\\\\srv\\', '\\\\srv'],
  ] as const)('%s %s → %s', (platform, input, expected) => {
    expect(normalizePath(input, platform)).toBe(expected);
  });
});

describe('comparison', () => {
  it('treats /home/foobar as outside /home/foo', () => {
    expect(isSameOrInside('/home/foobar', '/home/foo', 'linux')).toBe(false);
    expect(isSameOrInside('/home/foo/bar', '/home/foo', 'linux')).toBe(true);
  });

  it('is case-insensitive on win32 and darwin, exact on linux', () => {
    expect(pathsEqual('C:\\Users\\ME', 'c:/users/me', 'win32')).toBe(true);
    expect(pathsEqual('/Users/Me/Docs', '/users/me/docs', 'darwin')).toBe(true);
    expect(pathsEqual('/home/Me', '/home/me', 'linux')).toBe(false);
  });

  it('handles roots as parents', () => {
    expect(isStrictlyInside('C:\\x', 'C:\\', 'win32')).toBe(true);
    expect(isStrictlyInside('/x', '/', 'linux')).toBe(true);
    expect(isStrictlyInside('/', '/', 'linux')).toBe(false);
  });
});

describe('parentOf / ancestors', () => {
  it('stops at roots', () => {
    expect(parentOf('/', 'linux')).toBeNull();
    expect(parentOf('C:\\', 'win32')).toBeNull();
    expect(parentOf('\\\\srv\\share\\', 'win32')).toBeNull();
    expect(parentOf('\\\\srv', 'win32')).toBeNull();
    expect(parentOf('\\\\srv\\share\\team', 'win32')).toBe('\\\\srv\\share\\');
  });

  it('lists every ancestor', () => {
    expect(ancestors('/a/b/c', 'linux')).toEqual(['/a/b/c', '/a/b', '/a', '/']);
    expect(ancestors('C:\\a\\b', 'win32')).toEqual(['C:\\a\\b', 'C:\\a', 'C:\\']);
  });
});

describe('segmentsBelow', () => {
  it('returns relative segments, [] for equal, null outside', () => {
    expect(segmentsBelow('/home/u', '/home/u/a/b', 'linux')).toEqual(['a', 'b']);
    expect(segmentsBelow('/home/u', '/home/u', 'linux')).toEqual([]);
    expect(segmentsBelow('/home/u', '/home/v', 'linux')).toBeNull();
    expect(segmentsBelow('C:\\', 'C:\\Users\\me', 'win32')).toEqual(['Users', 'me']);
    expect(segmentsBelow('/Users/Me', '/users/me/Docs', 'darwin')).toEqual(['Docs']);
  });
});

describe('parseRoot', () => {
  it('distinguishes drives, UNC shares, and bare servers', () => {
    expect(parseRoot('D:\\work\\x', 'win32')).toEqual({ kind: 'drive', root: 'D:\\' });
    expect(parseRoot('\\\\srv\\share\\team', 'win32')).toEqual({
      kind: 'unc',
      root: '\\\\srv\\share\\',
      server: 'srv',
      share: 'share',
    });
    expect(parseRoot('\\\\srv', 'win32')).toEqual({ kind: 'unc', root: '\\\\srv', server: 'srv' });
    expect(parseRoot('/x', 'darwin')).toEqual({ kind: 'posix', root: '/' });
  });
});

describe('misc', () => {
  it('maps host platforms onto the three inference platforms', () => {
    expect(toInferencePlatform('win32')).toBe('win32');
    expect(toInferencePlatform('darwin')).toBe('darwin');
    expect(toInferencePlatform('freebsd')).toBe('linux');
  });

  it('recognizes absolute paths per platform', () => {
    expect(isAbsolutePath('C:\\x', 'win32')).toBe(true);
    expect(isAbsolutePath('\\\\srv\\share', 'win32')).toBe(true);
    expect(isAbsolutePath('x\\y', 'win32')).toBe(false);
    expect(isAbsolutePath('/x', 'linux')).toBe(true);
    expect(isAbsolutePath('x', 'linux')).toBe(false);
  });

  it('returns the last segment, or the root itself', () => {
    expect(basenameOf('/a/b/', 'linux')).toBe('b');
    expect(basenameOf('/', 'linux')).toBe('/');
    expect(basenameOf('C:\\', 'win32')).toBe('C:\\');
  });
});
