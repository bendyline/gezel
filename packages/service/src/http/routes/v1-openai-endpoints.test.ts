import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { externalGezelModelId } from '@bendyline/gezel';
import { createTrustingFetch } from '@bendyline/gezel-client/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockProvider } from '../../providers/mock.js';
import { type RunningService, startService } from '../../service.js';

/**
 * Settings → Connected Apps controls for the OpenAI-compatible facade:
 *
 *   - `openaiEndpoints.enabled: false` gates every inference surface and
 *     OpenAI-scoped registrations, while CLI registration and the panel's
 *     management surface (`GET /v1/apps`) stay up.
 *   - `openaiEndpoints.servingGezelId` optionally overrides the
 *     Meester-backed fallback for requests naming an unknown model (a
 *     client's hardcoded "gpt-4o").
 */
let svc: RunningService;
let baseUrl: string;
let rootToken: string;
let home: string;
let httpFetch: typeof fetch;

const priorMockFlag = process.env.GEZEL_MOCK_PROVIDER;

beforeAll(async () => {
  process.env.GEZEL_MOCK_PROVIDER = '1';
  home = await mkdtemp(join(tmpdir(), 'gezel-v1-endpoints-'));
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

function call(method: string, path: string, opts: { body?: unknown; token?: string } = {}) {
  return httpFetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
}

async function setEndpointsConfig(value: {
  enabled?: boolean;
  servingGezelId?: string;
  supportingBehaviors?: boolean;
}): Promise<void> {
  const res = await call('PUT', '/api/config', {
    body: { openaiEndpoints: value },
    token: rootToken,
  });
  expect(res.status).toBe(200);
}

describe('openaiEndpoints.enabled = false', () => {
  beforeAll(async () => {
    await setEndpointsConfig({ enabled: false });
  });

  afterAll(async () => {
    await setEndpointsConfig({});
  });

  it('gates /v1/chat/completions with 403 openai_endpoints_disabled', async () => {
    const res = await call('POST', '/v1/chat/completions', {
      body: { model: 'copilot:mock-fast', messages: [{ role: 'user', content: 'hi' }] },
      token: rootToken,
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('openai_endpoints_disabled');
    expect(body.error.message).toContain('Connected Apps');
  });

  it('gates /v1/models and the ollama facade', async () => {
    const models = await call('GET', '/v1/models', { token: rootToken });
    expect(models.status).toBe(403);
    const tags = await call('GET', '/ollama/v1/tags', { token: rootToken });
    expect(tags.status).toBe(403);
  });

  it('gates OpenAI registrations but keeps CLI registration and management up', async () => {
    const register = await call('POST', '/v1/apps/register', {
      body: { appId: 'blocked-app', appName: 'Blocked App', scopes: ['openai'] },
    });
    expect(register.status).toBe(403);
    const cliRegister = await call('POST', '/v1/apps/register', {
      body: { appId: 'headless-cli', appName: 'Gezel CLI', scopes: ['cli'] },
    });
    expect(cliRegister.status).toBe(201);
    // The Connected Apps panel still needs its listing while the facade
    // is off — that's how the user turns it back on.
    const list = await call('GET', '/v1/apps', { token: rootToken });
    expect(list.status).toBe(200);
  });
});

describe('openaiEndpoints unset (default)', () => {
  it('serves /v1 normally', async () => {
    const res = await call('POST', '/v1/chat/completions', {
      body: { model: 'copilot:mock-fast', messages: [{ role: 'user', content: 'hi' }] },
      token: rootToken,
    });
    expect(res.status).toBe(200);
  });
});

describe('servingGezelId fallback', () => {
  let gezelId: string;

  beforeAll(async () => {
    const created = await call('POST', '/api/gezels', {
      body: { name: 'Poortwachter', role: 'Concierge', model: 'mock-reasoning' },
      token: rootToken,
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as { id: string };
    gezelId = body.id;
  });

  afterAll(async () => {
    await setEndpointsConfig({});
  });

  it('without an override, unknown models fall back to the default Meester', async () => {
    await setEndpointsConfig({});
    const res = await call('POST', '/v1/chat/completions', {
      body: { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] },
      token: rootToken,
    });
    expect(res.status).toBe(200);
  });

  it('uses an explicitly named provider model instead of the fallback gezel model', async () => {
    await setEndpointsConfig({ servingGezelId: gezelId });
    const provider = await svc.context.chat.getProvider('copilot');
    if (!(provider instanceof MockProvider)) throw new Error('expected MockProvider');
    const before = provider.calls.length;
    const res = await call('POST', '/v1/chat/completions', {
      body: { model: 'copilot:mock-fast', messages: [{ role: 'user', content: 'be quick' }] },
      token: rootToken,
    });
    expect(res.status).toBe(200);
    const create = provider.calls.slice(before).find((call) => call.kind === 'create');
    expect(create?.opts?.model).toBe('mock-fast');
  });

  it('routes unknown model strings through the configured fallback gezel', async () => {
    await setEndpointsConfig({ servingGezelId: gezelId });
    const provider = await svc.context.chat.getProvider('copilot');
    if (!(provider instanceof MockProvider)) throw new Error('expected MockProvider');
    const before = provider.calls.length;
    const res = await call('POST', '/v1/chat/completions', {
      body: { model: 'gpt-4o', messages: [{ role: 'user', content: 'who answers?' }] },
      token: rootToken,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      model: string;
      choices: Array<{ message: { content: string } }>;
    };
    // The caller's model string round-trips unchanged in the envelope.
    expect(body.model).toBe('gpt-4o');
    expect(body.choices[0]?.message.content).toContain('who answers?');
    const create = provider.calls.slice(before).find((call) => call.kind === 'create');
    expect(create?.opts?.model).toBe('mock-reasoning');
  });

  it('lists every gezel with name and role metadata, with the fallback first', async () => {
    await setEndpointsConfig({ servingGezelId: gezelId });
    const res = await call('GET', '/v1/models', { token: rootToken });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{
        id: string;
        owned_by: string;
        name?: string;
        role?: string;
        is_fallback?: boolean;
      }>;
    };
    expect(body.data[0]).toMatchObject({
      id: 'gezel:concierge-poortwachter',
      owned_by: 'gezel',
      name: 'Poortwachter',
      role: 'Concierge',
      is_fallback: true,
    });
    const gezelList = await call('GET', '/v1/gezels', { token: rootToken });
    const gezelBody = (await gezelList.json()) as {
      data: Array<{ id: string; name: string; role?: string }>;
    };
    for (const gezel of gezelBody.data) {
      expect(body.data.some((entry) => entry.id === externalGezelModelId(gezel))).toBe(true);
    }
  });
});

describe('session defaults — tuning always, profile gated by supportingBehaviors', () => {
  let mockCopilot: MockProvider;

  beforeAll(async () => {
    const provider = await svc.context.chat.getProvider('copilot');
    if (!(provider instanceof MockProvider)) {
      throw new Error('expected MockProvider for copilot in test env');
    }
    mockCopilot = provider;
  });

  afterAll(async () => {
    await setEndpointsConfig({});
  });

  async function lastCreateOpts(): Promise<Record<string, unknown>> {
    const before = mockCopilot.calls.length;
    const res = await call('POST', '/v1/chat/completions', {
      body: { model: 'copilot:mock-fast', messages: [{ role: 'user', content: 'hi' }] },
      token: rootToken,
    });
    expect(res.status).toBe(200);
    const create = mockCopilot.calls.slice(before).find((c) => c.kind === 'create');
    expect(create).toBeDefined();
    return (create?.opts ?? {}) as unknown as Record<string, unknown>;
  }

  it('passes tuning and a caller-safe profile by default (switch unset)', async () => {
    await setEndpointsConfig({});
    const opts = await lastCreateOpts();
    expect(opts.tuning).toBeDefined();
    expect(opts.profile).toBeDefined();
    const behaviorIds = (opts.profile as { behaviors?: Array<{ id: string }> }).behaviors?.map(
      (entry) => entry.id,
    );
    expect(behaviorIds).not.toContain('turn.ramble-detection');
  });

  it('supportingBehaviors: false keeps tuning but drops the behavior profile', async () => {
    await setEndpointsConfig({ supportingBehaviors: false });
    const opts = await lastCreateOpts();
    expect(opts.tuning).toBeDefined();
    expect(opts.profile).toBeUndefined();
  });
});

describe('per-request overlays (sampling / response_format / tool_choice)', () => {
  let mockCopilot: MockProvider;

  beforeAll(async () => {
    const provider = await svc.context.chat.getProvider('copilot');
    if (!(provider instanceof MockProvider)) throw new Error('expected MockProvider');
    mockCopilot = provider;
  });

  async function createOptsFor(extra: Record<string, unknown>): Promise<{
    tuning?: {
      sampling: Record<string, unknown>;
      output: Record<string, unknown>;
      toolChoice?: string;
    };
  }> {
    const before = mockCopilot.calls.length;
    const res = await call('POST', '/v1/chat/completions', {
      body: {
        model: 'copilot:mock-fast',
        messages: [{ role: 'user', content: 'hi' }],
        ...extra,
      },
      token: rootToken,
    });
    expect(res.status).toBe(200);
    const create = mockCopilot.calls.slice(before).find((c) => c.kind === 'create');
    return (create?.opts ?? {}) as never;
  }

  it('overlays sampling params as the topmost tuning layer', async () => {
    const opts = await createOptsFor({
      temperature: 0.25,
      top_p: 0.5,
      max_completion_tokens: 123,
      presence_penalty: 0.1,
      frequency_penalty: -0.2,
      seed: 7,
    });
    expect(opts.tuning?.sampling).toMatchObject({
      temperature: 0.25,
      topP: 0.5,
      maxTokens: 123,
      presencePenalty: 0.1,
      frequencyPenalty: -0.2,
      seed: 7,
    });
  });

  it('max_completion_tokens wins over max_tokens when both are sent', async () => {
    const opts = await createOptsFor({ max_tokens: 50, max_completion_tokens: 60 });
    expect(opts.tuning?.sampling.maxTokens).toBe(60);
  });

  it('maps response_format json_schema onto the tuning output block', async () => {
    const schema = { type: 'object', properties: { answer: { type: 'string' } } };
    const opts = await createOptsFor({
      response_format: { type: 'json_schema', json_schema: { name: 'reply', schema } },
    });
    expect(opts.tuning?.output.jsonSchema).toEqual(schema);
  });

  it('maps response_format json_object and string tool_choice', async () => {
    const opts = await createOptsFor({
      response_format: { type: 'json_object' },
      tool_choice: 'required',
      tools: [{ type: 'function', function: { name: 'do_thing' } }],
    });
    expect(opts.tuning?.output.responseFormat).toBe('json_object');
    expect(opts.tuning?.toolChoice).toBe('required');
  });
});

describe('GET /v1/models/{id} (retrieve)', () => {
  it('returns the entry for a known qualified id', async () => {
    const res = await call('GET', '/v1/models/copilot:mock-fast', { token: rootToken });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; object: string; owned_by: string };
    expect(body).toMatchObject({ id: 'copilot:mock-fast', object: 'model', owned_by: 'copilot' });
  });

  it('404s an unknown id with the OpenAI envelope', async () => {
    const res = await call('GET', '/v1/models/nope:missing', { token: rootToken });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('model_not_found');
  });
});

describe('observability — usage tracking + history events', () => {
  it('records app turns in the usage tracker and logs v1.chat.completion', async () => {
    const res = await call('POST', '/v1/chat/completions', {
      body: {
        model: 'copilot:mock-fast',
        messages: [{ role: 'user', content: 'count me' }],
      },
      token: rootToken,
    });
    expect(res.status).toBe(200);

    const usage = await call('GET', '/api/usage', { token: rootToken });
    expect(usage.status).toBe(200);
    const usageBody = (await usage.json()) as {
      providers: { copilot?: { totalTurns: number; totalTokensOut: number } };
    };
    expect(usageBody.providers.copilot?.totalTurns ?? 0).toBeGreaterThan(0);
    expect(usageBody.providers.copilot?.totalTokensOut ?? 0).toBeGreaterThan(0);

    const history = await call('GET', '/api/history?kind=v1.chat.completion', {
      token: rootToken,
    });
    expect(history.status).toBe(200);
    const historyBody = (await history.json()) as {
      entries: Array<{ kind: string; details?: { appId?: string; model?: string } }>;
    };
    const entry = historyBody.entries.find((e) => e.kind === 'v1.chat.completion');
    expect(entry).toBeDefined();
    expect(entry?.details?.model).toBe('copilot:mock-fast');
  });
});
