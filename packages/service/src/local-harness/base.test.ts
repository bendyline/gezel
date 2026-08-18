import { describe, expect, it } from 'vitest';
import { findHarnessModel, posixShellWord, powershellLiteral } from './base.js';

describe('findHarnessModel', () => {
  it('accepts a legacy persisted-id ref for a newly advertised role-name model', () => {
    const advertised = {
      id: 'gezel:developer-maya',
      label: 'Maya',
      kind: 'gezel' as const,
      provider: 'llama-cpp' as const,
      gezelId: 'maya-stable-id',
      supportsTools: true,
    };

    expect(findHarnessModel([advertised], 'gezel:maya-stable-id')).toBe(advertised);
  });

  it('uses stable gezel metadata when a renamed gezel gets a new advertised id', () => {
    const renamed = {
      id: 'gezel:lead-developer-maya-jones',
      label: 'Maya Jones',
      kind: 'gezel' as const,
      provider: 'llama-cpp' as const,
      gezelId: 'maya-stable-id',
      supportsTools: true,
    };

    expect(findHarnessModel([renamed], 'gezel:developer-maya', 'maya-stable-id')).toBe(renamed);
  });
});

/**
 * Every harness launch command is assembled from these two helpers, and each
 * one is reached only on its own platform in production. Pin the escaping rules
 * here — platform-free — so the branch a developer never runs still has
 * coverage, and so the manager suites can assert whole launch strings against
 * quoting that is defined rather than assumed.
 */
describe('posixShellWord', () => {
  it('leaves a word that needs no quoting alone', () => {
    for (const value of ['pi', 'codex', 'gezel-local', '/usr/local/bin/opencode', 'C:']) {
      expect(posixShellWord(value)).toBe(value);
    }
  });

  it.each([
    ['a space', '/Users/Mike Smith/.pi/agent', `'/Users/Mike Smith/.pi/agent'`],
    // The Windows case: a native path is never a bare POSIX word, so a
    // cross-platform launch string quotes it even on macOS and Linux.
    ['a backslash', 'C:\\Users\\mike\\gezel.js', `'C:\\Users\\mike\\gezel.js'`],
    ['a dollar sign', '/tmp/$HOME/x', `'/tmp/$HOME/x'`],
    ['a semicolon', '/tmp/a;rm -rf b', `'/tmp/a;rm -rf b'`],
    ['nothing at all', '', `''`],
  ])('quotes a word containing %s', (_label, value, expected) => {
    expect(posixShellWord(value)).toBe(expected);
  });

  it('closes and reopens the quote around an embedded single quote', () => {
    // `'` cannot appear inside a single-quoted POSIX word, so the only correct
    // encoding leaves the quoted run and escapes it standalone.
    expect(posixShellWord("/Users/o'brien/.pi")).toBe(`'/Users/o'"'"'brien/.pi'`);
  });
});

describe('powershellLiteral', () => {
  it('always quotes, so nothing is ever left for PowerShell to expand', () => {
    expect(powershellLiteral('codex')).toBe(`'codex'`);
    expect(powershellLiteral('C:\\Users\\Mike Smith\\gezel.js')).toBe(
      `'C:\\Users\\Mike Smith\\gezel.js'`,
    );
    // A single-quoted PowerShell literal expands neither $vars nor backticks.
    expect(powershellLiteral('$env:PATH`n')).toBe("'$env:PATH`n'");
  });

  it('doubles an embedded single quote', () => {
    expect(powershellLiteral("C:\\Users\\o'brien\\gezel.js")).toBe(
      `'C:\\Users\\o''brien\\gezel.js'`,
    );
  });
});
