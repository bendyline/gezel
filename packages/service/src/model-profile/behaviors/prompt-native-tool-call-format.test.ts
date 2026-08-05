/**
 * Coverage for `prompt.native-tool-call-format`.
 *
 * The behavior exists because LFM2.5-2.6B on MLX drops the function name
 * under gezel's assembled system prompt (measured 0/8 native calls; 8/8
 * with this block). The regression risk is the config gate: if enabling
 * without an `example` ever started emitting a block, an A/B toggling it
 * via GEZEL_FORCE_BEHAVIORS would diverge its arms on empty guidance.
 */

import { describe, expect, it } from 'vitest';
import type { PromptCtx } from '../types.js';
import { PromptNativeToolCallFormat } from './prompt-native-tool-call-format.js';

const CTX = {
  catalogId: 'lfm2.5-2.6b-q4',
  tier: 'tiny',
  family: 'other',
  modelId: 'lfm2.5-2.6b-q4',
  providerName: 'mlx',
  hasPlaywright: false,
  isMeester: false,
  about: '',
} as unknown as PromptCtx;

const EXAMPLE = "<|tool_call_start|>[write_file(path='notes.md', content='hi')]<|tool_call_end|>";

describe('prompt.native-tool-call-format', () => {
  it('renders the configured example verbatim', () => {
    const out = PromptNativeToolCallFormat.promptAppend?.(CTX, { example: EXAMPLE });
    expect(out).toContain(EXAMPLE);
    expect(out).toContain('## Tool-call format');
  });

  it('names the two shapes the model actually drifts into', () => {
    const out = PromptNativeToolCallFormat.promptAppend?.(CTX, { example: EXAMPLE }) ?? '';
    expect(out).toContain('json');
    expect(out).toContain('bare arguments object');
  });

  it('is a no-op without a config (so a forced A/B cannot diverge on empty guidance)', () => {
    expect(PromptNativeToolCallFormat.promptAppend?.(CTX, undefined)).toBeNull();
  });

  it('is a no-op when the example is blank or whitespace', () => {
    expect(PromptNativeToolCallFormat.promptAppend?.(CTX, { example: '   ' })).toBeNull();
  });

  it('rejects a config with no example', () => {
    expect(PromptNativeToolCallFormat.configSchema?.safeParse({}).success).toBe(false);
    expect(PromptNativeToolCallFormat.configSchema?.safeParse({ example: EXAMPLE }).success).toBe(
      true,
    );
  });
});
