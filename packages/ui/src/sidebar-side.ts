import { DEFAULT_SIDEBAR_SIDE } from '@bendyline/gezel';
import { api } from './api.js';

export type SidebarSide = 'left' | 'right';

const STORAGE_KEY = 'gezel:sidebar-side';
const CHANGE_EVENT = 'gezel:sidebar-side-change';

/**
 * The cached side for a choice: the default is stored as an absent key, so a
 * cache that was never written and one holding the default read the same.
 */
function cacheSide(side: SidebarSide): void {
  try {
    if (side === DEFAULT_SIDEBAR_SIDE) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, side);
  } catch {
    /* ignore */
  }
}

/**
 * The current sidebar side from the localStorage cache. `left` is the
 * default (`DEFAULT_SIDEBAR_SIDE`; it was `right` until 2026-11-11), so only
 * an explicit `right` opts out and an absent or garbage value resolves to
 * `left`. The CSS treats no attribute as the LEFT base and keys the RIGHT
 * layout off `data-sidebar-side="right"`, so a fresh install paints the
 * default with nothing stamped at all.
 */
export function getSidebarSide(): SidebarSide {
  try {
    const cached = localStorage.getItem(STORAGE_KEY);
    if (cached === 'left' || cached === 'right') return cached;
  } catch {
    /* localStorage unavailable — fall through to the default */
  }
  return DEFAULT_SIDEBAR_SIDE;
}

/**
 * Persist the sidebar side, apply it immediately, and mirror it to the
 * gezel config so it survives Electron's ephemeral-port shuffle — same
 * reasoning as `setThemePref` in theme.ts. The config always gets the choice
 * by name, which is what tells a chosen side from the default: a person who
 * picked the right keeps it when the default moves.
 */
export function setSidebarSide(side: SidebarSide): void {
  cacheSide(side);
  applySidebarSide(side);
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
  void api.updateConfig({ sidebarSide: side }).catch(() => {});
}

/**
 * Reflect `side` onto the document root; CSS keys the layout off it. The
 * LEFT layout is the CSS base (no attribute); the RIGHT layout is the
 * override that `data-sidebar-side="right"` selects.
 */
export function applySidebarSide(side: SidebarSide): void {
  const root = document.documentElement;
  if (side === 'left') root.removeAttribute('data-sidebar-side');
  else root.setAttribute('data-sidebar-side', 'right');
}

/**
 * Boot-time reconciliation: pull `sidebarSide` from the gezel config and
 * apply it if it differs from the localStorage cache. Mirrors
 * `syncThemeFromConfig`. The early `theme-init.js` script has already
 * applied the cached value before first paint; this covers the case where
 * the config (cross-boot source of truth) disagrees with a stale cache. A
 * config with no choice in it leaves the cache alone: the cache only ever
 * holds a side the person picked, or nothing.
 */
export async function syncSidebarSideFromConfig(): Promise<void> {
  let serverSide: SidebarSide | undefined;
  try {
    const cfg = await api.getConfig();
    if (cfg.sidebarSide === 'left' || cfg.sidebarSide === 'right') serverSide = cfg.sidebarSide;
  } catch {
    /* offline / boot race — keep whatever localStorage says */
    return;
  }
  if (!serverSide) return;
  if (serverSide === getSidebarSide()) return;
  cacheSide(serverSide);
  applySidebarSide(serverSide);
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}
