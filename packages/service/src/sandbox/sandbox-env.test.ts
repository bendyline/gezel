import { describe, expect, it } from 'vitest';
import { sandboxEnv } from './runner.js';

describe('sandboxEnv allowlist', () => {
  it('strips known secret keys', () => {
    const out = sandboxEnv({
      PATH: '/usr/bin',
      GEZEL_TOKEN: 'should-not-leak',
      OPENAI_API_KEY: 'sk-nope',
      GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp-nope',
      DATABASE_URL: 'postgres://...',
      HOME: '/home/dev',
    });
    expect(out).not.toHaveProperty('GEZEL_TOKEN');
    expect(out).not.toHaveProperty('OPENAI_API_KEY');
    expect(out).not.toHaveProperty('GITHUB_PERSONAL_ACCESS_TOKEN');
    expect(out).not.toHaveProperty('DATABASE_URL');
  });

  it('keeps essentials needed for Node to function', () => {
    const out = sandboxEnv({
      PATH: '/usr/bin',
      HOME: '/home/dev',
      NODE_OPTIONS: '--max-old-space-size=512',
      LANG: 'en_US.UTF-8',
      LC_CTYPE: 'UTF-8',
      USERPROFILE: 'C:/Users/dev',
    });
    expect(out.PATH).toBe('/usr/bin');
    expect(out.HOME).toBe('/home/dev');
    expect(out.NODE_OPTIONS).toBe('--max-old-space-size=512');
    expect(out.LANG).toBe('en_US.UTF-8');
    expect(out.LC_CTYPE).toBe('UTF-8');
    expect(out.USERPROFILE).toBe('C:/Users/dev');
  });

  it('drops arbitrary user env vars', () => {
    const out = sandboxEnv({
      PATH: '/usr/bin',
      SECRET_KEY: 'yep',
      FOO: 'bar',
      MY_APP_CONFIG: '{...}',
    });
    expect(out).not.toHaveProperty('SECRET_KEY');
    expect(out).not.toHaveProperty('FOO');
    expect(out).not.toHaveProperty('MY_APP_CONFIG');
  });

  it('matches the allowlist case-insensitively (Windows keys are mixed-case)', () => {
    // Windows hands env vars over in whatever case the parent set them —
    // commonly `Path`, `SystemRoot`, `windir` — not the uppercase the
    // allowlist is written in. They must still be kept (and keep their
    // original case) or the sandboxed shell loses PATH and can't find
    // node/npm/git.
    const out = sandboxEnv({
      Path: 'C:/Windows/System32',
      SystemRoot: 'C:/Windows',
      windir: 'C:/Windows',
      ProgramData: 'C:/ProgramData',
    });
    expect(out.Path).toBe('C:/Windows/System32');
    expect(out.SystemRoot).toBe('C:/Windows');
    expect(out.windir).toBe('C:/Windows');
    // Still not in the allowlist → dropped regardless of case.
    expect(out).not.toHaveProperty('ProgramData');
  });

  it('skips null/undefined values', () => {
    const out = sandboxEnv({
      PATH: undefined,
      HOME: null as unknown as string,
      NODE_OPTIONS: '--foo',
    });
    expect(out).not.toHaveProperty('PATH');
    expect(out).not.toHaveProperty('HOME');
    expect(out.NODE_OPTIONS).toBe('--foo');
  });
});
