import { describe, expect, it, vi } from 'vitest';
import type { NativeEngineSupervisor } from '../native/supervisor.js';
import { MlxProvider } from './provider.js';

function completionResponse(): Response {
  return new Response(
    [
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'Ready.' }, finish_reason: 'stop' }] })}`,
      '',
      'data: [DONE]',
      '',
    ].join('\n'),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

describe('MLX startup capacity handoff', () => {
  it('protects a turn before startup finishes and through its first HTTP request', async () => {
    let active = 0;
    const yieldForWaitingCapacity = vi.fn(async () => {
      throw new Error('the waiting claim stopped the newly started engine');
    });
    const withRequest = vi.fn(async <T>(run: () => Promise<T>): Promise<T> => {
      active++;
      try {
        return await run();
      } finally {
        active--;
      }
    });
    const supervisor = {
      coordinatesCapacity: true,
      withRequest,
      yieldForWaitingCapacity,
      ensureRunning: async () => {
        expect(active).toBe(1);
        return { baseUrl: 'http://mlx.test' };
      },
      markUsed: () => {},
    } as unknown as NativeEngineSupervisor;
    const fetchImpl = (async () => {
      expect(active).toBe(1);
      return completionResponse();
    }) as typeof fetch;
    const provider = new MlxProvider({ supervisor, fetchImpl });
    const session = await provider.createSession({ systemMessage: 'system' });

    await expect(session.sendAndWait('hello', { timeoutMs: 5_000 })).resolves.toContain('Ready.');
    expect(withRequest).toHaveBeenCalledTimes(1);
    expect(yieldForWaitingCapacity).not.toHaveBeenCalled();
    expect(active).toBe(0);
    await session.disconnect();
  });

  it('keeps a nested housekeeping turn inside its caller’s capacity guard', async () => {
    const withRequest = vi.fn(async <T>(run: () => Promise<T>): Promise<T> => run());
    const provider = new MlxProvider({
      supervisor: { coordinatesCapacity: true, withRequest } as unknown as NativeEngineSupervisor,
    });
    await provider.withEngineTurn(async () => {
      await provider.withEngineTurn(async () => {});
    });
    expect(withRequest).toHaveBeenCalledTimes(1);
  });
});
