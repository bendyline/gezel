import { useState, useSyncExternalStore } from 'react';
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

export interface UpdateActions {
  /** The shell call in flight, if any. */
  busy: 'install' | 'restart' | null;
  error: string | null;
  install(): void;
  restart(): void;
}

/**
 * The install and restart keys shared by Settings → About and the Home
 * banner. `busy` covers the shell call itself. On macOS the install hands off
 * to Installer.app and the update state reports what happens next, so the key
 * comes back once the installer is open. A Windows install and every restart
 * quit the app, so their "Restarting…" stays until the window goes.
 */
export function useUpdateActions(platform?: string): UpdateActions {
  const [busy, setBusy] = useState<UpdateActions['busy']>(null);
  const [error, setError] = useState<string | null>(null);

  const run = (action: 'install' | 'restart'): void => {
    const bridge = window.__GEZEL__?.update;
    const restart = bridge?.restart;
    const call =
      action === 'install'
        ? bridge && (() => bridge.install())
        : restart && (() => restart());
    setError(null);
    if (!call) {
      setError(
        action === 'install'
          ? 'Installing updates needs the Gezel desktop app.'
          : 'Quit Gezel and open it again to finish updating.',
      );
      return;
    }
    setBusy(action);
    void call()
      .then((result) => {
        if (!result.ok) {
          setError(result.error);
          setBusy(null);
        } else if (action === 'install' && platform === 'darwin') {
          setBusy(null);
        }
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
        setBusy(null);
      });
  };

  return { busy, error, install: () => run('install'), restart: () => run('restart') };
}

/** Test-only: forget the cached state so the next mount re-reads the bridge. */
export function resetUpdateStateForTests(): void {
  current = null;
  started = false;
  listeners.clear();
}
