import { act, renderHook } from '@testing-library/react';
import type { RefObject } from 'react';
import { describe, expect, it } from 'vitest';
import { useStableHeaderPopoverPosition } from './useStableHeaderPopoverPosition.js';

function anchorRect(right: number, bottom: number): DOMRect {
  return { right, bottom } as DOMRect;
}

describe('useStableHeaderPopoverPosition', () => {
  it('holds the opening coordinate through parent movement and re-anchors on window resize', () => {
    let rect = anchorRect(window.innerWidth - 180, 40);
    const anchorRef = {
      current: {
        getBoundingClientRect: () => rect,
      } as HTMLElement,
    } as RefObject<HTMLElement>;

    const { result, rerender } = renderHook(
      ({ open }) => useStableHeaderPopoverPosition(anchorRef, open, 8),
      { initialProps: { open: true } },
    );

    const maxHeight = window.innerHeight - 48 - 8;
    expect(result.current).toEqual({ position: 'fixed', top: 48, right: 180, maxHeight });

    // A live label/neighbor update shifts the pill, but an already-open
    // dropdown must not follow it horizontally.
    rect = anchorRect(window.innerWidth - 40, 40);
    rerender({ open: true });
    expect(result.current).toEqual({ position: 'fixed', top: 48, right: 180, maxHeight });

    // Resizing the actual viewport is the one time the open dropdown should
    // attach itself to the trigger's new window geometry.
    act(() => window.dispatchEvent(new Event('resize')));
    expect(result.current).toEqual({ position: 'fixed', top: 48, right: 40, maxHeight });
  });

  // Without a height bound the slab is not a scroll container, so a wheel
  // gesture over it scrolls the page behind it instead.
  it('bounds the surface to the space left below the trigger', () => {
    const anchorRef = {
      current: {
        getBoundingClientRect: () => anchorRect(window.innerWidth - 180, window.innerHeight - 100),
      } as HTMLElement,
    } as RefObject<HTMLElement>;

    const { result } = renderHook(() => useStableHeaderPopoverPosition(anchorRef, true, 8));

    expect(result.current?.maxHeight).toBe(100 - 8 - 8);
  });
});
