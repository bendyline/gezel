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
 * Calls `listener` when the side changes, here or from the boot-time sync,
 * and returns the unsubscribe. Shaped for `useSyncExternalStore`.
 */
export function onSidebarSideChange(listener: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, listener);
  return () => window.removeEventListener(CHANGE_EVENT, listener);
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
 * Boot-time reconciliation: pull `sidebarSide` from the gezel config (the
 * cross-boot source of truth), cache it, and paint the resolved side. Mirrors
 * `syncThemeFromConfig`. A config with no choice in it leaves the cache alone:
 * the cache only ever holds a side the person picked, or nothing.
 *
 * The side is painted every time, even when the cache already agrees. Two
 * scripts stamp the root before this runs, `theme-init.js` from the cache and
 * the start screen from its saved snapshot, and `getSidebarSide()` is what
 * Settings shows. Painting only on a cache change left a start screen's
 * `right` on the root while Settings said Left (2026-11-11).
 */
export async function syncSidebarSideFromConfig(): Promise<void> {
  let serverSide: SidebarSide | undefined;
  try {
    const cfg = await api.getConfig();
    if (cfg.sidebarSide === 'left' || cfg.sidebarSide === 'right') serverSide = cfg.sidebarSide;
  } catch {
    /* offline / boot race — keep whatever is painted */
    return;
  }
  const before = getSidebarSide();
  if (serverSide) cacheSide(serverSide);
  const side = serverSide ?? before;
  applySidebarSide(side);
  if (side !== before) window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}
