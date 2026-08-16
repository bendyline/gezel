import { randomUUID } from 'node:crypto';
import type { StorageJob, StorageJobKind, StorageJobPhase } from '@bendyline/gezel';

/**
 * Tracks the one storage operation allowed to run at a time.
 *
 * Cleanup, backup, and restore all walk and rewrite the same directories, so
 * running two at once means one job measuring or archiving a tree the other
 * is deleting. The HTTP layer rejects a second start rather than trying to
 * interleave them, matching how the folder-move worker guards itself.
 */
export class StorageJobManager {
  private readonly jobs = new Map<string, StorageJob>();

  create(kind: StorageJobKind, totals?: { totalItems?: number; totalBytes?: number }): StorageJob {
    const job: StorageJob = {
      id: randomUUID(),
      kind,
      status: 'queued',
      itemsDone: 0,
      totalItems: totals?.totalItems ?? 0,
      bytesDone: 0,
      totalBytes: totals?.totalBytes ?? 0,
      startedAt: new Date().toISOString(),
      restartRequired: false,
      cancelRequested: false,
      skippedExternal: [],
    };
    this.jobs.set(job.id, job);
    return job;
  }

  get(id: string): StorageJob | undefined {
    return this.jobs.get(id);
  }

  hasActive(): boolean {
    for (const job of this.jobs.values()) {
      if (job.status === 'queued' || job.status === 'running') return true;
    }
    return false;
  }

  /**
   * Ask the worker to stop at its next item boundary. Deletion is not undone
   * — whatever already went is gone — so this bounds the damage rather than
   * reversing it, and the job still reports what it freed.
   */
  requestCancel(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;
    if (job.status !== 'queued' && job.status !== 'running') return false;
    job.cancelRequested = true;
    return true;
  }

  update(id: string, patch: Partial<StorageJob>): void {
    const job = this.jobs.get(id);
    if (!job) return;
    Object.assign(job, patch);
  }

  setPhase(id: string, phase: StorageJobPhase, currentLabel?: string): void {
    this.update(id, { phase, currentLabel });
  }

  finish(id: string, outcome: { error?: string; cancelled?: boolean }): void {
    const status = outcome.error ? 'error' : outcome.cancelled ? 'cancelled' : 'done';
    this.update(id, {
      status,
      endedAt: new Date().toISOString(),
      ...(outcome.error ? { error: outcome.error } : {}),
    });
  }
}
