import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { externalGezelModelId } from '@bendyline/gezel';
import { createTrustingFetch } from '@bendyline/gezel-client/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockProvider } from '../../providers/mock.js';
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

  it('lists the serving gezel by role and name', async () => {
    const gezel = (await svc.context.store.listGezels())[0]!;
    await svc.context.store.writeConfig({
      openaiEndpoints: { servingGezelId: gezel.id },
    });
    try {
      const res = await call('GET', '/ollama/v1/tags', { token: rootToken });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { models: Array<{ name: string }> };
      expect(body.models[0]?.name).toBe(externalGezelModelId(gezel));
    } finally {
      await svc.context.store.writeConfig({ openaiEndpoints: {} });
    }
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

describe('POST /ollama/v1/chat — tool calling (Ollama-native shapes)', () => {
  let mockCopilot: MockProvider;

  beforeAll(async () => {
    const provider = await svc.context.chat.getProvider('copilot');
    if (!(provider instanceof MockProvider)) {
      throw new Error('expected MockProvider for copilot in test env');
    }
    mockCopilot = provider;
  });

  it('returns captured calls as message.tool_calls with OBJECT arguments + done_reason', async () => {
    mockCopilot.scriptExternalToolCalls([
      { id: 'call_1', name: 'get_weather', arguments: '{"city":"Delft"}' },
    ]);
    const res = await call('POST', '/ollama/v1/chat', {
      body: {
        model: 'copilot:mock-fast',
        messages: [{ role: 'user', content: 'weather in Delft?' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'get_weather',
              parameters: { type: 'object', properties: { city: { type: 'string' } } },
            },
          },
        ],
        stream: false,
      },
      token: rootToken,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      message: {
        tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>;
      };
      done: boolean;
      done_reason?: string;
    };
    // Ollama's wire shape: object arguments, no ids.
    expect(body.message.tool_calls).toEqual([
      { function: { name: 'get_weather', arguments: { city: 'Delft' } } },
    ]);
    expect(body.done).toBe(true);
    expect(body.done_reason).toBe('stop');
  });

  it('accepts an Ollama-style tool-result follow-up turn (object args in history)', async () => {
    mockCopilot.script('It is sunny in Delft.');
    const before = mockCopilot.calls.length;
    const res = await call('POST', '/ollama/v1/chat', {
      body: {
        model: 'copilot:mock-fast',
        messages: [
          { role: 'user', content: 'weather in Delft?' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [{ function: { name: 'get_weather', arguments: { city: 'Delft' } } }],
          },
          { role: 'tool', content: 'sunny, 21C', tool_name: 'get_weather' },
        ],
        stream: false,
      },
      token: rootToken,
    });
    expect(res.status).toBe(200);
    // The transcript reached the session as real prior turns: the
    // assistant turn carries string-encoded arguments and the tool
    // result consumed its synthesized id.
    const create = mockCopilot.calls.slice(before).find((c) => c.kind === 'create');
    const priors = (create?.opts?.priorMessages ?? []) as Array<Record<string, unknown>>;
    expect(priors.some((m) => m.role === 'tool' && m.toolCallId === 'call_0')).toBe(true);
  });

  it('injects file-action receipts for Ollama-native tool loops too', async () => {
    const before = mockCopilot.calls.length;
    const res = await call('POST', '/ollama/v1/chat', {
      body: {
        model: 'copilot:mock-fast',
        messages: [
          { role: 'user', content: 'Write index.html and css/style.css.' },
          {
            role: 'assistant',
            content: 'I will write both files.',
            tool_calls: [
              {
                function: {
                  name: 'write_file',
                  arguments: { path: '/tmp/site/index.html', content: '<html>' },
                },
              },
            ],
          },
          { role: 'tool', content: 'Wrote file successfully.', tool_name: 'write_file' },
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: 'write_file',
              parameters: { type: 'object', properties: { path: { type: 'string' } } },
            },
          },
        ],
        stream: false,
      },
      token: rootToken,
    });

    expect(res.status).toBe(200);
    const create = mockCopilot.calls.slice(before).find((entry) => entry.kind === 'create');
    const providerInput = JSON.stringify(create?.opts?.priorMessages ?? []);
    expect(providerInput).toContain('[Gezel caller-owned action ledger]');
    expect(providerInput).toContain('write_file (call_0) -> \\"/tmp/site/index.html\\"');
    expect(providerInput).not.toMatch(/-> .*css\/style\.css/u);
  });
});

describe('POST /ollama/v1/chat — options + format overlay, done_reason', () => {
  let mockCopilot: MockProvider;

  beforeAll(async () => {
    const provider = await svc.context.chat.getProvider('copilot');
    if (!(provider instanceof MockProvider)) throw new Error('expected MockProvider');
    mockCopilot = provider;
  });

  it('overlays options onto tuning and infers done_reason=length at the cap', async () => {
    const before = mockCopilot.calls.length;
    const res = await call('POST', '/ollama/v1/chat', {
      body: {
        model: 'copilot:mock-fast',
        messages: [{ role: 'user', content: 'talk' }],
        options: { temperature: 0.3, top_k: 40, num_predict: 1 },
        format: 'json',
        stream: false,
      },
      token: rootToken,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { done_reason?: string };
    // MockProvider reports outputTokens = reply length in chars ≥ 1.
    expect(body.done_reason).toBe('length');
    const create = mockCopilot.calls.slice(before).find((c) => c.kind === 'create');
    const tuning = create?.opts?.tuning as
      | { sampling: Record<string, unknown>; output: Record<string, unknown> }
      | undefined;
    expect(tuning?.sampling).toMatchObject({ temperature: 0.3, topK: 40, maxTokens: 1 });
    expect(tuning?.output.responseFormat).toBe('json_object');
  });
});

describe('POST /ollama/v1/generate — single-turn completion', () => {
  it('returns the Ollama generate envelope', async () => {
    const res = await call('POST', '/ollama/v1/generate', {
      body: {
        model: 'copilot:mock-fast',
        prompt: 'say something',
        system: 'be brief',
        stream: false,
      },
      token: rootToken,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      response: string;
      done: boolean;
      done_reason?: string;
    };
    expect(body.response).toContain('say something');
    expect(body.done).toBe(true);
    expect(body.done_reason).toBe('stop');
  });

  it('streams NDJSON response chunks', async () => {
    const res = await call('POST', '/ollama/v1/generate', {
      body: { model: 'copilot:mock-fast', prompt: 'stream me' },
      token: rootToken,
    });
    expect(res.status).toBe(200);
    const lines = (await res.text())
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lines[lines.length - 1]?.done).toBe(true);
    const reassembled = lines
      .filter((l) => l.done === false)
      .map((l) => l.response ?? '')
      .join('');
    expect(reassembled).toContain('stream me');
  });
});

describe('Ollama auxiliary endpoints — show / embed / embeddings / ps', () => {
  it('GET /ps returns an empty running-models list', async () => {
    const res = await call('GET', '/ollama/v1/ps', { token: rootToken });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ models: [] });
  });

  it('POST /show returns model metadata with capabilities', async () => {
    const res = await call('POST', '/ollama/v1/show', {
      body: { model: 'copilot:mock-fast' },
      token: rootToken,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      capabilities: string[];
      model_info: Record<string, unknown>;
    };
    expect(body.capabilities).toContain('tools');
    expect(body.model_info['general.architecture']).toBe('gezel');
  });

  it('POST /show 404s an unknown model', async () => {
    const res = await call('POST', '/ollama/v1/show', {
      body: { model: 'definitely-not-a-model' },
      token: rootToken,
    });
    expect(res.status).toBe(404);
  });

  it('POST /embed returns one vector per input', async () => {
    const res = await call('POST', '/ollama/v1/embed', {
      body: { model: 'copilot:mock-embedding', input: ['aap', 'noot'] },
      token: rootToken,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { embeddings: number[][] };
    expect(body.embeddings).toHaveLength(2);
    expect(body.embeddings[0]?.length).toBeGreaterThan(0);
  });

  it('POST /embeddings (legacy) returns a single vector', async () => {
    const res = await call('POST', '/ollama/v1/embeddings', {
      body: { model: 'copilot:mock-embedding', prompt: 'mies' },
      token: rootToken,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { embedding: number[] };
    expect(body.embedding.length).toBeGreaterThan(0);
  });
});

describe('POST /ollama/v1/chat — images (Ollama bare-base64 shape)', () => {
  // 1x1 transparent PNG — starts with the iVBOR magic the mime sniffer keys on.
  const PNG_1X1 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  it('attaches last-message images to the prompt with a sniffed mime type', async () => {
    const provider = await svc.context.chat.getProvider('copilot');
    if (!(provider instanceof MockProvider)) {
      throw new Error('expected MockProvider for copilot in test env');
    }
    const before = provider.calls.length;
    const res = await call('POST', '/ollama/v1/chat', {
      body: {
        model: 'copilot:mock-fast',
        messages: [{ role: 'user', content: 'what is in this picture?', images: [PNG_1X1] }],
        stream: false,
      },
      token: rootToken,
    });
    expect(res.status).toBe(200);
    const send = provider.calls.slice(before).find((c) => c.kind === 'send');
    const attachments = (send?.sendOpts?.attachments ?? []) as Array<{
      base64: string;
      mimeType: string;
    }>;
    expect(attachments).toHaveLength(1);
    expect(attachments[0]?.mimeType).toBe('image/png');
    expect(attachments[0]?.base64).toBe(PNG_1X1);
  });

  it('accepts an image-only message (no text) as a valid prompt', async () => {
    const res = await call('POST', '/ollama/v1/chat', {
      body: {
        model: 'copilot:mock-fast',
        messages: [{ role: 'user', content: '', images: [PNG_1X1] }],
        stream: false,
      },
      token: rootToken,
    });
    expect(res.status).toBe(200);
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
