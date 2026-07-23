export interface PreventableQuitEvent {
  preventDefault(): void;
}

export interface QuitCoordinatorOptions {
  shutdown: () => Promise<void>;
  quitAgain: () => void;
  onError?: (error: unknown) => void;
}

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
    void this.opts
      .shutdown()
      .catch((error) => this.opts.onError?.(error))
      .finally(() => {
        this.state = 'complete';
        this.opts.quitAgain();
      });
  }
}
