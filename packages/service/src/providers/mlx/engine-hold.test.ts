import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EnginePhaseEvent } from '../streaming-session.js';
import type { LLMSession } from '../types.js';
import { engineHoldLabelFor } from './engine-hold.js';
import { MlxProvider } from './provider.js';

/**
 * The sidecar runs requests in waves, so a request can sit in the engine
 * behind someone else's whole turn with nothing on its own stream. Measured
 * before this: a 300-token question waited behind a 55k-token re-prefill,
 * was labelled "Processing prompt", and was aborted at 407s by the
 * pre-first-byte watchdog without ever starting. The engine now says what it
 * is doing with each request it holds; these tests pin that the session
 * believes it.
 */

function chunk(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content } }] })}\n\n`;
}

interface HeldStream {
  push(text: string): void;
  finish(): void;
  bodies: Array<Record<string, unknown>>;
}

function heldEngine(): { fetchImpl: typeof fetch; stream: HeldStream } {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const bodies: Array<Record<string, unknown>> = [];
  const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
        init?.signal?.addEventListener('abort', () => {
          c.error(new DOMException('The operation was aborted.', 'AbortError'));
        });
      },
    });
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  });
  return {
    fetchImpl: fetchImpl as unknown as typeof fetch,
    stream: {
      bodies,
      push: (text) => controller?.enqueue(encoder.encode(chunk(text))),
      finish: () => {
        controller?.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller?.close();
      },
    },
  };
}

const sessions: LLMSession[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(sessions.splice(0).map((session) => session.disconnect()));
});

async function startTurn(opts?: { enginePriority?: 'interactive' | 'background' }) {
  vi.useFakeTimers();
  const { fetchImpl, stream } = heldEngine();
  const provider = new MlxProvider({ baseUrl: 'http://engine.test', fetchImpl });
  const session = await provider.createSession({ systemMessage: 'system' });
  sessions.push(session);
  const phases: EnginePhaseEvent[] = [];
  (
    session as unknown as {
      onEnginePhase(handler: (event: EnginePhaseEvent) => void): () => void;
    }
  ).onEnginePhase((event) => phases.push(event));
  const queueNotices: Array<{ aheadOf: number }> = [];
  const result = session
    .sendAndWait('What is 17 times 23?', {
      timeoutMs: 4 * 60 * 60 * 1000,
      queue: {
        lane: 'interactive',
        sessionId: 'sess-held',
        ...(opts?.enginePriority ? { enginePriority: opts.enginePriority } : {}),
        onQueueWait: (info) => queueNotices.push(info),
      },
    })
    .then(
      (text) => ({ ok: true as const, text }),
      (error: unknown) => ({ ok: false as const, error: String(error) }),
    );
  await vi.advanceTimersByTimeAsync(10);
  return { provider, stream, phases, queueNotices, result };
}

describe('MLX requests the engine is holding', () => {
  it('a queued request outlives the pre-first-byte bound while the engine says it is waiting', async () => {
    const { provider, stream, phases, queueNotices, result } = await startTurn();
    // Twelve minutes in the engine's queue — far past the 300s bound —
    // with the sidecar's worker re-announcing the hold every minute.
    for (let minute = 0; minute < 12; minute++) {
      provider.onStdoutLine('[mlx] [batch] waiting cache=sess-held ahead=0 behind=sess-task');
      await vi.advanceTimersByTimeAsync(60_000);
    }
    expect(
      phases.some(
        (p) => p.phase === 'prefill' && p.detail === 'Waiting for another chat to finish',
      ),
    ).toBe(true);
    // The chat's "model queue" state is held, not left to expire between
    // engine markers.
    expect(queueNotices.length).toBeGreaterThan(12);
    expect(queueNotices[0]).toEqual({ aheadOf: 1 });

    provider.onStdoutLine('[mlx] [batch] admitted cache=sess-held waited=720.0s');
    await vi.advanceTimersByTimeAsync(10);
    const noticesAtAdmission = queueNotices.length;
    stream.push('391');
    stream.finish();
    await vi.advanceTimersByTimeAsync(10);
    expect(await result).toEqual({ ok: true, text: '391' });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(queueNotices.length).toBe(noticesAtAdmission);
  });

  it('the same silence with no engine markers still trips the bound', async () => {
    const { result } = await startTurn();
    await vi.advanceTimersByTimeAsync(301_000);
    const outcome = await result;
    expect(outcome.ok).toBe(false);
  });

  it("another session's hold does not keep this request alive", async () => {
    const { provider, result } = await startTurn();
    for (let minute = 0; minute < 6; minute++) {
      provider.onStdoutLine('[mlx] [batch] waiting cache=someone-else ahead=0 behind=sess-held');
      await vi.advanceTimersByTimeAsync(60_000);
    }
    expect((await result).ok).toBe(false);
  });

  it('a paused reply keeps its stream alive and says why', async () => {
    const { provider, stream, phases, result } = await startTurn({ enginePriority: 'background' });
    stream.push('The ledger lists ');
    await vi.advanceTimersByTimeAsync(10);
    // Parked for a person's chat for ten minutes: twice the streaming bound.
    for (let minute = 0; minute < 10; minute++) {
      provider.onStdoutLine('[mlx] [batch] paused cache=sess-held for=sess-chat');
      await vi.advanceTimersByTimeAsync(60_000);
    }
    expect(
      phases.some((p) => p.phase === 'generating' && p.detail === 'Paused while a chat goes first'),
    ).toBe(true);
    stream.push('forty journeymen.');
    stream.finish();
    await vi.advanceTimersByTimeAsync(10);
    expect(await result).toEqual({ ok: true, text: 'The ledger lists forty journeymen.' });
    expect(stream.bodies[0]?.priority).toBe('background');
  });

  it('only background requests spell out a priority', async () => {
    const { stream, result } = await startTurn();
    stream.push('ok');
    stream.finish();
    await vi.advanceTimersByTimeAsync(10);
    await result;
    expect(stream.bodies[0]).not.toHaveProperty('priority');
  });
});

describe('engineHoldLabelFor', () => {
  it('counts what is ahead, in plain language', () => {
    expect(engineHoldLabelFor({ state: 'waiting', behind: ['a'] })).toBe(
      'Waiting for another chat to finish',
    );
    expect(engineHoldLabelFor({ state: 'waiting', behind: ['a', 'b'], ahead: 1 })).toBe(
      'Waiting for 3 other chats to finish',
    );
    expect(engineHoldLabelFor({ state: 'paused', behind: ['a'] })).toBe(
      'Paused while a chat goes first',
    );
  });
});
