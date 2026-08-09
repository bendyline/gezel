const DUPLICATE_SIGNAL_WINDOW_MS = 750;

export interface TwoStageSignalHandlerOptions {
  abort: () => void;
  forceExit: (code: number) => void;
  log: (message: string) => void;
  now?: () => number;
  subject?: string;
  duplicateWindowMs?: number;
}

/**
 * Build the two-stage stop handler used by eval CLIs.
 *
 * pnpm/shell process stacks can fan one terminal Ctrl+C back into the child as
 * two near-simultaneous signals. Treat that burst as one stop request so the
 * trial still snapshots and finalizes. A genuinely later second signal keeps
 * the documented force-exit escape hatch.
 */
export function createTwoStageSignalHandler(
  opts: TwoStageSignalHandlerOptions,
): (signal: NodeJS.Signals) => void {
  const now = opts.now ?? Date.now;
  const duplicateWindowMs = opts.duplicateWindowMs ?? DUPLICATE_SIGNAL_WINDOW_MS;
  const subject = opts.subject ?? 'current trial';
  let firstHitAt: number | null = null;

  return (signal) => {
    const hitAt = now();
    if (firstHitAt === null) {
      firstHitAt = hitAt;
      opts.log(
        `\n[evals] ${signal} received — aborting ${subject} gracefully (Ctrl+C again after cleanup starts to force-exit)`,
      );
      opts.abort();
      return;
    }
    if (hitAt - firstHitAt < duplicateWindowMs) {
      opts.log(`[evals] duplicate ${signal} during stop propagation ignored; cleanup continues`);
      return;
    }
    opts.log('[evals] second signal — forcing exit');
    opts.forceExit(130);
  };
}

export function installEvalSignalHandlers(subject = 'current trial'): AbortController {
  const controller = new AbortController();
  const handler = createTwoStageSignalHandler({
    abort: () => controller.abort(),
    forceExit: (code) => process.exit(code),
    log: (message) => console.error(message),
    subject,
  });
  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
  return controller;
}
