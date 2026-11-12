import type { GezelSummary, Project, TimelineMessage } from '@bendyline/gezel';
import { useCallback, useLayoutEffect, useSyncExternalStore } from 'react';
import { ChatStickyHeader } from './ChatStickyHeader.js';
import type { LiveSlot } from './chat-live-slot.js';
import type { FrameCoalescedStore } from './frame-coalesced-store.js';
import { useLiveContentShown } from './live-render-gate.js';

const NOT_SUBSCRIBED = () => () => {};

/**
 * A single narrow React subscription into a mutable streaming store. The
 * parent timeline supplies the stable structural position; only this child
 * redraws when fragments mutate the item at that position. Off screen (a
 * closed fold, a hidden pane: see live-render-gate.tsx) it does not
 * subscribe, and resubscribing when shown reads the latest state at once.
 */
export function FrameCoalescedItem<T>({
  store,
  itemKey,
  render,
  onRendered,
}: {
  store: FrameCoalescedStore<T>;
  itemKey: string;
  render: (item: T) => React.ReactNode;
  onRendered?: () => void;
}): React.ReactNode {
  const shown = useLiveContentShown();
  const subscribe = useCallback(
    (listener: () => void) => store.subscribeItem(itemKey, listener),
    [store, itemKey],
  );
  const getSnapshot = useCallback(() => store.getItemSnapshot(itemKey), [store, itemKey]);
  const version = useSyncExternalStore(
    shown ? subscribe : NOT_SUBSCRIBED,
    getSnapshot,
    getSnapshot,
  );
  const item = store.items.get(itemKey);

  // biome-ignore lint/correctness/useExhaustiveDependencies: version is the external-store render signal; item intentionally keeps mutable identity.
  useLayoutEffect(() => {
    if (item) onRendered?.();
  }, [item, onRendered, version]);

  return item ? <>{render(item)}</> : null;
}

export function FrameCoalescedLiveStickyHeader({
  store,
  sessionId,
  userMsg,
  gezels,
  projects,
  debugMode = false,
}: {
  store: FrameCoalescedStore<LiveSlot>;
  sessionId: string;
  userMsg: TimelineMessage;
  gezels: Map<string, GezelSummary>;
  projects?: ReadonlyMap<string, Project>;
  debugMode?: boolean;
}): React.ReactNode {
  return (
    <FrameCoalescedItem
      store={store}
      itemKey={sessionId}
      render={(slot) => (
        <ChatStickyHeader
          payload={{ userMsg, assistantInfo: { kind: 'live', sessionId, slot } }}
          gezels={gezels}
          {...(projects ? { projects } : {})}
          debugMode={debugMode}
        />
      )}
    />
  );
}
