import { describe, expect, it } from 'vitest';
import { browserScriptEnv, sandboxEnv } from './runner.js';

describe('browserScriptEnv allowlist', () => {
  it('drops daemon and provider credentials, including npm auth', () => {
    const out = browserScriptEnv({
      PATH: '/usr/bin',
      HOME: '/home/dev',
      GEZEL_TOKEN: 'should-not-leak',
      GEZEL_NODE_PATH: '/opt/node',
      OPENAI_API_KEY: 'sk-nope',
      ANTHROPIC_API_KEY: 'sk-ant-nope',
      GITHUB_TOKEN: 'ghp-nope',
      AWS_SECRET_ACCESS_KEY: 'nope',
      NODE_AUTH_TOKEN: 'npm-nope',
      NODE_OPTIONS: '--require /tmp/evil.cjs',
    });
    for (const key of [
      'GEZEL_TOKEN',
      'GEZEL_NODE_PATH',
      'OPENAI_API_KEY',
      'ANTHROPIC_API_KEY',
      'GITHUB_TOKEN',
      'AWS_SECRET_ACCESS_KEY',
      'NODE_AUTH_TOKEN',
      'NODE_OPTIONS',
    ]) {
      expect(out, key).not.toHaveProperty(key);
    }
    expect(out.PATH).toBe('/usr/bin');
    expect(out.HOME).toBe('/home/dev');
  });

  it('keeps what a browser and pnpm need: proxy, CA bundle, display and app-data roots', () => {
    const out = browserScriptEnv({
      https_proxy: 'http://proxy.corp:3128',
      NO_PROXY: 'localhost',
      NODE_EXTRA_CA_CERTS: '/etc/corp-ca.pem',
      DISPLAY: ':0',
      XDG_RUNTIME_DIR: '/run/user/1000',
      LocalAppData: 'C:/Users/dev/AppData/Local',
      APPDATA: 'C:/Users/dev/AppData/Roaming',
    });
    expect(out.https_proxy).toBe('http://proxy.corp:3128');
    expect(out.NO_PROXY).toBe('localhost');
    expect(out.NODE_EXTRA_CA_CERTS).toBe('/etc/corp-ca.pem');
    expect(out.DISPLAY).toBe(':0');
    expect(out.XDG_RUNTIME_DIR).toBe('/run/user/1000');
    expect(out.LocalAppData).toBe('C:/Users/dev/AppData/Local');
    expect(out.APPDATA).toBe('C:/Users/dev/AppData/Roaming');
  });
});

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
