import { describe, expect, it, vi } from 'vitest';
import { MockProvider } from '../providers/mock.js';
import type { ServiceContext } from './context.js';
import { VSCODE_BRIDGE_MARKER_HEADER, buildVSCodeBridgeApp } from './vscode-bridge.js';

function context(
  opts: {
    provider?: MockProvider;
    resolveExternalConversationId?: (...args: unknown[]) => Promise<string>;
    beginExternalConversation?: (...args: unknown[]) => Promise<unknown>;
  } = {},
): ServiceContext {
  const records = new Map([
    [
      'vscode-token',
      {
        appId: 'vscode-test',
        appName: 'VS Code test',
        scopes: ['openai'],
        token: 'vscode-token',
        createdAt: 1,
        lastUsedAt: 0,
      },
    ],
  ]);
  return {
    tokenStore: {
      lookup: (token: string) => records.get(token) ?? null,
      touch: () => undefined,
    },
    store: {
      readConfig: async () => ({ openaiEndpoints: {} }),
      listGezels: async () => [{ id: 'sipho', name: 'Sipho' }],
      getGezel: async (id: string) =>
        id === 'sipho'
          ? {
              id: 'sipho',
              name: 'Sipho',
              about: 'You are Sipho.',
              parsed: { frontmatter: {} },
            }
          : null,
    },
    chat: {
      listModelsForProvider: async () => [],
      getProviderForModel: async () => opts.provider!,
      providerForGezel: async () => 'llama-cpp',
      resolveModelSessionDefaults: async () => null,
      recordExternalUsage: () => undefined,
      ...(opts.resolveExternalConversationId
        ? { resolveExternalConversationId: opts.resolveExternalConversationId }
        : {}),
      ...(opts.beginExternalConversation
        ? { beginExternalConversation: opts.beginExternalConversation }
        : {}),
    },
    history: { log: async () => undefined },
  } as unknown as ServiceContext;
}

const auth = { authorization: 'Bearer vscode-token' };

describe('buildVSCodeBridgeApp', () => {
  it('serves only authenticated chat completions and model discovery', async () => {
    const app = buildVSCodeBridgeApp(context());
    expect((await app.request('http://127.0.0.1/v1/models')).status).toBe(401);
    const models = await app.request('http://127.0.0.1/v1/models', { headers: auth });
    expect(models.status).toBe(200);
    expect(models.headers.get(VSCODE_BRIDGE_MARKER_HEADER)).toBe('1');
    await expect(models.json()).resolves.toMatchObject({ object: 'list' });

    for (const path of ['/api/config', '/v1/apps', '/v1/responses']) {
      expect((await app.request(`http://127.0.0.1${path}`, { headers: auth })).status).toBe(404);
    }
  });

  it('rejects non-loopback host headers and never enables CORS', async () => {
    const app = buildVSCodeBridgeApp(context());
    const response = await app.request('http://127.0.0.1/v1/models', {
      headers: { ...auth, host: 'evil.example' },
    });
    expect(response.status).toBe(403);
    expect(response.headers.get(VSCODE_BRIDGE_MARKER_HEADER)).toBe('1');
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('streams reasoning and mirrors a gezel-targeted VS Code transcript', async () => {
    const provider = new MockProvider();
    provider.scriptReasoning('Planning ', 'the build.');
    provider.script('Starting the implementation.');
    const finish = vi.fn(async () => undefined);
    const resolveExternalConversationId = vi.fn(async () => 'vscode-thread-1');
    const beginExternalConversation = vi.fn(async () => ({
      sessionId: 'external-vscode-thread-1',
      projectId: 'default',
      onContentDelta: vi.fn(),
      onReasoningDelta: vi.fn(),
      onToolArgsDelta: vi.fn(),
      finish,
      fail: vi.fn(async () => undefined),
    }));
    const app = buildVSCodeBridgeApp(
      context({ provider, resolveExternalConversationId, beginExternalConversation }),
    );

    const response = await app.request('http://127.0.0.1/v1/chat/completions', {
      method: 'POST',
      headers: {
        ...auth,
        'content-type': 'application/json',
        'x-request-id': 'vscode-request-42',
      },
      body: JSON.stringify({
        model: 'gezel:sipho',
        messages: [{ role: 'user', content: 'Build the app' }],
        stream: true,
      }),
    });

    expect(response.status).toBe(200);
    const deltas = (await response.text())
      .split('\n')
      .filter((line) => line.startsWith('data: {'))
      .map((line) => JSON.parse(line.slice('data: '.length)))
      .flatMap(
        (chunk) => chunk.choices?.map((choice: { delta?: object }) => choice.delta ?? {}) ?? [],
      );
    expect(deltas.map((delta) => delta.reasoning_content ?? '').join('')).toBe(
      'Planning the build.',
    );
    expect(deltas.map((delta) => delta.content ?? '').join('')).toBe(
      'Starting the implementation.',
    );
    const send = provider.calls.find((call) => call.kind === 'send');
    expect(send?.sendOpts?.timeoutMs).toBe(8 * 60 * 60 * 1000);
    expect(resolveExternalConversationId).toHaveBeenCalledWith({
      sourceId: 'vscode',
      gezelId: 'sipho',
      messages: [{ role: 'user', content: 'Build the app' }],
      fallbackExternalConversationId: 'vscode-request-42',
    });
    expect(beginExternalConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: 'vscode',
        sourceName: 'VS Code',
        externalConversationId: 'vscode-thread-1',
        gezelId: 'sipho',
      }),
    );
    expect(finish).toHaveBeenCalledWith({
      content: 'Starting the implementation.',
      reasoning: 'Planning the build.',
      finishReason: 'stop',
    });
  });
});
