import type { GezelSummary, TimelineMessage } from '@bendyline/gezel';
import { useCallback, useLayoutEffect, useSyncExternalStore } from 'react';
import { ChatStickyHeader } from './ChatStickyHeader.js';
import type { LiveSlot } from './chat-live-slot.js';
import type { FrameCoalescedStore } from './frame-coalesced-store.js';

/**
 * A single narrow React subscription into a mutable streaming store. The
 * parent timeline supplies the stable structural position; only this child
 * redraws when fragments mutate the item at that position.
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
  const subscribe = useCallback(
    (listener: () => void) => store.subscribeItem(itemKey, listener),
    [store, itemKey],
  );
  const getSnapshot = useCallback(() => store.getItemSnapshot(itemKey), [store, itemKey]);
  const version = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
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
}: {
  store: FrameCoalescedStore<LiveSlot>;
  sessionId: string;
  userMsg: TimelineMessage;
  gezels: Map<string, GezelSummary>;
}): React.ReactNode {
  return (
    <FrameCoalescedItem
      store={store}
      itemKey={sessionId}
      render={(slot) => (
        <ChatStickyHeader
          payload={{ userMsg, assistantInfo: { kind: 'live', sessionId, slot } }}
          gezels={gezels}
        />
      )}
    />
  );
}
