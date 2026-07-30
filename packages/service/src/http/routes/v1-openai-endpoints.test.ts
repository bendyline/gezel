import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTrustingFetch } from '@bendyline/gezel-client/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockProvider } from '../../providers/mock.js';
import { type RunningService, startService } from '../../service.js';

/**
 * Settings → Connected Apps controls for the OpenAI-compatible facade:
 *
 *   - `openaiEndpoints.enabled: false` gates every inference surface AND
 *     new app registrations with `403 openai_endpoints_disabled`, while
 *     the panel's own management surface (`GET /v1/apps`) stays up.
 *   - `openaiEndpoints.servingGezelId` routes requests naming an
 *     unknown model (a client's hardcoded "gpt-4o") through the chosen
 *     gezel instead of failing with 404.
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

  it('gates new app registrations but keeps the management surface up', async () => {
    const register = await call('POST', '/v1/apps/register', {
      body: { appId: 'blocked-app', appName: 'Blocked App', scopes: ['openai'] },
    });
    expect(register.status).toBe(403);
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
      body: { name: 'Poortwachter', role: 'Concierge' },
      token: rootToken,
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as { id: string };
    gezelId = body.id;
  });

  afterAll(async () => {
    await setEndpointsConfig({});
  });

  it('without a serving gezel, unknown models still 404 loudly', async () => {
    await setEndpointsConfig({});
    const res = await call('POST', '/v1/chat/completions', {
      body: { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] },
      token: rootToken,
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('model_not_found');
  });

  it('routes unknown model strings through the serving gezel', async () => {
    await setEndpointsConfig({ servingGezelId: gezelId });
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
  });

  it('lists the serving gezel first in /v1/models', async () => {
    await setEndpointsConfig({ servingGezelId: gezelId });
    const res = await call('GET', '/v1/models', { token: rootToken });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{ id: string; owned_by: string }>;
    };
    expect(body.data[0]).toMatchObject({ id: 'gezel:Poortwachter', owned_by: 'gezel' });
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

  it('passes resolved tuning AND profile by default (switch unset)', async () => {
    await setEndpointsConfig({});
    const opts = await lastCreateOpts();
    expect(opts.tuning).toBeDefined();
    expect(opts.profile).toBeDefined();
  });

  it('supportingBehaviors: false keeps tuning but drops the behavior profile', async () => {
    await setEndpointsConfig({ supportingBehaviors: false });
    const opts = await lastCreateOpts();
    expect(opts.tuning).toBeDefined();
    expect(opts.profile).toBeUndefined();
  });
});
