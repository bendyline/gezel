import { describe, expect, it, vi } from 'vitest';
import type { ServiceContext } from '../context.js';
import { sessionRoutes } from './sessions.js';

function context(): ServiceContext {
  return {
    chat: {
      getSessionRecord: async () => ({
        id: 'external-pi-1',
        source: {
          kind: 'external',
          appId: 'pi',
          appName: 'Pi',
          externalConversationId: 'pi-session-1',
          readOnly: true,
        },
      }),
      send: vi.fn(),
      reset: vi.fn(),
      cancelInflight: vi.fn(),
      interruptWithMessage: vi.fn(),
      trackBackground: vi.fn(),
    },
  } as unknown as ServiceContext;
}

describe('external chat session routes', () => {
  it.each([
    ['send', '/external-pi-1/send', { message: 'Reply here' }],
    ['interrupt', '/external-pi-1/interrupt', { message: 'Take over' }],
    ['reset', '/external-pi-1/reset', undefined],
    ['cancel', '/external-pi-1/cancel', undefined],
  ])('rejects %s mutations on a Pi-owned read-only session', async (_name, path, body) => {
    const ctx = context();
    const response = await sessionRoutes(ctx).request(`http://localhost${path}`, {
      method: 'POST',
      ...(body
        ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
        : {}),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: 'This conversation is controlled by Pi and is read-only in Gezel.',
      code: 'external_session_read_only',
    });
    expect(ctx.chat.send).not.toHaveBeenCalled();
    expect(ctx.chat.reset).not.toHaveBeenCalled();
    expect(ctx.chat.cancelInflight).not.toHaveBeenCalled();
    expect(ctx.chat.interruptWithMessage).not.toHaveBeenCalled();
  });
});
