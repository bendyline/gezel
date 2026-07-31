const RELOAD_MARKER = 'gezel:stale-bundle-reload-at';
const DEFAULT_RELOAD_COOLDOWN_MS = 15_000;

interface StaleBundleRecoveryOptions {
  target?: EventTarget;
  storage?: Pick<Storage, 'getItem' | 'setItem'>;
  reload?: () => void;
  now?: () => number;
  cooldownMs?: number;
}

/**
 * Vite emits `vite:preloadError` when a lazy import points at a chunk that no
 * longer exists. This happens when the UI bundle is replaced while an older
 * page is still open. Reload once so the page picks up the new index and its
 * new content hashes.
 *
 * The session marker prevents a genuinely broken deployment from entering a
 * reload loop. On a second failure during the cooldown, Vite is allowed to
 * surface the original error to the tab boundary.
 */
export function installStaleBundleRecovery(options: StaleBundleRecoveryOptions = {}): () => void {
  const target = options.target ?? window;
  const storage = options.storage ?? window.sessionStorage;
  const reload = options.reload ?? (() => window.location.reload());
  const now = options.now ?? Date.now;
  const cooldownMs = options.cooldownMs ?? DEFAULT_RELOAD_COOLDOWN_MS;
  let reloadRequested = false;

  const handlePreloadError = (event: Event) => {
    // One lazy import can preload several stale files. Suppress all of their
    // errors while the first one is already navigating this document away.
    if (reloadRequested) {
      event.preventDefault();
      return;
    }

    let lastReloadAt = Number.NaN;
    try {
      const storedReloadAt = storage.getItem(RELOAD_MARKER);
      if (storedReloadAt !== null) lastReloadAt = Number(storedReloadAt);
    } catch {
      // Session storage can be unavailable in hardened browser contexts.
    }

    const elapsed = now() - lastReloadAt;
    if (Number.isFinite(lastReloadAt) && elapsed >= 0 && elapsed < cooldownMs) return;

    event.preventDefault();
    reloadRequested = true;
    try {
      storage.setItem(RELOAD_MARKER, String(now()));
    } catch {
      // Reload recovery still works without the loop guard in normal app use.
    }
    reload();
  };

  target.addEventListener('vite:preloadError', handlePreloadError);
  return () => target.removeEventListener('vite:preloadError', handlePreloadError);
}
