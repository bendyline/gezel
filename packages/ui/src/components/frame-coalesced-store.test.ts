import { describe, expect, it, vi } from 'vitest';
import { FrameCoalescedStore, type FrameScheduler } from './frame-coalesced-store.js';

function controlledFrames(): {
  scheduler: FrameScheduler;
  flush: () => void;
  pending: () => number;
} {
  const callbacks = new Map<number, FrameRequestCallback>();
  let nextHandle = 1;
  return {
    scheduler: {
      request(callback) {
        const handle = nextHandle++;
        callbacks.set(handle, callback);
        return handle;
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
    pending: () => callbacks.size,
  };
}

describe('FrameCoalescedStore', () => {
  it('keeps every mutation while publishing one item notification per frame', () => {
    const frames = controlledFrames();
    const store = new FrameCoalescedStore<{ text: string }>(frames.scheduler);
    store.items.set('session', { text: '' });
    const listener = vi.fn();
    store.subscribeItem('session', listener);

    for (let i = 0; i < 100; i += 1) {
      store.items.get('session')!.text += String(i % 10);
      store.markItemChanged('session');
    }

    expect(store.items.get('session')!.text).toHaveLength(100);
    expect(listener).not.toHaveBeenCalled();
    expect(frames.pending()).toBe(1);

    frames.flush();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getItemSnapshot('session')).toBe(1);
  });

  it('separates item updates from structural timeline updates', () => {
    const frames = controlledFrames();
    const store = new FrameCoalescedStore<object>(frames.scheduler);
    const structureListener = vi.fn();
    const firstListener = vi.fn();
    const secondListener = vi.fn();
    store.subscribeStructure(structureListener);
    store.subscribeItem('first', firstListener);
    store.subscribeItem('second', secondListener);

    store.markItemChanged('first');
    store.markItemChanged('first');
    frames.flush();
    expect(firstListener).toHaveBeenCalledTimes(1);
    expect(secondListener).not.toHaveBeenCalled();
    expect(structureListener).not.toHaveBeenCalled();

    store.markStructureChanged();
    frames.flush();
    expect(structureListener).toHaveBeenCalledTimes(1);
    expect(store.getStructureSnapshot()).toBe(1);
  });
});
