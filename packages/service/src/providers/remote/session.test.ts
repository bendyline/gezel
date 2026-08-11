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
  handlers: Record<
    string,
    (args: Record<string, unknown>) => Promise<string | { text: string; isError: boolean }>
  >,
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
    callToolRich: async (name: string, args: Record<string, unknown>) => {
      const result = await handlers[name]!(args);
      return {
        ...(typeof result === 'string' ? { text: result, isError: false } : result),
        images: [],
      };
    },
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

  it('captures every call when caller tools are advertised, even if no returned name matches', async () => {
    const requests: Array<Record<string, unknown>> = [];
    let bridgeCalls = 0;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return sseResponse([
        { type: 'delta', text: 'I will inspect it.' },
        {
          type: 'tool_call',
          calls: [
            { id: 'read-1', name: 'read_file', arguments: '{"path":"README.md"}' },
            { id: 'unknown-1', name: 'hallucinated_tool', arguments: '{}' },
          ],
        },
        { type: 'done' },
      ]);
    }) as unknown as typeof fetch;
    const session = new RemoteSession({
      baseUrl: 'https://broker',
      token: 'broker-token',
      fetch: fetchImpl,
      queue: new ProviderQueue({ concurrency: 1 }),
      bridges: fakeBridge({
        read_file: async () => {
          bridgeCalls += 1;
          return 'must not run';
        },
      }),
      externalTools: [
        {
          name: 'shell',
          description: 'Run a shell command',
          parameters: { type: 'object', properties: { command: { type: 'string' } } },
        },
      ],
      systemMessage: 'system',
      model: 'llama-cpp:qwen',
      priorMessages: [],
      numCtx: 65_536,
      timeoutMs: 60_000,
    });

    await expect(session.sendAndWait('inspect the repository')).resolves.toBe('I will inspect it.');

    expect(requests).toHaveLength(1);
    expect((requests[0]!.tools as Array<{ name: string }>).map((tool) => tool.name)).toEqual([
      'read_file',
      'shell',
    ]);
    expect(bridgeCalls).toBe(0);
    expect(session.capturedToolCalls()).toEqual([
      { id: 'read-1', name: 'read_file', arguments: '{"path":"README.md"}' },
      { id: 'unknown-1', name: 'hallucinated_tool', arguments: '{}' },
    ]);
  });

  it('forwards native-engine liveness, TTFT phases, and performance telemetry', async () => {
    const fetchImpl = (async () =>
      sseResponse([
        { type: 'phase', provider: 'llama-cpp', phase: 'prefill', detail: 'prompt' },
        { type: 'wire_pulse' },
        { type: 'reasoning_delta', text: 'considering' },
        { type: 'tool_args_delta', name: 'write_file', text: '{"path":"game.html"' },
        {
          type: 'phase',
          provider: 'llama-cpp',
          phase: 'generating',
          detail: 'First token in 12.3s',
          ttftMs: 12_345,
        },
        {
          type: 'turn_stats',
          provider: 'llama-cpp',
          promptTokens: 100,
          completionTokens: 20,
          durationMs: 5000,
          tokensPerSec: 4,
        },
        { type: 'engine_stats', provider: 'llama-cpp', ramAllocBytes: 4_000_000_000 },
        { type: 'delta', text: 'Ready.' },
        { type: 'done' },
      ])) as unknown as typeof fetch;
    const session = new RemoteSession({
      baseUrl: 'https://b',
      token: 'tok',
      fetch: fetchImpl,
      queue: new ProviderQueue({ concurrency: 1 }),
      bridges: fakeBridge({}),
      systemMessage: 'sys',
      model: 'llama-cpp:gemma-e2b',
      priorMessages: [],
      numCtx: 32_768,
      timeoutMs: 60_000,
    });
    const phases: Array<{ phase: string; ttftMs?: number }> = [];
    const reasoning: string[] = [];
    const toolArgs: Array<[string, string]> = [];
    const turnStats: Array<{ tokensPerSec?: number }> = [];
    const engineStats: Array<{ ramAllocBytes: number }> = [];
    let pulses = 0;
    session.onEnginePhase((event) => phases.push(event));
    session.onReasoningDelta((text) => reasoning.push(text));
    session.onToolArgsDelta((name, text) => toolArgs.push([name, text]));
    session.onWirePulse(() => {
      pulses += 1;
    });
    session.onTurnStats((event) => turnStats.push(event));
    session.onEngineStats((event) => engineStats.push(event));

    await expect(session.sendAndWait('build it')).resolves.toBe('Ready.');
    expect(phases).toEqual([
      { provider: 'llama-cpp', phase: 'prefill', detail: 'prompt' },
      {
        provider: 'llama-cpp',
        phase: 'generating',
        detail: 'First token in 12.3s',
        ttftMs: 12_345,
      },
    ]);
    expect(reasoning).toEqual(['considering']);
    expect(toolArgs).toEqual([['write_file', '{"path":"game.html"']]);
    expect(pulses).toBe(1);
    expect(turnStats).toEqual([
      {
        provider: 'llama-cpp',
        promptTokens: 100,
        completionTokens: 20,
        durationMs: 5000,
        tokensPerSec: 4,
      },
    ]);
    expect(engineStats).toEqual([{ provider: 'llama-cpp', ramAllocBytes: 4_000_000_000 }]);
  });

  it('advances from acceptance note to deliverable write across remote forward passes', async () => {
    const requests: Array<Record<string, unknown>> = [];
    const emitted = [
      {
        id: 'note-1',
        name: 'write_task_note',
        arguments: '{"ref":"frogger/1","stepId":"build","text":"Acceptance checklist"}',
      },
      {
        id: 'write-1',
        name: 'write_file',
        arguments: '{"path":"index.html","content":"<!doctype html><canvas></canvas>"}',
      },
    ];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const call = emitted.shift();
      return call
        ? sseResponse([{ type: 'tool_call', calls: [call] }, { type: 'done' }])
        : sseResponse([{ type: 'delta', text: 'Built the game.' }, { type: 'done' }]);
    }) as unknown as typeof fetch;
    const executed: string[] = [];
    const session = new RemoteSession({
      baseUrl: 'https://b',
      token: 'tok',
      fetch: fetchImpl,
      queue: new ProviderQueue({ concurrency: 1 }),
      bridges: fakeBridge({
        write_task_note: async () => {
          executed.push('write_task_note');
          return 'Appended acceptance checklist.';
        },
        write_file: async () => {
          executed.push('write_file');
          return 'Wrote index.html.';
        },
      }),
      systemMessage: 'sys',
      model: 'mlx:gemma4-e4b-q4',
      priorMessages: [],
      numCtx: 32_768,
      timeoutMs: 60_000,
    });

    await expect(
      session.sendAndWait('Record the checklist, then build index.html.', {
        attachments: [{ base64: 'aW1hZ2U=', mimeType: 'image/png', filename: 'reference.png' }],
      }),
    ).resolves.toBe('Built the game.');
    expect(executed).toEqual(['write_task_note', 'write_file']);
    expect(requests).toHaveLength(3);
    expect(requests[0]!.attachments).toHaveLength(1);
    expect(requests[1]!.prompt).toBe('');
    expect(requests[1]!.attachments).toBeUndefined();
    expect(requests[2]!.prompt).toBe('');
    expect(requests[2]!.attachments).toBeUndefined();
    expect(
      (requests[2]!.priorMessages as Array<Record<string, unknown>>).filter(
        (message) => message.role === 'user' && message.content === '',
      ),
    ).toEqual([]);
  });

  it('stops varying-text write_task_note spin in the outer remote loop', async () => {
    const requests: Array<Record<string, unknown>> = [];
    let pass = 0;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      pass += 1;
      return sseResponse([
        {
          type: 'tool_call',
          calls: [
            {
              id: `note-${pass}`,
              name: 'write_task_note',
              arguments: JSON.stringify({
                ref: 'frogger/1',
                stepId: 'build',
                text: `Acceptance checklist version ${pass}`,
              }),
            },
          ],
        },
        { type: 'done' },
      ]);
    }) as unknown as typeof fetch;
    let noteWrites = 0;
    const session = new RemoteSession({
      baseUrl: 'https://b',
      token: 'tok',
      fetch: fetchImpl,
      queue: new ProviderQueue({ concurrency: 1 }),
      bridges: fakeBridge({
        write_task_note: async () => {
          noteWrites += 1;
          return `Appended note ${noteWrites}.`;
        },
        write_file: async () => 'Wrote index.html.',
      }),
      systemMessage: 'sys',
      model: 'mlx:gemma4-e4b-q4',
      priorMessages: [],
      numCtx: 32_768,
      activeCraftbookStep: { name: 'Build' },
      timeoutMs: 60_000,
    });

    await expect(
      session.sendAndWait('Record acceptance criteria, then write index.html.'),
    ).rejects.toMatchObject({ code: 'turn-aborted' });
    expect(noteWrites).toBe(5);
    expect(requests).toHaveLength(5);
    const fourthPrior = requests[3]!.priorMessages as Array<Record<string, unknown>>;
    expect(fourthPrior.at(-1)?.content).toContain('Stop re-writing');
  });

  it('stops repeated tool failures across remote passes even when arguments change', async () => {
    const requests: Array<Record<string, unknown>> = [];
    let pass = 0;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      pass += 1;
      return sseResponse([
        {
          type: 'tool_call',
          calls: [
            {
              id: `write-${pass}`,
              name: 'write_file',
              arguments: JSON.stringify({
                path: `attempt-${pass}.html`,
                content: `draft ${pass}`,
              }),
            },
          ],
        },
        { type: 'done' },
      ]);
    }) as unknown as typeof fetch;
    let writes = 0;
    const session = new RemoteSession({
      baseUrl: 'https://b',
      token: 'tok',
      fetch: fetchImpl,
      queue: new ProviderQueue({ concurrency: 1 }),
      bridges: fakeBridge({
        write_file: async () => {
          writes += 1;
          return { text: 'Write failed: validation rejected the draft', isError: true };
        },
      }),
      systemMessage: 'sys',
      model: 'mlx:gemma4-e4b-q4',
      priorMessages: [],
      numCtx: 32_768,
      timeoutMs: 60_000,
    });

    await expect(session.sendAndWait('Write the deliverable.')).rejects.toMatchObject({
      code: 'turn-aborted',
    });
    expect(writes).toBe(5);
    expect(requests).toHaveLength(5);
    const fourthPrior = requests[3]!.priorMessages as Array<Record<string, unknown>>;
    expect(fourthPrior.at(-1)?.content).toContain('STOP retrying fragments');
  });

  it('ends the turn immediately after a successful project kickoff', async () => {
    let forwardPasses = 0;
    let kickoffCalls = 0;
    const fetchImpl = (async () => {
      forwardPasses++;
      return sseResponse([
        {
          type: 'tool_call',
          calls: [
            {
              id: 'kickoff-1',
              name: 'start_project',
              arguments: JSON.stringify({ name: 'Frogger Arcade' }),
            },
          ],
        },
        { type: 'done' },
      ]);
    }) as unknown as typeof fetch;
    const session = new RemoteSession({
      baseUrl: 'https://b',
      token: 'tok',
      fetch: fetchImpl,
      queue: new ProviderQueue({ concurrency: 1 }),
      bridges: fakeBridge({
        start_project: async () => {
          kickoffCalls++;
          return 'Started project "Frogger Arcade" (frogger-arcade). Recruited Maya as lead (template: developer). Created task frogger-arcade/1.';
        },
      }),
      systemMessage: 'sys',
      model: 'mlx:gemma-e4b',
      priorMessages: [],
      numCtx: 32_768,
      timeoutMs: 60_000,
    });

    const text = await session.sendAndWait('Build me Frogger');

    expect(forwardPasses).toBe(1);
    expect(kickoffCalls).toBe(1);
    expect(text).toContain('Project "Frogger Arcade" is kicked off');
    expect(text).toContain('Maya is on it');
  });

  it('stops after two failed project kickoffs even when the model varies the arguments', async () => {
    let forwardPasses = 0;
    let kickoffCalls = 0;
    const fetchImpl = (async () => {
      forwardPasses++;
      return sseResponse([
        {
          type: 'tool_call',
          calls: [
            {
              id: `kickoff-${forwardPasses}`,
              name: 'start_project',
              arguments: JSON.stringify({ name: `Frogger ${forwardPasses}` }),
            },
          ],
        },
        { type: 'done' },
      ]);
    }) as unknown as typeof fetch;
    const session = new RemoteSession({
      baseUrl: 'https://b',
      token: 'tok',
      fetch: fetchImpl,
      queue: new ProviderQueue({ concurrency: 1 }),
      bridges: fakeBridge({
        start_project: async () => {
          kickoffCalls++;
          return { text: 'start_project failed: routing unavailable', isError: true };
        },
      }),
      systemMessage: 'sys',
      model: 'mlx:gemma-e4b',
      priorMessages: [],
      numCtx: 32_768,
      timeoutMs: 60_000,
    });

    const text = await session.sendAndWait('Build me Frogger');

    expect(forwardPasses).toBe(2);
    expect(kickoffCalls).toBe(2);
    expect(text).toContain("couldn't start the project after 2 attempts");
    expect(text).toContain('routing unavailable');
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

  it('simplifies rejected llama.cpp tool grammars across an older remote broker', async () => {
    const requests: Array<Record<string, unknown>> = [];
    let attempt = 0;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      attempt += 1;
      if (attempt <= 2) {
        return sseResponse([
          {
            type: 'error',
            code: 'inference_failed',
            message:
              '[llama-cpp] /v1/chat/completions returned 400 Bad Request: Failed to initialize samplers: failed to parse grammar',
          },
        ]);
      }
      return sseResponse([{ type: 'delta', text: 'Recovered.' }, { type: 'done' }]);
    }) as unknown as typeof fetch;
    const session = new RemoteSession({
      baseUrl: 'https://b',
      token: 't',
      fetch: fetchImpl,
      queue: new ProviderQueue({ concurrency: 1 }),
      bridges: fakeBridge({}),
      externalTools: [
        {
          name: 'handoff',
          description: 'Delegate work',
          parameters: {
            type: 'object',
            properties: {
              target: {
                oneOf: [{ type: 'string', pattern: '^developer$' }, { type: 'number' }],
              },
            },
            required: ['target'],
          },
        },
      ],
      systemMessage: 's',
      model: 'llama-cpp:qwen',
      priorMessages: [],
      numCtx: 65_536,
      timeoutMs: 60_000,
    });

    await expect(session.sendAndWait('hi')).resolves.toBe('Recovered.');

    expect(requests).toHaveLength(3);
    const parameters = requests.map(
      (request) => (request.tools as Array<{ parameters: Record<string, unknown> }>)[0]!.parameters,
    );
    expect(parameters[0]).toMatchObject({
      properties: { target: { oneOf: expect.any(Array) } },
      required: ['target'],
    });
    expect(parameters[1]).toEqual({
      type: 'object',
      properties: { target: {} },
      required: ['target'],
    });
    expect(parameters[2]).toEqual({ type: 'object' });
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

  it('counts overlapping prefix-cache layers as metadata, not extra prompt text', () => {
    const stable = 's'.repeat(40_000);
    const gezelPrefix = stable.slice(0, 30_000);
    const session = new RemoteSession({
      baseUrl: 'https://b',
      token: 't',
      fetch: (async () => sseResponse([{ type: 'done' }])) as unknown as typeof fetch,
      queue: new ProviderQueue({ concurrency: 1 }),
      bridges: fakeBridge({}),
      systemMessage: stable,
      systemPromptLayers: { gezel: gezelPrefix, project: stable },
      volatileContext: 'volatile',
      model: 'm',
      priorMessages: [{ role: 'user', content: 'earlier' }],
      numCtx: 65_536,
      timeoutMs: 60_000,
    });

    expect(session.estimatePromptChars()).toBe(
      stable.length + 'volatile'.length + 'earlier'.length,
    );
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

  it('holds and retries tenant saturation instead of surfacing HTTP 429', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      if (calls === 1) {
        return Response.json(
          { error: 'tenant_concurrency_exceeded' },
          { status: 429, headers: { 'Retry-After': '0' } },
        );
      }
      return sseResponse([{ type: 'delta', text: 'after the queue' }, { type: 'done' }]);
    }) as typeof fetch;
    const waits: number[] = [];
    const session = new RemoteSession({
      baseUrl: 'https://b',
      token: 't',
      fetch: fetchImpl,
      queue: new ProviderQueue({ concurrency: 1 }),
      bridges: fakeBridge({}),
      systemMessage: 's',
      model: 'mlx:m',
      priorMessages: [],
      numCtx: 32_768,
      timeoutMs: 60_000,
    });

    await expect(
      session.sendAndWait('hi', {
        queue: {
          lane: 'interactive',
          affinity: true,
          onQueueWait: ({ aheadOf }) => waits.push(aheadOf),
        },
      }),
    ).resolves.toBe('after the queue');
    expect(calls).toBe(2);
    expect(waits).toEqual([1]);
  });

  it('does not charge broker queue time against a continued tool-loop timeout', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      if (calls === 1) {
        return Response.json(
          { error: 'tenant_concurrency_exceeded' },
          { status: 429, headers: { 'Retry-After': '0.05' } },
        );
      }
      if (calls === 2) {
        return sseResponse([
          {
            type: 'tool_call',
            calls: [{ id: 't1', name: 'read_file', arguments: '{}' }],
          },
          { type: 'done' },
        ]);
      }
      return sseResponse([{ type: 'delta', text: 'finished' }, { type: 'done' }]);
    }) as typeof fetch;
    const session = new RemoteSession({
      baseUrl: 'https://b',
      token: 't',
      fetch: fetchImpl,
      queue: new ProviderQueue({ concurrency: 1 }),
      bridges: fakeBridge({ read_file: async () => 'contents' }),
      systemMessage: 's',
      model: 'mlx:m',
      priorMessages: [],
      numCtx: 32_768,
      timeoutMs: 20,
    });

    await expect(session.sendAndWait('hi')).resolves.toBe('finished');
    expect(calls).toBe(3);
  });

  it('cancels promptly while waiting for remote tenant capacity', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return Response.json(
        { error: 'tenant_concurrency_exceeded' },
        { status: 429, headers: { 'Retry-After': '60' } },
      );
    }) as typeof fetch;
    const controller = new AbortController();
    const session = new RemoteSession({
      baseUrl: 'https://b',
      token: 't',
      fetch: fetchImpl,
      queue: new ProviderQueue({ concurrency: 1 }),
      bridges: fakeBridge({}),
      systemMessage: 's',
      model: 'mlx:m',
      priorMessages: [],
      numCtx: 32_768,
      timeoutMs: 60_000,
    });

    const pending = session.sendAndWait('hi', {
      queue: { lane: 'interactive', affinity: true, signal: controller.signal },
    });
    while (calls === 0) await Promise.resolve();
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toBe(1);
  });
});
