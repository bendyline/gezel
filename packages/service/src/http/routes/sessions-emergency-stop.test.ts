import { describe, expect, it, vi } from 'vitest';
import type { ServiceContext } from '../context.js';
import { sessionRoutes } from './sessions.js';

function context(overrides?: { writeFails?: boolean }) {
  const order: string[] = [];
  const emergencyStop = vi.fn(async () => {
    order.push('stop');
    return {
      cancelledTurns: 2,
      clearedQueuedMessages: 3,
      clearedDeferredActions: 1,
    };
  });
  const readConfig = vi.fn(async () => {
    order.push('read');
    return { aiEngagementMode: 'proactive' as const };
  });
  const writeConfig = vi.fn(async () => {
    order.push('write');
    if (overrides?.writeFails) throw new Error('disk unavailable');
    return { aiEngagementMode: 'reactive' as const };
  });
  const log = vi.fn(async () => undefined);
  const setEngagementMode = vi.fn();
  return {
    order,
    emergencyStop,
    readConfig,
    writeConfig,
    log,
    setEngagementMode,
    ctx: {
      chat: { emergencyStop, setEngagementMode },
      store: { readConfig, writeConfig },
      history: { log },
    } as unknown as ServiceContext,
  };
}

describe('POST /api/sessions/emergency-stop', () => {
  it('starts cancellation first, persists Reactive mode, and returns the stop counts', async () => {
    const fixture = context();
    const app = sessionRoutes(fixture.ctx);

    const response = await app.request('/emergency-stop', { method: 'POST' });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      engagementMode: 'reactive',
      persisted: true,
      cancelledTurns: 2,
      clearedQueuedMessages: 3,
      clearedDeferredActions: 1,
    });
    expect(fixture.order[0]).toBe('stop');
    expect(fixture.writeConfig).toHaveBeenCalledWith({ aiEngagementMode: 'reactive' });
    expect(fixture.setEngagementMode).toHaveBeenCalledWith('reactive');
    expect(fixture.log).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'config.engagementMode.changed' }),
    );
  });

  it('reports the partial outcome when chats stop but the mode cannot be persisted', async () => {
    const fixture = context({ writeFails: true });
    const app = sessionRoutes(fixture.ctx);

    const response = await app.request('/emergency-stop', { method: 'POST' });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual(
      expect.objectContaining({
        ok: false,
        engagementMode: 'reactive',
        persisted: false,
        cancelledTurns: 2,
      }),
    );
  });
});
