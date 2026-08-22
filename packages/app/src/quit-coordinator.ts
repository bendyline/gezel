export interface PreventableQuitEvent {
  preventDefault(): void;
}

export interface QuitCoordinatorOptions {
  shutdown: () => Promise<void>;
  quitAgain: () => void;
  onError?: (error: unknown) => void;
  /**
   * Last-resort wall for graceful cleanup. The second quit is allowed through
   * after this even when an owned in-process service never settles.
   */
  shutdownTimeoutMs?: number;
}

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;

/**
 * Electron does not await promises returned by `before-quit` listeners.
 * Intercept the first quit, perform shutdown exactly once, then issue a
 * second quit that is allowed through. Repeated quit requests while cleanup
 * is running are prevented and coalesced.
 */
export class QuitCoordinator {
  private state: 'idle' | 'shutting-down' | 'complete' = 'idle';

  constructor(private readonly opts: QuitCoordinatorOptions) {}

  handleBeforeQuit(event: PreventableQuitEvent): void {
    if (this.state === 'complete') return;
    event.preventDefault();
    if (this.state === 'shutting-down') return;

    this.state = 'shutting-down';
    const timeoutMs = Math.max(1, this.opts.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        reject(new Error(`graceful shutdown timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timeout.unref?.();
    });
    // Promise.race observes the shutdown promise even when the deadline wins,
    // so a later rejection cannot become an unhandled rejection while the
    // final Electron quit is in flight.
    void Promise.race([this.opts.shutdown(), deadline])
      .catch((error) => this.opts.onError?.(error))
      .finally(() => {
        if (timeout) clearTimeout(timeout);
        this.state = 'complete';
        this.opts.quitAgain();
      });
  }
}
