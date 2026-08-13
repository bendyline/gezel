export interface SignalCleanupHost {
  exitCode?: string | number;
  on(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  off(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
}

export interface SignalCleanupOptions {
  host?: SignalCleanupHost;
  onError?: (error: unknown) => void;
}

/**
 * Keep Node's default signal exit from skipping asynchronous owned-resource
 * cleanup. Repeated signals coalesce onto the same promise; the owning
 * operation's normal `finally` may safely call its own idempotent cleanup too.
 */
export function installSignalCleanup(
  cleanup: (() => Promise<void>) | undefined,
  options: SignalCleanupOptions = {},
): () => void {
  if (!cleanup) return () => {};
  const host = options.host ?? process;
  let cleanupPromise: Promise<void> | undefined;
  const onSignal = (signal: 'SIGINT' | 'SIGTERM') => {
    host.exitCode = signal === 'SIGINT' ? 130 : 143;
    cleanupPromise ??= cleanup().catch((error) => {
      options.onError?.(error);
      host.exitCode = 1;
    });
  };
  const onSigint = () => onSignal('SIGINT');
  const onSigterm = () => onSignal('SIGTERM');
  host.on('SIGINT', onSigint);
  host.on('SIGTERM', onSigterm);
  return () => {
    host.off('SIGINT', onSigint);
    host.off('SIGTERM', onSigterm);
  };
}
