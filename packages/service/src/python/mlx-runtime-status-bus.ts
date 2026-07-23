import { EventEmitter } from 'node:events';

/**
 * Lifecycle of the lazy `mlx` Python venv that backs the MLX chat provider.
 *
 *   - `idle`: nothing happening yet — either MLX has never been picked,
 *     or the venv exists and no work is in flight.
 *   - `provisioning`: a chat turn just hit `buildMlxProvider`, the venv
 *     was missing or stale, and `uvRuntime.ensureVenv(...)` is currently
 *     running (uv resolving + downloading torch / mlx-vlm wheels).
 *     First-install on a clean machine takes 1–5 minutes; the user sees
 *     no chat output until this finishes.
 *   - `ready`: the venv is provisioned and the provider is usable.
 *   - `error`: the last `ensureVenv` attempt threw; chat will keep
 *     surfacing the same actionable error until it succeeds.
 *
 * Surfaced as a single header pill in the UI so users get a visible
 * "MLX is still warming up" signal instead of staring at a hung chat.
 */
export type MlxRuntimePhase = 'idle' | 'provisioning' | 'ready' | 'error';

export interface MlxRuntimeStatus {
  phase: MlxRuntimePhase;
  /** Optional human-readable message for the pill / tooltip. */
  message?: string;
  /** Populated when `phase === 'error'`. */
  error?: string;
  /** ISO timestamp of the latest transition. */
  updatedAt: string;
}

/**
 * Tiny pub-sub for the MLX venv lifecycle. Same shape as
 * `SystemStatusBus` so the SSE endpoint and client can mirror that
 * pattern. Subscribers receive the current state on subscription.
 */
export class MlxRuntimeStatusBus {
  private readonly emitter = new EventEmitter();
  private state: MlxRuntimeStatus = {
    phase: 'idle',
    updatedAt: new Date().toISOString(),
  };

  get current(): MlxRuntimeStatus {
    return this.state;
  }

  publish(next: Omit<MlxRuntimeStatus, 'updatedAt'>): void {
    this.state = { ...next, updatedAt: new Date().toISOString() };
    this.emitter.emit('status', this.state);
  }

  subscribe(listener: (status: MlxRuntimeStatus) => void): () => void {
    listener(this.state);
    this.emitter.on('status', listener);
    return () => {
      this.emitter.off('status', listener);
    };
  }
}
