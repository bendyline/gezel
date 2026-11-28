import { extractReasoning } from '@bendyline/gezel';
import {
  InklingMessageStream,
  templateTextUsesInklingMessages,
} from '@bendyline/gezel-inference/internal/providers/mlx/inkling-messages';
import { MlxProvider } from '@bendyline/gezel-inference/internal/providers/mlx/provider';
import { StreamingReasoningSplit } from '@bendyline/gezel-inference/internal/providers/mlx/reasoning-stream';
import { LeakyToolCallStripper } from '@bendyline/gezel-inference/internal/providers/mlx/tool-call-stripper';
import type { LLMSession } from '@bendyline/gezel-inference/internal/providers/types';
import { parseGemmaToolCall } from '@bendyline/gezel/local-loop';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Inkling 2 Mini on mlx-vlm 0.8.1 streams its message format as text. Both
// fixtures are verbatim sidecar output from 2026-11-27, thinking shortened.
const THOUGHT = 'The user wants just the number. 17*23 = 391.';
const ANSWER = `<|message_model|><|content_thinking|>${THOUGHT}<|end_message|><|message_model|><|content_text|>391<|end_message|><|content_model_end_sampling|>`;
const CALL_THOUGHT = 'Need use get_weather tool. Choose celsius.';
const CALL = `<|message_model|><|content_thinking|>${CALL_THOUGHT}<|end_message|><|message_model|>get_weather<|content_invoke_tool_json|>{"name":"get_weather","args":{"city":"Valencia","unit":"celsius"}}<|end_message|><|content_model_end_sampling|>`;

const KNOWN = new Set(['get_weather', 'write_file']);

function translate(chunks: string[]): string {
  const stream = new InklingMessageStream();
  return chunks.map((chunk) => stream.push(chunk)).join('') + stream.flush();
}

/** Every way of cutting `text` into two chunks, plus one character at a time. */
function splits(text: string): string[][] {
  const out: string[][] = [[...text]];
  for (let i = 1; i < text.length; i++) out.push([text.slice(0, i), text.slice(i)]);
  return out;
}

/** The provider's order: translator, then stripper, then the live reasoning split. */
function pipeline(chunks: string[]) {
  const inkling = new InklingMessageStream();
  const stripper = new LeakyToolCallStripper();
  const split = new StreamingReasoningSplit({ opensInReasoning: false });
  let raw = '';
  let visible = '';
  let reasoning = '';
  const take = (text: string) => {
    raw += text;
    const live = split.push(text);
    visible += live.visible;
    reasoning += live.reasoning;
  };
  for (const chunk of chunks) take(stripper.push(inkling.push(chunk)));
  take(stripper.push(inkling.flush()) + stripper.flush());
  const rest = split.flush();
  visible += rest.visible;
  reasoning += rest.reasoning;
  return { raw, visible, reasoning, stripper };
}

describe('InklingMessageStream', () => {
  it('turns thinking into a think block and unwraps the reply', () => {
    expect(translate([ANSWER])).toBe(`<think>${THOUGHT}</think>391`);
  });

  it('turns a tool call into the marker the stripper captures', () => {
    expect(translate([CALL])).toBe(
      `<think>${CALL_THOUGHT}</think><|tool_call|>get_weather{"city":"Valencia","unit":"celsius"}<tool_call|>`,
    );
  });

  it('gives the same result however the stream is chunked', () => {
    for (const fixture of [ANSWER, CALL]) {
      const whole = translate([fixture]);
      for (const chunks of splits(fixture)) expect(translate(chunks)).toBe(whole);
    }
  });

  it('closes thinking the turn ended inside, so it stays reasoning', () => {
    expect(translate(['<|message_model|><|content_thinking|>Still weighing'])).toBe(
      '<think>Still weighing</think>',
    );
  });

  it('drops everything after the end of the turn or a turn written for someone else', () => {
    expect(translate([`${ANSWER}leftover`])).toBe(`<think>${THOUGHT}</think>391`);
    expect(
      translate(['<|message_model|><|content_text|>Done.<|end_message|><|message_user|>Thanks']),
    ).toBe('Done.');
  });

  it('separates two reply segments with a blank line', () => {
    expect(
      translate([
        '<|message_model|><|content_text|>First.<|end_message|><|message_model|><|content_text|>Second.<|end_message|>',
      ]),
    ).toBe('First.\n\nSecond.');
  });

  it('passes ordinary text through, including a lone angle bracket', () => {
    expect(translate(['x < y', ' and it ends with <'])).toBe('x < y and it ends with <');
  });

  it('treats a role token followed by prose as prose', () => {
    const prose = `Sorry, ${'that went wrong. '.repeat(10)}`;
    expect(translate([`<|message_model|>${prose}`])).toBe(prose);
  });
});

describe('Inkling through the MLX stream filters', () => {
  it('streams the reply as visible and the thinking as reasoning', () => {
    for (const chunks of splits(ANSWER)) {
      const out = pipeline(chunks);
      expect(out.visible).toBe('391');
      expect(out.reasoning).toBe(THOUGHT);
      expect(extractReasoning(out.raw)).toEqual({ visible: '391', reasoning: THOUGHT });
    }
  });

  it('hands a tool call to the marker repair and shows none of it', () => {
    for (const chunks of splits(CALL)) {
      const out = pipeline(chunks);
      expect(out.visible).toBe('');
      expect(out.reasoning).toBe(CALL_THOUGHT);
      const bodies = out.stripper.getStrippedBodies();
      expect(bodies).toHaveLength(1);
      expect(parseGemmaToolCall(bodies[0]!, KNOWN)).toEqual({
        name: 'get_weather',
        arguments: { city: 'Valencia', unit: 'celsius' },
      });
    }
  });

  it('keeps an argument that mentions the stripper marker intact', () => {
    const content = 'Gemma closes calls with <tool_call|> and opens them with <|tool_call|>.';
    const out = pipeline([
      `<|message_model|>write_file<|content_invoke_tool_json|>${JSON.stringify({ name: 'write_file', args: { path: 'notes.md', content } })}<|end_message|>`,
    ]);
    const bodies = out.stripper.getStrippedBodies();
    expect(bodies).toHaveLength(1);
    expect(parseGemmaToolCall(bodies[0]!, KNOWN)?.arguments).toEqual({ path: 'notes.md', content });
  });

  it('repairs a body whose string value carries raw newlines', () => {
    const out = pipeline([
      '<|message_model|>write_file<|content_invoke_tool_json|>{"name":"write_file","args":{"path":"a.md","content":"line one\nline two"}}<|end_message|>',
    ]);
    expect(parseGemmaToolCall(out.stripper.getStrippedBodies()[0]!, KNOWN)?.arguments).toEqual({
      path: 'a.md',
      content: 'line one\nline two',
    });
  });

  it('records a tool call the turn ended inside as cut off', () => {
    const out = pipeline([
      '<|message_model|>write_file<|content_invoke_tool_json|>{"name":"write_file","args":{"path":"a.md","content":"partial',
    ]);
    expect(out.visible).toBe('');
    expect(out.stripper.getStrippedBodies()).toEqual([
      'write_file{"path":"a.md","content":"partial',
    ]);
    expect([...out.stripper.getEosFlushedBodyIndices()]).toEqual([0]);
  });
});

describe('templateTextUsesInklingMessages', () => {
  it('recognizes Inkling and nothing else', () => {
    expect(
      templateTextUsesInklingMessages(
        '{{- "<|message_model|>" ~ fn.name ~ "<|content_invoke_tool_json|>" -}}',
      ),
    ).toBe(true);
    expect(templateTextUsesInklingMessages('<|channel>thought\n<channel|><|tool_call>')).toBe(
      false,
    );
    expect(templateTextUsesInklingMessages('{%- if add_generation_prompt %}<think>\n')).toBe(false);
  });
});

describe('MlxProvider with an Inkling model', () => {
  const sessions: LLMSession[] = [];
  afterEach(async () => {
    await Promise.all(sessions.splice(0).map((session) => session.disconnect()));
  });

  function stream(text: string): Response {
    const frames = (text.match(/[\s\S]{1,7}/g) ?? []).map(
      (content) =>
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`,
    );
    frames.push(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '' }, finish_reason: 'stop' }] })}\n\n`,
      'data: [DONE]\n\n',
    );
    return new Response(frames.join(''), { headers: { 'content-type': 'text/event-stream' } });
  }

  async function turn(text: string, opts: { inklingMessages: boolean; tools?: boolean }) {
    const provider = new MlxProvider({
      baseUrl: 'http://engine.test',
      fetchImpl: vi.fn().mockResolvedValue(stream(text)) as unknown as typeof fetch,
      ...(opts.inklingMessages ? { inklingMessages: true } : {}),
    });
    const session = await provider.createSession({
      systemMessage: 'Be brief.',
      profile: {
        catalogId: 'inkling2-mini-26b-nvfp4',
        tier: 'medium',
        style: { family: 'other', reasoningFormat: 'think', toolCallFormat: 'function-call' },
        behaviors: [],
      },
      ...(opts.tools
        ? {
            externalTools: [
              {
                name: 'get_weather',
                description: 'Get the current weather for a city.',
                parameters: {
                  type: 'object',
                  properties: { city: { type: 'string' }, unit: { type: 'string' } },
                  required: ['city'],
                },
              },
            ],
          }
        : {}),
    });
    sessions.push(session);
    let visible = '';
    let reasoning = '';
    session.onDelta((chunk) => {
      visible += chunk;
    });
    session.onReasoningDelta?.((chunk) => {
      reasoning += chunk;
    });
    const reply = await session.sendAndWait('Go.', { timeoutMs: 5_000 });
    return { visible, reasoning, reply, calls: session.capturedToolCalls?.() ?? [] };
  }

  it('shows only the answer, with the thinking on the reasoning channel', async () => {
    const out = await turn(ANSWER, { inklingMessages: true });
    expect(out.visible).toBe('391');
    expect(out.reasoning).toBe(THOUGHT);
    expect(out.reply).toBe('391');
  });

  it('captures the tool call without streaming any of its markup', async () => {
    const out = await turn(CALL, { inklingMessages: true, tools: true });
    expect(out.visible).toBe('');
    expect(out.reasoning).toBe(CALL_THOUGHT);
    expect(out.calls).toHaveLength(1);
    expect(out.calls[0]!.name).toBe('get_weather');
    expect(JSON.parse(out.calls[0]!.arguments)).toEqual({ city: 'Valencia', unit: 'celsius' });
  });

  it('leaves other models alone', async () => {
    const out = await turn('<think>Plain.</think>Hello!', { inklingMessages: false });
    expect(out.visible).toBe('Hello!');
    expect(out.reply).toBe('Hello!');
  });
});
