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
  home = await mkdtemp(join(tmpdir(), 'gezel-v1-gezels-'));
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

describe('GET /v1/gezels', () => {
  it('requires bearer auth', async () => {
    const res = await v1('GET', '/v1/gezels');
    expect(res.status).toBe(401);
  });

  it('lists at least the default Meester + Klerk seeded on first boot', async () => {
    const res = await v1('GET', '/v1/gezels', { token: rootToken });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      object: string;
      data: Array<{ id: string; name: string }>;
    };
    expect(body.object).toBe('list');
    expect(body.data.length).toBeGreaterThanOrEqual(2);
    // Each entry must carry the basic identification fields.
    for (const g of body.data) {
      expect(typeof g.id).toBe('string');
      expect(typeof g.name).toBe('string');
    }
  });

  it('returns an effectiveProvider for every gezel — picker-display contract', async () => {
    const res = await v1('GET', '/v1/gezels', { token: rootToken });
    const body = (await res.json()) as {
      data: Array<{
        id: string;
        provider?: string;
        model?: string;
        effectiveProvider: string;
        effectiveModel?: string;
      }>;
    };
    // The VS Code language-model-chat provider uses these fields to
    // render "Gezel: <name> · <role> · <model>" without doing its own
    // install-default join. Contract: every gezel has an
    // effectiveProvider; effectiveModel is optional because CLI
    // providers don't expose a model id.
    expect(body.data.length).toBeGreaterThan(0);
    for (const g of body.data) {
      expect(typeof g.effectiveProvider).toBe('string');
      expect(g.effectiveProvider.length).toBeGreaterThan(0);
      // When the frontmatter pinned a model, the effective model must
      // mirror it (overrides win over install defaults).
      if (g.model) expect(g.effectiveModel).toBe(g.model);
    }
  });
});

describe('POST /v1/chat/completions — gezel:<id-or-name> routing', () => {
  it('routes through a gezel by name and the response echoes the request prompt via the mock provider', async () => {
    // First fetch a known gezel name.
    const list = await v1('GET', '/v1/gezels', { token: rootToken });
    const { data } = (await list.json()) as { data: Array<{ id: string; name: string }> };
    const target = data[0]!;

    const res = await v1('POST', '/v1/chat/completions', {
      body: {
        model: `gezel:${target.name}`,
        messages: [{ role: 'user', content: 'hello there' }],
      },
      token: rootToken,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      model: string;
      choices: Array<{ message: { content: string } }>;
    };
    // The response echoes the original model field for round-tripping.
    expect(body.model).toBe(`gezel:${target.name}`);
    // MockProvider echoes "Mock reply: <prompt>" — confirms we
    // actually reached the provider rather than short-circuiting.
    expect(body.choices[0]?.message.content).toContain('hello there');
  });

  it('routes through a gezel by id (UUID-ish) the same way as by name', async () => {
    const list = await v1('GET', '/v1/gezels', { token: rootToken });
    const { data } = (await list.json()) as { data: Array<{ id: string; name: string }> };
    const target = data[0]!;

    const res = await v1('POST', '/v1/chat/completions', {
      body: {
        model: `gezel:${target.id}`,
        messages: [{ role: 'user', content: 'ping' }],
      },
      token: rootToken,
    });
    expect(res.status).toBe(200);
  });

  it('returns 404 gezel_not_found for an unknown ref', async () => {
    const res = await v1('POST', '/v1/chat/completions', {
      body: {
        model: 'gezel:definitely-not-a-real-gezel',
        messages: [{ role: 'user', content: 'x' }],
      },
      token: rootToken,
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('gezel_not_found');
  });
});
