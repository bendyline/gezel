import { describe, expect, it } from 'vitest';
import {
  ChatCompletionRequestSchema,
  flattenTranscriptIntoPrompt,
  resolveModelTarget,
  translateMessages,
} from './translate.js';

describe('ChatCompletionRequestSchema', () => {
  it('accepts a minimal valid request', () => {
    const result = ChatCompletionRequestSchema.safeParse({
      model: 'copilot:gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(result.success).toBe(true);
  });

  it('rejects empty messages', () => {
    const result = ChatCompletionRequestSchema.safeParse({
      model: 'copilot:gpt-4o',
      messages: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing model', () => {
    const result = ChatCompletionRequestSchema.safeParse({
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(result.success).toBe(false);
  });

  it('accepts but does not require optional sampling params', () => {
    const result = ChatCompletionRequestSchema.safeParse({
      model: 'copilot:gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.7,
      max_tokens: 256,
      stream: true,
    });
    expect(result.success).toBe(true);
  });

  it('parses max_completion_tokens, n, and stream_options (route guards decide their fate)', () => {
    const result = ChatCompletionRequestSchema.safeParse({
      model: 'copilot:gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
      max_completion_tokens: 512,
      n: 3,
      stream: true,
      stream_options: { include_usage: true },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.max_completion_tokens).toBe(512);
      expect(result.data.n).toBe(3);
      expect(result.data.stream_options?.include_usage).toBe(true);
    }
  });

  it('accepts the developer role (OpenAI successor to system)', () => {
    const result = ChatCompletionRequestSchema.safeParse({
      model: 'copilot:gpt-4o',
      messages: [
        { role: 'developer', content: 'be terse' },
        { role: 'user', content: 'hi' },
      ],
    });
    expect(result.success).toBe(true);
  });
});

describe('translateMessages — developer role', () => {
  it('folds developer messages into the system message like system messages', () => {
    const result = translateMessages([
      { role: 'developer', content: 'be terse' },
      { role: 'system', content: 'be kind' },
      { role: 'user', content: 'hi' },
    ]);
    expect(result.systemMessage).toBe('be terse\n\nbe kind');
    expect(result.prompt).toBe('hi');
    expect(result.priorMessages).toEqual([]);
  });
});

describe('translateMessages — tool message content parts', () => {
  it('accepts a content-part array on tool results and concatenates text parts', () => {
    const result = translateMessages([
      { role: 'user', content: 'check the weather' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{}' } },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'call_1',
        content: [
          { type: 'text', text: 'sunny,' },
          { type: 'text', text: '21C' },
        ],
      },
    ]);
    const toolEntry = result.priorMessages.find((m) => m.role === 'tool');
    expect(toolEntry).toMatchObject({ content: 'sunny,\n21C', toolCallId: 'call_1' });
  });
});

describe('flattenTranscriptIntoPrompt', () => {
  it('returns the input unchanged when there is no history', () => {
    const input = {
      systemMessage: 'sys',
      prompt: 'hi',
      priorMessages: [],
      attachments: [],
    };
    expect(flattenTranscriptIntoPrompt(input)).toBe(input);
  });

  it('folds user/assistant history into the prompt and clears priorMessages', () => {
    const result = flattenTranscriptIntoPrompt({
      systemMessage: 'sys',
      prompt: 'and now?',
      priorMessages: [
        { role: 'user', content: 'what is 2+2?' },
        { role: 'assistant', content: '4' },
      ],
      attachments: [],
    });
    expect(result.priorMessages).toEqual([]);
    expect(result.systemMessage).toBe('sys');
    expect(result.prompt).toContain('User: what is 2+2?');
    expect(result.prompt).toContain('Assistant: 4');
    // The in-flight turn comes last, after the history block.
    expect(result.prompt.endsWith('User: and now?')).toBe(true);
  });

  it('renders tool results and assistant tool calls as labeled text', () => {
    const result = flattenTranscriptIntoPrompt({
      systemMessage: '',
      prompt: '',
      priorMessages: [
        { role: 'user', content: 'check the weather' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call_1', name: 'get_weather', arguments: '{"city":"Delft"}' }],
        },
        { role: 'tool', content: 'sunny, 21C', toolCallId: 'call_1' },
      ],
      attachments: [],
    });
    expect(result.prompt).toContain('get_weather({"city":"Delft"})');
    expect(result.prompt).toContain('Tool result (call_1): sunny, 21C');
    // Empty in-flight prompt (tool-result-last request) gets an explicit
    // continuation instruction instead of a dangling "User:" line.
    expect(result.prompt).toContain('Continue the conversation');
  });
});

describe('resolveModelTarget', () => {
  it('parses a qualified provider:model id', () => {
    expect(resolveModelTarget('llama-cpp:qwen3-4b-instruct')).toEqual({
      provider: 'llama-cpp',
      model: 'qwen3-4b-instruct',
      echoModel: 'llama-cpp:qwen3-4b-instruct',
    });
  });

  it('accepts a slash separator as a convenience for OpenAI clients', () => {
    expect(resolveModelTarget('ollama/llama3.1:8b')?.provider).toBe('ollama');
    // The colon AFTER the slash is preserved as part of the model name.
    expect(resolveModelTarget('ollama/llama3.1:8b')?.model).toBe('llama3.1:8b');
  });

  it('accepts a bare provider name as a request to use that provider default', () => {
    expect(resolveModelTarget('copilot')).toEqual({
      provider: 'copilot',
      model: undefined,
      echoModel: 'copilot',
    });
  });

  it('returns null for an unknown provider prefix', () => {
    expect(resolveModelTarget('unknownprovider:foo')).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(resolveModelTarget('')).toBeNull();
    expect(resolveModelTarget('   ')).toBeNull();
  });

  it('trims trailing whitespace from the model name but keeps the echo intact', () => {
    const r = resolveModelTarget('mlx: qwen3-4b ');
    expect(r?.provider).toBe('mlx');
    expect(r?.model).toBe('qwen3-4b');
    expect(r?.echoModel).toBe('mlx: qwen3-4b ');
  });

  it('treats a bare non-provider string as unknown (does NOT default to copilot)', () => {
    // The /api/models route's parseProvider defaults to copilot for
    // unknown query strings; /v1 explicitly refuses so callers see a
    // clear "model_not_found" rather than silently hitting the wrong
    // provider.
    expect(resolveModelTarget('gpt-4')).toBeNull();
  });
});

describe('translateMessages', () => {
  it('splits a typical user-only conversation into system + prompt', () => {
    const result = translateMessages([
      { role: 'system', content: 'You are concise.' },
      { role: 'user', content: 'What is 2+2?' },
    ]);
    expect(result.systemMessage).toBe('You are concise.');
    expect(result.prompt).toBe('What is 2+2?');
    expect(result.priorMessages).toEqual([]);
  });

  it('threads prior turns into priorMessages and uses the LAST message as the prompt', () => {
    const result = translateMessages([
      { role: 'system', content: 'system' },
      { role: 'user', content: 'turn1' },
      { role: 'assistant', content: 'reply1' },
      { role: 'user', content: 'turn2' },
    ]);
    expect(result.systemMessage).toBe('system');
    expect(result.priorMessages).toEqual([
      { role: 'user', content: 'turn1' },
      { role: 'assistant', content: 'reply1' },
    ]);
    expect(result.prompt).toBe('turn2');
  });

  it('concatenates multiple system messages with blank-line separators', () => {
    const result = translateMessages([
      { role: 'system', content: 'first' },
      { role: 'system', content: 'second' },
      { role: 'user', content: 'go' },
    ]);
    expect(result.systemMessage).toBe('first\n\nsecond');
  });

  it('produces an empty systemMessage when no system entries are present', () => {
    const result = translateMessages([{ role: 'user', content: 'hi' }]);
    expect(result.systemMessage).toBe('');
    expect(result.prompt).toBe('hi');
  });

  it('rejects a system-only conversation', () => {
    expect(() => translateMessages([{ role: 'system', content: 'sys' }])).toThrow(
      /must include at least one non-system entry/,
    );
  });

  it('rejects an empty last-message content', () => {
    expect(() =>
      translateMessages([
        { role: 'system', content: 'sys' },
        { role: 'user', content: '   ' },
      ]),
    ).toThrow(/last message/);
  });
});
