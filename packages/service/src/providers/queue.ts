/**
 * The provider queue lives in core so the daemon and the phone runtime
 * schedule with one implementation; see
 * `packages/core/src/runtime/provider-queue.ts`. This module is the
 * service's import point and keeps the one piece that reads the process
 * environment.
 */

import { DEFAULT_AMBIENT_QUIET_MS } from '@bendyline/gezel/runtime';

export {
  AbortedWhileQueuedError,
  DEFAULT_AMBIENT_QUIET_MS,
  ProviderQueue,
  QUEUE_WAIT_NOTICE_DELAY_MS,
  QUEUE_WAIT_NOTICE_REPEAT_MS,
  backgroundLaneCap,
  runInQueue,
} from '@bendyline/gezel/runtime';
export type {
  EnqueueRequest,
  Lane,
  ProviderQueueOptions,
  QueueSnapshot,
  QueueWaitOpts,
} from '@bendyline/gezel/runtime';

/**
 * Ambient quiet window for local engine queues. Override with
 * `GEZEL_AMBIENT_QUIET_MS` (milliseconds; `0` disables ambient gating
 * entirely).
 */
export function defaultAmbientQuietMs(): number {
  const raw = process.env.GEZEL_AMBIENT_QUIET_MS;
  if (raw !== undefined) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return DEFAULT_AMBIENT_QUIET_MS;
}
