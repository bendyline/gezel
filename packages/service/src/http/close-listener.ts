import type { ServerType } from '@hono/node-server';

/**
 * Close a listener without waiting on its open streams. An SSE stream holds
 * its server open until the handler's keepalive loop notices the disconnect,
 * and under load (the full test suite) that settle time outran Vitest's
 * `afterAll` budget. So this closes every HTTP/1 connection, destroys any
 * HTTP/2 session, and stops waiting after `capMs`: the OS releases what is
 * left when the process exits or the next test starts.
 */
export function closeListener(server: ServerType, capMs = 2_000): Promise<void> {
  return new Promise<void>((resolve) => {
    server.close(() => resolve());
    const s = server as unknown as {
      closeAllConnections?: () => void;
      closeIdleConnections?: () => void;
      _sessions?: Set<{ destroy?: () => void }>;
    };
    s.closeIdleConnections?.();
    s.closeAllConnections?.();
    // http2: there's no closeAllConnections; iterate active sessions.
    for (const session of s._sessions ?? []) {
      try {
        session.destroy?.();
      } catch {
        /* ignore */
      }
    }
    setTimeout(resolve, capMs).unref();
  });
}
