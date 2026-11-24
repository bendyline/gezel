import { describe, expect, it } from 'vitest';
import {
  CLAUDE_CLI_AUTH_ENV,
  CODEX_CLI_AUTH_ENV,
  agentCliEnv,
  withMcpBootstrapCode,
} from './agent-cli-env.js';
import {
  claudeAbsoluteRulePath,
  claudeCredentialDenyRules,
  claudeKeptLocalDenyRules,
} from './anthropic-cli/credential-deny.js';

describe('agentCliEnv', () => {
  const daemon = {
    PATH: '/usr/bin',
    HOME: '/home/me',
    GEZEL_TOKEN: 'root-ish',
    GEZEL_HOME: '/home/me/.gezel',
    gezel_debug: '1',
    GH_TOKEN: 'gh-secret',
    OPENAI_API_KEY: 'sk-openai',
    ANTHROPIC_API_KEY: 'sk-ant',
    AWS_SECRET_ACCESS_KEY: 'aws',
  };

  it('keeps the CLI its own sign-in and nothing of Gezel’s or the person’s other secrets', () => {
    const claude = agentCliEnv(daemon, CLAUDE_CLI_AUTH_ENV);
    expect(claude).toMatchObject({
      PATH: '/usr/bin',
      HOME: '/home/me',
      ANTHROPIC_API_KEY: 'sk-ant',
    });
    expect(claude.AWS_SECRET_ACCESS_KEY).toBe('aws');
    for (const name of ['GEZEL_TOKEN', 'GEZEL_HOME', 'gezel_debug', 'GH_TOKEN', 'OPENAI_API_KEY']) {
      expect(claude[name]).toBeUndefined();
    }
    const codex = agentCliEnv(daemon, CODEX_CLI_AUTH_ENV);
    expect(codex.OPENAI_API_KEY).toBe('sk-openai');
    expect(codex.ANTHROPIC_API_KEY).toBeUndefined();
    expect(codex.GH_TOKEN).toBeUndefined();
  });
});

describe('withMcpBootstrapCode', () => {
  const env = { GEZEL_TOKEN: 'live-token', GEZEL_BASE_URL: 'https://127.0.0.1:6228' };

  it('writes a fresh single-use code in place of the session token', () => {
    let n = 0;
    const mint = () => `code-${++n}`;
    expect(withMcpBootstrapCode(env, mint)).toEqual({
      GEZEL_BASE_URL: 'https://127.0.0.1:6228',
      GEZEL_TOKEN_CODE: 'code-1',
    });
    expect(withMcpBootstrapCode(env, mint).GEZEL_TOKEN_CODE).toBe('code-2');
  });

  it('keeps the env as it was without a minter, or when minting fails', () => {
    expect(withMcpBootstrapCode(env, undefined)).toBe(env);
    expect(
      withMcpBootstrapCode(env, () => {
        throw new Error('no session token');
      }),
    ).toBe(env);
  });
});

describe('claudeKeptLocalDenyRules', () => {
  it('covers a kept folder and everything below it, in any project', () => {
    expect(claudeKeptLocalDenyRules(['/home/me/.gezel/projects/week/artifacts/data/work'])).toEqual(
      [
        'Read(//home/me/.gezel/projects/week/artifacts/data/work)',
        'Read(//home/me/.gezel/projects/week/artifacts/data/work/**)',
      ],
    );
    expect(claudeKeptLocalDenyRules(['relative/data'])).toEqual([]);
  });
});

describe('claudeCredentialDenyRules', () => {
  it('writes absolute paths in Claude Code’s POSIX rule form', () => {
    expect(claudeAbsoluteRulePath('C:\\Users\\me\\.gezel')).toBe('//c/Users/me/.gezel');
    expect(claudeAbsoluteRulePath('/home/me/.gezel/')).toBe('//home/me/.gezel');
  });

  it('denies reading and editing the credential files, and nothing for a relative home', () => {
    const rules = claudeCredentialDenyRules('/home/me/.gezel');
    expect(rules).toContain('Read(//home/me/.gezel/runtime/**)');
    expect(rules).toContain('Edit(//home/me/.gezel/runtime/**)');
    expect(rules).toContain('Read(//home/me/.gezel/tokens.json)');
    expect(rules).toContain('Read(//home/me/.gezel/secrets.key)');
    expect(rules.some((rule) => rule.includes('/projects/'))).toBe(false);
    expect(claudeCredentialDenyRules('relative/home')).toEqual([]);
    expect(claudeCredentialDenyRules(undefined)).toEqual([]);
  });
});
