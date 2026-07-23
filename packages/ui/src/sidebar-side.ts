import { api } from './api.js';

export type SidebarSide = 'left' | 'right';

const STORAGE_KEY = 'gezel:sidebar-side';
const CHANGE_EVENT = 'gezel:sidebar-side-change';

/**
 * The current sidebar side from the localStorage cache. `right` is the
 * default, so only an explicit `left` opts out — an absent/garbage value
 * resolves to `right`. The CSS keys the RIGHT layout off the presence of
 * `data-sidebar-side="right"` and treats no-attribute as the LEFT base,
 * so `applySidebarSide` stamps the attribute for `right` and clears it
 * for `left` (see below); the default resolving to `right` is what makes
 * a fresh install stamp the attribute on first paint.
 */
export function getSidebarSide(): SidebarSide {
  try {
    if (localStorage.getItem(STORAGE_KEY) === 'left') return 'left';
  } catch {
    /* localStorage unavailable — fall through to the default */
  }
  return 'right';
}

/**
 * Persist the sidebar side, apply it immediately, and mirror it to the
 * gezel config so it survives Electron's ephemeral-port shuffle — same
 * reasoning as `setThemePref` in theme.ts. `right` is the default, so it
 * clears the cache key (absent = default) and `left` stores explicitly.
 */
export function setSidebarSide(side: SidebarSide): void {
  try {
    if (side === 'right') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, side);
  } catch {
    /* ignore */
  }
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
 * the config (cross-boot source of truth) disagrees with a stale cache.
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
  try {
    if (serverSide === 'right') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, serverSide);
  } catch {
    /* ignore */
  }
  applySidebarSide(serverSide);
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}
