import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  findGemmaNativeToolCallSpans,
  findGlmToolCallSpans,
  findHermesFunctionToolCallSpans,
} from '../providers/local-tool-call-salvage.js';
import { coerceArgsToSchema } from '../providers/tool-arg-schema-coercion.js';
import { decorativeMarkupShapes, realCallSentence, toolCallIdiomFor } from './tool-call-idiom.js';
import type { ToolGrammarFormat } from './tool-grammar.js';

interface IdiomExample {
  format: ToolGrammarFormat;
  tool: { name: string; parameters: Record<string, unknown> };
  text: string;
  expect: Record<string, unknown>;
}

const { examples } = JSON.parse(
  readFileSync(new URL('./tool-call-idiom-examples.json', import.meta.url), 'utf8'),
) as { examples: IdiomExample[] };

const FINDERS: Record<
  ToolGrammarFormat,
  (text: string, names: ReadonlySet<string>) => Array<{ name: string; arguments: unknown }>
> = {
  hermes: findHermesFunctionToolCallSpans,
  gemma: findGemmaNativeToolCallSpans,
  glm: findGlmToolCallSpans,
};

/** Parse a call the way a local provider does: salvage, then schema coercion. */
function parse(format: ToolGrammarFormat, text: string, tool: IdiomExample['tool']) {
  const spans = FINDERS[format](text, new Set([tool.name]));
  expect(spans, `${format} salvage found no call in ${JSON.stringify(text)}`).toHaveLength(1);
  expect(spans[0]!.name).toBe(tool.name);
  return coerceArgsToSchema(spans[0]!.arguments as Record<string, unknown>, tool.parameters).args;
}

describe('tool-call idiom examples parse as the prompt promises', () => {
  it.each(examples.map((e) => [`${e.format}: ${e.tool.name}`, e] as const))('%s', (_label, e) => {
    expect(parse(e.format, e.text, e.tool)).toEqual(e.expect);
  });

  it('covers every format an idiom exists for', () => {
    for (const format of ['hermes', 'gemma', 'glm'] as const) {
      expect(examples.some((e) => e.format === format)).toBe(true);
    }
  });
});

describe('toolCallIdiomFor', () => {
  it('resolves the local Qwen family to the Hermes idiom', () => {
    expect(toolCallIdiomFor({ providerName: 'mlx', family: 'qwen' })?.format).toBe('hermes');
    expect(toolCallIdiomFor({ providerName: 'llama-cpp', family: 'qwen' })?.format).toBe('hermes');
  });

  it('has no idiom on a structured-channel provider or an unmapped family', () => {
    expect(toolCallIdiomFor({ providerName: 'anthropic', family: 'qwen' })).toBeNull();
    expect(toolCallIdiomFor({ providerName: 'mlx', family: 'llama' })).toBeNull();
  });

  it("teaches a nested argument in a form the model's own parser reads back", () => {
    // The prose snippet itself, with NAME filled in, must survive salvage +
    // coercion as a real object — prompt and parser cannot disagree.
    const idiom = toolCallIdiomFor({ providerName: 'mlx', family: 'qwen' })!;
    const snippet = /`(<parameter=NAME>[\s\S]*?<\/parameter>)`/.exec(idiom.nestedArgument!)![1]!;
    const tool = {
      name: 'invoke_craftbook',
      parameters: { type: 'object', properties: { params: { type: 'object' } } },
    };
    const text = `<tool_call>\n<function=invoke_craftbook>\n${snippet.replace('NAME', 'params')}\n</function>\n</tool_call>`;
    expect(parse('hermes', text, tool)).toEqual({ params: { key: 'value' } });
  });
});

describe('decorative markup never includes the model’s own call shape', () => {
  it('keeps the full list for models with no idiom', () => {
    const shapes = decorativeMarkupShapes(null);
    expect(shapes.some((s) => s.includes('<function=name>'))).toBe(true);
    expect(realCallSentence(null)).toContain('function-calling channel');
  });

  it('drops the Hermes shape for Qwen and names its block as the call', () => {
    const idiom = toolCallIdiomFor({ providerName: 'mlx', family: 'qwen' });
    const shapes = decorativeMarkupShapes(idiom);
    expect(shapes.some((s) => s.includes('<function=name>'))).toBe(false);
    expect(shapes.some((s) => s.includes('<invoke name='))).toBe(true);
    expect(realCallSentence(idiom)).toContain('<tool_call><function=…>');
  });

  it('drops the Gemma special-token shape for Gemma', () => {
    const idiom = toolCallIdiomFor({ providerName: 'mlx', family: 'gemma' });
    expect(decorativeMarkupShapes(idiom).some((s) => s.includes('<|tool_call|>'))).toBe(false);
  });
});
