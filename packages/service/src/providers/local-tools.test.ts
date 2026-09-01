import { turnCancelledMessage } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { LlamaCppProvider } from './llama-cpp/provider.js';
import { MlxProvider } from './mlx/provider.js';
import { OllamaProvider } from './ollama.js';

/**
 * Smoke-test that the local providers advertise external-tools
 * support. The full capture+halt + multi-turn history behavior is
 * covered structurally — these providers mirror the OpenAI/Anthropic
 * pattern already unit-tested in
 * `openai.tools.test.ts` and `anthropic.tools.test.ts`. End-to-end
 * stream-pump coverage would require a stubbed llama-server / Ollama
 * / mlx subprocess and lives in the larger e2e suite.
 *
 * Without this gate, a future refactor that drops `supportsExternalTools`
 * would silently regress the route's tool-support advertisement and
 * users would get `tools_not_supported_for_provider` for engines that
 * actually do support tools.
 */
describe('Local providers advertise supportsExternalTools = true', () => {
  it('LlamaCppProvider', () => {
    const provider = new LlamaCppProvider({ baseUrl: 'http://127.0.0.1:0' });
    expect(provider.supportsExternalTools).toBe(true);
  });

  it('MlxProvider', () => {
    const provider = new MlxProvider({ baseUrl: 'http://127.0.0.1:0' });
    expect(provider.supportsExternalTools).toBe(true);
  });

  it('OllamaProvider', () => {
    const provider = new OllamaProvider({});
    expect(provider.supportsExternalTools).toBe(true);
  });
});

/**
 * Same gate for `supportsPriorMessages`: dropping the flag would make
 * the stateless `/v1` + Ollama-facade routes flatten history into the
 * prompt for engines that honor real turn arrays — degraded quality
 * with no error anywhere.
 */
describe('Local providers advertise supportsPriorMessages = true', () => {
  it('LlamaCppProvider', () => {
    const provider = new LlamaCppProvider({ baseUrl: 'http://127.0.0.1:0' });
    expect(provider.supportsPriorMessages).toBe(true);
  });

  it('MlxProvider', () => {
    const provider = new MlxProvider({ baseUrl: 'http://127.0.0.1:0' });
    expect(provider.supportsPriorMessages).toBe(true);
  });

  it('OllamaProvider', () => {
    const provider = new OllamaProvider({});
    expect(provider.supportsPriorMessages).toBe(true);
  });
});

describe('MlxProvider engine request lock', () => {
  const sseResponse = (content: string): Response =>
    new Response(
      [
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content } }] })}`,
        '',
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}`,
        '',
        'data: [DONE]',
        '',
      ].join('\n'),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );

  it('serializes backend requests even when callers enter concurrently', async () => {
    const provider = new MlxProvider({ baseUrl: 'http://127.0.0.1:0' });
    const events: string[] = [];
    let active = 0;
    let maxActive = 0;
    let releaseFirst!: () => void;

    const first = provider.runExclusiveEngineRequest('first', async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      events.push('first:start');
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      events.push('first:end');
      active--;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const second = provider.runExclusiveEngineRequest('second', async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      events.push('second:start');
      active--;
      events.push('second:end');
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(events).toEqual(['first:start']);
    releaseFirst();
    await Promise.all([first, second]);

    expect(maxActive).toBe(1);
    expect(events).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
  });

  it('removes an aborted physical-slot waiter before handing off the lease', async () => {
    const provider = new MlxProvider({ baseUrl: 'http://127.0.0.1:0' });
    const releaseHeldSlot = await provider.acquireExclusiveEngineRequest('held');
    const ctrl = new AbortController();
    const waiting = provider.acquireExclusiveEngineRequest('cancelled-waiter', ctrl.signal);

    ctrl.abort();
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    releaseHeldSlot();

    const releaseFreshSlot = await provider.acquireExclusiveEngineRequest('fresh');
    releaseFreshSlot();
    expect(provider.isEngineBusy()).toBe(false);
  });

  it('releases the physical slot when an in-flight fetch is aborted', async () => {
    let signalFirstFetchEntered!: () => void;
    const firstFetchEntered = new Promise<void>((resolve) => {
      signalFirstFetchEntered = resolve;
    });
    let fetchCalls = 0;
    const fetchImpl = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      fetchCalls++;
      if (fetchCalls === 1) {
        signalFirstFetchEntered();
        return await new Promise<Response>((_resolve, reject) => {
          const abort = () => reject(new DOMException('aborted', 'AbortError'));
          if (init?.signal?.aborted) abort();
          else init?.signal?.addEventListener('abort', abort, { once: true });
        });
      }
      return sseResponse('recovered');
    }) as typeof fetch;
    const provider = new MlxProvider({ baseUrl: 'http://mlx.test', fetchImpl });
    const firstSession = await provider.createSession({ systemMessage: 'first' });
    const secondSession = await provider.createSession({ systemMessage: 'second' });
    const ctrl = new AbortController();
    const first = firstSession.sendAndWait('hang', {
      queue: { lane: 'interactive', sessionId: 'abort-first', signal: ctrl.signal },
    });
    await firstFetchEntered;
    const second = secondSession.sendAndWait('follow-up', {
      queue: { lane: 'background', sessionId: 'after-abort' },
    });

    ctrl.abort();
    await expect(first).rejects.toThrow(turnCancelledMessage());
    await expect(second).resolves.toBe('recovered');
    expect(fetchCalls).toBe(2);
    expect(provider.isEngineBusy()).toBe(false);
  });

  it('releases the physical slot after fetch and HTTP response failures', async () => {
    for (const failure of ['transport', 'http'] as const) {
      const fetchImpl = (async () => {
        if (failure === 'transport') throw new Error('socket broke');
        return new Response('engine unavailable', { status: 503, statusText: 'Unavailable' });
      }) as typeof fetch;
      const provider = new MlxProvider({ baseUrl: 'http://mlx.test', fetchImpl });
      const session = await provider.createSession({ systemMessage: failure });

      await expect(
        session.sendAndWait('fail', {
          queue: { lane: 'interactive', sessionId: `${failure}-failure` },
        }),
      ).rejects.toThrow();
      expect(provider.isEngineBusy()).toBe(false);
    }
  });

  it('bounds physical-slot waiting by the turn deadline', async () => {
    const provider = new MlxProvider({
      baseUrl: 'http://mlx.test',
      fetchImpl: (async () => {
        throw new Error('a timed-out waiter must not reach fetch');
      }) as typeof fetch,
    });
    const releaseHeldSlot = await provider.acquireExclusiveEngineRequest('held');
    const waitingSession = await provider.createSession({ systemMessage: 'waiting' });

    await expect(
      waitingSession.sendAndWait('wait', {
        timeoutMs: 25,
        queue: { lane: 'background', sessionId: 'deadline-waiter' },
      }),
    ).rejects.toThrow('timed out');

    releaseHeldSlot();
    const releaseFreshSlot = await provider.acquireExclusiveEngineRequest('fresh');
    releaseFreshSlot();
    expect(provider.isEngineBusy()).toBe(false);
  });
});

describe('MlxProvider immediate write_file rescue tuning', () => {
  it('turns off thinking and raises short output budgets for urgent write_file-only turns', async () => {
    let capturedBody: Record<string, unknown> | null = null;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      const sse = [
        'data: {"choices":[{"index":0,"delta":{"content":"done"},"finish_reason":"stop"}]}',
        '',
        'data: [DONE]',
        '',
      ].join('\n');
      return new Response(sse, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }) as typeof fetch;
    const provider = new MlxProvider({ baseUrl: 'http://mlx.test', fetchImpl });
    const session = await provider.createSession({
      systemMessage: 'system',
      externalTools: [
        {
          name: 'write_file',
          description: 'write a file',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string' }, content: { type: 'string' } },
            required: ['path', 'content'],
          },
        },
      ],
      tuning: {
        sampling: { temperature: 0.6, topP: 0.95, maxTokens: 2_048 },
        reasoning: { enableThinking: true },
        output: {},
        promptTags: {},
        wasThinking: true,
      },
    });

    await session.sendAndWait(
      '[scenario check] There is still **no `index.html`** in the workspace. Do not end your turn until `write_file` has created it.',
      { timeoutMs: 5_000 },
    );

    const body = capturedBody as Record<string, unknown> | null;
    expect(body?.max_tokens).toBe(4096);
    expect(body?.temperature).toBe(0.2);
    expect(body?.top_p).toBe(0.8);
    expect(body?.chat_template_kwargs).toEqual({ enable_thinking: false });
    const messages = body?.messages as Array<{ role: string; content: string }>;
    expect(messages.at(-1)?.content).toContain('make this a compact first pass');
    expect(messages.at(-1)?.content).toContain('Prioritize a complete, runnable file');
    expect(messages.at(-1)?.content).not.toContain('under 250 lines');
  });

  it('raises the output floor for direct file work without forcing write_file-only rescue', async () => {
    let capturedBody: Record<string, unknown> | null = null;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      const sse = [
        'data: {"choices":[{"index":0,"delta":{"content":"done"},"finish_reason":"stop"}]}',
        '',
        'data: [DONE]',
        '',
      ].join('\n');
      return new Response(sse, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }) as typeof fetch;
    const provider = new MlxProvider({ baseUrl: 'http://mlx.test', fetchImpl });
    const session = await provider.createSession({
      systemMessage: 'system',
      externalTools: [
        {
          name: 'write_file',
          description: 'write a file',
          parameters: { type: 'object', properties: {} },
        },
        {
          name: 'write_task_note',
          description: 'write a task note',
          parameters: { type: 'object', properties: {} },
        },
      ],
      forceDirectFileWork: true,
      tuning: {
        sampling: { maxTokens: 2_048 },
        reasoning: { enableThinking: true },
        output: {},
        promptTags: {},
        wasThinking: true,
      },
    });

    await session.sendAndWait('Lock acceptance criteria, then build index.html.', {
      timeoutMs: 5_000,
    });

    const body = capturedBody as Record<string, unknown> | null;
    expect(body?.max_tokens).toBe(4096);
    const messages = body?.messages as Array<{ role: string; content: string }>;
    expect(messages.at(-1)?.content).not.toContain('[Local-model rescue:');
  });
});

describe('MlxProvider tool salvage', () => {
  it('does not promote hidden tools that were not advertised this turn', async () => {
    const fetchImpl = (async () => {
      const content = [
        'I will delegate this.',
        '<tool_call>',
        '<function=message_gezel>',
        '<parameter=gezel>moana</parameter>',
        '<parameter=message>Please patch index.html</parameter>',
        '</function>',
        '</tool_call>',
      ].join('\n');
      const sse = [
        `data: ${JSON.stringify({
          choices: [{ index: 0, delta: { content }, finish_reason: 'stop' }],
        })}`,
        '',
        'data: [DONE]',
        '',
      ].join('\n');
      return new Response(sse, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }) as typeof fetch;
    const provider = new MlxProvider({ baseUrl: 'http://mlx.test', fetchImpl });
    const session = await provider.createSession({
      systemMessage: 'system',
      externalTools: [
        {
          name: 'write_file',
          description: 'write a file',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string' }, content: { type: 'string' } },
            required: ['path', 'content'],
          },
        },
      ],
    });

    const reply = await session.sendAndWait('write index.html', { timeoutMs: 5_000 });

    expect(reply).toContain('message_gezel');
    expect(session.capturedToolCalls?.()).toEqual([]);
  });
});
