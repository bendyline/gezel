import { type RefObject, useEffect, useState } from 'react';

/**
 * Width threshold (CSS pixels) at which a surface flips to compact
 * layout — right-rail commands listing suppressed, gezel-roster chip
 * row free to wrap to a single dropdown, narrow-friendly tab labels.
 *
 * Calibrated against the surfaces that share this hook:
 *
 *   - VS Code chat sidebar — typically 250–450 px, sometimes wider
 *     when the user drags the rail out. Always compact in practice.
 *   - Desktop gezel app, project view with the project-list sidebar
 *     open — main column lands at ~400–500 px on a 1280-wide window
 *     with the side rail expanded. Should be compact here too: at
 *     these widths the right-rail commands panel wraps below the
 *     composer (see the narrow-window screenshot) and the
 *     tab row's "Workspace"/"Artifacts" labels get clipped.
 *   - Mobile portrait — 320–414 px. Always compact.
 *
 * 480 is the smallest threshold that catches BOTH the embedded
 * webview and the narrow-desktop case while leaving room above
 * (≥480 px) for the side panel to render comfortably. Lower this
 * if tablets at ~600 px start over-eagerly collapsing chrome that
 * fits fine; raise it if the right rail is unusable at 481–520 px.
 */
export const COMPACT_LAYOUT_THRESHOLD_PX = 480;

/**
 * Subscribe to an element's `clientWidth` via `ResizeObserver` and
 * return a boolean that flips to `true` once the width drops below
 * `threshold`. Returns `false` until the first measurement lands —
 * the cold-render assumption is "wide enough" so the desktop SPA
 * doesn't flash-of-compact-content on first paint while the
 * observer wires up.
 *
 * `hysteresisPx` widens the *exit* boundary only: compact engages
 * below `threshold` but doesn't release until `threshold +
 * hysteresisPx`, leaving a dead band where the last decision sticks.
 * Pass a non-zero band whenever the width is under continuous user
 * control — dragging a split grip across a bare threshold otherwise
 * tears the layout down and rebuilds it on every pixel of jitter.
 * Defaults to 0 (bare threshold) for window-driven surfaces.
 *
 * Caller responsibility: attach the returned ref's `.current` to a
 * stable DOM element (usually the surface's outermost wrapper). The
 * hook auto-disconnects on unmount.
 *
 * Resize-observer-missing path: returns `false` permanently. Today
 * that only fires in jsdom without the polyfill; production browsers
 * have broad ResizeObserver support.
 */
export function useCompactLayout(
  ref: RefObject<HTMLElement | null>,
  threshold: number = COMPACT_LAYOUT_THRESHOLD_PX,
  hysteresisPx = 0,
): boolean {
  const [compact, setCompact] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // No ResizeObserver in this runtime — stay non-compact and
    // accept that we can't auto-collapse. Callers that absolutely
    // need compact (the VS Code webview) pass an explicit prop
    // upstream as belt-and-braces.
    if (typeof ResizeObserver === 'undefined') return;

    const measure = () => {
      const w = el.clientWidth;
      setCompact((prev) => {
        // Width 0 means "not laid out / not rendered" (a hidden tab, a
        // detaching subtree), not "infinitely narrow" — hold the last
        // decision rather than reading a collapse into it.
        if (w <= 0) return prev;
        // Asymmetric boundaries: enter compact below `threshold`, leave
        // it only once past `threshold + hysteresisPx`. Inside the band
        // `prev` wins, which is what makes a grip drag stable.
        const next = prev ? w < threshold + hysteresisPx : w < threshold;
        // Skip the state update when the boolean didn't actually
        // change. Without this guard the ResizeObserver callback
        // would still re-render the subtree on every observed
        // resize event even when the layout decision is unchanged.
        return next === prev ? prev : next;
      });
    };
    // Sync initial measurement so the first paint reflects the real
    // width — ResizeObserver's initial callback fires asynchronously
    // and a one-frame flash of non-compact layout on a narrow surface
    // is visible enough to be annoying.
    measure();

    const ro = new ResizeObserver(() => measure());
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, threshold, hysteresisPx]);

  return compact;
}
