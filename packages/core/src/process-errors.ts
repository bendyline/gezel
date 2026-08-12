/** The two Node process events that otherwise become fatal stock dialogs. */
export type FatalProcessErrorSource = 'uncaughtException' | 'unhandledRejection';

export interface ProcessErrorEventTarget {
  on(event: FatalProcessErrorSource, listener: (reason: unknown) => void): unknown;
  off(event: FatalProcessErrorSource, listener: (reason: unknown) => void): unknown;
}

export type FatalProcessErrorHandler = (
  error: Error,
  source: FatalProcessErrorSource,
) => void | Promise<void>;

/** Give promise rejections and non-Error throws one stable presentation. */
export function errorFromUnknown(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  if (typeof reason === 'string') return new Error(reason);
  try {
    return new Error(JSON.stringify(reason));
  } catch {
    return new Error(String(reason));
  }
}

/**
 * Register both top-level Node failure channels through one callback.
 *
 * The callback owns termination policy: Electron can show a final dialog,
 * while the headless daemon can stop its listener before exiting.
 */
export function installProcessErrorHandlers(
  target: ProcessErrorEventTarget,
  handler: FatalProcessErrorHandler,
): () => void {
  const onUncaughtException = (reason: unknown) => {
    void handler(errorFromUnknown(reason), 'uncaughtException');
  };
  const onUnhandledRejection = (reason: unknown) => {
    void handler(errorFromUnknown(reason), 'unhandledRejection');
  };
  target.on('uncaughtException', onUncaughtException);
  target.on('unhandledRejection', onUnhandledRejection);
  return () => {
    target.off('uncaughtException', onUncaughtException);
    target.off('unhandledRejection', onUnhandledRejection);
  };
}
