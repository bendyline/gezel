import { setTimeout as wait } from 'node:timers/promises';
import type { GezelClient } from '@bendyline/gezel-client/node';

export const DEFAULT_KNOWLEDGE_INSTALL_TIMEOUT_MS = 8 * 60_000;
const DEFAULT_POLL_INTERVAL_MS = 200;
const DEFAULT_PROGRESS_LOG_INTERVAL_MS = 30_000;

function positiveEnvMs(name: string): number | null {
  const raw = process.env[name]?.trim();
  if (!raw) return null;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export interface WaitForKnowledgeInstallOptions {
  label: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  progressLogIntervalMs?: number;
  log?: (line: string) => void;
}

export class KnowledgeInstallTimeoutError extends Error {
  constructor(
    readonly jobId: string,
    readonly timeoutMs: number,
    cancellation: string,
    label: string,
  ) {
    super(`${label} install timed out after ${timeoutMs}ms (job=${jobId}, ${cancellation})`);
    this.name = 'KnowledgeInstallTimeoutError';
  }
}

function describeLastEvent(event: { type: string; [key: string]: unknown } | undefined): string {
  if (!event) return 'none';
  if (event.type !== 'progress') return event.type;
  const phase = typeof event.phase === 'string' ? event.phase : 'unknown';
  const done = typeof event.bytesDone === 'number' ? event.bytesDone : '?';
  const total = typeof event.bytesTotal === 'number' ? event.bytesTotal : '?';
  return `progress:${phase}:${done}/${total}`;
}

/**
 * Wait for a daemon-owned knowledge install without allowing scenario setup
 * to hang forever. The install job outlives a disconnected client, so a
 * timeout must explicitly cancel it before the trial daemon is torn down.
 */
export async function waitForKnowledgeInstall(
  client: GezelClient,
  jobId: string,
  options: WaitForKnowledgeInstallOptions,
): Promise<{ durationMs: number }> {
  const timeoutMs =
    options.timeoutMs ??
    positiveEnvMs('GEZEL_EVAL_KNOWLEDGE_INSTALL_TIMEOUT_MS') ??
    DEFAULT_KNOWLEDGE_INSTALL_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const progressLogIntervalMs = options.progressLogIntervalMs ?? DEFAULT_PROGRESS_LOG_INTERVAL_MS;
  const startedAt = Date.now();
  let nextProgressLogAt = progressLogIntervalMs;

  while (Date.now() - startedAt < timeoutMs) {
    const job = await client.getKnowledgeJob(jobId);
    const elapsedMs = Date.now() - startedAt;
    if (job.finished) {
      if (job.error) throw new Error(`${options.label} install failed: ${job.error}`);
      return { durationMs: elapsedMs };
    }
    if (options.log && elapsedMs >= nextProgressLogAt) {
      const lastEvent = describeLastEvent(job.events.at(-1));
      options.log(
        `[scenario:setup] ${options.label} install still running after ${Math.round(elapsedMs / 1_000)}s (job=${jobId} lastEvent=${lastEvent})`,
      );
      nextProgressLogAt += progressLogIntervalMs;
    }
    await wait(Math.min(pollIntervalMs, Math.max(1, timeoutMs - elapsedMs)));
  }

  const cancellation = await client
    .cancelKnowledgeJob(jobId)
    .then((result) => (result.cancelled ? 'cancelled' : 'already-terminal'))
    .catch((error) => `cancel-failed:${error instanceof Error ? error.message : String(error)}`);
  throw new KnowledgeInstallTimeoutError(jobId, timeoutMs, cancellation, options.label);
}
