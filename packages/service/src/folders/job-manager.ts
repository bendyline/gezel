import { randomUUID } from 'node:crypto';
import type { FolderScope } from './scope.js';

export type MoveJobStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled';
export type MoveJobPhase = 'scan' | 'backup' | 'copy' | 'verify' | 'swap' | 'cleanup' | 'prune';

export interface MoveJob {
  id: string;
  scope: FolderScope;
  sourcePath: string;
  destPath: string;
  conflictPolicy: 'overwrite-all' | 'skip-all';
  status: MoveJobStatus;
  phase?: MoveJobPhase;
  filesDone: number;
  totalFiles: number;
  bytesDone: number;
  totalBytes: number;
  startedAt: string;
  endedAt?: string;
  error?: string;
  /** True when the job's final config-swap phase succeeded — UI uses
   *  this to surface the "Restart now" button. */
  restartRequired: boolean;
  /** Set when the move has been cancelled and the worker should stop
   *  at the next phase boundary. The worker loops check this. */
  cancelRequested: boolean;
}

export class JobManager {
  private readonly jobs = new Map<string, MoveJob>();

  create(input: Pick<MoveJob, 'scope' | 'sourcePath' | 'destPath' | 'conflictPolicy'>): MoveJob {
    const id = randomUUID();
    const job: MoveJob = {
      id,
      scope: input.scope,
      sourcePath: input.sourcePath,
      destPath: input.destPath,
      conflictPolicy: input.conflictPolicy,
      status: 'queued',
      filesDone: 0,
      totalFiles: 0,
      bytesDone: 0,
      totalBytes: 0,
      startedAt: new Date().toISOString(),
      restartRequired: false,
      cancelRequested: false,
    };
    this.jobs.set(id, job);
    return job;
  }

  get(id: string): MoveJob | undefined {
    return this.jobs.get(id);
  }

  /** True when at least one job is in `queued` or `running` state. The
   *  HTTP layer rejects new moves while a job is active to keep semantics
   *  simple — only one externalization in flight at a time. */
  hasActive(): boolean {
    for (const j of this.jobs.values()) {
      if (j.status === 'queued' || j.status === 'running') return true;
    }
    return false;
  }

  /** Best-effort cancel: sets the flag, returns true when the job is in
   *  a state where the worker can honour it. Cancellation past the swap
   *  phase is ignored (rolling back a partial config swap is worse than
   *  finishing). */
  requestCancel(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;
    if (job.status !== 'queued' && job.status !== 'running') return false;
    if (job.phase === 'swap' || job.phase === 'cleanup' || job.phase === 'prune') return false;
    job.cancelRequested = true;
    return true;
  }

  /** Mutate a job in-place. Centralized so the worker doesn't need to
   *  know about Map identity. */
  update(id: string, patch: Partial<MoveJob>): void {
    const job = this.jobs.get(id);
    if (!job) return;
    Object.assign(job, patch);
  }
}
