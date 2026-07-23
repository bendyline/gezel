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
  home = await mkdtemp(join(tmpdir(), 'gezel-ollama-compat-'));
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

function call(
  method: string,
  path: string,
  opts: { body?: unknown; token?: string; origin?: string } = {},
): Promise<Response> {
  return httpFetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.origin ? { Origin: opts.origin } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
}

describe('GET /ollama/v1/tags', () => {
  it('requires bearer auth', async () => {
    const res = await call('GET', '/ollama/v1/tags');
    expect(res.status).toBe(401);
  });

  it('lists models in Ollama-shaped format', async () => {
    const res = await call('GET', '/ollama/v1/tags', { token: rootToken });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      models: Array<{ name: string; model: string; details: { format: string } }>;
    };
    expect(body.models.length).toBeGreaterThan(0);
    // MockProvider seeds `copilot:mock-fast` and `openai:mock-fast`.
    const names = body.models.map((m) => m.name);
    expect(names).toContain('copilot:mock-fast');
    expect(names).toContain('openai:mock-fast');
  });
});

describe('POST /ollama/v1/chat — non-streaming', () => {
  it('returns an Ollama-shaped envelope when stream=false', async () => {
    const res = await call('POST', '/ollama/v1/chat', {
      body: {
        model: 'copilot:mock-fast',
        messages: [{ role: 'user', content: 'tell me' }],
        stream: false,
      },
      token: rootToken,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      model: string;
      message: { role: string; content: string };
      done: boolean;
    };
    expect(body.model).toBe('copilot:mock-fast');
    expect(body.message.role).toBe('assistant');
    expect(body.message.content).toContain('tell me');
    expect(body.done).toBe(true);
  });
});

describe('POST /ollama/v1/chat — NDJSON streaming', () => {
  it('streams NDJSON lines terminated by done:true', async () => {
    const res = await call('POST', '/ollama/v1/chat', {
      body: {
        model: 'copilot:mock-fast',
        messages: [{ role: 'user', content: 'narrate' }],
      },
      token: rootToken,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/x-ndjson/);
    const text = await res.text();
    const lines = text
      .trim()
      .split('\n')
      .filter((l) => l.length > 0);
    expect(lines.length).toBeGreaterThan(1);
    const parsed = lines.map((l) => JSON.parse(l));
    // First chunk has message content, last has done:true.
    expect(parsed[parsed.length - 1]?.done).toBe(true);
    const middleChunks = parsed.filter((p) => p.done === false);
    expect(middleChunks.length).toBeGreaterThan(0);
    const reassembled = middleChunks.map((c) => c.message?.content ?? '').join('');
    expect(reassembled).toContain('narrate');
  });
});

describe('POST /ollama/v1/chat — validation', () => {
  it('returns 404 for an unknown provider prefix', async () => {
    const res = await call('POST', '/ollama/v1/chat', {
      body: {
        model: 'unknownprovider:foo',
        messages: [{ role: 'user', content: 'x' }],
      },
      token: rootToken,
    });
    expect(res.status).toBe(404);
  });

  it('returns 404 for an uninstalled local model id', async () => {
    // llama-cpp is a known provider, but this model isn't installed —
    // the engine-pool route validates against the catalog instead of
    // silently serving whatever model happens to be resident.
    const res = await call('POST', '/ollama/v1/chat', {
      body: {
        model: 'llama-cpp:definitely-not-installed',
        messages: [{ role: 'user', content: 'x' }],
      },
      token: rootToken,
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('definitely-not-installed');
    expect(body.error).toContain('models/ensure');
  });
});

describe('CORS for /v1/* and /ollama/v1/*', () => {
  it('OPTIONS preflight returns 204 with allow-origin echoing the request', async () => {
    const res = await call('OPTIONS', '/v1/chat/completions', {
      origin: 'http://localhost:5173',
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
    expect(res.headers.get('access-control-allow-methods')).toMatch(/POST/);
  });

  it('actual response carries access-control-allow-origin when Origin is sent', async () => {
    const res = await call('GET', '/v1/models', {
      token: rootToken,
      origin: 'http://docblocks.local',
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('http://docblocks.local');
    expect(res.headers.get('vary')).toBe('Origin');
  });

  it('does not attach CORS headers when no Origin header is present', async () => {
    const res = await call('GET', '/v1/models', { token: rootToken });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('attaches CORS headers on auth failures so the browser can read the 401', async () => {
    const res = await call('GET', '/v1/models', {
      origin: 'http://localhost:5173',
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
  });

  it('also CORSes the Ollama-compat facade', async () => {
    const res = await call('OPTIONS', '/ollama/v1/chat', {
      origin: 'http://localhost:5173',
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
  });
});
