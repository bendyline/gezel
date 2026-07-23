import { describe, expect, it } from 'vitest';
import { ChatCompletionRequestSchema, resolveModelTarget, translateMessages } from './translate.js';

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
