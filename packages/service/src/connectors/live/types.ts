/**
 * The contract for connectors that drive local hardware (`driver: 'device'`).
 * Where a synced connector is a pass — list, fetch, write, close — a device
 * connector is a loop that runs until it is told to stop: a camera watching
 * a room. The live host owns starting, stopping, retrying, and reporting;
 * an adapter owns only its hardware and what it does with what it senses.
 */

import type {
  ConnectorTypeManifest,
  LiveBindingStatus,
  Project,
  ProjectConnectorBinding,
} from '@bendyline/gezel';

export interface LiveRunContext {
  project: Project;
  binding: ProjectConnectorBinding;
  manifest: ConnectorTypeManifest;
  /** Artifact-relative corpus root (`data/<name>`). */
  corpusDir: string;
  /** The binding's display name, for status lines and event records. */
  label: string;
  /** Aborted when the binding must stop (paused, unbound, emergency stop, shutdown). */
  signal: AbortSignal;
  /** Merge into the binding's live status; the host publishes changes. */
  report(patch: Partial<LiveBindingStatus>): void;
  /** Proof of life (a frame arrived). Silence past the adapter's limit restarts it. */
  heartbeat(): void;
  /** Whether autonomous model work (a vision review) may run right now. */
  reviewAllowed(): boolean;
}

export interface LiveAdapter {
  /**
   * Run until `ctx.signal` aborts, then resolve. Throw (or reject) when the
   * hardware fails; the host shows the message and retries with backoff.
   */
  run(ctx: LiveRunContext): Promise<void>;
  /** Longest silence between heartbeats before the host restarts the run. */
  readonly heartbeatTimeoutMs: number;
}

/** A failure whose message is already plain language for the person. */
export class LiveAdapterError extends Error {
  constructor(
    message: string,
    /** Retrying cannot help until the person changes something. */
    readonly needsAttention = false,
  ) {
    super(message);
    this.name = 'LiveAdapterError';
  }
}
