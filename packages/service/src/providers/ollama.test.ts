import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OllamaProvider,
  type ToolCallEntry,
  buildLoopBailMessage,
  detectRepeatCall,
  heuristicNumCtx,
  stableArgsKey,
} from './ollama.js';
import type { TurnUsage } from './types.js';

/**
 * Build a mock `fetch` that matches URLs by substring and returns canned
 * responses. Each URL can resolve to either a static JSON body or a
 * ReadableStream of NDJSON chunks. Unhandled URLs reject loudly.
 */
function stubFetch(handlers: Record<string, () => Response | Promise<Response>>): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0]) => {
    const url = typeof input === 'string' ? input : input.toString();
    for (const [pattern, fn] of Object.entries(handlers)) {
      if (url.includes(pattern)) return fn();
    }
    throw new Error(`[test-fetch] no handler for ${url}`);
  }) as typeof fetch;
}

function ndjsonResponse(lines: unknown[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      for (const line of lines) {
        ctrl.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
      }
      ctrl.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'application/x-ndjson' },
  });
}

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('OllamaProvider.listModels', () => {
  it('maps /api/tags into ModelInfo[] with family-based tool support', async () => {
    globalThis.fetch = stubFetch({
      '/api/tags': () =>
        new Response(
          JSON.stringify({
            models: [
              { name: 'llama3.2', details: { parameter_size: '3B' } },
              { name: 'qwen2.5:7b', details: { parameter_size: '7B' } },
              { name: 'phi3:mini', details: { parameter_size: '3.8B' } },
            ],
          }),
          { status: 200 },
        ),
    });

    const provider = new OllamaProvider({ baseUrl: 'http://ollama.test' });
    const models = await provider.listModels();
    expect(models).toHaveLength(3);
    const byId = new Map(models.map((m) => [m.id, m]));
    expect(byId.get('llama3.2')?.supportsTools).toBe(true);
    expect(byId.get('llama3.2')?.parameterSize).toBe('3B');
    expect(byId.get('qwen2.5:7b')?.supportsTools).toBe(true);
    // phi3 isn't on the tool-capable allowlist.
    expect(byId.get('phi3:mini')?.supportsTools).toBe(false);
  });

  it('forwards cancellation to the lazy /api/tags initialization probe', async () => {
    const requestSignal: { value: AbortSignal | undefined } = { value: undefined };
    globalThis.fetch = (async (_input, init) => {
      requestSignal.value = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        const onAbort = () => reject(requestSignal.value?.reason);
        requestSignal.value?.addEventListener('abort', onAbort, { once: true });
      });
    }) as typeof fetch;
    const provider = new OllamaProvider({ baseUrl: 'http://ollama.test' });
    const controller = new AbortController();

    const pending = provider.initialize(controller.signal);
    expect(requestSignal.value).toBe(controller.signal);
    controller.abort(new DOMException('setup discovery timed out', 'AbortError'));

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(requestSignal.value?.aborted).toBe(true);
  });
});

describe('OllamaProvider chat turn', () => {
  it('streams deltas and returns the full concatenated text', async () => {
    globalThis.fetch = stubFetch({
      '/api/tags': () => new Response(JSON.stringify({ models: [] }), { status: 200 }),
      '/api/chat': () =>
        ndjsonResponse([
          { message: { role: 'assistant', content: 'Hello' } },
          { message: { role: 'assistant', content: ' there' } },
          {
            message: { role: 'assistant', content: '!' },
            done: true,
            prompt_eval_count: 9,
            eval_count: 3,
          },
        ]),
    });

    const provider = new OllamaProvider({ baseUrl: 'http://ollama.test' });
    const session = await provider.createSession({
      systemMessage: 'You are a test.',
      model: 'llama3.2',
    });
    const deltas: string[] = [];
    session.onDelta((c) => deltas.push(c));
    const usage: Array<{ inputTokens: number; outputTokens: number }> = [];
    session.onUsage((u) =>
      usage.push({ inputTokens: u.inputTokens, outputTokens: u.outputTokens }),
    );

    const reply = await session.sendAndWait('hi');
    expect(reply).toBe('Hello there!');
    expect(deltas).toEqual(['Hello', ' there', '!']);
    expect(usage).toEqual([{ inputTokens: 9, outputTokens: 3 }]);
  });

  it('populates TurnUsage.contextUtilization with prompt_eval_count vs num_ctx', async () => {
    globalThis.fetch = stubFetch({
      '/api/tags': () => new Response(JSON.stringify({ models: [] }), { status: 200 }),
      '/api/chat': () =>
        ndjsonResponse([
          {
            message: { role: 'assistant', content: 'ok' },
            done: true,
            prompt_eval_count: 1234,
            eval_count: 5,
          },
        ]),
    });

    const provider = new OllamaProvider({ baseUrl: 'http://ollama.test' });
    const session = await provider.createSession({
      systemMessage: 'sys',
      model: 'llama3.2',
      numCtx: 4096,
    });
    const usage: TurnUsage[] = [];
    session.onUsage((u) => usage.push(u));

    await session.sendAndWait('hi');
    expect(usage).toHaveLength(1);
    expect(usage[0]?.contextUtilization).toEqual({ used: 1234, limit: 4096 });
  });

  it('logs a truncation-likely warning when prompt_eval_count ≥ 95% of num_ctx', async () => {
    globalThis.fetch = stubFetch({
      '/api/tags': () => new Response(JSON.stringify({ models: [] }), { status: 200 }),
      '/api/chat': () =>
        ndjsonResponse([
          {
            message: { role: 'assistant', content: 'ok' },
            done: true,
            // 3900 / 4096 ≈ 95.2% — just over the threshold.
            prompt_eval_count: 3900,
            eval_count: 1,
          },
        ]),
    });

    const warnSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const provider = new OllamaProvider({ baseUrl: 'http://ollama.test' });
    const session = await provider.createSession({
      systemMessage: 'sys',
      model: 'llama3.2',
      numCtx: 4096,
    });

    await session.sendAndWait('hi');
    const truncWarn = warnSpy.mock.calls.find((args) =>
      args.some((a) => typeof a === 'string' && a.includes('context truncation likely')),
    );
    expect(truncWarn).toBeTruthy();
    expect(truncWarn?.[0]).toMatch(/3900\/4096/);
  });

  it('aborts the fetch when the caller-supplied signal fires', async () => {
    // Fetch that resolves to a stream which only closes when the
    // fetch signal fires. ollama's sendAndWait must wire the
    // external signal into the fetch call so user-initiated cancel
    // propagates through; without that wire the stream hangs, the
    // reader loop never exits, and the test trips the 5s timeout.
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/tags')) {
        return new Response(JSON.stringify({ models: [] }), { status: 200 });
      }
      let streamCtrl: ReadableStreamDefaultController<Uint8Array> | undefined;
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          streamCtrl = c;
        },
      });
      const abortStream = () => {
        streamCtrl?.error(new DOMException('aborted', 'AbortError'));
      };
      if (init?.signal) {
        if (init.signal.aborted) abortStream();
        else init.signal.addEventListener('abort', abortStream, { once: true });
      }
      return new Response(stream, { status: 200 });
    }) as typeof fetch;

    const provider = new OllamaProvider({ baseUrl: 'http://ollama.test' });
    const session = await provider.createSession({
      systemMessage: 'You are a test.',
      model: 'llama3.2',
    });

    const ctrl = new AbortController();
    const pending = session.sendAndWait('hi', {
      queue: { lane: 'interactive', signal: ctrl.signal },
    });
    // Let the fetch start + stream reader attach before aborting.
    await new Promise<void>((r) => setTimeout(r, 10));
    ctrl.abort();
    await expect(pending).rejects.toThrow(/turn cancelled by caller/);
  });
});

describe('OllamaSession num_ctx wiring', () => {
  it('sends the caller-supplied num_ctx via options.num_ctx', async () => {
    const chatBodies: unknown[] = [];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/tags')) {
        return new Response(JSON.stringify({ models: [] }), { status: 200 });
      }
      if (url.includes('/api/chat')) {
        if (init?.body) chatBodies.push(JSON.parse(init.body as string));
        return ndjsonResponse([{ message: { role: 'assistant', content: 'ok' }, done: true }]);
      }
      throw new Error(`[test-fetch] no handler for ${url}`);
    }) as typeof fetch;

    const provider = new OllamaProvider({ baseUrl: 'http://ollama.test' });
    const session = await provider.createSession({
      systemMessage: 'SYS',
      model: 'llama3.2',
      numCtx: 16384,
    });
    await session.sendAndWait('hi');

    expect(chatBodies).toHaveLength(1);
    const body = chatBodies[0] as { options?: Record<string, number> };
    expect(body.options?.num_ctx).toBe(16384);
  });

  it('falls back to the parameter-size heuristic when num_ctx is not pinned', async () => {
    const chatBodies: unknown[] = [];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/tags')) {
        return new Response(
          JSON.stringify({
            models: [{ name: 'tiny-model', details: { parameter_size: '3B' } }],
          }),
          { status: 200 },
        );
      }
      if (url.includes('/api/chat')) {
        if (init?.body) chatBodies.push(JSON.parse(init.body as string));
        return ndjsonResponse([{ message: { role: 'assistant', content: 'ok' }, done: true }]);
      }
      throw new Error(`[test-fetch] no handler for ${url}`);
    }) as typeof fetch;

    const provider = new OllamaProvider({ baseUrl: 'http://ollama.test' });
    const session = await provider.createSession({
      systemMessage: 'SYS',
      model: 'tiny-model',
    });
    await session.sendAndWait('hi');

    const body = chatBodies[0] as { options?: Record<string, number> };
    expect(body.options?.num_ctx).toBe(16384);
  });
});

describe('heuristicNumCtx', () => {
  it('maps parameter-size strings onto tiered defaults', () => {
    expect(heuristicNumCtx(undefined)).toBe(32768);
    expect(heuristicNumCtx('1B')).toBe(16384);
    expect(heuristicNumCtx('3B')).toBe(16384);
    expect(heuristicNumCtx('7B')).toBe(32768);
    expect(heuristicNumCtx('13B')).toBe(32768);
    expect(heuristicNumCtx('30B')).toBe(65536);
    expect(heuristicNumCtx('70B')).toBe(65536);
  });
});

describe('OllamaSession priorMessages seeding', () => {
  it('passes the seeded transcript + new user message to /api/chat', async () => {
    const chatBodies: unknown[] = [];
    globalThis.fetch = stubFetch({
      '/api/tags': () => new Response(JSON.stringify({ models: [] }), { status: 200 }),
      '/api/chat': async () =>
        ndjsonResponse([{ message: { role: 'assistant', content: 'ok' }, done: true }]),
    });
    // Spy on fetch to inspect the body of /api/chat calls.
    const originalStub = globalThis.fetch;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/chat') && init?.body) {
        chatBodies.push(JSON.parse(init.body as string));
      }
      return originalStub(input, init);
    }) as typeof fetch;

    const provider = new OllamaProvider({ baseUrl: 'http://ollama.test' });
    const session = await provider.createSession({
      systemMessage: 'SYS',
      model: 'llama3.2',
      priorMessages: [
        { role: 'user', content: 'earlier user turn' },
        { role: 'assistant', content: 'earlier reply' },
      ],
    });
    await session.sendAndWait('current question');

    expect(chatBodies).toHaveLength(1);
    const body = chatBodies[0] as { messages: Array<{ role: string; content: string }> };
    expect(body.messages.map((m) => [m.role, m.content])).toEqual([
      ['system', 'SYS'],
      ['user', 'earlier user turn'],
      ['assistant', 'earlier reply'],
      ['user', 'current question'],
    ]);
  });

  it('continues from a seeded tool result without appending an empty user turn', async () => {
    const chatBodies: unknown[] = [];
    const baseFetch = stubFetch({
      '/api/tags': () => new Response(JSON.stringify({ models: [] }), { status: 200 }),
      '/api/chat': async () =>
        ndjsonResponse([{ message: { role: 'assistant', content: 'Built it.' }, done: true }]),
    });
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/chat') && init?.body) {
        chatBodies.push(JSON.parse(init.body as string));
      }
      return baseFetch(input, init);
    }) as typeof fetch;
    const provider = new OllamaProvider({ baseUrl: 'http://ollama.test' });
    const session = await provider.createSession({
      systemMessage: 'SYS',
      model: 'llama3.2',
      priorMessages: [
        { role: 'user', content: 'Build index.html.' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'note-1', name: 'write_task_note', arguments: '{"ref":"frogger/1"}' }],
        },
        { role: 'tool', content: 'Appended note.', toolCallId: 'note-1' },
      ],
    });

    await session.sendAndWait('', { continueFromToolResult: true });

    const body = chatBodies[0] as { messages: Array<{ role: string; content: string }> };
    expect(body.messages.at(-1)).toMatchObject({ role: 'tool', content: 'Appended note.' });
    expect(body.messages).not.toContainEqual({ role: 'user', content: '' });
  });
});

describe('ollama tool-loop bail', () => {
  const entry = (name: string, args: unknown): ToolCallEntry => ({
    name,
    argsKey: stableArgsKey(args),
    argsRaw: args,
  });

  it('detectRepeatCall returns null for diverse, legitimate exploration', () => {
    const log: ToolCallEntry[] = [
      entry('list_dir', { path: 'src' }),
      entry('read_file', { path: 'src/a.ts' }),
      entry('read_file', { path: 'src/b.ts' }),
      entry('read_file', { path: 'src/c.ts' }),
      entry('stat', { path: 'src/d.ts' }),
    ];
    expect(detectRepeatCall(log)).toBeNull();
  });

  it('detectRepeatCall fires when the same (name, args) pair appears 3 times in a row', () => {
    const log: ToolCallEntry[] = [
      entry('list_dir', { path: 'src' }),
      entry('read_file', { path: 'src/a.ts' }),
      entry('read_file', { path: 'src/a.ts' }),
      entry('read_file', { path: 'src/a.ts' }),
    ];
    const hit = detectRepeatCall(log);
    expect(hit).not.toBeNull();
    expect(hit?.name).toBe('read_file');
    expect(hit?.count).toBe(3);
  });

  it('detectRepeatCall does NOT fire on spaced-out cumulative repeats', () => {
    // Developer-style exploration pass: same ref is re-read after each
    // state change. That's legitimate context refresh, not a stuck loop.
    const log: ToolCallEntry[] = [
      entry('list_artifacts', {}),
      entry('list_tasks', {}),
      entry('read_task_notes', { ref: 'saint-louis-trip/1' }),
      entry('get_task', { ref: 'saint-louis-trip/2' }),
      entry('search_memory', { query: 'saint louis' }),
      entry('read_task_notes', { ref: 'saint-louis-trip/1' }),
      entry('write_task_note', { text: 'breakdown' }),
      entry('get_task', { ref: 'saint-louis-trip/1' }),
      entry('advance_task_step', { ref: 'saint-louis-trip/1' }),
      entry('list_tasks', { status: 'active' }),
      entry('ask_user_question', { question: 'what next?' }),
      entry('advance_task_step', { ref: 'saint-louis-trip/1' }),
      entry('ask_user_question', { question: 'what work?' }),
      entry('read_task_notes', { ref: 'saint-louis-trip/1' }),
    ];
    expect(detectRepeatCall(log)).toBeNull();
  });

  it('detectRepeatCall treats different args as distinct', () => {
    const log: ToolCallEntry[] = [
      entry('read_file', { path: 'src/a.ts' }),
      entry('read_file', { path: 'src/b.ts' }),
      entry('read_file', { path: 'src/c.ts' }),
    ];
    expect(detectRepeatCall(log)).toBeNull();
  });

  it('detectRepeatCall fires only on the tail — prior diverse work is fine', () => {
    // Long legitimate run, then the model falls into a spin at the end.
    const log: ToolCallEntry[] = [
      entry('list_tasks', {}),
      entry('read_task_notes', { ref: 'a' }),
      entry('read_file', { path: 'x' }),
      entry('list_dir', { path: 'y' }),
      entry('list_dir', { path: 'y' }),
      entry('list_dir', { path: 'y' }),
    ];
    const hit = detectRepeatCall(log);
    expect(hit?.name).toBe('list_dir');
  });

  it('buildLoopBailMessage (cap) names the reason and lists top tools in non-debug mode', () => {
    const callLog: ToolCallEntry[] = [
      entry('read_file', { path: 'a' }),
      entry('read_file', { path: 'b' }),
      entry('list_dir', { path: 'src' }),
    ];
    const msg = buildLoopBailMessage({ reason: 'cap', callLog, debugOn: false });
    expect(msg).toContain('96 tool-call rounds');
    expect(msg).toContain('read_file ×2');
    expect(msg).toContain('list_dir ×1');
    expect(msg).not.toContain('Sequence:');
  });

  it('buildLoopBailMessage (repeat) names the looped tool', () => {
    const callLog: ToolCallEntry[] = [
      entry('read_file', { path: 'a' }),
      entry('read_file', { path: 'a' }),
      entry('read_file', { path: 'a' }),
    ];
    const msg = buildLoopBailMessage({
      reason: 'repeat',
      callLog,
      debugOn: false,
      repeat: {
        name: 'read_file',
        argsKey: stableArgsKey({ path: 'a' }),
        argsRaw: { path: 'a' },
        count: 3,
      },
    });
    expect(msg).toContain('`read_file`');
    expect(msg).toContain('3× in a row');
  });

  it('buildLoopBailMessage in debug mode appends an ordered sequence', () => {
    const callLog: ToolCallEntry[] = [
      entry('list_dir', { path: 'src' }),
      entry('read_file', { path: 'src/a.ts' }),
    ];
    const msg = buildLoopBailMessage({ reason: 'cap', callLog, debugOn: true });
    expect(msg).toContain('Sequence:');
    expect(msg).toContain('1. list_dir({"path":"src"})');
    expect(msg).toContain('2. read_file({"path":"src/a.ts"})');
  });

  it('buildLoopBailMessage in debug mode clips a runaway sequence', () => {
    const callLog: ToolCallEntry[] = Array.from({ length: 60 }, (_, i) =>
      entry('read_file', { path: `f${i}.ts` }),
    );
    const msg = buildLoopBailMessage({ reason: 'cap', callLog, debugOn: true });
    expect(msg).toContain('…(20 more)');
  });
});
