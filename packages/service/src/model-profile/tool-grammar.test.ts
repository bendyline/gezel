import { describe, expect, it } from 'vitest';

import type { ModelStyle } from '@bendyline/gezel';
import { familyToToolGrammarHint } from './tool-grammar.js';

const style = (family: ModelStyle['family']): ModelStyle => ({
  family,
  reasoningFormat: 'think',
  toolCallFormat: 'function-call',
});

describe('familyToToolGrammarHint', () => {
  it('maps qwen → hermes tier-2 (name+params; Qwen 3.5/3.6 use <function=NAME> nesting, not the legacy JSON envelope)', () => {
    expect(familyToToolGrammarHint(style('qwen'))).toEqual({
      format: 'hermes',
      mode: 'name-and-params',
    });
  });

  it('maps qwq → hermes tier-2 (shares Qwen tool-call format)', () => {
    expect(familyToToolGrammarHint(style('qwq'))).toEqual({
      format: 'hermes',
      mode: 'name-and-params',
    });
  });

  it('maps nemotron → hermes tier-2 (Nemotron 3.5 Lightning uses the qwen3_coder XML template)', () => {
    expect(familyToToolGrammarHint(style('nemotron'))).toEqual({
      format: 'hermes',
      mode: 'name-and-params',
    });
  });

  it('maps granite → hermes tier-2 (Granite 4.2 uses the nested qwen3_coder XML template)', () => {
    expect(familyToToolGrammarHint(style('granite'))).toEqual({
      format: 'hermes',
      mode: 'name-and-params',
    });
  });

  it('maps gemma → gemma tier-1 (name-only; <|tool_call>call:NAME{…}<tool_call|>, token-verified)', () => {
    expect(familyToToolGrammarHint(style('gemma'))).toEqual({
      format: 'gemma',
      mode: 'name-only',
    });
  });

  it('maps glm → glm tier-1 (name-only; <tool_call>NAME<arg_key>…</tool_call>, token-verified)', () => {
    expect(familyToToolGrammarHint(style('glm'))).toEqual({
      format: 'glm',
      mode: 'name-only',
    });
  });

  it('returns null for families whose MLX grammar is not yet token-verified', () => {
    // Unmapped families fall back to the TS salvage layer (no regression).
    for (const f of ['llama', 'mistral', 'deepseek', 'gpt-oss', 'phi', 'other'] as const) {
      expect(familyToToolGrammarHint(style(f))).toBeNull();
    }
  });

  it('returns null for undefined style', () => {
    expect(familyToToolGrammarHint(undefined)).toBeNull();
  });
});
