import {
  CODEX_REASONING_EFFORTS,
  isCodexReasoningEffort,
} from '@bendyline/gezel-inference/internal/providers/codex-cli/reasoning';
import { describe, expect, it } from 'vitest';
import { CodexCliProvider } from './provider.js';

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
