import { describe, expect, it } from 'vitest';
import type { PromptCtx } from '../types.js';
import { ToolsMlxGrammar } from './tools-mlx-grammar.js';

function ctx(tools: string[]): PromptCtx {
  return {
    catalogId: 'qwen3.8-27b-q4',
    tier: 'medium',
    family: 'qwen',
    modelId: 'qwen3.8-27b-q4',
    providerName: 'mlx',
    hasPlaywright: false,
    isMeester: false,
    about: '',
    availableToolNames: new Set(tools),
  };
}

describe('tools.mlx-grammar prompt contract', () => {
  it('reminds tool-enabled models that every required field must be emitted', () => {
    const out = ToolsMlxGrammar.promptAppend?.(ctx(['wikipedia_search']), undefined) ?? '';
    expect(out).toContain('every field listed in `required` must be present');
    expect(out).toContain('Optional fields may be omitted');
    expect(out).toContain('parameter names exactly');
    expect(out).toContain('<tool_call>{"name":"…","arguments"');
  });

  it('does not prescribe the Hermes JSON envelope to other grammar families', () => {
    const out =
      ToolsMlxGrammar.promptAppend?.({ ...ctx(['write_file']), family: 'gemma' }, undefined) ?? '';
    expect(out).toContain('every field listed in `required` must be present');
    expect(out).not.toContain('JSON envelope');
  });

  it('adds nothing when the session has no tools', () => {
    expect(ToolsMlxGrammar.promptAppend?.(ctx([]), undefined)).toBeNull();
  });
});
