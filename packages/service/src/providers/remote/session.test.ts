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
      timeoutMs: 60_000,
    });
    session.onDelta((d) => deltas.push(d));

    const text = await session.sendAndWait('read a.txt', {
      queue: { lane: 'interactive', affinity: true, sessionId: 's1', gezelId: 'g1' },
    });

    expect(text).toBe('Let me read it. The file says hello.');
    expect(deltas.join('')).toBe('Let me read it. The file says hello.');
    expect(toolRanWithPath).toBe('a.txt');

    // Two forward-passes; the second carried the assistant tool-call turn + the
    // tool result in priorMessages (the loop runs on A).
    expect(calls).toHaveLength(2);
    const prior = calls[1]!.priorMessages as Array<Record<string, unknown>>;
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
      timeoutMs: 60_000,
    });
    const text = await session.sendAndWait('hi', {
      queue: { lane: 'interactive', affinity: true },
    });
    expect(text).toBe('just text');
  });
});
