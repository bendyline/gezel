import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chatModelSources } from './model-sources.ts';
import {
  CHAT_PROVIDERS,
  buildProviderConfig,
  categorizeProvider,
  defaultModelFor,
  isChatProvider,
  isLocalEngine,
  isSelfOrchestratingProvider,
  probeProviderAuth,
} from './providers.ts';

describe('CHAT_PROVIDERS allowlist', () => {
  it('includes every provider the harness can drive', () => {
    expect([...CHAT_PROVIDERS].sort()).toEqual(
      [
        'anthropic',
        'anthropic-cli',
        'codex-cli',
        'copilot',
        'ds4',
        'llama-cpp',
        'mlx',
        'openai',
      ].sort(),
    );
  });

  it('matches isChatProvider exactly — no extra accepted names', () => {
    expect(isChatProvider('llama-cpp')).toBe(true);
    expect(isChatProvider('codex-cli')).toBe(true);
    expect(isChatProvider('openai')).toBe(true);
    expect(isChatProvider('ollama')).toBe(false); // deliberately excluded
    expect(isChatProvider('not-a-provider')).toBe(false);
    expect(isChatProvider('')).toBe(false);
  });
});

describe('categorizeProvider', () => {
  it('maps local engines to local-engine', () => {
    expect(categorizeProvider('llama-cpp')).toBe('local-engine');
    expect(categorizeProvider('mlx')).toBe('local-engine');
  });

  it('maps CLI wrappers to cli-wrapper', () => {
    expect(categorizeProvider('codex-cli')).toBe('cli-wrapper');
    expect(categorizeProvider('anthropic-cli')).toBe('cli-wrapper');
  });

  it('maps cloud SDKs to cloud-sdk', () => {
    expect(categorizeProvider('copilot')).toBe('cloud-sdk');
    expect(categorizeProvider('openai')).toBe('cloud-sdk');
    expect(categorizeProvider('anthropic')).toBe('cloud-sdk');
  });
});

describe('isSelfOrchestratingProvider', () => {
  it('is true for providers that run their own agent loop (cli wrappers + copilot)', () => {
    expect(isSelfOrchestratingProvider('codex-cli')).toBe(true);
    expect(isSelfOrchestratingProvider('anthropic-cli')).toBe(true);
    expect(isSelfOrchestratingProvider('copilot')).toBe(true);
  });

  it('is false for raw providers gezel drives turn-by-turn (local engines + raw cloud APIs)', () => {
    expect(isSelfOrchestratingProvider('llama-cpp')).toBe(false);
    expect(isSelfOrchestratingProvider('mlx')).toBe(false);
    expect(isSelfOrchestratingProvider('anthropic')).toBe(false);
    expect(isSelfOrchestratingProvider('openai')).toBe(false);
  });
});

describe('isLocalEngine', () => {
  it('is true only for llama-cpp and mlx', () => {
    expect(isLocalEngine('llama-cpp')).toBe(true);
    expect(isLocalEngine('mlx')).toBe(true);
    expect(isLocalEngine('codex-cli')).toBe(false);
    expect(isLocalEngine('anthropic-cli')).toBe(false);
    expect(isLocalEngine('copilot')).toBe(false);
    expect(isLocalEngine('openai')).toBe(false);
    expect(isLocalEngine('anthropic')).toBe(false);
  });
});

describe('defaultModelFor', () => {
  it('returns a model id for every provider', () => {
    // Postmortem rendering assumes a non-empty model id when the user
    // didn't pass --model. Anything that returns '' here would break
    // the trial dir naming + result.json.
    for (const p of CHAT_PROVIDERS) {
      const m = defaultModelFor(p);
      expect(m.length).toBeGreaterThan(0);
    }
  });

  it('keeps the historical llama-cpp baseline and a smaller MLX default', () => {
    expect(defaultModelFor('llama-cpp')).toBe('gemma4-e4b-q4');
    expect(defaultModelFor('mlx')).toBe('qwen3.5-4b-q4');
    // Both the fast default and the historical E4B baseline must be runnable
    // on MLX so explicit cross-engine comparisons do not fail during warm.
    expect(chatModelSources('qwen3.5-4b-q4')?.mlx).toBe(true);
    expect(chatModelSources('gemma4-e4b-q4')?.mlx).toBe(true);
  });
});

describe('buildProviderConfig', () => {
  it('keys defaultModel by the provider name', () => {
    expect(buildProviderConfig('openai', 'gpt-5')).toEqual({
      provider: 'openai',
      defaultModel: { openai: 'gpt-5' },
    });
  });

  it('pins bypassPermissions for codex-cli (non-interactive evals)', () => {
    // Otherwise codex's MCP wrapper auto-cancels every tool call with
    // "user cancelled MCP tool call" — the first smoke trial burned
    // a 5-minute budget on zero turns because of exactly this.
    expect(buildProviderConfig('codex-cli', 'gpt-5.5')).toEqual({
      provider: 'codex-cli',
      defaultModel: { 'codex-cli': 'gpt-5.5' },
      codexCli: { defaultPermissionMode: 'bypassPermissions' },
    });
  });

  it('pins bypassPermissions for anthropic-cli (same reason)', () => {
    expect(buildProviderConfig('anthropic-cli', 'claude-sonnet-4.6')).toEqual({
      provider: 'anthropic-cli',
      defaultModel: { 'anthropic-cli': 'claude-sonnet-4.6' },
      anthropicCli: { defaultPermissionMode: 'bypassPermissions' },
    });
  });

  it('preserves the llama-cpp shape that runner.ts used to build by hand', () => {
    // Regression: the old hard-coded if/else used exactly this shape;
    // dropping any field would silently change how the trial daemon
    // gets configured.
    expect(buildProviderConfig('llama-cpp', 'gemma4-e4b-q4')).toEqual({
      provider: 'llama-cpp',
      defaultModel: { 'llama-cpp': 'gemma4-e4b-q4' },
    });
  });

  it('produces a payload that is a subset of the larger updateConfig the runner sends', () => {
    // The runner spreads this into a payload that also carries
    // `imageProvider` + `firstRunCompleted`. The fields here must
    // never overlap with those, otherwise the spread would clobber
    // them.
    const cfg = buildProviderConfig('mlx', 'gemma4-e4b-q4');
    expect('imageProvider' in cfg).toBe(false);
    expect('firstRunCompleted' in cfg).toBe(false);
  });
});

describe('probeProviderAuth', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'gezel-probe-auth-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('local engines always pass (no auth)', () => {
    expect(probeProviderAuth('llama-cpp', {}).ok).toBe(true);
    expect(probeProviderAuth('mlx', {}).ok).toBe(true);
  });

  it('openai passes when OPENAI_API_KEY is set, fails when missing', () => {
    expect(probeProviderAuth('openai', {}).ok).toBe(false);
    expect(probeProviderAuth('openai', { OPENAI_API_KEY: '' }).ok).toBe(false);
    expect(probeProviderAuth('openai', { OPENAI_API_KEY: 'sk-test' }).ok).toBe(true);
  });

  it('openai failure message is actionable', () => {
    const res = probeProviderAuth('openai', {});
    expect(res.message).toContain('OPENAI_API_KEY');
    expect(res.message).toContain('export');
  });

  it('anthropic passes when ANTHROPIC_API_KEY is set', () => {
    expect(probeProviderAuth('anthropic', {}).ok).toBe(false);
    expect(probeProviderAuth('anthropic', { ANTHROPIC_API_KEY: 'sk-ant-test' }).ok).toBe(true);
  });

  it('codex-cli passes on CODEX_API_KEY', () => {
    expect(probeProviderAuth('codex-cli', { CODEX_API_KEY: 'test' }).ok).toBe(true);
  });

  it('codex-cli also accepts OPENAI_API_KEY as a fallback', () => {
    expect(probeProviderAuth('codex-cli', { OPENAI_API_KEY: 'sk-test' }).ok).toBe(true);
  });

  it('codex-cli passes when ~/.codex/auth.json (via CODEX_HOME) exists', async () => {
    const codexHome = join(tmp, 'codex-home');
    await mkdir(codexHome, { recursive: true });
    writeFileSync(join(codexHome, 'auth.json'), '{}');
    expect(probeProviderAuth('codex-cli', { CODEX_HOME: codexHome }).ok).toBe(true);
  });

  it('codex-cli fails when env unset AND no auth.json on disk', () => {
    const codexHome = join(tmp, 'empty-codex-home');
    const res = probeProviderAuth('codex-cli', { CODEX_HOME: codexHome });
    expect(res.ok).toBe(false);
    expect(res.message).toContain('codex login');
  });

  it('anthropic-cli passes on ANTHROPIC_API_KEY', () => {
    expect(probeProviderAuth('anthropic-cli', { ANTHROPIC_API_KEY: 'sk-ant-test' }).ok).toBe(true);
  });

  it('copilot passes on GH_TOKEN or GITHUB_TOKEN', () => {
    expect(probeProviderAuth('copilot', { GH_TOKEN: 'ghp_test' }).ok).toBe(true);
    expect(probeProviderAuth('copilot', { GITHUB_TOKEN: 'ghp_test' }).ok).toBe(true);
  });

  it('copilot passes when gh hosts.yml exists in the resolved config dir', async () => {
    const ghDir = join(tmp, 'gh-config');
    await mkdir(ghDir, { recursive: true });
    writeFileSync(join(ghDir, 'hosts.yml'), 'github.com:\n');
    expect(probeProviderAuth('copilot', { GH_CONFIG_DIR: ghDir }).ok).toBe(true);
  });

  it('copilot fails when neither env nor gh config is set up', () => {
    // Empty env + a config dir that exists but contains no hosts.yml.
    const ghDir = join(tmp, 'empty-gh-config');
    const res = probeProviderAuth('copilot', { GH_CONFIG_DIR: ghDir });
    expect(res.ok).toBe(false);
    expect(res.message).toContain('gh auth login');
  });
});
