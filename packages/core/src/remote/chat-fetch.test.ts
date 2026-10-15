import { describe, expect, it, vi } from 'vitest';
import { inferRequestFromChat, remoteChatFetch } from './chat-fetch.js';
import type { RemoteInferRequest } from './wire.js';

const MODEL = 'llama-cpp:qwen3.6-27b';

function sse(...events: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of events) controller.enqueue(encoder.encode(event));
        controller.close();
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  );
}

const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;

async function readAll(response: Response): Promise<string> {
  return await response.text();
}

function chatFetch(
  upstream: typeof fetch,
  extra: Partial<Parameters<typeof remoteChatFetch>[0]> = {},
) {
  return remoteChatFetch({
    fetch: upstream,
    baseUrl: 'https://192.168.1.20:6229',
    token: 'device-token',
    model: MODEL,
    serverName: 'Werkbank',
    ...extra,
  });
}

const chatBody = (messages: unknown[], tools?: unknown[]) =>
  JSON.stringify({ model: 'x', stream: true, messages, ...(tools ? { tools } : {}) });

describe('inferRequestFromChat', () => {
  it('splits the system prompt, volatile band, history, and this turn', () => {
    const request = inferRequestFromChat(
      {
        messages: [
          { role: 'system', content: 'You are Ada.' },
          { role: 'system', content: 'Today is Thursday.' },
          { role: 'user', content: 'Earlier question' },
          { role: 'assistant', content: 'Earlier answer' },
          { role: 'user', content: 'What now?' },
        ],
        tools: [
          {
            type: 'function',
            function: { name: 'read_file', description: 'Read', parameters: { type: 'object' } },
          },
        ],
      },
      { model: MODEL, queue: { sessionId: 's1' } },
    );
    expect(request).toMatchObject({
      model: MODEL,
      systemMessage: 'You are Ada.',
      volatileContext: 'Today is Thursday.',
      prompt: 'What now?',
      priorMessages: [
        { role: 'user', content: 'Earlier question' },
        { role: 'assistant', content: 'Earlier answer' },
      ],
      tools: [{ name: 'read_file', description: 'Read', parameters: { type: 'object' } }],
      queue: { lane: 'interactive', sessionId: 's1', affinity: true },
    });
  });

  it('continues after a tool result with an empty prompt and the call in history', () => {
    const request = inferRequestFromChat(
      {
        messages: [
          { role: 'system', content: 'sys' },
          { role: 'user', content: 'Read it' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'c1', function: { name: 'read_file', arguments: '{"path":"a"}' } }],
          },
          { role: 'tool', tool_call_id: 'c1', content: 'file text' },
        ],
      },
      { model: MODEL },
    );
    expect(request.prompt).toBe('');
    expect(request.priorMessages).toEqual([
      { role: 'user', content: 'Read it' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'read_file', arguments: '{"path":"a"}' }],
      },
      { role: 'tool', content: 'file text', toolCallId: 'c1' },
    ]);
  });

  it('carries images as attachments now and as history later', () => {
    const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } };
    const now = inferRequestFromChat(
      { messages: [{ role: 'user', content: [{ type: 'text', text: 'What is this?' }, image] }] },
      { model: MODEL },
    );
    expect(now.attachments).toEqual([
      { base64: 'AAAA', mimeType: 'image/png', filename: 'image-1' },
    ]);
    const later = inferRequestFromChat(
      {
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'What is this?' }, image] },
          { role: 'assistant', content: 'A dot.' },
          { role: 'user', content: 'Thanks' },
        ],
      },
      { model: MODEL },
    );
    expect(later.priorMessages[0]).toEqual({
      role: 'user',
      content: 'What is this?',
      images: ['AAAA'],
    });
    expect(later.protocolVersion).toBe(2);
  });
});

describe('remoteChatFetch', () => {
  it('streams the server frames back as chat-completion chunks', async () => {
    let sent: RemoteInferRequest | undefined;
    const upstream = vi.fn(async (_url: unknown, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body));
      return sse(
        ': keepalive\n\n',
        frame({ type: 'reasoning_delta', text: 'Hmm.' }),
        frame({ type: 'delta', text: 'Hel' }),
        frame({ type: 'delta', text: 'lo' }),
        frame({ type: 'usage', model: MODEL, inputTokens: 10, outputTokens: 2 }),
        frame({ type: 'done' }),
      );
    }) as unknown as typeof fetch;
    const response = await chatFetch(upstream)('gezel-remote://x/v1/chat/completions', {
      method: 'POST',
      body: chatBody([{ role: 'user', content: 'Hi' }]),
    });
    const text = await readAll(response);
    expect(sent?.prompt).toBe('Hi');
    expect(text).toContain('"reasoning_content":"Hmm."');
    expect(text).toContain('"content":"Hel"');
    expect(text).toContain('"prompt_tokens":10');
    expect(text).toContain('"finish_reason":"stop"');
    expect(text.trim().endsWith('data: [DONE]')).toBe(true);
    expect(text).toContain(': keepalive');
  });

  it('hands tool calls back for the local loop to run', async () => {
    const upstream = (async () =>
      sse(
        frame({
          type: 'tool_call',
          calls: [{ id: 'c1', name: 'read_file', arguments: '{"path":"a.md"}' }],
        }),
        frame({ type: 'done' }),
      )) as unknown as typeof fetch;
    const text = await readAll(
      await chatFetch(upstream)('x://h/v1/chat/completions', {
        method: 'POST',
        body: chatBody([{ role: 'user', content: 'Read a.md' }]),
      }),
    );
    expect(text).toContain('"tool_calls":[{"index":0,"id":"c1","type":"function"');
    expect(text).toContain('"finish_reason":"tool_calls"');
  });

  it('waits out a busy server instead of failing the turn', async () => {
    let calls = 0;
    const upstream = (async () => {
      calls += 1;
      if (calls === 1) {
        return new Response('{"error":"engine_busy"}', {
          status: 503,
          headers: { 'retry-after': '0.01' },
        });
      }
      return sse(frame({ type: 'delta', text: 'ok' }), frame({ type: 'done' }));
    }) as unknown as typeof fetch;
    const text = await readAll(
      await chatFetch(upstream)('x://h/v1/chat/completions', {
        method: 'POST',
        body: chatBody([{ role: 'user', content: 'Hi' }]),
      }),
    );
    expect(calls).toBe(2);
    expect(text).toContain('"content":"ok"');
  });

  it('names an unreachable server in words and reports it', async () => {
    const onReachability = vi.fn();
    const onFailure = vi.fn();
    const upstream = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const response = await chatFetch(upstream, { onReachability, onFailure })(
      'x://h/v1/chat/completions',
      { method: 'POST', body: chatBody([{ role: 'user', content: 'Hi' }]) },
    );
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("Werkbank isn't reachable right now");
    expect(onReachability).toHaveBeenCalledWith(false);
    expect(onFailure).toHaveBeenCalledWith(expect.stringContaining("Werkbank isn't reachable"));
  });

  it('ends a reply whose server proved it heartbeats and then went silent', async () => {
    const encoder = new TextEncoder();
    const upstream = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(': keepalive\n\n'));
            controller.enqueue(encoder.encode(frame({ type: 'delta', text: 'Hal' })));
            // …and then nothing, ever.
          },
        }),
        { status: 200 },
      )) as unknown as typeof fetch;
    const text = await readAll(
      await chatFetch(upstream, { idleMs: 40 })('x://h/v1/chat/completions', {
        method: 'POST',
        body: chatBody([{ role: 'user', content: 'Hi' }]),
      }),
    );
    expect(text).toContain('"content":"Hal"');
    expect(text).toContain('Werkbank stopped responding partway through this reply');
  });

  it('says which model a server lacks', async () => {
    const upstream = (async () =>
      new Response('{"error":"model_not_loaded","model":"x"}', {
        status: 404,
      })) as unknown as typeof fetch;
    const response = await chatFetch(upstream)('x://h/v1/chat/completions', {
      method: 'POST',
      body: chatBody([{ role: 'user', content: 'Hi' }]),
    });
    expect(response.status).toBe(404);
    expect(await response.text()).toContain("Werkbank doesn't have this model ready to run");
  });
});
