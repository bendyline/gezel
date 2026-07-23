import { EventEmitter } from 'node:events';

/**
 * Progress states the system-toolset bootstrap moves through. Rendered as
 * pills in the Home screen HealthPanel and streamed to subscribers via
 * `GET /api/system-toolsets/status`.
 */
export type SystemBootstrapPhase =
  | 'idle'
  | 'installing-toolsets'
  | 'downloading-browser'
  | 'ready'
  /**
   * Terminal state when the shipped manifest is entirely placeholders
   * (dev build before the pin step runs) — we didn't install anything,
   * but also didn't fail. Not green: any gezel flow that depends on a
   * system toolset (Playwright, the Copilot SDK) would fail silently
   * if the UI reported "ready" here, so we surface the gap explicitly.
   */
  | 'setup-incomplete'
  | 'error';

export interface SystemBootstrapStatus {
  phase: SystemBootstrapPhase;
  /** Toolset ID currently being installed, when `phase==='installing-toolsets'`. */
  currentToolset?: string;
  /** Chromium download progress, when `phase==='downloading-browser'`. */
  browserProgress?: {
    bytesDownloaded: number;
    bytesTotal: number | null;
  };
  /** Human-readable error, when `phase==='error'`. */
  error?: string;
  /** ISO timestamp of the latest transition. */
  updatedAt: string;
}

/**
 * Tiny pub-sub for bootstrap status — subscribers get the current state on
 * subscription (so a late SSE connection doesn't miss the already-ready
 * signal) and every subsequent transition.
 */
export class SystemStatusBus {
  private readonly emitter = new EventEmitter();
  private state: SystemBootstrapStatus = {
    phase: 'idle',
    updatedAt: new Date().toISOString(),
  };

  get current(): SystemBootstrapStatus {
    return this.state;
  }

  publish(next: Omit<SystemBootstrapStatus, 'updatedAt'>): void {
    this.state = { ...next, updatedAt: new Date().toISOString() };
    this.emitter.emit('status', this.state);
  }

  subscribe(listener: (status: SystemBootstrapStatus) => void): () => void {
    listener(this.state);
    this.emitter.on('status', listener);
    return () => {
      this.emitter.off('status', listener);
    };
  }
}
