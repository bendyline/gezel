/**
 * Lets an ordinary mouse wheel move a horizontal strip.
 *
 * A wheel only emits `deltaY`, which a horizontally scrolling element
 * ignores, so a strip of cards could be moved only by dragging its bar or
 * with a trackpad. The listener scrolls `viewport` by whichever axis the
 * wheel moved most. At either end it leaves the event alone, so the page
 * around the strip scrolls as usual. Ctrl/Cmd+wheel stays zoom.
 *
 * Attached natively because React's delegated wheel listener is passive and
 * cannot stop the surrounding page from scrolling when the strip consumes it.
 * Returns the detach function.
 */
export function attachHorizontalWheel(
  target: HTMLElement,
  viewport: HTMLElement = target,
): () => void {
  const onWheel = (event: WheelEvent) => {
    if (event.ctrlKey || event.metaKey || event.defaultPrevented) return;
    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    const unit =
      event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? Number.parseFloat(getComputedStyle(viewport).lineHeight) || 16
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? viewport.clientWidth
          : 1;
    const left = Math.max(
      0,
      Math.min(viewport.scrollWidth - viewport.clientWidth, viewport.scrollLeft + delta * unit),
    );
    if (Math.abs(left - viewport.scrollLeft) < 0.5) return;
    event.preventDefault();
    event.stopPropagation();
    viewport.scrollLeft = left;
  };
  target.addEventListener('wheel', onWheel, { passive: false });
  return () => target.removeEventListener('wheel', onWheel);
}
