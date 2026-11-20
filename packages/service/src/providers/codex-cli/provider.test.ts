import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CODEX_REASONING_EFFORTS,
  isCodexReasoningEffort,
} from '@bendyline/gezel-inference/internal/providers/codex-cli/reasoning';
import { describe, expect, it } from 'vitest';
import { CodexCliProvider } from './provider.js';
import type { CodexSessionDeps } from './session.js';

describe('CodexCliProvider model catalog', () => {
  it('offers the GPT-6 family with the levels Codex lists for each model', async () => {
    const provider = new CodexCliProvider({ runtimeDir: '/tmp/gezel-codex-cli-test' });
    const models = await provider.listModels();

    expect(models.find((model) => model.id === 'gpt-6.1-sol')).toMatchObject({
      name: 'gpt-6.1-sol — GPT-6.1 Sol',
      reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      defaultReasoningEffort: 'low',
    });
    for (const id of ['gpt-6-astra', 'gpt-6-sol']) {
      expect(models.find((model) => model.id === id)).toMatchObject({
        reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
        defaultReasoningEffort: 'medium',
      });
    }
    expect(models.find((model) => model.id === 'gpt-6-luna')).toMatchObject({
      reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultReasoningEffort: 'medium',
    });
  });

  it('offers the GPT-5.6 family with Codex-specific reasoning levels', async () => {
    const provider = new CodexCliProvider({ runtimeDir: '/tmp/gezel-codex-cli-test' });
    const models = await provider.listModels();

    expect(models.find((model) => model.id === 'gpt-5.6-sol')).toMatchObject({
      name: 'gpt-5.6-sol — GPT-5.6 Sol',
      reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      defaultReasoningEffort: 'low',
    });
    expect(models.find((model) => model.id === 'gpt-5.6-terra')).toMatchObject({
      reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      defaultReasoningEffort: 'medium',
    });
    expect(models.find((model) => model.id === 'gpt-5.6-luna')).toMatchObject({
      reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultReasoningEffort: 'medium',
    });
  });

  it('drops models Codex retired and lets configured models override defaults', async () => {
    const provider = new CodexCliProvider({
      runtimeDir: '/tmp/gezel-codex-cli-test',
      extraModels: [{ id: 'gpt-5.5', name: 'Pinned GPT-5.5' }],
    });
    const models = await provider.listModels();

    const ids = models.map((model) => model.id);
    expect(ids).toContain('gpt-5.5');
    expect(ids).not.toContain('gpt-5.4');
    expect(ids).not.toContain('gpt-5.3');
    expect(models.find((model) => model.id === 'gpt-5.5')).toEqual({
      id: 'gpt-5.5',
      name: 'Pinned GPT-5.5',
    });
  });
});

describe('Codex CLI reasoning efforts', () => {
  it('accepts the complete CLI vocabulary and rejects foreign provider labels', () => {
    expect(CODEX_REASONING_EFFORTS).toEqual([
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultra',
    ]);
    for (const effort of CODEX_REASONING_EFFORTS) {
      expect(isCodexReasoningEffort(effort)).toBe(true);
    }
    expect(isCodexReasoningEffort('none')).toBe(false);
    expect(isCodexReasoningEffort('custom')).toBe(false);
  });
});

// A one-shot (an about, a summary, a script's llm.oneShot, a /v1 request)
// ran in the daemon's own folder with the install's mode and Codex's shell,
// so a prompt could have it print runtime/auth-token.
describe('CodexCliProvider one-shot sessions', () => {
  async function oneShotDeps(opts: { manageRuntimeFiles?: boolean } = {}) {
    const runtimeDir = await mkdtemp(join(tmpdir(), 'gezel-codex-oneshot-'));
    const provider = new CodexCliProvider({
      runtimeDir,
      defaultPermissionMode: 'full',
      extraConfigOverrides: { 'features.shell_tool': 'true', model_verbosity: '"low"' },
      ...opts,
    });
    Object.assign(provider, {
      resolved: {
        path: 'codex',
        version: '0.0.0-test',
        capabilities: {
          autoReview: false,
          strictConfig: false,
          managedHooks: false,
          stdinPrompt: true,
        },
      },
    });
    const session = await provider.createSession({ systemMessage: 'Write a summary.' });
    const internals = session as unknown as {
      deps: CodexSessionDeps;
      configOverrides(): Record<string, string> | undefined;
    };
    return { runtimeDir, deps: internals.deps, overrides: internals.configOverrides() };
  }

  it.each([true, false])(
    'runs read-only, without a shell, in an empty folder (managed files: %s)',
    async (manageRuntimeFiles) => {
      const { runtimeDir, deps, overrides } = await oneShotDeps({ manageRuntimeFiles });
      try {
        expect(deps.permissionMode).toBe('plan');
        expect(deps.context.shellTool).toBe(false);
        expect(deps.context.cwd).toBe(join(runtimeDir, 'oneshot-cwd'));
        expect(await readdir(deps.context.cwd)).toEqual([]);
        expect(deps.context.cwd).not.toBe(process.cwd());
        // The person's -c cannot turn the shell back on.
        expect(overrides).toEqual({
          'features.shell_tool': 'false',
          model_verbosity: '"low"',
          'features.unified_exec': 'false',
        });
      } finally {
        await rm(runtimeDir, { recursive: true, force: true });
      }
    },
  );
});
