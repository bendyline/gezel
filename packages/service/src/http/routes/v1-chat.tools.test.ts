import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTrustingFetch } from '@bendyline/gezel-client/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockProvider } from '../../providers/mock.js';
import { type RunningService, startService } from '../../service.js';

let svc: RunningService;
let baseUrl: string;
let rootToken: string;
let home: string;
let httpFetch: typeof fetch;
let mockCopilot: MockProvider;

const priorMockFlag = process.env.GEZEL_MOCK_PROVIDER;

beforeAll(async () => {
  process.env.GEZEL_MOCK_PROVIDER = '1';
  home = await mkdtemp(join(tmpdir(), 'gezel-v1-tools-'));
  svc = await startService({ home });
  const scheme = svc.cert ? 'https' : 'http';
  baseUrl = `${scheme}://127.0.0.1:${svc.port}`;
  rootToken = svc.context.token;
  httpFetch = svc.cert ? createTrustingFetch({ cert: svc.cert.certPem }) : fetch;

  // The service builds its mock providers inside `service.ts` when
  // GEZEL_MOCK_PROVIDER=1. Pull the copilot mock back out of the chat
  // manager so the test can script tool calls + responses on it.
  const provider = await svc.context.chat.getProvider('copilot');
  if (!(provider instanceof MockProvider)) {
    throw new Error('expected MockProvider for copilot in test env');
  }
  mockCopilot = provider;
}, 30_000);

afterAll(async () => {
  await svc.stop();
  await rm(home, { recursive: true, force: true }).catch(() => {});
  if (priorMockFlag === undefined) delete process.env.GEZEL_MOCK_PROVIDER;
  else process.env.GEZEL_MOCK_PROVIDER = priorMockFlag;
}, 30_000);

function v1(
  method: string,
  path: string,
  opts: { body?: unknown; token?: string } = {},
): Promise<Response> {
  return httpFetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
}

const WEATHER_TOOL = {
  type: 'function' as const,
  function: {
    name: 'get_weather',
    description: 'Look up the current weather for a city.',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
    },
  },
};

const WRITE_TOOL = {
  type: 'function' as const,
  function: {
    name: 'write',
    description: 'Write one file.',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['filePath', 'content'],
    },
  },
};

describe('POST /v1/chat/completions — tool calling (round-trip)', () => {
  it('Turn 1: model emits a tool call → response carries tool_calls + finish_reason=tool_calls', async () => {
    mockCopilot.scriptExternalToolCalls([
      { id: 'call_1', name: 'get_weather', arguments: '{"city":"Amsterdam"}' },
    ]);
    const res = await v1('POST', '/v1/chat/completions', {
      body: {
        model: 'copilot:mock-fast',
        messages: [{ role: 'user', content: 'What is the weather in Amsterdam?' }],
        tools: [WEATHER_TOOL],
      },
      token: rootToken,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      choices: Array<{
        message: {
          role: string;
          tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
        };
        finish_reason: string;
      }>;
    };
    expect(body.choices[0]?.finish_reason).toBe('tool_calls');
    const tcs = body.choices[0]?.message.tool_calls;
    expect(tcs).toHaveLength(1);
    expect(tcs?.[0]?.id).toBe('call_1');
    expect(tcs?.[0]?.function.name).toBe('get_weather');
    expect(JSON.parse(tcs?.[0]?.function.arguments ?? '{}')).toEqual({
      city: 'Amsterdam',
    });
  });

  it("Turn 2: tool result posted back with role:'tool' resolves to a plain text response", async () => {
    // No scripted external tool calls this time — falls through to
    // the normal scripted response branch, which echoes the prompt.
    const res = await v1('POST', '/v1/chat/completions', {
      body: {
        model: 'copilot:mock-fast',
        messages: [
          { role: 'user', content: 'What is the weather in Amsterdam?' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'get_weather', arguments: '{"city":"Amsterdam"}' },
              },
            ],
          },
          {
            role: 'tool',
            tool_call_id: 'call_1',
            content: '12 degrees, light rain',
          },
        ],
        tools: [WEATHER_TOOL],
      },
      token: rootToken,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      choices: Array<{
        message: { role: string; content: string; tool_calls?: unknown };
        finish_reason: string;
      }>;
    };
    // Mock provider returns its default reply because there's no
    // scripted external call. We just verify the round-trip succeeds.
    expect(body.choices[0]?.finish_reason).toBe('stop');
    expect(body.choices[0]?.message.tool_calls).toBeUndefined();
  });

  it('injects a path-scoped action ledger into a file-write continuation', async () => {
    const callStart = mockCopilot.calls.length;
    const res = await v1('POST', '/v1/chat/completions', {
      body: {
        model: 'copilot:mock-fast',
        messages: [
          { role: 'user', content: 'Build index.html, css/style.css, and js/app.js.' },
          {
            role: 'assistant',
            content: 'I will create all three files.',
            tool_calls: [
              {
                id: 'call-index',
                type: 'function',
                function: {
                  name: 'write',
                  arguments: '{"filePath":"/tmp/site/index.html","content":"<html>"}',
                },
              },
            ],
          },
          { role: 'tool', tool_call_id: 'call-index', content: 'Wrote file successfully.' },
        ],
        tools: [WRITE_TOOL],
      },
      token: rootToken,
    });

    expect(res.status).toBe(200);
    const create = mockCopilot.calls.slice(callStart).find((call) => call.kind === 'create');
    const providerInput = JSON.stringify(create?.opts?.priorMessages ?? []);
    expect(providerInput).toContain('[Gezel caller-owned action ledger]');
    expect(providerInput).toContain('write (call-index) -> \\"/tmp/site/index.html\\"');
    expect(providerInput).toContain('Planned or narrated actions are not receipts');
    expect(providerInput).not.toMatch(/-> .*css\/style\.css/u);
    expect(providerInput).not.toMatch(/-> .*js\/app\.js/u);
  });

  it('Streaming: emits a delta chunk with tool_calls then finishes with finish_reason=tool_calls', async () => {
    mockCopilot.scriptExternalToolCalls([
      { id: 'call_s', name: 'get_weather', arguments: '{"city":"Berlin"}' },
    ]);
    const res = await v1('POST', '/v1/chat/completions', {
      body: {
        model: 'copilot:mock-fast',
        messages: [{ role: 'user', content: 'Berlin weather?' }],
        tools: [WEATHER_TOOL],
        stream: true,
      },
      token: rootToken,
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    const dataLines = text
      .split(/\n/)
      .filter((line) => line.startsWith('data: '))
      .map((line) => line.slice('data: '.length));
    expect(dataLines[dataLines.length - 1]).toBe('[DONE]');
    const chunks = dataLines.slice(0, -1).map((d) => JSON.parse(d));
    const toolCallChunk = chunks.find((c) => c.choices[0]?.delta?.tool_calls);
    expect(toolCallChunk).toBeTruthy();
    expect(toolCallChunk.choices[0].delta.tool_calls[0].function.name).toBe('get_weather');
    const final = chunks[chunks.length - 1];
    expect(final.choices[0].finish_reason).toBe('tool_calls');
  });

  it('an uninstalled local model 404s before any provider/tool-support evaluation', async () => {
    const res = await v1('POST', '/v1/chat/completions', {
      body: {
        model: 'llama-cpp:nope',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [WEATHER_TOOL],
      },
      token: rootToken,
    });
    // The engine-pool route validates the model id against the local
    // catalog before resolving a provider — an uninstalled id is a
    // deterministic 404 (formerly a flaky 400/500 from provider-init
    // failure), and no engine spawn is ever attempted.
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('model_not_found');
  });

  it('string tool_choice is accepted (honored via the tuning layer)', async () => {
    const res = await v1('POST', '/v1/chat/completions', {
      body: {
        model: 'copilot:mock-fast',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [WEATHER_TOOL],
        tool_choice: 'auto',
      },
      token: rootToken,
    });
    expect(res.status).toBe(200);
  });

  it('rejects an assistant-as-last-message request', async () => {
    const res = await v1('POST', '/v1/chat/completions', {
      body: {
        model: 'copilot:mock-fast',
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'reply' },
        ],
      },
      token: rootToken,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('empty_prompt');
  });
});
