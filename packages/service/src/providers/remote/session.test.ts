import { describe, expect, it } from 'vitest';
import type { McpBridgePool } from '../mcp-bridge-pool.js';
import { ProviderQueue } from '../queue.js';
import { RemoteSession } from './session.js';

/** Build a Response whose body streams the given frames as SSE `data:` events. */
function sseResponse(frames: unknown[]): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of frames) controller.enqueue(enc.encode(`data: ${JSON.stringify(f)}\n\n`));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function fakeBridge(
  handlers: Record<string, (args: Record<string, unknown>) => Promise<string>>,
): McpBridgePool {
  return {
    isEmpty: () => Object.keys(handlers).length === 0,
    getOpenAITools: () =>
      Object.keys(handlers).map((name) => ({
        type: 'function' as const,
        name,
        description: '',
        parameters: { type: 'object' },
      })),
    callToolRich: async (name: string, args: Record<string, unknown>) => ({
      text: await handlers[name]!(args),
      images: [],
    }),
    stop: async () => {},
  } as unknown as McpBridgePool;
}

describe('RemoteSession', () => {
  it('prepares the exact user-owned prompt and posts it to the broker warm endpoint', async () => {
    let request:
      | { url: string; authorization: string | null; body: Record<string, unknown> }
      | undefined;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      request = {
        url,
        authorization: new Headers(init?.headers).get('authorization'),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      };
      return Response.json({ ok: true }, { status: 202 });
    }) as unknown as typeof fetch;
    const session = new RemoteSession({
      baseUrl: 'https://broker',
      token: 'broker-token',
      fetch: fetchImpl,
      queue: new ProviderQueue({ concurrency: 1 }),
      bridges: fakeBridge({ read_file: async () => 'x' }),
      systemMessage: 'stable system',
      systemPromptLayers: { gezel: 'gezel layer', project: 'project layer' },
      volatileContext: 'volatile state',
      tuning: { sampling: { temperature: 0.2 } },
      model: 'mlx:qwen',
      priorMessages: [{ role: 'user', content: 'earlier turn' }],
      numCtx: 32_768,
      timeoutMs: 60_000,
    });

    await session.prewarm('session-a');

    expect(request?.url).toBe('https://broker/v1/remote/cache/warm');
    expect(request?.authorization).toBe('Bearer broker-token');
    expect(request?.body).toMatchObject({
      model: 'mlx:qwen',
      sessionId: 'session-a',
      systemMessage: 'stable system',
      systemPromptLayers: { gezel: 'gezel layer', project: 'project layer' },
      volatileContext: 'volatile state',
      priorMessages: [{ role: 'user', content: 'earlier turn' }],
      tools: [{ name: 'read_file' }],
      tuning: { sampling: { temperature: 0.2 } },
    });
  });

  it('streams deltas, executes a tool LOCALLY, and loops to completion', async () => {
    const calls: Array<Record<string, unknown>> = [];
    let n = 0;
    const fetchImpl = (async (_url: string, init: { body: string }) => {
      calls.push(JSON.parse(init.body));
      n += 1;
      if (n === 1) {
        return sseResponse([
          { type: 'delta', text: 'Let me read it. ' },
          {
            type: 'tool_call',
            calls: [{ id: 't1', name: 'read_file', arguments: JSON.stringify({ path: 'a.txt' }) }],
          },
          { type: 'done' },
        ]);
      }
      return sseResponse([
        { type: 'delta', text: 'The file says hello.' },
        { type: 'usage', model: 'm', inputTokens: 10, outputTokens: 5 },
        { type: 'done' },
      ]);
    }) as unknown as typeof fetch;

    let toolRanWithPath: string | undefined;
    const deltas: string[] = [];
    const session = new RemoteSession({
      baseUrl: 'https://b',
      token: 'tok',
      fetch: fetchImpl,
      queue: new ProviderQueue({ concurrency: 1 }),
      bridges: fakeBridge({
        read_file: async (args) => {
          toolRanWithPath = String(args.path);
          return 'contents of a.txt';
        },
      }),
      systemMessage: 'sys',
      model: 'llama-cpp:big',
      priorMessages: [],
      numCtx: 32_768,
      timeoutMs: 60_000,
    });
    session.onDelta((d) => deltas.push(d));

    const text = await session.sendAndWait('read a.txt', {
      queue: {
        lane: 'interactive',
        affinity: true,
        sessionId: 's1',
        gezelId: 'g1',
        projectId: 'p1',
      },
    });

    expect(text).toBe('Let me read it. The file says hello.');
    expect(deltas.join('')).toBe('Let me read it. The file says hello.');
    expect(toolRanWithPath).toBe('a.txt');

    // Two forward-passes; the second carried the assistant tool-call turn + the
    // tool result in priorMessages (the loop runs on A).
    expect(calls).toHaveLength(2);
    const prior = calls[1]!.priorMessages as Array<Record<string, unknown>>;
    expect(prior.some((m) => m.role === 'user' && m.content === 'read a.txt')).toBe(true);
    expect(prior.some((m) => m.role === 'tool' && m.content === 'contents of a.txt')).toBe(true);
    expect(
      prior.some(
        (m) =>
          m.role === 'assistant' &&
          Array.isArray(m.toolCalls) &&
          (m.toolCalls as unknown[]).length === 1,
      ),
    ).toBe(true);

    // A advertised its local bridge tools on the wire; B never executed them.
    const tools = calls[0]!.tools as Array<{ name: string }>;
    expect(tools.map((t) => t.name)).toContain('read_file');
    expect(calls[0]!.queue).toMatchObject({ projectId: 'p1' });
  });

  it('throws when B sends an error frame', async () => {
    const fetchImpl = (async () =>
      sseResponse([
        { type: 'error', code: 'model_not_loaded', message: 'nope' },
      ])) as unknown as typeof fetch;
    const session = new RemoteSession({
      baseUrl: 'https://b',
      token: 't',
      fetch: fetchImpl,
      queue: new ProviderQueue({ concurrency: 1 }),
      bridges: fakeBridge({}),
      systemMessage: 's',
      model: 'm',
      priorMessages: [],
      numCtx: 32_768,
      timeoutMs: 60_000,
    });
    await expect(
      session.sendAndWait('hi', { queue: { lane: 'interactive', affinity: true } }),
    ).rejects.toThrow(/model_not_loaded/);
  });

  it('returns immediately when B streams no tool calls', async () => {
    const fetchImpl = (async () =>
      sseResponse([
        { type: 'delta', text: 'just text' },
        { type: 'done' },
      ])) as unknown as typeof fetch;
    const session = new RemoteSession({
      baseUrl: 'https://b',
      token: 't',
      fetch: fetchImpl,
      queue: new ProviderQueue({ concurrency: 1 }),
      bridges: fakeBridge({}),
      systemMessage: 's',
      model: 'm',
      priorMessages: [],
      numCtx: 32_768,
      timeoutMs: 60_000,
    });
    const text = await session.sendAndWait('hi', {
      queue: { lane: 'interactive', affinity: true },
    });
    expect(text).toBe('just text');
  });

  it('resolves rotated broker ports and credentials before every turn', async () => {
    const calls: Array<{
      url: string;
      authorization: string | null;
      body: Record<string, unknown>;
    }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({
        url,
        authorization: new Headers(init?.headers).get('authorization'),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return sseResponse([{ type: 'delta', text: 'ok' }, { type: 'done' }]);
    }) as unknown as typeof fetch;
    let connection = { baseUrl: 'https://127.0.0.1:7001', token: 'first', fetch: fetchImpl };
    const session = new RemoteSession({
      baseUrl: 'https://stale.invalid',
      token: 'stale',
      fetch: fetchImpl,
      resolveConnection: () => connection,
      queue: new ProviderQueue({ concurrency: 1 }),
      bridges: fakeBridge({}),
      systemMessage: 's',
      model: 'm',
      priorMessages: [],
      numCtx: 32_768,
      timeoutMs: 60_000,
    });

    await session.sendAndWait('one');
    connection = { baseUrl: 'https://127.0.0.1:7002', token: 'second', fetch: fetchImpl };
    await session.sendAndWait('two');

    expect(calls.map(({ url, authorization }) => ({ url, authorization }))).toEqual([
      { url: 'https://127.0.0.1:7001/v1/remote/infer', authorization: 'Bearer first' },
      { url: 'https://127.0.0.1:7002/v1/remote/infer', authorization: 'Bearer second' },
    ]);
    const secondPrior = calls[1]!.body.priorMessages as Array<Record<string, unknown>>;
    expect(secondPrior).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'user', content: 'one' }),
        expect.objectContaining({ role: 'assistant', content: 'ok' }),
      ]),
    );
  });

  it('updates pressure calibration from usage and estimates the complete prompt', async () => {
    const fetchImpl = (async () =>
      sseResponse([
        {
          type: 'usage',
          model: 'm',
          inputTokens: 100,
          outputTokens: 10,
          contextUtilization: { used: 100, limit: 12_288 },
        },
        { type: 'delta', text: 'ok' },
        { type: 'done' },
      ])) as unknown as typeof fetch;
    const session = new RemoteSession({
      baseUrl: 'https://b',
      token: 't',
      fetch: fetchImpl,
      queue: new ProviderQueue({ concurrency: 1 }),
      bridges: fakeBridge({ read_file: async () => 'x' }),
      systemMessage: 'system-prefix',
      model: 'm',
      priorMessages: [{ role: 'user', content: 'earlier-message' }],
      numCtx: 32_768,
      timeoutMs: 60_000,
    });

    expect(session.estimatePromptChars()).toBeGreaterThan(
      'system-prefix'.length + 'earlier-message'.length,
    );
    await session.sendAndWait('hello');
    expect(session.numCtx).toBe(12_288);
    expect(session.estimatePromptChars()).toBeGreaterThan('hello'.length + 'ok'.length);
  });

  it('budgets tool output and compacts older turns inside a remote tool loop', async () => {
    const requests: Array<Record<string, unknown>> = [];
    let pass = 0;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      pass += 1;
      return pass === 1
        ? sseResponse([
            {
              type: 'tool_call',
              calls: [{ id: 't1', name: 'read_file', arguments: '{}' }],
            },
            { type: 'done' },
          ])
        : sseResponse([{ type: 'delta', text: 'done' }, { type: 'done' }]);
    }) as unknown as typeof fetch;
    let toolBudget: { budgetChars?: number; numCtxTokens?: number } | undefined;
    const bridges = {
      isEmpty: () => false,
      getOpenAITools: () => [
        {
          type: 'function' as const,
          name: 'read_file',
          description: 'read',
          parameters: { type: 'object' },
        },
      ],
      callToolRich: async (
        _name: string,
        _args: Record<string, unknown>,
        opts?: { budgetChars?: number; numCtxTokens?: number },
      ) => {
        toolBudget = opts;
        return { text: 'tool result', images: [] };
      },
      stop: async () => {},
    } as unknown as McpBridgePool;
    const compactions: Array<Array<{ role: string; content: string }>> = [];
    const session = new RemoteSession({
      baseUrl: 'https://b',
      token: 't',
      fetch: fetchImpl,
      queue: new ProviderQueue({ concurrency: 1 }),
      bridges,
      systemMessage: 's'.repeat(24_000),
      model: 'm',
      priorMessages: [
        { role: 'user', content: 'old one' },
        { role: 'assistant', content: 'old reply one' },
        { role: 'user', content: 'old two' },
        { role: 'assistant', content: 'old reply two' },
      ],
      numCtx: 8_192,
      requestCompaction: async ({ priorMessages }) => {
        compactions.push(priorMessages);
        return { syntheticContent: '[condensed history]' };
      },
      timeoutMs: 60_000,
    });

    await expect(session.sendAndWait('current request')).resolves.toBe('done');
    expect(toolBudget?.numCtxTokens).toBe(8_192);
    expect(toolBudget?.budgetChars).toBeTypeOf('number');
    expect(compactions).toHaveLength(1);
    expect(compactions[0]).toHaveLength(4);
    const continuation = requests[1]!.priorMessages as Array<Record<string, unknown>>;
    expect(continuation[0]).toMatchObject({ role: 'assistant', content: '[condensed history]' });
    expect(continuation).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'user', content: 'current request' }),
        expect.objectContaining({ role: 'tool', content: 'tool result' }),
      ]),
    );
  });
});
