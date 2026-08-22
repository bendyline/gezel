/**
 * Titlebar density — how much the header's status cluster may say.
 *
 * The header packs a variable number of live status pills (queue chips,
 * one engine pill per busy on-device engine, quota, engagement) into the
 * strip left over after the brand and the search well. Three engines at
 * once — DwarfStar plus llama.cpp plus MLX — pushed the cluster off the
 * right edge of the titlebar, because `.app-header-right` is
 * `flex-shrink: 0` on purpose: the pills would rather drop words than
 * shrink into an unreadable smear.
 *
 * So dropping words is what this does. Density is measured once for the
 * whole cluster and shared through `HeaderDensityContext`, so every pill
 * sheds detail at the same moment instead of each one deciding for
 * itself:
 *
 *   full     everything
 *   compact  the machine name ("This Mac" — every local engine wears it,
 *            so it says nothing once a second pill is on screen) and the
 *            queue chip's activity phrase go
 *   tight    the gezel name in an engine pill goes too; the pill keeps
 *            the engine, the phase and the model
 *   minimal  the model name goes as well, leaving the phase and the clock
 *            — but only where something else remains to name the pill, so
 *            an idle pill never shrinks to a bare dot
 *
 * Nothing is lost outright — every dropped string stays in the pill's
 * `title` and in its popover.
 *
 * The measurement deliberately prices the search well at its floor
 * (`SEARCH_FLOOR_PX`) rather than at its current width, which makes
 * `availableWidth` independent of our own compaction: a denser cluster
 * doesn't widen the space it is measured against. Without that, every
 * step would immediately look like it fitted at the previous density and
 * the pills would flicker between the two forever. `blocked` closes the
 * remaining half of that loop — see `resolveHeaderDensity`.
 */

import { type RefObject, createContext, useContext, useEffect, useRef, useState } from 'react';

export type HeaderDensity = 'full' | 'compact' | 'tight' | 'minimal';

/** Loosest to densest. Steps are taken one at a time, never skipped. */
export const HEADER_DENSITY_ORDER: readonly HeaderDensity[] = [
  'full',
  'compact',
  'tight',
  'minimal',
];

/**
 * Width the search well is entitled to keep no matter how busy the right
 * cluster gets. Mirrors the `clamp()` minimum in `.titlebar-search`; the
 * flex rules let it shrink below this, which is exactly the crowding this
 * module exists to notice.
 */
export const SEARCH_FLOOR_PX = 180;

/**
 * How much room a looser density must have spare before it is tried
 * again after it overflowed. Pure anti-flutter margin: without it a
 * one-pixel window resize would re-trigger the overflow it just escaped.
 */
export const DENSITY_REENTRY_MARGIN_PX = 32;

export interface HeaderDensityState {
  density: HeaderDensity;
  /**
   * For each density that has overflowed, the cluster budget available at
   * the moment it did. That density is not attempted again until the
   * budget grows past it — the only reason we don't oscillate.
   */
  blocked: Partial<Record<HeaderDensity, number>>;
}

export interface HeaderDensityMeasurement {
  /** What the status cluster occupies right now, at the current density. */
  clusterWidth: number;
  /** What it may occupy: the header's content box minus everything else, with the search at its floor. */
  availableWidth: number;
}

export const INITIAL_HEADER_DENSITY_STATE: HeaderDensityState = {
  density: 'full',
  blocked: {},
};

/**
 * One step of the density loop. Returns the same object when nothing
 * changes so callers can skip the re-render on identity.
 */
export function resolveHeaderDensity(
  state: HeaderDensityState,
  measurement: HeaderDensityMeasurement,
): HeaderDensityState {
  const index = HEADER_DENSITY_ORDER.indexOf(state.density);
  if (index < 0) return INITIAL_HEADER_DENSITY_STATE;

  if (measurement.clusterWidth > measurement.availableWidth) {
    const denser = HEADER_DENSITY_ORDER[index + 1];
    if (!denser) return state;
    return {
      density: denser,
      blocked: { ...state.blocked, [state.density]: measurement.availableWidth },
    };
  }

  const looser = HEADER_DENSITY_ORDER[index - 1];
  if (!looser) return state;
  const blockedAt = state.blocked[looser];
  if (
    blockedAt !== undefined &&
    measurement.availableWidth <= blockedAt + DENSITY_REENTRY_MARGIN_PX
  ) {
    return state;
  }
  const blocked = { ...state.blocked };
  delete blocked[looser];
  return { density: looser, blocked };
}

/**
 * Forget which densities overflowed. Called when the cluster's structure
 * changes (a pill appears or goes away) — the recorded budgets describe a
 * cluster that no longer exists, and keeping them would pin an emptier
 * header at a density it has outgrown.
 */
export function clearHeaderDensityBlocks(state: HeaderDensityState): HeaderDensityState {
  if (Object.keys(state.blocked).length === 0) return state;
  return { density: state.density, blocked: {} };
}

/**
 * A cheap stand-in for "how many things are in the cluster", used to
 * notice structural change between measurements. It counts only elements
 * that exist at every density — pill roots and queue chips, never the
 * inner spans compaction removes — so compacting can't be mistaken for
 * the content itself changing.
 */
export function headerClusterSignature(cluster: Element): number {
  return cluster.childElementCount * 100 + cluster.querySelectorAll('.queue-meter-chip').length;
}

/**
 * Measure the cluster against the room the rest of the header leaves it.
 *
 * Everything except the cluster is priced at its current width, save the
 * search well which is priced at `SEARCH_FLOOR_PX` — the budget is "what
 * is left once the search keeps the width it is owed". Out-of-flow
 * children (the search-results overlay) and hidden ones don't count.
 */
export function measureHeaderDensity(
  header: HTMLElement,
  cluster: HTMLElement,
): HeaderDensityMeasurement | null {
  const view = header.ownerDocument?.defaultView;
  if (!view) return null;
  const style = view.getComputedStyle(header);
  const paddingLeft = Number.parseFloat(style.paddingLeft) || 0;
  const paddingRight = Number.parseFloat(style.paddingRight) || 0;
  const gap = Number.parseFloat(style.columnGap) || 0;
  const contentWidth = header.getBoundingClientRect().width - paddingLeft - paddingRight;
  if (!(contentWidth > 0)) return null;

  let clusterWidth = 0;
  let othersWidth = 0;
  let inFlowChildren = 0;
  for (const child of Array.from(header.children)) {
    if (!(child instanceof view.HTMLElement)) continue;
    const childStyle = view.getComputedStyle(child);
    if (childStyle.display === 'none') continue;
    if (childStyle.position === 'absolute' || childStyle.position === 'fixed') continue;
    inFlowChildren += 1;
    const width = child.getBoundingClientRect().width;
    if (child === cluster) {
      clusterWidth = width;
    } else if (child.classList.contains('titlebar-search')) {
      othersWidth += SEARCH_FLOOR_PX;
    } else {
      othersWidth += width;
    }
  }
  if (clusterWidth <= 0) return null;

  const gaps = gap * Math.max(0, inFlowChildren - 1);
  return { clusterWidth, availableWidth: contentWidth - othersWidth - gaps };
}

/**
 * Read the density the header settled on. Defaults to `full` outside the
 * header (and in tests that render a pill on its own), so nothing has to
 * know about this module to render correctly.
 */
export const HeaderDensityContext = createContext<HeaderDensity>('full');

export function useHeaderDensity(): HeaderDensity {
  return useContext(HeaderDensityContext);
}

/**
 * Drive the density loop from the live header.
 *
 * Re-measures on every size change of the header or the cluster, batched
 * to one animation frame. Each density change resizes the cluster, which
 * re-enters here — the loop settles because `resolveHeaderDensity` refuses
 * to re-try a density that overflowed at the budget still on offer.
 *
 * Without `ResizeObserver` (jsdom, plain server render) the header simply
 * stays at `full`.
 */
export function useHeaderDensityMeasurement(
  headerRef: RefObject<HTMLElement | null>,
  clusterRef: RefObject<HTMLElement | null>,
): HeaderDensity {
  const [state, setState] = useState(INITIAL_HEADER_DENSITY_STATE);
  const stateRef = useRef(state);
  stateRef.current = state;
  const signatureRef = useRef<number | null>(null);

  useEffect(() => {
    const header = headerRef.current;
    const cluster = clusterRef.current;
    if (!header || !cluster) return;
    const view = header.ownerDocument?.defaultView;
    if (!view || typeof view.ResizeObserver !== 'function') return;

    let frame = 0;
    const evaluate = () => {
      frame = 0;
      const measurement = measureHeaderDensity(header, cluster);
      if (!measurement) return;
      const signature = headerClusterSignature(cluster);
      let current = stateRef.current;
      if (signatureRef.current !== null && signatureRef.current !== signature) {
        current = clearHeaderDensityBlocks(current);
      }
      signatureRef.current = signature;
      const next = resolveHeaderDensity(current, measurement);
      if (next === stateRef.current) return;
      stateRef.current = next;
      setState(next);
    };
    const schedule = () => {
      if (frame) return;
      frame = view.requestAnimationFrame(evaluate);
    };

    const observer = new view.ResizeObserver(schedule);
    observer.observe(header);
    observer.observe(cluster);
    schedule();
    return () => {
      if (frame) view.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [headerRef, clusterRef]);

  return state.density;
}
