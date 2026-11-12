import type { ChatEventEnvelope } from '@bendyline/gezel';
import { useEffect, useEffectEvent } from 'react';
import { api } from '../api.js';
import { forEachEvent } from '../reconnecting-stream.js';
import { streamSharedAllChatEvents, streamSharedProjectChatEvents } from '../shared-chat-events.js';

/**
 * Hear every chat event while mounted, over the app's one shared stream.
 * The handler always sees the latest props and state; changing it does not
 * reopen the subscription.
 */
export function useAllChatEvents(
  onEvent: (envelope: ChatEventEnvelope) => void,
  enabled = true,
): void {
  const handle = useEffectEvent(onEvent);
  // biome-ignore lint/correctness/useExhaustiveDependencies: an effect event is never a dependency; it always calls the latest handler.
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    void forEachEvent(
      streamSharedAllChatEvents({
        url: api.allEventsUrl(),
        headers: api.authHeader(),
        signal: controller.signal,
        fetch: api.getFetch(),
      }),
      (envelope) => handle(envelope as ChatEventEnvelope),
    );
    return () => controller.abort();
  }, [enabled]);
}

/** The same for one project's events. Subscribes again when the project changes. */
export function useProjectChatEvents(
  projectId: string | null | undefined,
  onEvent: (envelope: ChatEventEnvelope) => void,
): void {
  const handle = useEffectEvent(onEvent);
  // biome-ignore lint/correctness/useExhaustiveDependencies: an effect event is never a dependency; it always calls the latest handler.
  useEffect(() => {
    if (!projectId) return;
    const controller = new AbortController();
    void forEachEvent(
      streamSharedProjectChatEvents({
        url: api.projectEventsUrl(projectId),
        headers: api.authHeader(),
        signal: controller.signal,
        fetch: api.getFetch(),
      }),
      (envelope) => handle(envelope as ChatEventEnvelope),
    );
    return () => controller.abort();
  }, [projectId]);
}
