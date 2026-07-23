import { describe, expect, it } from 'vitest';
import type { SecretKey, SecretStore } from '../secrets/types.js';
import { stringifySecretKey } from '../secrets/types.js';
import { WebhookChannel } from './webhook.js';

function memorySecrets(initial: Record<string, string> = {}): SecretStore {
  const map = new Map(Object.entries(initial));
  return {
    backend: 'file' as const,
    get: async (key: SecretKey) => map.get(stringifySecretKey(key)) ?? null,
    set: async (key: SecretKey, value: string) => {
      map.set(stringifySecretKey(key), value);
    },
    delete: async (key: SecretKey) => {
      map.delete(stringifySecretKey(key));
    },
    has: async (key: SecretKey) => map.has(stringifySecretKey(key)),
    listForToolset: async () => [],
  };
}

interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

function recordingFetch(response: Partial<Response> = {}): {
  fetch: typeof fetch;
  calls: RecordedRequest[];
} {
  const calls: RecordedRequest[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input as URL | Request).toString();
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers as Record<string, string>) ?? {})) {
      headers[k.toLowerCase()] = String(v);
    }
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? init.body : '',
    });
    const status = response.status ?? 200;
    const ok = status >= 200 && status < 300;
    return {
      ok,
      status,
      text: async () => (response as { text?: () => Promise<string> }).text?.() ?? '',
    } as Response;
  };
  return { fetch: fetchImpl, calls };
}

describe('WebhookChannel', () => {
  it('posts the default JSON body with JSON-encoded message', async () => {
    const { fetch, calls } = recordingFetch();
    const ch = new WebhookChannel({
      config: { url: 'https://example.test/hook' },
      secrets: memorySecrets(),
      fetchImpl: fetch,
    });
    await ch.initialize();
    const result = await ch.send('hello world');
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.headers['content-type']).toBe('application/json');
    expect(calls[0]!.body).toBe('{"message":"hello world"}');
  });

  it('substitutes {{message}} as a JSON-encoded string', async () => {
    const { fetch, calls } = recordingFetch();
    const ch = new WebhookChannel({
      config: {
        url: 'https://example.test/hook',
        bodyTemplate: '{"text":{{message}},"source":"gezel"}',
      },
      secrets: memorySecrets(),
      fetchImpl: fetch,
    });
    await ch.initialize();
    await ch.send('hi "there"\nnewline');
    expect(calls[0]!.body).toBe('{"text":"hi \\"there\\"\\nnewline","source":"gezel"}');
  });

  it('adds a Bearer auth header when webhookBearerToken is set', async () => {
    const { fetch, calls } = recordingFetch();
    const secrets = memorySecrets({
      'providerCredential:webhookBearerToken': 'tok-123',
    });
    const ch = new WebhookChannel({
      config: { url: 'https://example.test/hook' },
      secrets,
      fetchImpl: fetch,
    });
    await ch.initialize();
    await ch.send('x');
    expect(calls[0]!.headers.authorization).toBe('Bearer tok-123');
  });

  it('adds a Basic auth header (base64-encoded) when webhookBasicAuth is set', async () => {
    const { fetch, calls } = recordingFetch();
    const secrets = memorySecrets({
      'providerCredential:webhookBasicAuth': 'alice:s3cret',
    });
    const ch = new WebhookChannel({
      config: { url: 'https://example.test/hook' },
      secrets,
      fetchImpl: fetch,
    });
    await ch.initialize();
    await ch.send('x');
    expect(calls[0]!.headers.authorization).toBe(
      `Basic ${Buffer.from('alice:s3cret', 'utf8').toString('base64')}`,
    );
  });

  it('prefers bearer over basic when both are configured', async () => {
    const { fetch, calls } = recordingFetch();
    const secrets = memorySecrets({
      'providerCredential:webhookBearerToken': 'tok',
      'providerCredential:webhookBasicAuth': 'a:b',
    });
    const ch = new WebhookChannel({
      config: { url: 'https://example.test/hook' },
      secrets,
      fetchImpl: fetch,
    });
    await ch.initialize();
    await ch.send('x');
    expect(calls[0]!.headers.authorization).toBe('Bearer tok');
  });

  it('merges user-supplied headers', async () => {
    const { fetch, calls } = recordingFetch();
    const ch = new WebhookChannel({
      config: {
        url: 'https://example.test/hook',
        headers: { 'X-Priority': 'high', Title: 'gezel ping' },
      },
      secrets: memorySecrets(),
      fetchImpl: fetch,
    });
    await ch.initialize();
    await ch.send('x');
    expect(calls[0]!.headers['x-priority']).toBe('high');
    expect(calls[0]!.headers.title).toBe('gezel ping');
  });

  it('propagates HTTP failure status', async () => {
    const { fetch } = recordingFetch({ status: 502, text: async () => 'Bad Gateway' });
    const ch = new WebhookChannel({
      config: { url: 'https://example.test/hook' },
      secrets: memorySecrets(),
      fetchImpl: fetch,
    });
    await ch.initialize();
    const result = await ch.send('x');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/HTTP 502/);
  });

  it('reports ready=false when the URL is invalid', async () => {
    const ch = new WebhookChannel({
      config: { url: 'not a url' },
      secrets: memorySecrets(),
      fetchImpl: recordingFetch().fetch,
    });
    await ch.initialize();
    const status = await ch.status();
    expect(status.ready).toBe(false);
    expect(status.lastError).toMatch(/invalid url/);
    const result = await ch.send('x');
    expect(result.ok).toBe(false);
  });

  it('respects the configured method (PUT)', async () => {
    const { fetch, calls } = recordingFetch();
    const ch = new WebhookChannel({
      config: { url: 'https://example.test/hook', method: 'PUT' },
      secrets: memorySecrets(),
      fetchImpl: fetch,
    });
    await ch.initialize();
    await ch.send('x');
    expect(calls[0]!.method).toBe('PUT');
  });

  it('hides long path segments in status detail.url', async () => {
    const ch = new WebhookChannel({
      config: { url: 'https://ntfy.sh/gezel-abcdef0123456789' },
      secrets: memorySecrets(),
      fetchImpl: recordingFetch().fetch,
    });
    await ch.initialize();
    const status = await ch.status();
    expect(status.detail?.url).toBe('https://ntfy.sh/gez***');
  });
});
