import type { ChatEventEnvelope, TerminalEventEnvelope } from '@bendyline/gezel';
import { streamProjectChatEvents, streamTerminalEvents } from '@bendyline/gezel-client';
import type { GezelClient } from '@bendyline/gezel-client/node';
import { useEffect, useRef } from 'react';

/**
 * Subscribe to a project's live chat-event stream for the lifetime of the
 * component (or until `projectId` changes). Every in-flight session in the
 * project surfaces here — including voorman→dev consultations — so the feed
 * shows all agent chatter, not just the user's own turn. The handler is
 * held in a ref so changing it doesn't re-open the SSE connection.
 */
export function useProjectEvents(
  client: GezelClient,
  projectId: string,
  handler: (env: ChatEventEnvelope) => void,
): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    const controller = new AbortController();
    void consumeWithReconnect(
      async function* () {
        for await (const env of streamProjectChatEvents({
          url: client.projectEventsUrl(projectId),
          headers: client.authHeader(),
          fetch: client.getFetch(),
          signal: controller.signal,
        })) {
          yield env;
        }
      },
      (env) => handlerRef.current(env),
      controller.signal,
    );
    return () => controller.abort();
  }, [client, projectId]);
}

/**
 * Subscribe to a project's terminal-output stream — drives CLI-mode shell
 * output in the feed. Same ref-stable-handler / abort-on-unmount shape as
 * {@link useProjectEvents}.
 */
export function useTerminalEvents(
  client: GezelClient,
  projectId: string,
  handler: (env: TerminalEventEnvelope) => void,
): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    const controller = new AbortController();
    void consumeWithReconnect(
      async function* () {
        for await (const env of streamTerminalEvents({
          url: client.terminalEventsUrl(projectId),
          headers: client.authHeader(),
          fetch: client.getFetch(),
          signal: controller.signal,
        })) {
          yield env;
        }
      },
      (env) => handlerRef.current(env),
      controller.signal,
    );
    return () => controller.abort();
  }, [client, projectId]);
}

/**
 * Keep a long-lived SSE subscription alive across daemon restarts and stale
 * sockets. A successful event resets the backoff; aborting the owning React
 * effect tears down both the active fetch and any pending retry delay.
 */
async function consumeWithReconnect<T>(
  open: () => AsyncGenerator<T>,
  handler: (event: T) => void,
  signal: AbortSignal,
): Promise<void> {
  let retryMs = 250;
  while (!signal.aborted) {
    try {
      for await (const event of open()) {
        handler(event);
        retryMs = 250;
      }
    } catch {
      /* stale socket / daemon restart; retry below */
    }
    if (signal.aborted) return;
    await abortableDelay(retryMs, signal);
    retryMs = Math.min(retryMs * 2, 5_000);
  }
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
  });
}
