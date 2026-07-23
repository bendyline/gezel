import { describe, expect, it } from 'vitest';
import { GezelApp } from './client.js';
import { GezelSdkError } from './errors.js';

function streamFromText(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(encoder.encode(text));
      c.close();
    },
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function sseResponse(text: string): Response {
  return new Response(streamFromText(text), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

/** Build a fetch that returns the given response for the next call only. */
function singleResponse(response: Response): typeof fetch {
  let consumed = false;
  return (async () => {
    if (consumed) throw new Error('fetch called twice');
    consumed = true;
    return response;
  }) as unknown as typeof fetch;
}

function recordingFetch(response: Response): {
  fetch: typeof fetch;
  calls: Array<{ url: string; init: RequestInit }>;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const f = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    return response;
  }) as unknown as typeof fetch;
  return { fetch: f, calls };
}

describe('GezelApp.chat — non-streaming', () => {
  it('POSTs to /v1/chat/completions and returns the OpenAI envelope', async () => {
    const envelope = {
      id: 'chatcmpl-x',
      object: 'chat.completion',
      created: 1,
      model: 'copilot:mock-fast',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'hi' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
    const { fetch, calls } = recordingFetch(jsonResponse(200, envelope));
    const app = new GezelApp({ baseUrl: 'http://x', token: 'tk', fetch });
    const res = await app.chat({
      model: 'copilot:mock-fast',
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(res).toEqual(envelope);
    expect(calls[0]?.url).toBe('http://x/v1/chat/completions');
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tk');
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('throws a GezelSdkError carrying status + code on a non-2xx', async () => {
    const app = new GezelApp({
      baseUrl: 'http://x',
      token: 'tk',
      fetch: singleResponse(
        jsonResponse(403, {
          error: {
            message: 'Tool calling is not supported in gezel /v1 yet.',
            code: 'tool_calling_not_supported_v1',
            type: 'invalid_request_error',
          },
        }),
      ),
    });
    try {
      await app.chat({
        model: 'copilot:mock-fast',
        messages: [{ role: 'user', content: 'x' }],
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(GezelSdkError);
      const e = err as GezelSdkError;
      expect(e.status).toBe(403);
      expect(e.code).toBe('tool_calling_not_supported_v1');
    }
  });
});

describe('GezelApp.chat — streaming', () => {
  it('yields parsed chunks until [DONE]', async () => {
    const sse = [
      'data: {"id":"x","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n',
      'data: {"id":"x","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"hel"},"finish_reason":null}]}\n\n',
      'data: {"id":"x","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":null}]}\n\n',
      'data: {"id":"x","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ].join('');

    const app = new GezelApp({
      baseUrl: 'http://x',
      token: 'tk',
      fetch: singleResponse(sseResponse(sse)),
    });
    const stream = await app.chat({
      model: 'copilot:mock-fast',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    });
    const chunks = [];
    for await (const c of stream) chunks.push(c);
    expect(chunks).toHaveLength(4);
    const reassembled = chunks.map((c) => c.choices[0]?.delta?.content ?? '').join('');
    expect(reassembled).toBe('hello');
    expect(chunks[chunks.length - 1]?.choices[0]?.finish_reason).toBe('stop');
  });

  it('throws a GezelSdkError when the stream contains an error envelope', async () => {
    const sse = [
      'data: {"id":"x","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n',
      'data: {"error":{"message":"provider died","code":"provider_error","type":"server_error"}}\n\n',
      'data: [DONE]\n\n',
    ].join('');
    const app = new GezelApp({
      baseUrl: 'http://x',
      token: 'tk',
      fetch: singleResponse(sseResponse(sse)),
    });
    const stream = await app.chat({
      model: 'copilot:mock-fast',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    });
    let saw: unknown;
    try {
      for await (const _ of stream) {
        /* drain */
      }
    } catch (err) {
      saw = err;
    }
    expect(saw).toBeInstanceOf(GezelSdkError);
    expect((saw as GezelSdkError).code).toBe('provider_error');
  });
});

describe('GezelApp.models', () => {
  it('GETs /v1/models', async () => {
    const { fetch, calls } = recordingFetch(
      jsonResponse(200, {
        object: 'list',
        data: [{ id: 'copilot:mock-fast', object: 'model', created: 1, owned_by: 'copilot' }],
      }),
    );
    const app = new GezelApp({ baseUrl: 'http://x', token: 'tk', fetch });
    const res = await app.models();
    expect(res.object).toBe('list');
    expect(res.data.map((m) => m.id)).toContain('copilot:mock-fast');
    expect(calls[0]?.url).toBe('http://x/v1/models');
  });
});

describe('GezelApp.ensureModel', () => {
  it('POSTs to /v1/models/ensure and returns the result', async () => {
    const { fetch, calls } = recordingFetch(
      jsonResponse(202, {
        status: 'downloading',
        model_id: 'llama-cpp:test',
        job_id: 'job-1',
      }),
    );
    const app = new GezelApp({ baseUrl: 'http://x', token: 'tk', fetch });
    const res = await app.ensureModel({ model: 'llama-cpp:test' });
    expect(res.status).toBe('downloading');
    expect(res.job_id).toBe('job-1');
    expect(calls[0]?.url).toBe('http://x/v1/models/ensure');
    expect(calls[0]?.init.method).toBe('POST');
  });
});

describe('GezelApp.streamEnsureEvents', () => {
  it('yields parsed events until terminal done', async () => {
    const sse = [
      'data: {"type":"progress","jobId":"j","modelId":"m","bytesWritten":10,"totalBytes":100}\n\n',
      'data: {"type":"progress","jobId":"j","modelId":"m","bytesWritten":100,"totalBytes":100}\n\n',
      'data: {"type":"done","jobId":"j","modelId":"m"}\n\n',
    ].join('');
    const app = new GezelApp({
      baseUrl: 'http://x',
      token: 'tk',
      fetch: singleResponse(sseResponse(sse)),
    });
    const events = [];
    for await (const ev of app.streamEnsureEvents('j')) events.push(ev);
    expect(events.map((e) => e.type)).toEqual(['progress', 'progress', 'done']);
  });
});

describe('GezelApp.embeddings', () => {
  it('POSTs to /v1/embeddings and returns the OpenAI envelope', async () => {
    const envelope = {
      object: 'list',
      data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2, 0.3] }],
      model: 'copilot:mock-embedding',
      usage: { prompt_tokens: 5, total_tokens: 5 },
      id: 'embd-abc',
    };
    const { fetch, calls } = recordingFetch(jsonResponse(200, envelope));
    const app = new GezelApp({ baseUrl: 'http://x', token: 'tk', fetch });
    const res = await app.embeddings({
      model: 'copilot:mock-embedding',
      input: 'hello',
    });
    expect(res).toEqual(envelope);
    expect(calls[0]?.url).toBe('http://x/v1/embeddings');
    expect(calls[0]?.init.method).toBe('POST');
  });

  it('surfaces embeddings_not_supported as a GezelSdkError', async () => {
    const app = new GezelApp({
      baseUrl: 'http://x',
      token: 'tk',
      fetch: singleResponse(
        jsonResponse(400, {
          error: {
            message: 'Provider "anthropic-cli" does not support embeddings.',
            code: 'embeddings_not_supported',
            type: 'invalid_request_error',
          },
        }),
      ),
    });
    try {
      await app.embeddings({ model: 'anthropic-cli:claude', input: 'x' });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(GezelSdkError);
      const e = err as GezelSdkError;
      expect(e.code).toBe('embeddings_not_supported');
      expect(e.status).toBe(400);
    }
  });
});

describe('GezelApp.revokeMyToken', () => {
  it('DELETEs /v1/apps/:appId/token', async () => {
    const { fetch, calls } = recordingFetch(jsonResponse(200, { ok: true }));
    const app = new GezelApp({ baseUrl: 'http://x', token: 'tk', fetch });
    await app.revokeMyToken('docblocks');
    expect(calls[0]?.url).toBe('http://x/v1/apps/docblocks/token');
    expect(calls[0]?.init.method).toBe('DELETE');
  });
});
