import { describe, expect, it, vi } from 'vitest';
import { ChatEventBus } from './events.js';
import { ChatManager } from './manager.js';

/**
 * A gezel's MCP child holds a session token scoped to that session. When the
 * child goes away the token must go too, or it outlives the session it was
 * minted for: anything that read it (a CLI agent's shell, a leaked log line)
 * keeps acting as that gezel. `session-token-rotation.test.ts` pins that a
 * re-mint keeps a live child's token; this pins that every teardown path
 * revokes it. No test asserted a single revocation before.
 */

function managerWith(revoke: (appId: string) => void): ChatManager {
  return new ChatManager({
    store: { readConfig: async () => ({}) } as never,
    events: new ChatEventBus(),
    memory: {} as never,
    getPort: () => 0,
    getToken: () => 'test-token',
    home: '/tmp/gezel-token-revocation-test',
    catalog: {} as never,
    secrets: {} as never,
    revokeSessionToken: revoke,
  });
}

/** Put a live session with an open provider session into the manager. */
function seedLiveSession(manager: ChatManager, sessionId: string, lastActivityAt: string) {
  const disconnect = vi.fn(async () => {});
  (manager as unknown as { states: Map<string, unknown> }).states.set(sessionId, {
    session: { disconnect },
    record: { id: sessionId, projectId: 'p1', gezelId: 'gz-1', lastActivityAt, messages: [] },
  });
  return disconnect;
}

describe('session token revocation on teardown', () => {
  it('revokes the token when a session is reset', async () => {
    const revoke = vi.fn();
    const manager = managerWith(revoke);
    const disconnect = seedLiveSession(manager, 's1', new Date().toISOString());

    await manager.reset('s1');

    expect(disconnect).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledWith('session:s1');
  });

  it('revokes the token of every session an idle sweep releases, and only those', async () => {
    const revoke = vi.fn();
    const manager = managerWith(revoke);
    const now = Date.parse('2026-11-23T12:00:00.000Z');
    seedLiveSession(manager, 'quiet', '2026-11-23T10:00:00.000Z');
    seedLiveSession(manager, 'recent', '2026-11-23T11:59:00.000Z');

    const released = await manager.releaseIdleSessions(60 * 60 * 1000, now);

    expect(released).toEqual(['quiet']);
    expect(revoke).toHaveBeenCalledWith('session:quiet');
    expect(revoke).not.toHaveBeenCalledWith('session:recent');
  });

  it('revokes every live session’s token on a client reset', async () => {
    const revoke = vi.fn();
    const manager = managerWith(revoke);
    seedLiveSession(manager, 'a', new Date().toISOString());
    seedLiveSession(manager, 'b', new Date().toISOString());

    await manager.resetClient({ deferBusy: true });

    expect(revoke).toHaveBeenCalledWith('session:a');
    expect(revoke).toHaveBeenCalledWith('session:b');
  });

  it('does nothing for a session that is not live', async () => {
    const revoke = vi.fn();
    const manager = managerWith(revoke);

    await manager.reset('never-started');

    expect(revoke).not.toHaveBeenCalled();
  });
});
