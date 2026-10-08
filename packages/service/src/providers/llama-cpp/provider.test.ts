import { turnCancelledMessage } from '@bendyline/gezel';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildStageOneNudge } from '../../tasks/gate-escalation.js';
import { GpuArbiter } from '../gpu-arbiter.js';
import type { NativeEngineSupervisor } from '../native/supervisor.js';
import { LlamaCppCacheAdapter } from './cache-adapter.js';
import {
  LlamaCppProvider,
  NativeEngineCrashedError,
  extractPrerequisiteRepairReadPaths,
} from './provider.js';

/**
 * Build an SSE Response body out of an array of events. Pass `'[DONE]'`
 * as a literal string for the terminator frame; everything else is
 * JSON-stringified and wrapped in `data: … \n\n`.
 */
function sseResponse(events: Array<unknown>): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(ctrl) {
      for (const ev of events) {
        const payload = ev === '[DONE]' ? '[DONE]' : JSON.stringify(ev);
        ctrl.enqueue(encoder.encode(`data: ${payload}\n\n`));
      }
      ctrl.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

/** Minimal fetch stub matching by URL substring — mirrors ollama.test.ts. */
function stubFetch(handlers: Record<string, () => Response | Promise<Response>>): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0]) => {
    const url = typeof input === 'string' ? input : input.toString();
    for (const [pattern, fn] of Object.entries(handlers)) {
      if (url.includes(pattern)) return fn();
    }
    throw new Error(`[test-fetch] no handler for ${url}`);
  }) as typeof fetch;
}

function tool(name: string) {
  return {
    type: 'function' as const,
    function: { name, description: '', parameters: { type: 'object' } },
  };
}

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('LlamaCppProvider physical request gate', () => {
  it('uses every supervised launch slot for interactive batching by default', () => {
    const supervisor = {
      async ensureRunning() {
        return { command: 'fake', args: [], baseUrl: 'http://llama.test' };
      },
      markUsed() {},
      async stop() {},
    } as unknown as NativeEngineSupervisor;
    const provider = new LlamaCppProvider({
      supervisor,
      concurrency: 4,
    });

    expect(provider.batch.maxConcurrency).toBe(4);
    expect(provider.queue.interactiveConcurrency).toBe(4);
    expect(provider.getLaunchedSlots()).toBe(4);
  });

  it('keeps an external server serial unless its batch width is explicit', () => {
    const provider = new LlamaCppProvider({
      baseUrl: 'http://llama.test',
      concurrency: 4,
    });

    expect(provider.batch.maxConcurrency).toBe(1);
    expect(provider.queue.interactiveConcurrency).toBe(1);
  });

  it('serializes cache preparation and streaming at one launched slot while preserving the background queue lane', async () => {
    let releaseFirstFetch!: () => void;
    const firstFetchBlocked = new Promise<void>((resolve) => {
      releaseFirstFetch = resolve;
    });
    let signalFirstFetchEntered!: () => void;
    const firstFetchEntered = new Promise<void>((resolve) => {
      signalFirstFetchEntered = resolve;
    });
    let fetchCalls = 0;
    let activeFetches = 0;
    let maxActiveFetches = 0;
    const fetchImpl = (async () => {
      fetchCalls++;
      const call = fetchCalls;
      activeFetches++;
      maxActiveFetches = Math.max(maxActiveFetches, activeFetches);
      if (call === 1) {
        signalFirstFetchEntered();
        await firstFetchBlocked;
      }
      activeFetches--;
      return sseResponse([
        { choices: [{ index: 0, delta: { content: `reply-${call}` } }] },
        { choices: [{ index: 0, finish_reason: 'stop' }] },
        '[DONE]',
      ]);
    }) as typeof fetch;

    // concurrency=1 launches one real `--parallel` slot. The provider queue
    // still has its second, reserved background lane by default.
    let ensureRunningCalls = 0;
    const supervisor = {
      async ensureRunning() {
        ensureRunningCalls++;
        return { command: 'fake', args: [], baseUrl: 'http://llama.test' };
      },
      markUsed() {},
      async stop() {},
    } as unknown as NativeEngineSupervisor;
    const provider = new LlamaCppProvider({
      supervisor,
      concurrency: 1,
      fetchImpl,
    });
    expect(provider.queue.describe().concurrency).toBe(2);

    const prepared: string[] = [];
    const adapter = new LlamaCppCacheAdapter({
      resolveBaseUrl: async () => null,
      slotCount: 1,
    });
    const prepareForSend = adapter.prepareForSend.bind(adapter);
    adapter.prepareForSend = async (...args) => {
      prepared.push(args[0]);
      await prepareForSend(...args);
    };
    provider.setCacheAdapter(adapter);

    const foreground = await provider.createSession({ systemMessage: 'foreground' });
    const background = await provider.createSession({ systemMessage: 'background' });
    const first = foreground.sendAndWait('first', {
      queue: { lane: 'interactive', sessionId: 'foreground-session' },
    });
    await firstFetchEntered;
    expect(provider.isEngineBusy()).toBe(true);

    const second = background.sendAndWait('second', {
      queue: { lane: 'background', sessionId: 'background-session' },
    });
    // The background logical queue lease is available, but physical cache
    // preparation must stay behind the foreground stream.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(provider.queue.snapshot().running).toBe(2);
    expect(ensureRunningCalls).toBe(1);
    expect(prepared).toEqual(['foreground-session']);
    expect(fetchCalls).toBe(1);
    expect(maxActiveFetches).toBe(1);

    releaseFirstFetch();
    await expect(first).resolves.toBe('reply-1');
    await expect(second).resolves.toBe('reply-2');
    expect(ensureRunningCalls).toBe(2);
    expect(prepared).toEqual(['foreground-session', 'background-session']);
    expect(maxActiveFetches).toBe(1);
    expect(provider.isEngineBusy()).toBe(false);
  });

  it('releases the physical slot when an in-flight request is aborted', async () => {
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
      return sseResponse([
        { choices: [{ index: 0, delta: { content: 'recovered' } }] },
        { choices: [{ index: 0, finish_reason: 'stop' }] },
        '[DONE]',
      ]);
    }) as typeof fetch;
    const provider = new LlamaCppProvider({
      baseUrl: 'http://llama.test',
      concurrency: 1,
      fetchImpl,
    });
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
  });

  it('releases the physical slot after a transport error and admits the next waiter', async () => {
    let fetchCalls = 0;
    const fetchImpl = (async () => {
      fetchCalls++;
      if (fetchCalls === 1) throw new Error('socket broke');
      return sseResponse([
        { choices: [{ index: 0, delta: { content: 'second-ok' } }] },
        { choices: [{ index: 0, finish_reason: 'stop' }] },
        '[DONE]',
      ]);
    }) as typeof fetch;
    const provider = new LlamaCppProvider({
      baseUrl: 'http://llama.test',
      concurrency: 1,
      fetchImpl,
    });
    const failedSession = await provider.createSession({ systemMessage: 'first' });
    const nextSession = await provider.createSession({ systemMessage: 'second' });

    await expect(
      failedSession.sendAndWait('fail', {
        queue: { lane: 'interactive', sessionId: 'transport-failure' },
      }),
    ).rejects.toThrow('socket broke');
    await expect(
      nextSession.sendAndWait('retry', {
        queue: { lane: 'background', sessionId: 'transport-recovery' },
      }),
    ).resolves.toBe('second-ok');
    expect(fetchCalls).toBe(2);
  });

  it('bounds physical-slot waiting by the turn deadline and removes the timed-out waiter', async () => {
    const provider = new LlamaCppProvider({
      baseUrl: 'http://llama.test',
      concurrency: 1,
      fetchImpl: (async () => {
        throw new Error('the timed-out waiter must not reach fetch');
      }) as typeof fetch,
    });
    const releaseHeldSlot = await provider.acquireExclusiveEngineRequest('held-by-first-turn');
    expect(provider.isEngineBusy()).toBe(true);
    const waitingSession = await provider.createSession({ systemMessage: 'waiting' });

    await expect(
      waitingSession.sendAndWait('wait', {
        timeoutMs: 20,
        queue: { lane: 'background', sessionId: 'deadline-waiter' },
      }),
    ).rejects.toThrow('timed out');

    releaseHeldSlot();
    // A timed-out waiter must be removed, not handed the slot later. A fresh
    // claimant should acquire and release immediately.
    const releaseFreshSlot = await provider.acquireExclusiveEngineRequest('fresh-claimant');
    releaseFreshSlot();
    expect(provider.isEngineBusy()).toBe(false);
  });
});

describe('LlamaCppProvider constructor', () => {
  it('rejects missing supervisor + baseUrl', () => {
    expect(() => new LlamaCppProvider({})).toThrow(/need either a supervisor or baseUrl/);
  });

  it('rejects supervisor + baseUrl both set', () => {
    const fakeSupervisor = {} as NativeEngineSupervisor;
    expect(() => new LlamaCppProvider({ supervisor: fakeSupervisor, baseUrl: 'http://x' })).toThrow(
      /mutually exclusive/,
    );
  });

  it('exposes numCtx + estimatePromptChars on the session (ChatManager pressure-check surface)', async () => {
    // ChatManager.checkContextPressure reads these fields off the
    // live session via duck typing (see manager.ts). This test pins
    // the surface in place so a future rename silently breaking the
    // pressure-check is caught here instead of manifesting as "my
    // llama-cpp chat never compacts."
    const provider = new LlamaCppProvider({ baseUrl: 'http://llama.test', numCtx: 8192 });
    const session = await provider.createSession({
      systemMessage: 'You are a test assistant.',
      priorMessages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello back' },
      ],
    });
    expect((session as unknown as { numCtx: number }).numCtx).toBe(8192);
    const estimate = (
      session as unknown as { estimatePromptChars: () => number }
    ).estimatePromptChars();
    // system + 'hi' + 'hello back' = 24 + 2 + 10 = 36.
    expect(estimate).toBe('You are a test assistant.'.length + 'hi'.length + 'hello back'.length);
  });

  it('defaults numCtx to a working 65k window when unset', async () => {
    // 65K matches the provider's built-in cap (bumped 32K → 49K → 65K
    // as matrix-3 petshop OOM'd at 49K under full
    // iteration depth). KV cache at 65K on a 26B Q4_K_M ≈ 2 GB —
    // fits on any host that already has the weights resident.
    const provider = new LlamaCppProvider({ baseUrl: 'http://llama.test' });
    const session = await provider.createSession({ systemMessage: 'sys' });
    expect((session as unknown as { numCtx: number }).numCtx).toBe(65_536);
  });

  /**
   * `timings_per_token` puts llama-server's running counters on every chunk.
   * Publishing them is what lets the status readouts state a token count and
   * a decode rate as fact instead of estimating both from streamed characters
   * and hedging the result with "≈".
   */
  it('fan-outs supervisor-classified phase events to active sessions', async () => {
    // Turn stays running (hangs on stream) until we trigger phase emission
    // from the provider side, then ends naturally.
    let resolveStream: null | (() => void) = null;
    const releaseStream = (): void => {
      resolveStream?.();
    };
    globalThis.fetch = (async () => {
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(ctrl) {
          // Enqueue the terminator only once the test releases it —
          // simulates the window where the session is actively waiting.
          resolveStream = () => {
            ctrl.enqueue(
              encoder.encode(
                'data: {"choices":[{"index":0,"delta":{"content":"ok"}}]}\n\ndata: {"choices":[{"index":0,"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\ndata: [DONE]\n\n',
              ),
            );
            ctrl.close();
          };
        },
      });
      return new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }) as typeof fetch;
    const provider = new LlamaCppProvider({ baseUrl: 'http://llama.test' });
    const session = (await provider.createSession({
      systemMessage: 'sys',
    })) as unknown as {
      onEnginePhase: (h: (ev: { phase: string; detail?: string }) => void) => () => void;
      sendAndWait: (prompt: string) => Promise<string>;
    };
    const phases: Array<{ phase: string; detail?: string }> = [];
    session.onEnginePhase((ev) => phases.push({ phase: ev.phase, detail: ev.detail }));
    const turnPromise = session.sendAndWait('hi');
    // Poll briefly until the session has registered itself — it does so
    // synchronously at the top of sendAndWaitInner, so one tick is enough.
    await new Promise((r) => setTimeout(r, 10));
    provider.onStdoutLine(
      '[llama-server] load_tensors:    Metal_Mapped model buffer size = 2356.44 MiB',
    );
    releaseStream();
    await turnPromise;
    const supervisorPhase = phases.find((p) => p.detail?.includes('Loading model'));
    expect(supervisorPhase?.phase).toBe('loading_model');
  });

  it('never attributes unscoped prefill to concurrent requests or replays it to a later request', async () => {
    const provider = new LlamaCppProvider({ baseUrl: 'http://llama.test' });
    type Session = Parameters<LlamaCppProvider['_registerActiveSession']>[0];
    const first = (await provider.createSession({ systemMessage: 'sys' })) as Session;
    const second = (await provider.createSession({ systemMessage: 'sys' })) as Session;
    const phases: [string[], string[]] = [[], []];
    first.onEnginePhase((event) => phases[0].push(event.phase));
    second.onEnginePhase((event) => phases[1].push(event.phase));
    provider._registerActiveSession(first);
    provider._registerActiveSession(second);
    provider.onStdoutLine('[llama-server] loading weights into buffers 42%');
    expect(phases).toEqual([['loading_model'], ['loading_model']]);
    const line =
      '[llama-server] slot update_slots: id 0 | task 1 | prompt processing progress, n_past = 2048, n_tokens = 13982, progress = 0.146474';
    provider.onStdoutLine(line);
    expect(phases).toEqual([['loading_model'], ['loading_model']]);
    provider._deregisterActiveSession(second);
    provider.onStdoutLine(line);
    expect(phases[0]).toEqual(['loading_model', 'prefill']);
    provider._registerActiveSession(second);
    expect(phases[1]).toEqual(['loading_model']);
    provider._deregisterActiveSession(first);
    provider._deregisterActiveSession(second);
  });

  it('strips trailing slashes from the explicit baseUrl', async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === 'string' ? input : input.toString();
      seen.push(url);
      return sseResponse([{ choices: [{ index: 0, delta: { content: 'ok' } }] }, '[DONE]']);
    }) as typeof fetch;
    const provider = new LlamaCppProvider({ baseUrl: 'http://llama.test:8080/' });
    const session = await provider.createSession({ systemMessage: 'sys', model: 'llama' });
    const reply = await session.sendAndWait('hi');
    expect(reply).toBe('ok');
    expect(seen).toHaveLength(1);
    // Trailing slash should have been stripped: exactly one slash before `v1`.
    expect(seen[0]).toBe('http://llama.test:8080/v1/chat/completions');
  });
});

describe('LlamaCppProvider supervisor integration', () => {
  const cudaExit = {
    incidentId: 'native-55121-1234',
    pid: 55121,
    startedAt: 1000,
    exitedAt: 1234,
    uptimeMs: 234,
    code: null,
    signal: 'SIGABRT' as const,
    expected: false,
    panicKind: 'cuda-invalid-argument' as const,
    panicLine: '[llama-server] CUDA error: invalid argument',
    outputTail: '[llama-server] CUDA error: invalid argument\n',
    diagnostics: { cudaArchitectures: '121a-real', computeCapability: '12.1' },
  };

  it('attributes a CUDA crash that happens while the engine is starting', async () => {
    const supervisor = {
      async ensureRunning() {
        throw new Error('[llama-server] child exited before becoming ready');
      },
      lastExitSnapshot() {
        return { ...cudaExit, exitedAt: Date.now() };
      },
      markUsed() {},
      async stop() {},
    } as unknown as NativeEngineSupervisor;

    const provider = new LlamaCppProvider({ supervisor });
    const session = await provider.createSession({ systemMessage: 'sys', model: 'llama' });
    await expect(session.sendAndWait('ping')).rejects.toMatchObject({
      code: 'native-engine-crash',
      incidentId: 'native-55121-1234',
      panicKind: 'cuda-invalid-argument',
    });
  });

  it('does not blame a new startup failure on a stale native exit', async () => {
    const supervisor = {
      async ensureRunning() {
        throw new Error('[llama-server] model file is missing');
      },
      lastExitSnapshot() {
        return cudaExit;
      },
      markUsed() {},
      async stop() {},
    } as unknown as NativeEngineSupervisor;

    const provider = new LlamaCppProvider({ supervisor });
    const session = await provider.createSession({ systemMessage: 'sys', model: 'llama' });
    const error = await session.sendAndWait('ping').catch((caught) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(NativeEngineCrashedError);
    expect((error as Error).message).toContain('model file is missing');
  });

  it('attributes a pre-response transport failure to the supervised CUDA crash', async () => {
    const supervisor = {
      async ensureRunning() {
        return { command: 'fake', args: [], baseUrl: 'http://127.0.0.1:18099' };
      },
      markUsed() {},
      async waitForUnexpectedExitSince() {
        return cudaExit;
      },
      async stop() {},
    } as unknown as NativeEngineSupervisor;
    globalThis.fetch = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;

    const provider = new LlamaCppProvider({ supervisor });
    const session = await provider.createSession({ systemMessage: 'sys', model: 'llama' });
    const error = await session.sendAndWait('ping').catch((caught) => caught);
    expect(error).toBeInstanceOf(NativeEngineCrashedError);
    expect(error).toMatchObject({
      code: 'native-engine-crash',
      engine: 'llama-cpp',
      incidentId: 'native-55121-1234',
      panicKind: 'cuda-invalid-argument',
    });
    expect((error as Error).message).toContain('It will restart on the next request');
  });

  it('attributes an open SSE stream terminating to the supervised CUDA crash', async () => {
    const supervisor = {
      async ensureRunning() {
        return { command: 'fake', args: [], baseUrl: 'http://127.0.0.1:18099' };
      },
      markUsed() {},
      async waitForUnexpectedExitSince() {
        return cudaExit;
      },
      async stop() {},
    } as unknown as NativeEngineSupervisor;
    globalThis.fetch = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(new TypeError('terminated'));
          },
        }),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      )) as typeof fetch;

    const provider = new LlamaCppProvider({ supervisor });
    const session = await provider.createSession({ systemMessage: 'sys', model: 'llama' });
    await expect(session.sendAndWait('ping')).rejects.toMatchObject({
      code: 'native-engine-crash',
      incidentId: 'native-55121-1234',
    });
  });

  it('calls supervisor.ensureRunning() and markUsed() on each turn', async () => {
    const ensureCalls: number[] = [];
    let usedCalls = 0;
    const supervisor = {
      async ensureRunning() {
        ensureCalls.push(Date.now());
        return {
          command: 'fake',
          args: [],
          baseUrl: 'http://127.0.0.1:18099',
        };
      },
      markUsed() {
        usedCalls++;
      },
      async stop() {},
    } as unknown as NativeEngineSupervisor;

    globalThis.fetch = stubFetch({
      '127.0.0.1:18099/v1/chat/completions': () =>
        sseResponse([{ choices: [{ index: 0, delta: { content: 'hi' } }] }, '[DONE]']),
    });

    const provider = new LlamaCppProvider({ supervisor });
    const session = await provider.createSession({ systemMessage: 'sys', model: 'llama' });
    const reply = await session.sendAndWait('ping');
    expect(reply).toBe('hi');
    expect(ensureCalls).toHaveLength(1);
    expect(usedCalls).toBeGreaterThanOrEqual(1);
  });

  it('keeps the llm GPU lease held until the streaming request finishes', async () => {
    let stopCalls = 0;
    const supervisor = {
      async ensureRunning() {
        return {
          command: 'fake',
          args: [],
          baseUrl: 'http://127.0.0.1:18099',
        };
      },
      markUsed() {},
      async stop() {
        stopCalls++;
      },
    } as unknown as NativeEngineSupervisor;
    const arbiter = new GpuArbiter({ policy: 'swap', log: () => {} });
    arbiter.registerEvictor('image', async () => {});

    const encoder = new TextEncoder();
    let streamCtrlResolve!: (ctrl: ReadableStreamDefaultController<Uint8Array>) => void;
    const streamCtrlReady = new Promise<ReadableStreamDefaultController<Uint8Array>>((resolve) => {
      streamCtrlResolve = resolve;
    });
    let fetchStartedResolve!: () => void;
    const fetchStarted = new Promise<void>((resolve) => {
      fetchStartedResolve = resolve;
    });
    globalThis.fetch = (async () => {
      fetchStartedResolve();
      return new Response(
        new ReadableStream<Uint8Array>({
          start(ctrl) {
            streamCtrlResolve(ctrl);
          },
        }),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      );
    }) as typeof fetch;

    const provider = new LlamaCppProvider({ supervisor, arbiter });
    const session = await provider.createSession({ systemMessage: 'sys', model: 'llama' });
    const sendPromise = session.sendAndWait('ping');
    await fetchStarted;

    let imageAcquired = false;
    const imagePending = arbiter.acquire('image').then(() => {
      imageAcquired = true;
    });
    await Promise.resolve();

    expect(imageAcquired).toBe(false);
    expect(stopCalls).toBe(0);

    const streamCtrl = await streamCtrlReady;
    streamCtrl.enqueue(
      encoder.encode(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'hi' } }] })}\n\n`,
      ),
    );
    streamCtrl.enqueue(encoder.encode('data: [DONE]\n\n'));
    streamCtrl.close();

    await expect(sendPromise).resolves.toBe('hi');
    await imagePending;
    expect(imageAcquired).toBe(true);
    expect(stopCalls).toBe(1);
  });
});

describe('LlamaCppProvider pool lifecycle', () => {
  function fakePoolSupervisor(stops: { n: number }): NativeEngineSupervisor {
    return {
      async ensureRunning() {
        return { command: 'fake', args: [], baseUrl: 'http://127.0.0.1:18099' };
      },
      markUsed() {},
      async stop() {
        stops.n++;
      },
    } as unknown as NativeEngineSupervisor;
  }

  it('shutdown poisons the provider — createSession refuses to respawn the engine', async () => {
    const stops = { n: 0 };
    const provider = new LlamaCppProvider({ supervisor: fakePoolSupervisor(stops) });
    await provider.shutdown();
    expect(stops.n).toBe(1);
    await expect(provider.createSession({ systemMessage: 's' })).rejects.toThrow(/disposed/);
  });

  // Regression: the tool loop acquires a GPU lease per iteration and normally
  // releases it in that iteration's `cleanupTurn`. The bounded-repair guardrails
  // throw ~1000 lines BEFORE `cleanupTurn` is installed, so those throws used to
  // escape with the lease still held. A leaked lease blocked EVERY later
  // acquirer forever — the whole daemon went silent with a healthy, idle engine
  // until gezeld restarted. Wild-caught on qwen3.6-35b-a3b-q8 /
  // conflict-synthesis (2026-08-07): a repair turn sat 309s having never reached
  // the engine, and a second session starved 941s behind it.
  //
  // Drives the real trigger — `prerequisite source-read repair exceeded its
  // bounded read allowance` — by burning read-only calls on an unrelated file so
  // the required read never lands. A fetch-level throw does NOT reproduce this:
  // that path is already caught and cleaned up.
  it('releases the GPU lease when a bounded-repair guardrail throws', async () => {
    const stops = { n: 0 };
    const arbiter = new GpuArbiter({ policy: 'swap', log: () => {} });
    const fetchImpl = (async () =>
      sseResponse([
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_read_unrelated',
                    type: 'function',
                    function: {
                      name: 'read_file',
                      arguments: '{"path":"unrelated.md"}',
                    },
                  },
                ],
              },
            },
          ],
        },
        { choices: [{ index: 0, finish_reason: 'tool_calls' }] },
        '[DONE]',
      ])) as unknown as typeof fetch;

    const provider = new LlamaCppProvider({
      supervisor: fakePoolSupervisor(stops),
      arbiter,
      fetchImpl,
    });
    const session = await provider.createSession({ systemMessage: 'sys', model: 'llama' });
    const internal = session as unknown as {
      deps: {
        bridges: {
          isEmpty: () => boolean;
          getOpenAITools: () => Array<{
            name: string;
            description: string;
            parameters: Record<string, unknown>;
          }>;
          hasTool: (name: string) => boolean;
          callTool: (name: string, args: Record<string, unknown>) => Promise<string>;
        };
      };
    };
    internal.deps.bridges = {
      isEmpty: () => false,
      getOpenAITools: () => [
        { name: 'read_file', description: 'Read a file.', parameters: { type: 'object' } },
        { name: 'write_file', description: 'Write a file.', parameters: { type: 'object' } },
      ],
      hasTool: (name: string) => name === 'read_file' || name === 'write_file',
      callTool: async (_name: string, args: Record<string, unknown>) =>
        `contents of ${String(args.path)}`,
    };

    const prompt = [
      "[scenario check] I looked at `synthesis.md` and the success criteria aren't met yet.",
      'Specific failure: source-read provenance is missing.',
      'SOURCE_READ_REQUIRED: the final claims are not backed by successful, ordered source reads.',
      'First call read_file on memo-product.md.',
      'Then patch `synthesis.md` using only the values you observed in those files.',
    ].join(' ');
    expect(extractPrerequisiteRepairReadPaths(prompt).length).toBeGreaterThan(0);

    await expect(session.sendAndWait(prompt)).rejects.toThrow(/bounded read allowance/);

    // The lease must be free. Before the fix this call never settled, and every
    // other session in the install was stuck behind it.
    const release = await arbiter.acquireLease('llm');
    expect(typeof release).toBe('function');
    release();
  });

  it('shutdown unregisters its keyed llm evictor so later image acquires skip it', async () => {
    const stops = { n: 0 };
    const arbiter = new GpuArbiter({ policy: 'swap', log: () => {} });
    const provider = new LlamaCppProvider({
      supervisor: fakePoolSupervisor(stops),
      arbiter,
      evictorOwnerId: 'llama-cpp/m#0',
    });
    await provider.shutdown();
    expect(stops.n).toBe(1);
    await arbiter.acquire('image');
    // Not stopped a second time — the registration is gone.
    expect(stops.n).toBe(1);
  });

  it('listModels enumerates the installed catalog when a manager is wired', async () => {
    const manager = {
      listInstalled: async () => [
        {
          id: 'qwen-9b',
          name: 'Qwen 9B',
          approxSizeBytes: 6.2 * 1024 ** 3,
          contextWindow: 32768,
        },
        { id: 'gemma-4b', name: 'Gemma 4B', approxSizeBytes: 3 * 1024 ** 3 },
      ],
    } as unknown as import('./models.js').LlamaCppModelManager;
    const provider = new LlamaCppProvider({
      baseUrl: 'http://127.0.0.1:1',
      modelManager: manager,
      defaultModel: 'resident-model',
    });
    const models = await provider.listModels();
    expect(models.map((m) => m.id)).toEqual(['qwen-9b', 'gemma-4b']);
    expect(models[0]!.name).toContain('Qwen 9B');
    expect(models[0]!.name).toContain('32k ctx');
    expect(models[0]!.contextWindow).toBe(32768);
    expect(models[1]!.contextWindow).toBeUndefined();
  });

  it('listModels falls back to the single running-config entry without a manager', async () => {
    const provider = new LlamaCppProvider({
      baseUrl: 'http://127.0.0.1:1',
      defaultModel: 'served-model',
    });
    const models = await provider.listModels();
    expect(models).toEqual([{ id: 'served-model', name: 'served-model', supportsTools: true }]);
  });
});

describe('LlamaCppProvider — waiting for a physical engine slot', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('announces the wait instead of parking silently', async () => {
    vi.useFakeTimers();
    // One physical slot, the shape a supervised single-slot launch has.
    const provider = new LlamaCppProvider({ baseUrl: 'http://llama.test', concurrency: 1 });
    const held = await provider.acquireExclusiveEngineRequest('first');

    const seen: number[] = [];
    const pending = provider.acquireExclusiveEngineRequest('second', undefined, ({ aheadOf }) =>
      seen.push(aheadOf),
    );

    // A brief wait (a background one-shot between iterations) stays quiet.
    await vi.advanceTimersByTimeAsync(150);
    expect(seen).toEqual([]);

    // Past the threshold the turn says so, and keeps saying so. Before this,
    // a turn could sit here for the whole of another session's round-trip —
    // minutes on one slot — with nothing but a debug line to show for it,
    // which the silence banner read as a wedged model.
    await vi.advanceTimersByTimeAsync(100);
    expect(seen).toEqual([1]);
    await vi.advanceTimersByTimeAsync(11_000);
    expect(seen.length).toBeGreaterThanOrEqual(3);

    held();
    const release = await pending;
    const atAcquire = seen.length;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(seen).toHaveLength(atAcquire);
    release();
  });

  it('does not announce anything when a slot is free', async () => {
    vi.useFakeTimers();
    const provider = new LlamaCppProvider({ baseUrl: 'http://llama.test', concurrency: 1 });
    const seen: number[] = [];
    const release = await provider.acquireExclusiveEngineRequest('only', undefined, ({ aheadOf }) =>
      seen.push(aheadOf),
    );
    await vi.advanceTimersByTimeAsync(30_000);
    expect(seen).toEqual([]);
    release();
  });
});

describe('LlamaCppProvider gate repair turns', () => {
  it.each([false, true])('selects gate repair tools (targeted=%s)', async (targeted) => {
    // Ordinary gate feedback permits reads; an explicit stage-1 escalation
    // uses the content already in context and asks for a targeted patch.
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      return sseResponse([
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_patch',
                    type: 'function',
                    function: {
                      name: 'replace_in_file',
                      arguments: '{"path":"index.html","find":"<p>x</p>","replace":"<p>y</p>"}',
                    },
                  },
                ],
              },
            },
          ],
        },
        { choices: [{ index: 0, finish_reason: 'tool_calls' }] },
        '[DONE]',
      ]);
    }) as typeof fetch;

    const provider = new LlamaCppProvider({ baseUrl: 'http://llama.test' });
    const session = await provider.createSession({
      systemMessage: 'sys',
      model: 'tinyllama',
      externalTools: [
        'write_file',
        'read_file',
        'replace_in_file',
        'replace_lines',
        'validate',
      ].map((name) => ({
        name,
        description: `${name} tool`,
        parameters: { type: 'object', additionalProperties: true },
      })),
    });
    await session.sendAndWait(
      targeted
        ? buildStageOneNudge({
            file: 'index.html',
            failingBullets: '- index.html failed the html-game check',
            frozen: false,
          })
        : 'The acceptance checks for `index.html` failed. Correct the existing file.',
    );

    expect(bodies).toHaveLength(1);
    const body = bodies[0]!;
    expect(body.temperature).toBe(0.2);
    expect(body.top_p).toBe(0.8);
    expect(body.max_tokens).toBe(targeted ? 2048 : 4096);
    const toolNames = (body.tools as Array<{ function?: { name?: string } }>).map(
      (t) => t.function?.name,
    );
    expect(toolNames.sort()).toEqual(
      targeted
        ? ['replace_in_file', 'replace_lines']
        : ['read_file', 'replace_in_file', 'replace_lines', 'validate'],
    );
    const messages = body.messages as Array<{ role: string; content: string }>;
    expect(messages.at(-1)?.content).toContain(
      targeted ? '[Local-model gate patch mode:' : '[Local-model repair mode:',
    );
  });
});

describe('LlamaCppProvider engine-scoped tool limits', () => {
  it('stops forcing tool choice engine-wide once the model rejects it', () => {
    // Wild-caught on Nanbeige4.2-3B: `tool_choice: "required"` 400s for this
    // model with one tool or forty, under its own template or a generic
    // ChatML override, while qwen3.5-2b on the same binary accepts it. Since
    // forcing the call IS the local-model rescue, an unguarded rejection
    // makes the rescue fail and the turn burn its whole repair allowance.
    const provider = new LlamaCppProvider({ baseUrl: 'http://llama.test' });
    expect(provider.supportsForcedToolChoice).toBe(true);

    provider.noteForcedToolChoiceUnsupported();
    expect(provider.supportsForcedToolChoice).toBe(false);

    // Monotonic — a later turn never re-enables it and re-pays the 400.
    provider.noteForcedToolChoiceUnsupported();
    expect(provider.supportsForcedToolChoice).toBe(false);
  });

  it('does not degrade a smaller tool roster because a larger one blew the grammar limit', () => {
    const provider = new LlamaCppProvider({ baseUrl: 'http://llama.test' });
    provider.noteToolGrammarFloor(48, 'simplified');
    // The ceiling that failed is a grammar-SIZE limit, so it says nothing
    // about a small roster; degrading that one would cost tool-argument
    // fidelity for free.
    expect(provider.toolGrammarFloorFor(5)).toBe('none');
    expect(provider.toolGrammarFloorFor(48)).toBe('simplified');
    expect(provider.toolGrammarFloorFor(75)).toBe('simplified');
    // The floor only ever widens: a smaller failing count lowers the bar,
    // and a more permissive tier sticks.
    provider.noteToolGrammarFloor(12, 'strip-patterns');
    expect(provider.toolGrammarFloorFor(12)).toBe('simplified');
    provider.noteToolGrammarFloor(48, 'permissive');
    expect(provider.toolGrammarFloorFor(12)).toBe('permissive');
  });
});
