import { describe, expect, it } from 'vitest';
import { AnthropicCliProvider } from './provider.js';
import { CLAUDE_REASONING_EFFORTS, isClaudeReasoningEffort } from './reasoning.js';

describe('AnthropicCliProvider model catalog', () => {
  it('offers the complete stable Claude Code alias set', async () => {
    const provider = new AnthropicCliProvider({ runtimeDir: '/tmp/gezel-claude-cli-test' });
    const models = await provider.listModels();

    expect(models.map((model) => model.id)).toEqual([
      'best',
      'default',
      'haiku',
      'opus',
      'opus[1m]',
      'opusplan',
      'sonnet',
      'sonnet[1m]',
    ]);
  });

  it('describes the current model-specific reasoning ranges', async () => {
    const provider = new AnthropicCliProvider({ runtimeDir: '/tmp/gezel-claude-cli-test' });
    const models = await provider.listModels();

    expect(models.find((model) => model.id === 'opus')).toMatchObject({
      reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultReasoningEffort: 'xhigh',
    });
    expect(models.find((model) => model.id === 'sonnet')).toMatchObject({
      reasoningEfforts: ['low', 'medium', 'high', 'max'],
      defaultReasoningEffort: 'high',
    });
    expect(models.find((model) => model.id === 'haiku')?.supportsReasoning).toBeUndefined();
  });

  it('lets configured entries override built-in aliases', async () => {
    const provider = new AnthropicCliProvider({
      runtimeDir: '/tmp/gezel-claude-cli-test',
      extraModels: [{ id: 'sonnet', name: 'Pinned Sonnet deployment' }],
    });

    expect((await provider.listModels()).find((model) => model.id === 'sonnet')).toEqual({
      id: 'sonnet',
      name: 'Pinned Sonnet deployment',
    });
  });
});

describe('Claude CLI reasoning efforts', () => {
  it('accepts the complete Claude Code vocabulary and rejects foreign labels', () => {
    expect(CLAUDE_REASONING_EFFORTS).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    for (const effort of CLAUDE_REASONING_EFFORTS) {
      expect(isClaudeReasoningEffort(effort)).toBe(true);
    }
    expect(isClaudeReasoningEffort('minimal')).toBe(false);
    expect(isClaudeReasoningEffort('ultra')).toBe(false);
  });
});
