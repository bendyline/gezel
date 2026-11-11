import { describe, expect, it } from 'vitest';
import {
  chatTemplateSupportsTools,
  chatTemplateThinks,
  ggufNonChatKind,
  ggufParameterSize,
  unreadableGgufTensorTypes,
} from './gguf-header.js';

describe('ggufParameterSize', () => {
  it('reads a plain size label', () => {
    expect(ggufParameterSize({ version: 3, sizeLabel: '8B' })).toBe('8B');
    expect(ggufParameterSize({ version: 3, sizeLabel: '30B-A3B' })).toBe('30B');
    expect(ggufParameterSize({ version: 3, sizeLabel: '600M' })).toBe('600M');
  });

  it('never multiplies an expert-count label out', () => {
    // gpt-oss-20b: `32x2.4B` would read as 77B; its tensors count 20.9B.
    expect(
      ggufParameterSize({ version: 3, sizeLabel: '32x2.4B', parameterCount: 20_914_757_184 }),
    ).toBe('21B');
    // A split file's header counts only its own tensors; fall back to size.
    expect(
      ggufParameterSize(
        { version: 3, sizeLabel: '8x7B' },
        { sizeBytes: 26 * 1024 ** 3, bitsPerWeight: 4.8 },
      ),
    ).toBe('47B');
  });
});

describe('ggufNonChatKind', () => {
  it('names adapters, projectors and embedding models', () => {
    expect(ggufNonChatKind({ version: 3, generalType: 'adapter' })).toBe('adapter');
    expect(ggufNonChatKind({ version: 3, architecture: 'clip' })).toBe('projector');
    expect(ggufNonChatKind({ version: 3, architecture: 'nomic-bert' })).toBe('embedding');
    expect(ggufNonChatKind({ version: 3, architecture: 'qwen3', poolingType: 1 })).toBe(
      'embedding',
    );
    expect(
      ggufNonChatKind({ version: 3, architecture: 'qwen3', poolingType: 1, chatTemplate: 'x' }),
    ).toBeUndefined();
  });
});

describe('unreadableGgufTensorTypes', () => {
  it('separates removed formats from ones newer than the engine', () => {
    expect(
      unreadableGgufTensorTypes({ version: 3, tensorTypeCounts: { 12: 3, 31: 1, 250: 1 } }),
    ).toEqual({ removed: ['Q4_0_4_4'], unknown: [250] });
  });
});

describe('chat template capabilities', () => {
  it('reads tools and thinking from the template', () => {
    expect(chatTemplateSupportsTools('{% if tools %}{{ tools }}{% endif %}')).toBe(true);
    expect(chatTemplateSupportsTools('{{ messages }}')).toBe(false);
    expect(chatTemplateThinks('{{ "<think>" }}')).toBe(true);
    expect(chatTemplateThinks('<|channel|>analysis')).toBe(true);
    expect(chatTemplateThinks(undefined)).toBe(false);
  });
});
