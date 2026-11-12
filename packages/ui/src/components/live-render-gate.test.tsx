import { act, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FrameCoalescedItem } from './frame-coalesced-item.js';
import { FrameCoalescedStore, type FrameScheduler } from './frame-coalesced-store.js';
import { LiveRenderGate } from './live-render-gate.js';

function controlledFrames(): { scheduler: FrameScheduler; flush: () => void } {
  const callbacks = new Map<number, FrameRequestCallback>();
  let next = 1;
  return {
    scheduler: {
      request(callback) {
        callbacks.set(next, callback);
        return next++;
      },
      cancel(handle) {
        callbacks.delete(handle);
      },
    },
    flush() {
      const frame = [...callbacks.values()];
      callbacks.clear();
      for (const callback of frame) callback(0);
    },
  };
}

function Reply({ shown, store }: { shown: boolean; store: FrameCoalescedStore<{ text: string }> }) {
  return (
    <LiveRenderGate shown={shown}>
      <FrameCoalescedItem store={store} itemKey="s1" render={(slot) => <p>{slot.text}</p>} />
    </LiveRenderGate>
  );
}

describe('LiveRenderGate', () => {
  it('holds a hidden reply still while it streams, then shows the latest text at once', () => {
    const frames = controlledFrames();
    const store = new FrameCoalescedStore<{ text: string }>(frames.scheduler);
    store.items.set('s1', { text: 'Hello' });
    const { rerender } = render(<Reply shown={false} store={store} />);
    expect(screen.getByText('Hello')).toBeInTheDocument();

    for (const piece of [' there', ', how', ' are you?']) {
      store.items.get('s1')!.text += piece;
      store.markItemChanged('s1');
      act(() => frames.flush());
    }
    expect(screen.getByText('Hello')).toBeInTheDocument();

    rerender(<Reply shown store={store} />);
    expect(screen.getByText('Hello there, how are you?')).toBeInTheDocument();
  });

  it('closes when any gate above it is closed', () => {
    const frames = controlledFrames();
    const store = new FrameCoalescedStore<{ text: string }>(frames.scheduler);
    store.items.set('s1', { text: 'Hi' });
    render(
      <LiveRenderGate shown={false}>
        <Reply shown store={store} />
      </LiveRenderGate>,
    );
    store.items.get('s1')!.text = 'Hi again';
    store.markItemChanged('s1');
    act(() => frames.flush());
    expect(screen.getByText('Hi')).toBeInTheDocument();
  });
});
