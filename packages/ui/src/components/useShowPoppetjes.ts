import { useEffect, useState } from 'react';
import { api } from '../api.js';

/**
 * Subscribes the "show poppetjes" flag (config.showPoppetjes) into a
 * component so avatar-rendering chokepoints (notably the leaf-level
 * `GezelIcon`) can hide the parametric figure when the user turns
 * poppetjes off. Defaults to `true` (poppetjes shown).
 *
 * Unlike the other config hooks, this one is read from a leaf component
 * that mounts many times per screen (every chat bubble, sidebar row,
 * project chip). To avoid each instance firing its own `getConfig`, the
 * value lives in a module-level cache shared across all subscribers: the
 * first mount triggers a single fetch, and a global `gezel:config-updated`
 * listener re-broadcasts a live toggle from SettingsView to every icon.
 */
let cached: boolean | undefined;
let inflight: Promise<void> | null = null;
const subscribers = new Set<(v: boolean) => void>();

function broadcast(v: boolean): void {
  cached = v;
  for (const fn of subscribers) fn(v);
}

function ensureLoaded(): void {
  if (cached !== undefined || inflight) return;
  inflight = api
    .getConfig()
    .then((cfg) => {
      broadcast(cfg.showPoppetjes !== false);
    })
    .catch(() => {})
    .finally(() => {
      inflight = null;
    });
}

if (typeof window !== 'undefined') {
  window.addEventListener('gezel:config-updated', (e: Event) => {
    const detail = (e as CustomEvent).detail as { showPoppetjes?: boolean } | undefined;
    if (detail && typeof detail.showPoppetjes === 'boolean') {
      broadcast(detail.showPoppetjes);
    }
  });
}

export function useShowPoppetjes(): boolean {
  const [on, setOn] = useState<boolean>(cached ?? true);

  useEffect(() => {
    subscribers.add(setOn);
    if (cached !== undefined) setOn(cached);
    else ensureLoaded();
    return () => {
      subscribers.delete(setOn);
    };
  }, []);

  return on;
}
