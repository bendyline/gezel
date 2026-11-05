import { describe, expect, it } from 'vitest';
import { AnthropicCliProvider } from './provider.js';
import { CLAUDE_REASONING_EFFORTS, isClaudeReasoningEffort } from './reasoning.js';

describe('AnthropicCliProvider model catalog', () => {
  it('lists the account aliases, then the families from fastest to most capable', async () => {
    const provider = new AnthropicCliProvider({ runtimeDir: '/tmp/gezel-claude-cli-test' });
    const models = await provider.listModels();

    expect(models.map((model) => [model.group, model.id])).toEqual([
      ['Chosen for your account', 'default'],
      ['Chosen for your account', 'best'],
      ['Models', 'haiku'],
      ['Models', 'sonnet'],
      ['Models', 'opus'],
      ['Models', 'fable'],
      ['Models', 'opusplan'],
    ]);
  });

  it('keeps names short and puts the explanation in the description', async () => {
    const provider = new AnthropicCliProvider({ runtimeDir: '/tmp/gezel-claude-cli-test' });
    const models = await provider.listModels();

    expect(models.find((model) => model.id === 'sonnet')).toMatchObject({
      name: 'Claude Sonnet',
      description: 'Balanced speed and capability for daily work',
    });
    expect(models.find((model) => model.id === 'fable')).toMatchObject({
      name: 'Claude Fable',
      reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultReasoningEffort: 'high',
      contextWindow: 1_000_000,
    });
    expect(models.find((model) => model.id === 'opusplan')?.name).toBe(
      'Plan with Opus, build with Sonnet',
    );
    for (const model of models) expect(model.name).not.toContain(' — ');
  });

  it('describes the current model-specific reasoning ranges', async () => {
    const provider = new AnthropicCliProvider({ runtimeDir: '/tmp/gezel-claude-cli-test' });
    const models = await provider.listModels();

    for (const id of ['opus', 'sonnet', 'haiku']) {
      expect(models.find((model) => model.id === id)).toMatchObject({
        supportsReasoning: true,
        reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        defaultReasoningEffort: 'medium',
      });
    }
    expect(models.find((model) => model.id === 'best')?.defaultReasoningEffort).toBe('high');
  });

  it('lets configured entries override built-in aliases in place', async () => {
    const provider = new AnthropicCliProvider({
      runtimeDir: '/tmp/gezel-claude-cli-test',
      extraModels: [
        { id: 'sonnet', name: 'Pinned Sonnet deployment' },
        { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5, pinned' },
      ],
    });
    const models = await provider.listModels();

    expect(models[3]).toEqual({
      id: 'sonnet',
      name: 'Pinned Sonnet deployment',
      group: 'Models',
    });
    expect(models.at(-1)).toEqual({
      id: 'claude-sonnet-5-5',
      name: 'Sonnet 5.5, pinned',
      group: 'Models',
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
