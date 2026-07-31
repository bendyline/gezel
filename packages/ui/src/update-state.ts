import { useSyncExternalStore } from 'react';
import type { UpdateState } from './api.js';

/**
 * One subscription to the Electron shell's update channel, shared by every
 * consumer (the navigation rail, Settings → About, the Home install prompt).
 *
 * The preload bridge's `onStateChanged` registers an `ipcRenderer.on` listener
 * with no way to remove it, so a per-component subscription leaked one
 * listener per mount — and each consumer also re-fetched the state and
 * flickered while it landed. Holding the latest value here keeps mounts free
 * and gives a remounting view the current state synchronously.
 */

let current: UpdateState | null = null;
let started = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function start(): void {
  if (started) return;
  started = true;
  const bridge = window.__GEZEL__?.update;
  if (!bridge) return;
  void bridge
    .state()
    .then((state) => {
      // A pushed update that arrived while the initial pull was in flight is
      // newer than what the pull returns — don't overwrite it.
      if (state && !current) {
        current = state;
        emit();
      }
    })
    .catch(() => {
      /* no update channel — the notice surfaces simply say nothing */
    });
  bridge.onStateChanged((state) => {
    current = state;
    emit();
  });
}

function subscribe(listener: () => void): () => void {
  start();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function snapshot(): UpdateState | null {
  return current;
}

export function useUpdateState(): UpdateState | null {
  return useSyncExternalStore(subscribe, snapshot);
}

/** Test-only: forget the cached state so the next mount re-reads the bridge. */
export function resetUpdateStateForTests(): void {
  current = null;
  started = false;
  listeners.clear();
}
