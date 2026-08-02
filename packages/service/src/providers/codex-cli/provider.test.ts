import { describe, expect, it } from 'vitest';
import { CodexCliProvider } from './provider.js';
import { CODEX_REASONING_EFFORTS, isCodexReasoningEffort } from './reasoning.js';

describe('CodexCliProvider model catalog', () => {
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

  it('preserves the older flagship entries and lets configured models override defaults', async () => {
    const provider = new CodexCliProvider({
      runtimeDir: '/tmp/gezel-codex-cli-test',
      extraModels: [{ id: 'gpt-5.5', name: 'Pinned GPT-5.5' }],
    });
    const models = await provider.listModels();

    expect(models.map((model) => model.id)).toEqual(
      expect.arrayContaining(['gpt-5.3', 'gpt-5.4', 'gpt-5.5']),
    );
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
