import { describe, expect, it, vi } from 'vitest';
import { startOfficeRelay } from './relay.js';

describe('startOfficeRelay', () => {
  it('registers the tools for the project and sends the closing DELETE with keepalive', async () => {
    const update = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    let capturedFetch: typeof fetch | undefined;
    const register = vi.fn(
      async (
        connection: { fetch?: typeof fetch },
        input: { projectId: string; label?: string },
      ) => {
        capturedFetch = connection.fetch;
        expect(input).toMatchObject({ projectId: 'p1', label: 'Word: Plan.docx' });
        return { relayId: 'r1', ready: Promise.resolve(), update, close };
      },
    );
    const statuses: string[] = [];
    const relay = await startOfficeRelay({
      baseUrl: 'https://localhost:4000',
      token: 't',
      projectId: 'p1',
      label: 'Word: Plan.docx',
      tools: [],
      onStatus: (s) => statuses.push(s),
      onUnauthorized: () => undefined,
      register: register as never,
    });
    expect(statuses[0]).toBe('connecting');
    await relay.update([]);
    expect(update).toHaveBeenCalledWith([]);
    await relay.close();
    expect(close).toHaveBeenCalled();

    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }));
    await capturedFetch!('https://localhost:4000/api/app-tools/relays/r1', { method: 'DELETE' });
    expect(spy.mock.calls[0]![1]).toMatchObject({ method: 'DELETE', keepalive: true });
    spy.mockRestore();
  });

  it('reports a revoked token', async () => {
    const onUnauthorized = vi.fn();
    await expect(
      startOfficeRelay({
        baseUrl: 'https://localhost:4000',
        token: 't',
        projectId: 'p1',
        label: 'x',
        tools: [],
        onStatus: () => undefined,
        onUnauthorized,
        register: (async () => {
          throw Object.assign(new Error('unauthorized'), { status: 401 });
        }) as never,
      }),
    ).rejects.toThrow();
    expect(onUnauthorized).toHaveBeenCalled();
  });
});
