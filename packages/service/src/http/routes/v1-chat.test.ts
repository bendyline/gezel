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
  it('rejects requests with no token', async () => {
    const res = await v1('POST', '/v1/chat/completions', {
      body: { model: 'copilot:mock-fast', messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(res.status).toBe(401);
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
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('missing_scope:openai');
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

  it('returns 400 + structured_outputs_not_supported_v1 when response_format is present', async () => {
    const res = await v1('POST', '/v1/chat/completions', {
      body: {
        model: 'copilot:mock-fast',
        messages: [{ role: 'user', content: 'hi' }],
        response_format: { type: 'json_object' },
      },
      token: rootToken,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('structured_outputs_not_supported_v1');
  });

  it('returns 400 + sampling_params_not_supported_v1 when a sampling param is present', async () => {
    const res = await v1('POST', '/v1/chat/completions', {
      body: {
        model: 'copilot:mock-fast',
        messages: [{ role: 'user', content: 'hi' }],
        temperature: 0.7,
      },
      token: rootToken,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('sampling_params_not_supported_v1');
    expect(body.error.message).toContain('temperature');
  });

  it('returns 404 model_not_found when the model prefix is unknown', async () => {
    const res = await v1('POST', '/v1/chat/completions', {
      body: { model: 'unknownprovider:foo', messages: [{ role: 'user', content: 'hi' }] },
      token: rootToken,
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('model_not_found');
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
