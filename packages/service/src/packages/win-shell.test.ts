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

  it('quotes BOTH the command and every argument when a shell is used', () => {
    // Quoting args but not the command was the actual bug: several call
    // sites did exactly that and still broke on spaced install paths.
    const out = winShellSafe('C:\\Program Files\\nodejs\\pnpm.cmd', ['install', '--prod'], true);
    expect(out).toEqual({
      command: '"C:\\Program Files\\nodejs\\pnpm.cmd"',
      args: ['"install"', '"--prod"'],
    });
  });

  it('produces a command line cmd.exe parses as one token', () => {
    const out = winShellSafe('C:\\Program Files\\nodejs\\claude.cmd', ['--version'], true);
    // This is what Node concatenates and hands to `cmd /d /s /c`.
    expect(`${out.command} ${out.args.join(' ')}`).toBe(
      '"C:\\Program Files\\nodejs\\claude.cmd" "--version"',
    );
  });

  it('does not alias the caller\u2019s array', () => {
    const args = ['a'];
    const out = winShellSafe('x', args, false);
    out.args.push('b');
    expect(args).toEqual(['a']);
  });
});
