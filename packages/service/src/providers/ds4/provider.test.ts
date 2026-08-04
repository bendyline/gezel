import type { GezelConfig } from '@bendyline/gezel';
import { describe, expect, it, vi } from 'vitest';
import { buildDs4Provider } from '../../chat/manager.js';
import { LlamaCppProvider } from '../llama-cpp/index.js';
import { Ds4Provider } from './provider.js';
import { classifyDs4Line } from './stdout-parser.js';

/**
 * A minimal stand-in for the inner llama.cpp engine. Ds4Provider is a
 * composition wrapper — these tests pin the contract that it relabels
 * identity to `'ds4'` while forwarding every LLMProvider call through.
 */
function mockInner(overrides: Partial<LlamaCppProvider> = {}): LlamaCppProvider {
  const session = { id: 'sess' };
  return {
    name: 'llama-cpp',
    initialize: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
    createSession: vi.fn().mockResolvedValue(session),
    listModels: vi.fn().mockResolvedValue([{ id: 'deepseek-v4-flash-284b-q2' }]),
    getEffectiveModelId: vi.fn().mockReturnValue('deepseek-v4-flash-284b-q2'),
    getContextWindow: vi.fn().mockReturnValue(35_840),
    queue: { concurrency: 1 },
    batch: { maxConcurrency: 1 },
    supportsExternalTools: true,
    ...overrides,
  } as unknown as LlamaCppProvider;
}

describe('Ds4Provider (composition over llama.cpp)', () => {
  it('presents name "ds4" while wrapping a llama-cpp engine', () => {
    const inner = mockInner();
    const p = new Ds4Provider({ inner });
    expect(p.name).toBe('ds4');
    // The engine-key / pool key off THIS class's name, not the inner's.
    expect(p.llamaCpp.name).toBe('llama-cpp');
  });

  it('delegates lifecycle + session + model calls to the inner engine', async () => {
    const inner = mockInner();
    const p = new Ds4Provider({ inner });

    await p.initialize();
    expect(inner.initialize).toHaveBeenCalledOnce();

    const opts = { systemPrompt: 'x' } as unknown as Parameters<Ds4Provider['createSession']>[0];
    await p.createSession(opts);
    expect(inner.createSession).toHaveBeenCalledWith(opts);

    expect(await p.listModels()).toEqual([{ id: 'deepseek-v4-flash-284b-q2' }]);
    expect(p.getEffectiveModelId()).toBe('deepseek-v4-flash-284b-q2');
    expect(p.getContextWindow()).toBe(35_840);

    await p.shutdown();
    expect(inner.shutdown).toHaveBeenCalledOnce();
  });

  it('opts the inner engine into reasoning replay + usage streaming (external URL path)', async () => {
    // Pins buildDs4Provider's baseProviderOpts wiring: ds4-server re-renders
    // replayed assistant turns as `<think>{reasoning_content}</think>` and
    // token-compares against its live KV, so the echo is what keeps agentic
    // continuations on the cached path (no full-tail re-prefill per tool turn).
    const saved = process.env.GEZEL_DS4_NO_REASONING_REPLAY;
    delete process.env.GEZEL_DS4_NO_REASONING_REPLAY;
    try {
      const p = await buildDs4Provider({
        config: { ds4BaseUrl: 'http://127.0.0.1:1' } as unknown as GezelConfig,
        affinity: undefined,
        home: '/tmp/gezel-ds4-wiring-test',
      });
      const inner = p.llamaCpp as unknown as {
        replayReasoningContent: boolean;
        includeUsageInStream: boolean;
      };
      expect(inner.replayReasoningContent).toBe(true);
      expect(inner.includeUsageInStream).toBe(true);
    } finally {
      if (saved !== undefined) process.env.GEZEL_DS4_NO_REASONING_REPLAY = saved;
    }
  });

  it('honors the GEZEL_DS4_NO_REASONING_REPLAY kill switch', async () => {
    const saved = process.env.GEZEL_DS4_NO_REASONING_REPLAY;
    process.env.GEZEL_DS4_NO_REASONING_REPLAY = '1';
    try {
      const p = await buildDs4Provider({
        config: { ds4BaseUrl: 'http://127.0.0.1:1' } as unknown as GezelConfig,
        affinity: undefined,
        home: '/tmp/gezel-ds4-wiring-test',
      });
      const inner = p.llamaCpp as unknown as { replayReasoningContent: boolean };
      expect(inner.replayReasoningContent).toBe(false);
    } finally {
      if (saved !== undefined) process.env.GEZEL_DS4_NO_REASONING_REPLAY = saved;
      else delete process.env.GEZEL_DS4_NO_REASONING_REPLAY;
    }
  });

  it('exposes the inner queue / batch / external-tools capability', () => {
    const inner = mockInner();
    const p = new Ds4Provider({ inner });
    expect(p.queue).toBe(inner.queue);
    expect(p.batch).toBe(inner.batch);
    expect(p.supportsExternalTools).toBe(true);
  });

  it('can make the wrapped engine strictly serial for SSD-streamed inference', () => {
    const inner = new LlamaCppProvider({
      baseUrl: 'http://ds4.test',
      concurrency: 1,
      reserveBackgroundSlot: false,
    });
    const p = new Ds4Provider({ inner });

    expect(p.queue?.concurrency).toBe(1);
    expect(p.queue?.interactiveConcurrency).toBe(1);
    expect(p.queue?.backgroundConcurrency).toBe(1);
    expect(p.batch?.maxConcurrency).toBe(1);
  });

  it('fans ds4-classified stdout progress out to active sessions', async () => {
    // The buildDs4Provider wiring: inner LlamaCppProvider constructed with
    // `classifyLine: classifyDs4Line`, supervisor routes stderr through
    // `onStdoutLine`. This pins the full line → phase-event path so a
    // multi-minute DS4 prefill surfaces live progress instead of silence.
    const originalFetch = globalThis.fetch;
    let resolveStream: null | (() => void) = null;
    const release = (): void => {
      resolveStream?.();
    };
    globalThis.fetch = (async () => {
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(ctrl) {
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
    try {
      const inner = new LlamaCppProvider({
        baseUrl: 'http://ds4.test',
        classifyLine: classifyDs4Line,
      });
      const p = new Ds4Provider({ inner });
      const session = (await p.createSession({ systemMessage: 'sys' })) as unknown as {
        onEnginePhase: (
          h: (ev: { phase: string; detail?: string; progress?: number }) => void,
        ) => () => void;
        sendAndWait: (prompt: string) => Promise<string>;
      };
      const phases: Array<{ phase: string; detail?: string; progress?: number }> = [];
      session.onEnginePhase((ev) =>
        phases.push({ phase: ev.phase, detail: ev.detail, progress: ev.progress }),
      );
      const turn = session.sendAndWait('hi');
      // Session registers itself synchronously at the top of
      // sendAndWaitInner; one tick is enough.
      await new Promise((r) => setTimeout(r, 10));
      p.llamaCpp.onStdoutLine(
        '[ds4-server] 0718 14:32:07 ds4-server: chat ctx=0..7880:7880 TOOLS prefill chunk 512/7880 (6.5%) chunk=39.35 t/s avg=39.35 t/s 13.013s',
      );
      release();
      await turn;
      const prefill = phases.find((x) => x.detail?.includes('Processing prompt'));
      expect(prefill?.phase).toBe('prefill');
      expect(prefill?.progress).toBeCloseTo(512 / 7880, 3);
      expect(prefill?.detail).toBe('Processing prompt (6% · 512 / 7,880 tokens · 39 tok/s)');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
