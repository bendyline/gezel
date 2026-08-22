const DEFAULT_SLOW_STEP_MS = 5_000;

export interface ShutdownStepOptions {
  warn: (message: string) => void;
  slowStepMs?: number;
}

/**
 * Name a slow service-shutdown await without changing its cleanup semantics.
 *
 * The Electron host owns the hard wall for the complete shutdown. This helper
 * deliberately does not race or abandon an individual step: it reports the
 * active step while the host still has time to finish gracefully, then notes
 * when that slow step eventually settles.
 */
export async function observeShutdownStep<T>(
  name: string,
  action: () => T | Promise<T>,
  options: ShutdownStepOptions,
): Promise<T> {
  const slowStepMs = Math.max(1, options.slowStepMs ?? DEFAULT_SLOW_STEP_MS);
  const startedAt = Date.now();
  let reportedSlow = false;
  const timer = setTimeout(() => {
    reportedSlow = true;
    options.warn(`[service] shutdown step "${name}" is still running after ${slowStepMs}ms`);
  }, slowStepMs);
  timer.unref?.();

  try {
    return await action();
  } finally {
    clearTimeout(timer);
    if (reportedSlow) {
      options.warn(
        `[service] shutdown step "${name}" finished after ${Math.max(0, Date.now() - startedAt)}ms`,
      );
    }
  }
}
