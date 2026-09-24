/**
 * The tool-call markup a local model writes, stated once per grammar format.
 *
 * Prompt prose used to name call syntax on its own, blind to the model
 * reading it, and it contradicted the model's own chat template twice:
 *
 *  - `tools.mlx-grammar` told Qwen 3.x that an object argument "must use the
 *    JSON envelope". Its template nests JSON inside `<parameter=NAME>`. A
 *    qwen3.8-27b Meester wrote the envelope as told, closed the XML it
 *    expected (`</parameter></function>`), and looped `</function>` to
 *    max_tokens (2026-09-23).
 *  - the tiny/small tool cookbooks listed `<function=name><parameter=…>` as
 *    markup never to write — which is exactly how Qwen calls a tool on a
 *    local engine.
 *
 * Anything a prompt says about call syntax comes from here, keyed on the
 * same family → format map the MLX grammar uses, so prompt, grammar, and
 * salvage parser describe one shape. `tool-call-idiom-examples.json` holds
 * calls written in each idiom: `tool-call-idiom.test.ts` runs them through
 * the salvage parser, `tool_grammar_modeltest.py` through the grammar on
 * real tokenizers.
 *
 * Say nothing about syntax the chat template already teaches. An idiom
 * carries only what the template leaves out.
 */

import type { ModelFamily, ProviderName } from '@bendyline/gezel';
import { isLocalProvider } from '@bendyline/gezel';
import { type ToolGrammarFormat, familyToToolGrammarHint } from './tool-grammar.js';

export interface ToolCallIdiom {
  format: ToolGrammarFormat;
  /** The model's own call block, as prompt prose names it. */
  callBlock: string;
  /**
   * How to write an object or array argument in this format, or null when
   * the nested form is unverified for it. Hermes templates render one as
   * JSON inside the parameter tag but only demonstrate scalars, which is
   * the gap this fills.
   */
  nestedArgument: string | null;
}

const IDIOMS: Record<ToolGrammarFormat, ToolCallIdiom> = {
  hermes: {
    format: 'hermes',
    callBlock: '`<tool_call><function=…>`',
    nestedArgument:
      'Write an object or array argument as JSON inside its parameter tag: `<parameter=NAME>{"key": "value"}</parameter>`.',
  },
  gemma: {
    format: 'gemma',
    callBlock: '`<|tool_call>call:…<tool_call|>`',
    nestedArgument: null,
  },
  glm: {
    format: 'glm',
    callBlock: '`<tool_call>NAME<arg_key>…`',
    nestedArgument: null,
  },
};

/**
 * The active model's idiom, or null when it has no verified textual format
 * — a cloud provider with a structured tool channel, or a local family the
 * grammar map does not cover. Null means "keep the generic wording".
 */
export function toolCallIdiomFor(ctx: {
  providerName: ProviderName;
  family: ModelFamily;
}): ToolCallIdiom | null {
  if (!isLocalProvider(ctx.providerName)) return null;
  const hint = familyToToolGrammarHint({ family: ctx.family });
  return hint ? IDIOMS[hint.format] : null;
}

/**
 * Markup a model writes as decoration instead of calling, each tagged with
 * the format for which that exact shape IS the call. A model is never told
 * to avoid its own call shape.
 */
const DECORATIVE_MARKUP: ReadonlyArray<{ shape: string; callFormat?: ToolGrammarFormat }> = [
  { shape: '`<|tool_call|>...`', callFormat: 'gemma' },
  { shape: '`<browser_navigate url="..." />`' },
  { shape: '`<function_calls><invoke name="...">...</invoke></function_calls>`' },
  { shape: '`<function=name><parameter=key>val</parameter></function>`', callFormat: 'hermes' },
  { shape: '`<tool_call>name key="value"` shell-style lines' },
];

export function decorativeMarkupShapes(idiom: ToolCallIdiom | null): string[] {
  return DECORATIVE_MARKUP.filter((m) => !idiom || m.callFormat !== idiom.format).map(
    (m) => m.shape,
  );
}

/** The sentence that says where a real call goes. */
export function realCallSentence(idiom: ToolCallIdiom | null): string {
  return idiom
    ? `Your ${idiom.callBlock} block is the call itself — write one to make a call, never to describe or plan one.`
    : 'Real calls go through the function-calling channel.';
}
