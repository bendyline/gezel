import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTrustingFetch } from '@bendyline/gezel-client/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningService, startService } from '../../service.js';

let svc: RunningService;
let baseUrl: string;
let rootToken: string;
let home: string;
let httpFetch: typeof fetch;

const priorMockFlag = process.env.GEZEL_MOCK_PROVIDER;

beforeAll(async () => {
  process.env.GEZEL_MOCK_PROVIDER = '1';
  home = await mkdtemp(join(tmpdir(), 'gezel-v1-chat-'));
  svc = await startService({ home });
  const scheme = svc.cert ? 'https' : 'http';
  baseUrl = `${scheme}://127.0.0.1:${svc.port}`;
  rootToken = svc.context.token;
  httpFetch = svc.cert ? createTrustingFetch({ cert: svc.cert.certPem }) : fetch;
}, 30_000);

afterAll(async () => {
  await svc.stop();
  await rm(home, { recursive: true, force: true }).catch(() => {});
  if (priorMockFlag === undefined) delete process.env.GEZEL_MOCK_PROVIDER;
  else process.env.GEZEL_MOCK_PROVIDER = priorMockFlag;
}, 30_000);

interface ApiOpts {
  body?: unknown;
  token?: string;
  accept?: string;
}

function v1(method: string, path: string, opts: ApiOpts = {}): Promise<Response> {
  return httpFetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.accept ? { Accept: opts.accept } : {}),
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
}

async function registerAndApproveApp(
  appId: string,
  scopes: string[] = ['openai'],
): Promise<string> {
  const reg = await v1('POST', '/v1/apps/register', {
    body: { appId, appName: `${appId} App`, scopes },
  });
  expect(reg.status).toBe(201);
  const { grantRequestId } = (await reg.json()) as { grantRequestId: string };
  const approve = await v1('POST', `/v1/apps/grant/${grantRequestId}/approve`, {
    token: rootToken,
  });
  expect(approve.status).toBe(200);
  const poll = await v1('GET', `/v1/apps/grant/${grantRequestId}`);
  expect(poll.status).toBe(200);
  const result = (await poll.json()) as { token: string };
  return result.token;
}

describe('POST /v1/chat/completions — auth', () => {
  it('rejects requests with no token — OpenAI error envelope', async () => {
    const res = await v1('POST', '/v1/chat/completions', {
      body: { model: 'copilot:mock-fast', messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as {
      error: { message: string; type: string; code: string };
    };
    expect(body.error.code).toBe('invalid_api_key');
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.error.message).toContain('Connected Apps');
  });

  it('rejects requests with the wrong scope', async () => {
    // A session token is valid but deliberately lacks `openai`, exercising
    // the route-layer scope guard without minting a reserved UI credential
    // through the public app-token API.
    const issued = svc.context.tokenStore.issueSession({
      appId: 'session:wrong-scope',
      projectId: 'default',
      gezelId: 'wrong-scope-gezel',
      team: false,
    });
    const wrongScopeToken = issued.token;
    const res = await v1('POST', '/v1/chat/completions', {
      body: { model: 'copilot:mock-fast', messages: [{ role: 'user', content: 'hi' }] },
      token: wrongScopeToken,
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { type: string; code: string } };
    expect(body.error.code).toBe('missing_scope:openai');
    expect(body.error.type).toBe('permission_error');
  });

  it('accepts the root token', async () => {
    const res = await v1('POST', '/v1/chat/completions', {
      body: { model: 'copilot:mock-fast', messages: [{ role: 'user', content: 'hi' }] },
      token: rootToken,
    });
    expect(res.status).toBe(200);
  });
});

describe('POST /v1/chat/completions — non-streaming', () => {
  it('returns an OpenAI-shaped chat.completion response from the mock provider', async () => {
    const res = await v1('POST', '/v1/chat/completions', {
      body: {
        model: 'copilot:mock-fast',
        messages: [
          { role: 'system', content: 'be concise' },
          { role: 'user', content: 'what is 2+2?' },
        ],
      },
      token: rootToken,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      object: string;
      model: string;
      choices: Array<{
        index: number;
        message: { role: string; content: string };
        finish_reason: string;
      }>;
      usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    };
    expect(body.object).toBe('chat.completion');
    expect(body.model).toBe('copilot:mock-fast');
    expect(body.choices).toHaveLength(1);
    expect(body.choices[0]?.message.role).toBe('assistant');
    // MockProvider echoes "Mock reply: <prompt>"; the last message in
    // our request is "what is 2+2?".
    expect(body.choices[0]?.message.content).toContain('what is 2+2?');
    expect(body.choices[0]?.finish_reason).toBe('stop');
    expect(body.usage.total_tokens).toBe(body.usage.prompt_tokens + body.usage.completion_tokens);
  });

  it('works through a per-app token issued via the consent flow', async () => {
    const token = await registerAndApproveApp('chat-app-1');
    const res = await v1('POST', '/v1/chat/completions', {
      body: {
        model: 'copilot:mock-fast',
        messages: [{ role: 'user', content: 'ping' }],
      },
      token,
    });
    expect(res.status).toBe(200);
  });
});

describe('POST /v1/chat/completions — streaming', () => {
  it('streams OpenAI-shaped chunks terminated by [DONE]', async () => {
    const res = await v1('POST', '/v1/chat/completions', {
      body: {
        model: 'copilot:mock-fast',
        messages: [{ role: 'user', content: 'tell me a tale' }],
        stream: true,
      },
      token: rootToken,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);

    const text = await res.text();
    // Each SSE message is `data: <payload>\n\n`.
    const dataLines = text
      .split(/\n/)
      .filter((line) => line.startsWith('data: '))
      .map((line) => line.slice('data: '.length));
    expect(dataLines.length).toBeGreaterThan(2);
    expect(dataLines[dataLines.length - 1]).toBe('[DONE]');

    // First chunk should be the assistant-role opener.
    const first = JSON.parse(dataLines[0]!);
    expect(first.choices[0].delta.role).toBe('assistant');

    // Last non-DONE chunk should carry finish_reason=stop.
    const lastJson = JSON.parse(dataLines[dataLines.length - 2]!);
    expect(lastJson.choices[0].finish_reason).toBe('stop');

    // Middle chunks should carry content deltas.
    const contentChunks = dataLines.slice(1, -2).map((d) => JSON.parse(d));
    expect(contentChunks.length).toBeGreaterThan(0);
    const reassembled = contentChunks.map((c) => c.choices[0]?.delta?.content ?? '').join('');
    expect(reassembled).toContain('tell me a tale');
  });
});

describe('POST /v1/chat/completions — request validation', () => {
  it('accepts a tools[] field now that external tool calling is wired (mock provider supports it)', async () => {
    // No scripted external tool calls — the mock provider falls
    // through to its scripted response, but the route accepts the
    // request and returns 200. See v1-chat.tools.test.ts for the
    // full round-trip coverage.
    const res = await v1('POST', '/v1/chat/completions', {
      body: {
        model: 'copilot:mock-fast',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [
          {
            type: 'function',
            function: { name: 'do_thing', description: 'do the thing' },
          },
        ],
      },
      token: rootToken,
    });
    expect(res.status).toBe(200);
  });

  it('accepts response_format (honored via the tuning overlay)', async () => {
    const res = await v1('POST', '/v1/chat/completions', {
      body: {
        model: 'copilot:mock-fast',
        messages: [{ role: 'user', content: 'hi' }],
        response_format: { type: 'json_object' },
      },
      token: rootToken,
    });
    expect(res.status).toBe(200);
  });

  it('accepts per-request sampling params (honored via the tuning overlay)', async () => {
    const res = await v1('POST', '/v1/chat/completions', {
      body: {
        model: 'copilot:mock-fast',
        messages: [{ role: 'user', content: 'hi' }],
        temperature: 0.7,
      },
      token: rootToken,
    });
    expect(res.status).toBe(200);
  });

  it('rejects the function-pinning tool_choice form', async () => {
    const res = await v1('POST', '/v1/chat/completions', {
      body: {
        model: 'copilot:mock-fast',
        messages: [{ role: 'user', content: 'hi' }],
        tool_choice: { type: 'function', function: { name: 'do_thing' } },
      },
      token: rootToken,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('tool_choice_function_not_supported_v1');
  });

  it('routes an unknown model prefix through the automatic fallback gezel', async () => {
    const res = await v1('POST', '/v1/chat/completions', {
      body: { model: 'unknownprovider:foo', messages: [{ role: 'user', content: 'hi' }] },
      token: rootToken,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { model: string };
    expect(body.model).toBe('unknownprovider:foo');
  });

  it('returns 404 model_not_found for an uninstalled local model id (no auto-download)', async () => {
    // llama-cpp is a valid provider, but this id isn't in the local
    // catalog — the engine-pool route rejects it with an install hint
    // instead of silently serving the resident model (and never
    // triggers a multi-GB pull from a chat request).
    const res = await v1('POST', '/v1/chat/completions', {
      body: {
        model: 'llama-cpp:definitely-not-installed',
        messages: [{ role: 'user', content: 'hi' }],
      },
      token: rootToken,
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('model_not_found');
    expect(body.error.message).toContain('definitely-not-installed');
    expect(body.error.message).toContain('models/ensure');
  });

  it('returns 400 on malformed body', async () => {
    const res = await v1('POST', '/v1/chat/completions', {
      body: { messages: [] },
      token: rootToken,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_body');
  });

  it('returns 400 invalid_json (not 500) when the body is not JSON at all', async () => {
    const res = await httpFetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${rootToken}`,
      },
      body: '{"model": "copilot:mock-fast", "messages": [',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; type: string } };
    expect(body.error.code).toBe('invalid_json');
    expect(body.error.type).toBe('invalid_request_error');
  });

  it('accepts max_completion_tokens and reports finish_reason=length at the cap', async () => {
    // MockProvider reports outputTokens = reply length in chars, so a
    // 1-token cap is always reached — the truncation heuristic fires.
    const res = await v1('POST', '/v1/chat/completions', {
      body: {
        model: 'copilot:mock-fast',
        messages: [{ role: 'user', content: 'hi' }],
        max_completion_tokens: 1,
      },
      token: rootToken,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      choices: Array<{ finish_reason: string }>;
    };
    expect(body.choices[0]?.finish_reason).toBe('length');
  });

  it('rejects n>1 loudly instead of silently returning one choice', async () => {
    const res = await v1('POST', '/v1/chat/completions', {
      body: {
        model: 'copilot:mock-fast',
        messages: [{ role: 'user', content: 'hi' }],
        n: 3,
      },
      token: rootToken,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('n_not_supported_v1');
  });

  it('accepts n=1 (the OpenAI default) without complaint', async () => {
    const res = await v1('POST', '/v1/chat/completions', {
      body: {
        model: 'copilot:mock-fast',
        messages: [{ role: 'user', content: 'hi' }],
        n: 1,
      },
      token: rootToken,
    });
    expect(res.status).toBe(200);
  });

  it('accepts the developer role and treats it as a system message', async () => {
    const res = await v1('POST', '/v1/chat/completions', {
      body: {
        model: 'copilot:mock-fast',
        messages: [
          { role: 'developer', content: 'be terse' },
          { role: 'user', content: 'hi there' },
        ],
      },
      token: rootToken,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    expect(body.choices[0]?.message.content).toContain('hi there');
  });
});

describe('POST /v1/chat/completions — stream_options.include_usage', () => {
  async function streamDataLines(body: Record<string, unknown>): Promise<string[]> {
    const res = await v1('POST', '/v1/chat/completions', { body, token: rootToken });
    expect(res.status).toBe(200);
    const text = await res.text();
    return text
      .split(/\n/)
      .filter((line) => line.startsWith('data: '))
      .map((line) => line.slice('data: '.length));
  }

  it('omits usage entirely when stream_options is absent (OpenAI default)', async () => {
    const dataLines = await streamDataLines({
      model: 'copilot:mock-fast',
      messages: [{ role: 'user', content: 'no usage please' }],
      stream: true,
    });
    const chunks = dataLines.filter((d) => d !== '[DONE]').map((d) => JSON.parse(d));
    for (const chunk of chunks) {
      expect('usage' in chunk).toBe(false);
    }
  });

  it('emits usage:null on chunks plus a final empty-choices usage chunk when requested', async () => {
    const dataLines = await streamDataLines({
      model: 'copilot:mock-fast',
      messages: [{ role: 'user', content: 'count my tokens' }],
      stream: true,
      stream_options: { include_usage: true },
    });
    expect(dataLines[dataLines.length - 1]).toBe('[DONE]');
    const chunks = dataLines.filter((d) => d !== '[DONE]').map((d) => JSON.parse(d));
    const usageChunk = chunks[chunks.length - 1];
    expect(usageChunk.choices).toEqual([]);
    expect(usageChunk.usage.total_tokens).toBe(
      usageChunk.usage.prompt_tokens + usageChunk.usage.completion_tokens,
    );
    for (const chunk of chunks.slice(0, -1)) {
      expect(chunk.usage).toBeNull();
    }
    // The finish_reason chunk is the second-to-last (before the usage chunk).
    const finishChunk = chunks[chunks.length - 2];
    expect(finishChunk.choices[0].finish_reason).toBe('stop');
  });
});

describe('GET /v1/models', () => {
  it('requires authentication', async () => {
    const res = await v1('GET', '/v1/models');
    expect(res.status).toBe(401);
  });

  it('lists mock models as OpenAI-shaped entries with provider-qualified ids', async () => {
    const res = await v1('GET', '/v1/models', { token: rootToken });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      object: string;
      data: Array<{ id: string; object: string; owned_by: string }>;
    };
    expect(body.object).toBe('list');
    const ids = body.data.map((m) => m.id);
    // GEZEL_MOCK_PROVIDER seeds copilot + openai as mocks. Mock
    // provider returns mock-fast + mock-reasoning.
    expect(ids).toContain('copilot:mock-fast');
    expect(ids).toContain('openai:mock-fast');
    const fast = body.data.find((m) => m.id === 'copilot:mock-fast');
    expect(fast?.object).toBe('model');
    expect(fast?.owned_by).toBe('copilot');
  });
});
