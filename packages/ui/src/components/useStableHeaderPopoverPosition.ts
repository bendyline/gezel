import {
  type CSSProperties,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useState,
} from 'react';

const VIEWPORT_EDGE_GAP_PX = 8;

interface HeaderPopoverPosition {
  top: number;
  right: number;
  maxHeight: number;
}

/**
 * Pins an open header popover to the viewport coordinate where its trigger
 * opened it. Header pills change width as live status text comes and goes;
 * keeping the popover in viewport space prevents those updates from dragging
 * an open surface sideways. A real viewport resize deliberately re-anchors it
 * so the surface remains attached to the header in the new window geometry.
 *
 * The measured `maxHeight` keeps the surface inside the viewport, which is
 * also what gives its own `overflow-y: auto` box something to scroll — a
 * popover that cannot scroll passes the wheel gesture to the page behind it.
 */
export function useStableHeaderPopoverPosition(
  anchorRef: RefObject<HTMLElement | null>,
  open: boolean,
  verticalGapPx: number,
): CSSProperties | undefined {
  const [position, setPosition] = useState<HeaderPopoverPosition | null>(null);

  const measure = useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const top = rect.bottom + verticalGapPx;
    const next = {
      top,
      right: Math.max(VIEWPORT_EDGE_GAP_PX, window.innerWidth - rect.right),
      maxHeight: Math.max(0, window.innerHeight - top - VIEWPORT_EDGE_GAP_PX),
    };
    setPosition((current) =>
      current?.top === next.top &&
      current.right === next.right &&
      current.maxHeight === next.maxHeight
        ? current
        : next,
    );
  }, [anchorRef, verticalGapPx]);

  // Measure after the popover enters the DOM but before paint. Later renders
  // caused by queue/engine status updates intentionally do not re-run this
  // effect because `open` remains true.
  useLayoutEffect(() => {
    if (open) measure();
  }, [measure, open]);

  useEffect(() => {
    if (!open) return;
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [measure, open]);

  if (!position) return undefined;
  return {
    position: 'fixed',
    top: position.top,
    right: position.right,
    maxHeight: position.maxHeight,
  };
}
