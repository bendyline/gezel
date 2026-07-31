import { describe, expect, it, vi } from 'vitest';
import { installStaleBundleRecovery } from './stale-bundle-recovery.js';

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

describe('installStaleBundleRecovery', () => {
  it('reloads and suppresses the stale lazy-import error once', () => {
    const target = new EventTarget();
    const reload = vi.fn();
    const remove = installStaleBundleRecovery({
      target,
      storage: memoryStorage(),
      reload,
      now: () => 1_000,
    });
    const event = new Event('vite:preloadError', { cancelable: true });

    target.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(reload).toHaveBeenCalledOnce();

    const siblingFailure = new Event('vite:preloadError', { cancelable: true });
    target.dispatchEvent(siblingFailure);
    expect(siblingFailure.defaultPrevented).toBe(true);
    expect(reload).toHaveBeenCalledOnce();
    remove();
  });

  it('lets a repeated failure reach the error boundary instead of reloading forever', () => {
    const firstDocument = new EventTarget();
    const reload = vi.fn();
    const storage = memoryStorage();
    installStaleBundleRecovery({
      target: firstDocument,
      storage,
      reload,
      now: () => 1_000,
    });

    firstDocument.dispatchEvent(new Event('vite:preloadError', { cancelable: true }));

    const reloadedDocument = new EventTarget();
    installStaleBundleRecovery({
      target: reloadedDocument,
      storage,
      reload,
      now: () => 1_000,
    });
    const repeated = new Event('vite:preloadError', { cancelable: true });
    reloadedDocument.dispatchEvent(repeated);

    expect(repeated.defaultPrevented).toBe(false);
    expect(reload).toHaveBeenCalledOnce();
  });
});
