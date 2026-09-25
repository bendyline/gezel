import { describe, expect, expectTypeOf, it } from 'vitest';
import type { ScriptInit, ScriptTransport } from './transport.js';

describe('ScriptTransport contract', () => {
  it('supports typed request results and fire-and-forget notifications', async () => {
    const init: ScriptInit = {
      input: { source: 'fixture' },
      runId: 'run-1',
      projectId: 'project-1',
      engagementMode: 'reactive',
      engagementFlags: { llmAllowed: true },
    };
    const notifications: Array<{ method: string; params?: unknown }> = [];
    const transport: ScriptTransport = {
      init,
      async call<T>(method: string, params?: unknown): Promise<T> {
        return { method, params } as T;
      },
      notify(method: string, params?: unknown): void {
        notifications.push({ method, ...(params === undefined ? {} : { params }) });
      },
    };

    const result = await transport.call<{ method: string; params: unknown }>('files.read', {
      path: 'brief.md',
    });
    transport.notify('output', { ok: true });

    expectTypeOf(result).toEqualTypeOf<{ method: string; params: unknown }>();
    expect(result).toEqual({ method: 'files.read', params: { path: 'brief.md' } });
    expect(notifications).toEqual([{ method: 'output', params: { ok: true } }]);
    expect(transport.init).toBe(init);
  });
});
