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
    (async () => {
      try {
        for await (const env of streamProjectChatEvents({
          url: client.projectEventsUrl(projectId),
          headers: client.authHeader(),
          fetch: client.getFetch(),
          signal: controller.signal,
        })) {
          handlerRef.current(env);
        }
      } catch {
        // Aborted on unmount, or the daemon went away — the feed simply
        // stops updating. Re-mounting (e.g. switching projects) reconnects.
      }
    })();
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
    (async () => {
      try {
        for await (const env of streamTerminalEvents({
          url: client.terminalEventsUrl(projectId),
          headers: client.authHeader(),
          fetch: client.getFetch(),
          signal: controller.signal,
        })) {
          handlerRef.current(env);
        }
      } catch {
        // Aborted on unmount, or daemon gone.
      }
    })();
    return () => controller.abort();
  }, [client, projectId]);
}
