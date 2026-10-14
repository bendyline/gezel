import { describe, expect, it, vi } from 'vitest';
import { startOfficeRelay } from './relay.js';

const SUBJECT = {
  kind: 'document' as const,
  app: 'Word',
  title: 'Plan.docx',
  path: 'C:\\Plans\\Plan.docx',
  focus: 'item' as const,
  editable: true,
  stateTool: 'office_read_selection',
};

describe('startOfficeRelay', () => {
  it('registers the tools for the project and sends the closing DELETE with keepalive', async () => {
    const update = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    let capturedFetch: typeof fetch | undefined;
    const register = vi.fn(
      async (
        connection: { fetch?: typeof fetch },
        input: {
          projectId: string;
          gezelIds?: string[];
          surfaceId?: string;
          label?: string;
          subject?: unknown;
        },
      ) => {
        capturedFetch = connection.fetch;
        // Only the gezel the pane talks to, in the pane's own threads.
        expect(input).toMatchObject({
          projectId: 'p1',
          gezelIds: ['lead'],
          surfaceId: 'pane-surface-1',
          label: 'Word: Plan.docx',
          // The document itself, so the daemon can brief the gezel about it.
          subject: SUBJECT,
        });
        return { relayId: 'r1', ready: Promise.resolve(), update, close };
      },
    );
    const statuses: string[] = [];
    const relay = await startOfficeRelay({
      baseUrl: 'https://localhost:4000',
      token: 't',
      projectId: 'p1',
      gezelId: 'lead',
      surfaceId: 'pane-surface-1',
      label: 'Word: Plan.docx',
      tools: [],
      subject: SUBJECT,
      onStatus: (s) => statuses.push(s),
      onUnauthorized: () => undefined,
      register: register as never,
    });
    expect(statuses[0]).toBe('connecting');
    const saved = { ...SUBJECT, editable: false };
    await relay.update([], saved);
    expect(update).toHaveBeenCalledWith([], { subject: saved });
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
        gezelId: 'lead',
        surfaceId: 'pane-surface-1',
        label: 'x',
        tools: [],
        subject: SUBJECT,
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
