import { resolveSocialMode } from '@bendyline/gezel';
import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { runtimeCapabilities } from '../runtime-capabilities.js';

/**
 * Subscribes social mode (config.social) into a component: characters in
 * how gezels talk, growth on display, a chat that opens on what is waiting.
 * Absent means the host's default — on for a phone (no daemon settings), off
 * for the desktop — so a setting nobody touched still reads correctly here.
 *
 * Shared cache like `useShowPoppetjes`: many surfaces read it at once, and a
 * `gezel:config-updated` from a Settings toggle reaches all of them.
 */
let cached: boolean | undefined;
let inflight: Promise<void> | null = null;
const subscribers = new Set<(v: boolean) => void>();

export function socialHost(): 'desktop' | 'phone' {
  return runtimeCapabilities().daemonSettings ? 'desktop' : 'phone';
}

function broadcast(v: boolean): void {
  cached = v;
  for (const fn of subscribers) fn(v);
}

function ensureLoaded(): void {
  if (cached !== undefined || inflight) return;
  inflight = api
    .getConfig()
    .then((cfg) => broadcast(resolveSocialMode(cfg, socialHost())))
    .catch(() => {})
    .finally(() => {
      inflight = null;
    });
}

if (typeof window !== 'undefined') {
  window.addEventListener('gezel:config-updated', (e: Event) => {
    // Only a detail that names `social` speaks for it: other saves broadcast
    // partial config (`{ aiEngagementMode }`), and resolving those against the
    // host default would switch a chosen social mode back off.
    const detail = (e as CustomEvent).detail as { social?: boolean } | undefined;
    if (detail && typeof detail.social === 'boolean') broadcast(detail.social);
  });
}

export function useSocialMode(): boolean {
  const [on, setOn] = useState<boolean>(cached ?? socialHost() === 'phone');

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
