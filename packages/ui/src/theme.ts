import { useSyncExternalStore } from 'react';
import { api } from './api.js';

export type ThemePref = 'system' | 'light' | 'dark';
export type EffectiveTheme = 'light' | 'dark';

const STORAGE_KEY = 'gezel:theme';
const CHANGE_EVENT = 'gezel:theme-change';

export function getThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'light' || v === 'dark') return v;
  } catch {
    /* localStorage unavailable — fall through to system */
  }
  return 'system';
}

export function setThemePref(pref: ThemePref): void {
  try {
    if (pref === 'system') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, pref);
  } catch {
    /* ignore */
  }
  applyThemePref(pref);
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
  // Mirror to server-side config so the pref survives Electron's
  // ephemeral-port shuffle. localStorage is keyed by origin and the
  // embedded service binds a fresh port every launch — without this
  // the pref strands on the previous boot's origin.
  void api.updateConfig({ themePref: pref }).catch(() => {});
}

export function applyThemePref(pref: ThemePref): void {
  const root = document.documentElement;
  if (pref === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', pref);
}

/**
 * Boot-time reconciliation: pull `themePref` from the gezel config
 * and apply it if it differs from what's currently in localStorage.
 * Idempotent — safe to call repeatedly. Call once on app mount.
 *
 * The flow:
 *   1. Early-paint inline script in `index.html` reads localStorage
 *      and sets `data-theme` immediately (no flash on same-port boots).
 *   2. App bundle loads, this function runs, fetches config.
 *   3. If `config.themePref` is set and differs from `getThemePref()`,
 *      apply it AND prime localStorage so the next boot's same-port
 *      case stays fast.
 */
export async function syncThemeFromConfig(): Promise<void> {
  let serverPref: ThemePref | undefined;
  try {
    const cfg = await api.getConfig();
    const t = cfg.themePref;
    if (t === 'system' || t === 'light' || t === 'dark') serverPref = t;
  } catch {
    /* offline / boot race — keep whatever localStorage says */
    return;
  }
  if (!serverPref) return;
  const localPref = getThemePref();
  if (serverPref === localPref) return;
  try {
    if (serverPref === 'system') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, serverPref);
  } catch {
    /* ignore */
  }
  applyThemePref(serverPref);
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}

function systemTheme(): EffectiveTheme {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function resolveEffective(): EffectiveTheme {
  const pref = getThemePref();
  return pref === 'system' ? systemTheme() : pref;
}

/**
 * Returns the live effective theme ('light' | 'dark') — never 'system'.
 * Re-renders the component on Settings changes and on OS-level switches
 * while the pref is 'system'.
 */
export function useEffectiveTheme(): EffectiveTheme {
  return useSyncExternalStore(
    (onChange) => {
      window.addEventListener(CHANGE_EVENT, onChange);
      const mql = window.matchMedia('(prefers-color-scheme: dark)');
      mql.addEventListener('change', onChange);
      return () => {
        window.removeEventListener(CHANGE_EVENT, onChange);
        mql.removeEventListener('change', onChange);
      };
    },
    resolveEffective,
    () => 'light',
  );
}
