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
  });

  it("teaches Qwen its own template's nested form, never the JSON envelope", () => {
    // 2026-09-23: told to use the envelope, qwen3.8-27b wrote it, closed the
    // XML its template expects, and looped `</function>` to max_tokens.
    const out = ToolsMlxGrammar.promptAppend?.(ctx(['invoke_craftbook']), undefined) ?? '';
    expect(out).toContain('`<parameter=NAME>{"key": "value"}</parameter>`');
    expect(out).not.toContain('JSON envelope');
    expect(out).not.toContain('<tool_call>{');
  });

  it('adds no nested-argument line where the form is unverified', () => {
    const out =
      ToolsMlxGrammar.promptAppend?.({ ...ctx(['write_file']), family: 'gemma' }, undefined) ?? '';
    expect(out).toContain('every field listed in `required` must be present');
    expect(out).not.toContain('<parameter=');
  });

  it('adds nothing when the session has no tools', () => {
    expect(ToolsMlxGrammar.promptAppend?.(ctx([]), undefined)).toBeNull();
  });
});
