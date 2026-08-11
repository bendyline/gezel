import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { COMPACT_LAYOUT_THRESHOLD_PX, useCompactLayout } from './useCompactLayout.js';

/**
 * Minimal ResizeObserver polyfill — jsdom doesn't ship one. The mock
 * captures the latest observation callback so a test can manually
 * trigger a resize event, and tracks `observe` / `disconnect` calls
 * so we can assert lifecycle hygiene.
 */
interface MockROEntry {
  contentRect: { width: number; height: number };
  target: Element;
}
type MockROCallback = (entries: MockROEntry[]) => void;

interface ActiveMockObserver {
  callback: MockROCallback;
  el: Element | null;
  disconnected: boolean;
}

let active: ActiveMockObserver | null = null;

class MockResizeObserver {
  constructor(private readonly cb: MockROCallback) {}
  observe(el: Element): void {
    active = { callback: this.cb, el, disconnected: false };
  }
  unobserve(): void {
    /* not exercised by the hook today */
  }
  disconnect(): void {
    if (active && active.callback === this.cb) active.disconnected = true;
  }
}

function setWidth(el: HTMLElement, width: number): void {
  // jsdom's `clientWidth` is read-only and defaults to 0. Define a
  // per-instance getter so the hook's measurement reads what we set.
  Object.defineProperty(el, 'clientWidth', { configurable: true, value: width });
  if (active && active.el === el && !active.disconnected) {
    active.callback([
      {
        contentRect: { width, height: 0 },
        target: el,
      },
    ]);
  }
}

beforeEach(() => {
  active = null;
  (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver =
    MockResizeObserver as unknown as typeof ResizeObserver;
});

afterEach(() => {
  delete (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
});

describe('useCompactLayout', () => {
  it('returns false before the ref attaches', () => {
    const { result } = renderHook(() => useCompactLayout({ current: null }));
    expect(result.current).toBe(false);
  });

  it('measures the element synchronously on mount and flips to compact at < threshold', async () => {
    const el = document.createElement('div');
    setWidth(el, 320); // mobile portrait, well below 480
    const { result } = renderHook(() => useCompactLayout({ current: el }));
    await waitFor(() => {
      expect(result.current).toBe(true);
    });
  });

  it('stays non-compact at >= threshold', async () => {
    const el = document.createElement('div');
    setWidth(el, COMPACT_LAYOUT_THRESHOLD_PX); // exactly at threshold — `<` is strict
    const { result } = renderHook(() => useCompactLayout({ current: el }));
    // No assertion-style waitFor since `false` is already the
    // initial state — instead, give the effect a beat and confirm.
    await waitFor(() => expect(active).not.toBeNull());
    expect(result.current).toBe(false);
  });

  it('updates when the element resizes through the threshold', async () => {
    const el = document.createElement('div');
    setWidth(el, 800);
    const { result } = renderHook(() => useCompactLayout({ current: el }));
    await waitFor(() => expect(active).not.toBeNull());
    expect(result.current).toBe(false);

    setWidth(el, 400);
    await waitFor(() => expect(result.current).toBe(true));

    setWidth(el, 600);
    await waitFor(() => expect(result.current).toBe(false));
  });

  it('respects a custom threshold', async () => {
    const el = document.createElement('div');
    setWidth(el, 600);
    const { result } = renderHook(() => useCompactLayout({ current: el }, 700));
    await waitFor(() => expect(result.current).toBe(true));
  });

  it('holds the last decision inside the hysteresis band', async () => {
    const el = document.createElement('div');
    setWidth(el, 900);
    const { result } = renderHook(() => useCompactLayout({ current: el }, 800, 100));
    await waitFor(() => expect(active).not.toBeNull());
    expect(result.current).toBe(false);

    // Entering still uses the bare threshold.
    setWidth(el, 850);
    await waitFor(() => expect(active).not.toBeNull());
    expect(result.current).toBe(false);
    setWidth(el, 799);
    await waitFor(() => expect(result.current).toBe(true));

    // Leaving needs threshold + band — 850 is inside it, so compact sticks.
    setWidth(el, 850);
    await waitFor(() => expect(active).not.toBeNull());
    expect(result.current).toBe(true);

    setWidth(el, 900);
    await waitFor(() => expect(result.current).toBe(false));
  });

  it('ignores width 0 (element not laid out yet) — stays non-compact', async () => {
    const el = document.createElement('div');
    setWidth(el, 0);
    const { result } = renderHook(() => useCompactLayout({ current: el }));
    await waitFor(() => expect(active).not.toBeNull());
    expect(result.current).toBe(false);
  });

  it('disconnects the observer on unmount', async () => {
    const el = document.createElement('div');
    setWidth(el, 400);
    const { unmount } = renderHook(() => useCompactLayout({ current: el }));
    await waitFor(() => expect(active).not.toBeNull());
    expect(active?.disconnected).toBe(false);
    unmount();
    expect(active?.disconnected).toBe(true);
  });

  it('returns false permanently when ResizeObserver is missing (degraded runtime)', () => {
    delete (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
    const el = document.createElement('div');
    setWidth(el, 320);
    const { result } = renderHook(() => useCompactLayout({ current: el }));
    expect(result.current).toBe(false);
  });
});
