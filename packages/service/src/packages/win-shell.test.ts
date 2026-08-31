import { describe, expect, it } from 'vitest';
import { UnquotableShellTokenError, quoteWinShellToken, winShellSafe } from './win-shell.js';

describe('quoteWinShellToken', () => {
  it('quotes a path containing a space', () => {
    // The exact regression: an unquoted `C:\Program Files\...` is split by
    // cmd.exe, which then reports `'C:\Program' is not recognized`.
    expect(quoteWinShellToken('C:\\Program Files\\nodejs\\claude.cmd')).toBe(
      '"C:\\Program Files\\nodejs\\claude.cmd"',
    );
  });

  it('quotes tokens with no special characters too', () => {
    // Unconditional quoting: a bare token is only safe until someone's
    // install path grows a space.
    expect(quoteWinShellToken('pnpm')).toBe('"pnpm"');
  });

  it('neutralises cmd metacharacters that would otherwise chain commands', () => {
    expect(quoteWinShellToken('foo & calc.exe')).toBe('"foo & calc.exe"');
    expect(quoteWinShellToken('a|b')).toBe('"a|b"');
    expect(quoteWinShellToken('a>b')).toBe('"a>b"');
    expect(quoteWinShellToken('a<b')).toBe('"a<b"');
    expect(quoteWinShellToken('a^b')).toBe('"a^b"');
    expect(quoteWinShellToken('(a)')).toBe('"(a)"');
    expect(quoteWinShellToken('a!b')).toBe('"a!b"');
  });

  it('keeps a semver caret intact', () => {
    expect(quoteWinShellToken('@playwright/mcp@^1.2.3')).toBe('"@playwright/mcp@^1.2.3"');
  });

  it('doubles embedded double quotes', () => {
    expect(quoteWinShellToken('say "hi"')).toBe('"say ""hi"""');
  });

  it('rejects % rather than mangling it — expansion fires inside quotes', () => {
    expect(() => quoteWinShellToken('%PATH%')).toThrow(UnquotableShellTokenError);
    expect(() => quoteWinShellToken('C:\\a%b\\pnpm.cmd')).toThrow(UnquotableShellTokenError);
  });

  it('rejects control characters', () => {
    expect(() => quoteWinShellToken('a\nb')).toThrow(UnquotableShellTokenError);
    expect(() => quoteWinShellToken('a\u0000b')).toThrow(UnquotableShellTokenError);
  });

  it('handles the empty string', () => {
    expect(quoteWinShellToken('')).toBe('""');
  });
});

describe('winShellSafe', () => {
  it('passes command and args through untouched when no shell is used', () => {
    // On the no-shell path Node hands argv straight to CreateProcess;
    // quoting there would become part of the literal value.
    const out = winShellSafe('C:\\Program Files\\gezel\\node.exe', ['a b', 'c'], false);
    expect(out).toEqual({
      command: 'C:\\Program Files\\gezel\\node.exe',
      args: ['a b', 'c'],
    });
  });

  it('folds the safely quoted command and arguments into one atomic shell command', () => {
    // A single command string + empty argv avoids both Node's unescaped
    // token concatenation and the corresponding DEP0190 warning.
    const out = winShellSafe('C:\\Program Files\\nodejs\\pnpm.cmd', ['install', '--prod'], true);
    expect(out).toEqual({
      command: '"C:\\Program Files\\nodejs\\pnpm.cmd" "install" "--prod"',
      args: [],
    });
  });

  it('produces a command line cmd.exe parses as one token', () => {
    const out = winShellSafe('C:\\Program Files\\nodejs\\claude.cmd', ['--version'], true);
    expect(out.command).toBe('"C:\\Program Files\\nodejs\\claude.cmd" "--version"');
    expect(out.args).toEqual([]);
  });

  it('keeps whitespace, quotes, Unicode, and shell metacharacters inside quoted tokens', () => {
    const out = winShellSafe(
      'C:\\Program Files\\tool.cmd',
      ['a b', '&', '|', '<', '>', '^', '(', ')', '!', 'Zażółć', 'say "hi"'],
      true,
    );
    expect(out).toEqual({
      command:
        '"C:\\Program Files\\tool.cmd" "a b" "&" "|" "<" ">" "^" "(" ")" "!" "Zażółć" "say ""hi"""',
      args: [],
    });
  });

  // Quoting a PATH-resolved command name makes cmd put the literal token in
  // `%0`, so the shim it resolves to sees `%~dp0` as the caller's cwd. That
  // sent corepack's pnpm.CMD looking for `<cwd>\node_modules\corepack\...`.
  it('leaves a bare PATH-resolved command name unquoted so %~dp0 survives', () => {
    const out = winShellSafe('pnpm', ['--dir', 'C:\\Program Files\\x', 'exec', 'node'], true);
    expect(out).toEqual({
      command: 'pnpm "--dir" "C:\\Program Files\\x" "exec" "node"',
      args: [],
    });
  });

  it('still quotes any command that is path-like, spaced, or metacharacter-bearing', () => {
    // Only a name cmd must resolve itself is exempt; everything else keeps
    // the quoting this module exists to guarantee.
    for (const command of [
      'C:\\Program Files\\nodejs\\pnpm.cmd',
      '.\\pnpm.cmd',
      'some tool',
      'foo&calc.exe',
      'dir/tool',
      '',
    ]) {
      expect(winShellSafe(command, [], true).command).toBe(quoteWinShellToken(command));
    }
  });

  it('keeps rejecting a command that cannot be quoted safely', () => {
    // The bare-name exception must not become a hole around validation.
    expect(() => winShellSafe('%PATH%', [], true)).toThrow(UnquotableShellTokenError);
  });

  it('does not alias the caller\u2019s array', () => {
    const args = ['a'];
    const out = winShellSafe('x', args, false);
    out.args.push('b');
    expect(args).toEqual(['a']);
  });
});
