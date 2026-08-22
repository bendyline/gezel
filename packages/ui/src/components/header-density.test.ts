import { describe, expect, it } from 'vitest';
import {
  DENSITY_REENTRY_MARGIN_PX,
  type HeaderDensityState,
  INITIAL_HEADER_DENSITY_STATE,
  SEARCH_FLOOR_PX,
  clearHeaderDensityBlocks,
  headerClusterSignature,
  measureHeaderDensity,
  resolveHeaderDensity,
} from './header-density.js';

/** Run the loop to a fixed point the way the ResizeObserver would. */
function settle(
  widths: Record<string, number>,
  availableWidth: number,
  start: HeaderDensityState = INITIAL_HEADER_DENSITY_STATE,
): { state: HeaderDensityState; steps: number } {
  let state = start;
  for (let steps = 1; steps <= 12; steps += 1) {
    const next = resolveHeaderDensity(state, {
      clusterWidth: widths[state.density] ?? 0,
      availableWidth,
    });
    if (next === state) return { state, steps };
    state = next;
  }
  throw new Error('density never settled');
}

describe('resolveHeaderDensity', () => {
  it('stays full when the cluster fits', () => {
    const { state } = settle({ full: 500, compact: 400, tight: 300, minimal: 240 }, 900);
    expect(state.density).toBe('full');
  });

  it('drops one step at a time until the cluster fits', () => {
    const { state } = settle({ full: 900, compact: 700, tight: 520, minimal: 420 }, 750);
    expect(state.density).toBe('compact');
  });

  it('reaches tight when even one compaction is not enough', () => {
    const { state } = settle({ full: 900, compact: 700, tight: 520, minimal: 420 }, 560);
    expect(state.density).toBe('tight');
  });

  it('sheds the model name before it overflows', () => {
    const { state } = settle({ full: 900, compact: 700, tight: 520, minimal: 420 }, 460);
    expect(state.density).toBe('minimal');
  });

  it('stays at minimal rather than overflowing further', () => {
    const { state } = settle({ full: 900, compact: 700, tight: 520, minimal: 420 }, 200);
    expect(state.density).toBe('minimal');
  });

  // The loop's whole reason for existing: a compacted cluster always "fits",
  // so without the blocked record it would step back up, overflow, and
  // flicker between the two forever.
  it('does not re-expand into a width that already overflowed', () => {
    const widths = { full: 900, compact: 700, tight: 520, minimal: 420 };
    const { state } = settle(widths, 750);
    expect(state.density).toBe('compact');
    expect(state.blocked.full).toBe(750);
    expect(resolveHeaderDensity(state, { clusterWidth: 700, availableWidth: 750 })).toBe(state);
  });

  it('re-expands once the window is wide enough to hold the looser form', () => {
    const widths = { full: 900, compact: 700, tight: 520, minimal: 420 };
    const settled = settle(widths, 750).state;
    const wider = settle(widths, 750 + DENSITY_REENTRY_MARGIN_PX + 200, settled).state;
    expect(wider.density).toBe('full');
    expect(wider.blocked.full).toBeUndefined();
  });

  it('ignores a re-expansion that only just clears the failed width', () => {
    const settled = settle({ full: 900, compact: 700, tight: 520, minimal: 420 }, 750).state;
    const nudged = resolveHeaderDensity(settled, {
      clusterWidth: 700,
      availableWidth: 750 + DENSITY_REENTRY_MARGIN_PX,
    });
    expect(nudged).toBe(settled);
  });

  it('re-expands after a pill goes away and the blocks are cleared', () => {
    const settled = settle({ full: 900, compact: 700, tight: 520, minimal: 420 }, 750).state;
    // Same titlebar, one engine fewer: the recorded budget describes a
    // cluster that no longer exists.
    const cleared = clearHeaderDensityBlocks(settled);
    const { state } = settle({ full: 600, compact: 480, tight: 380, minimal: 300 }, 750, cleared);
    expect(state.density).toBe('full');
  });

  it('leaves a state with no blocks untouched when clearing', () => {
    expect(clearHeaderDensityBlocks(INITIAL_HEADER_DENSITY_STATE)).toBe(
      INITIAL_HEADER_DENSITY_STATE,
    );
  });
});

/** jsdom lays nothing out, so every measured box is stated explicitly. */
function box(el: HTMLElement, width: number): HTMLElement {
  el.getBoundingClientRect = (() => ({ width }) as DOMRect) as HTMLElement['getBoundingClientRect'];
  return el;
}

function buildHeader(widths: {
  header: number;
  brand: number;
  search: number;
  cluster: number;
}): { header: HTMLElement; cluster: HTMLElement } {
  const header = document.createElement('header');
  header.style.paddingLeft = '83px';
  header.style.paddingRight = '16px';
  header.style.columnGap = '24px';
  box(header, widths.header);

  const brand = box(document.createElement('button'), widths.brand);
  const search = box(document.createElement('div'), widths.search);
  search.classList.add('titlebar-search');
  // The search-results overlay is out of flow and must not be priced.
  const overlay = box(document.createElement('div'), 900);
  overlay.style.position = 'fixed';
  const cluster = box(document.createElement('div'), widths.cluster);

  header.append(brand, search, overlay, cluster);
  document.body.append(header);
  return { header, cluster };
}

describe('measureHeaderDensity', () => {
  it('prices the search at its floor so the budget survives our own compaction', () => {
    const { header, cluster } = buildHeader({
      header: 1510,
      brand: 120,
      search: 460,
      cluster: 700,
    });
    const wide = measureHeaderDensity(header, cluster);

    // Squeeze the search well past its floor; the budget must not move,
    // otherwise compacting would look like it created room for itself.
    box(header.querySelector<HTMLElement>('.titlebar-search') as HTMLElement, 0);
    const squeezed = measureHeaderDensity(header, cluster);

    expect(wide?.availableWidth).toBe(squeezed?.availableWidth);
    // 1510 − 83 − 16 padding − 120 brand − 180 search floor − 2 × 24px gaps
    // (the out-of-flow overlay neither takes width nor opens a gap).
    expect(wide?.availableWidth).toBe(1510 - 83 - 16 - 120 - SEARCH_FLOOR_PX - 48);
    expect(wide?.clusterWidth).toBe(700);
  });

  it('counts a cluster that has outgrown its budget as overflowing', () => {
    const { header, cluster } = buildHeader({
      header: 1510,
      brand: 120,
      search: 0,
      cluster: 1100,
    });
    const measurement = measureHeaderDensity(header, cluster);
    expect(measurement).not.toBeNull();
    expect(measurement && measurement.clusterWidth > measurement.availableWidth).toBe(true);
  });
});

describe('headerClusterSignature', () => {
  it('changes when a pill appears but not when a pill compacts', () => {
    const cluster = document.createElement('div');
    const pill = document.createElement('div');
    const inner = document.createElement('span');
    pill.append(inner);
    cluster.append(pill);
    const before = headerClusterSignature(cluster);

    inner.remove();
    expect(headerClusterSignature(cluster)).toBe(before);

    cluster.append(document.createElement('div'));
    expect(headerClusterSignature(cluster)).not.toBe(before);
  });
});
