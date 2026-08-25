import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type {
  CodeReview,
  CodeReviewKind,
  CodeReviewManifest,
  CodeReviewRecord,
  ProjectDetail,
  Task,
} from '@bendyline/gezel';
import {
  CodeReviewRecordSchema,
  KeyedLock,
  createLogger,
  nowIso,
  parseTaskRef,
} from '@bendyline/gezel';
import type { CatalogService } from '@bendyline/gezel-catalog';
import { projectCodeReviewsFile } from '@bendyline/gezel/paths';
import type { ChatManager } from '../chat/manager.js';
import { writeFileAtomic } from '../fs/atomic.js';
import type { Store } from '../fs/store.js';
import type { HistoryManager } from '../history/manager.js';
import type { ContentIndex } from '../index-store/content-index.js';
import { dispatchTaskEntry } from '../tasks/entry-dispatch.js';
import type { TaskManager } from '../tasks/manager.js';
import type { TaskRunner } from '../tasks/runner.js';
import type { WorkspaceIndexManager } from '../workspace/index-manager.js';
import type { GitManager, GitReviewSnapshot } from './manager.js';
import { createReviewTask } from './review-task.js';

const log = createLogger('git');

/** Records kept per project; older rows are pruned (their artifact folders stay on disk). */
const MAX_REVIEW_RECORDS = 50;

/** Cap on the pre-dispatch content-index refresh — never stall a review on a cold index. */
const INDEX_REFRESH_TIMEOUT_MS = 120_000;

export class ReviewInProgressError extends Error {
  constructor(readonly review: CodeReviewRecord) {
    super('A review of that kind is already running — one at a time.');
    this.name = 'ReviewInProgressError';
  }
}

export interface CodeReviewManagerDeps {
  home: string;
  store: Store;
  git: GitManager;
  tasks: TaskManager;
  taskRunner: TaskRunner;
  history?: HistoryManager;
  catalog: CatalogService;
  chat: ChatManager;
  contentIndex: ContentIndex;
  workspaceIndex: WorkspaceIndexManager;
}

interface CodeReviewsFile {
  version: 1;
  reviews: CodeReviewRecord[];
}

/**
 * Owns the durable per-project code-review records
 * (`~/.gezel/projects/{id}/code-reviews.json`) and the kickoff
 * orchestration: snapshot the change set into artifacts, create the
 * review task (craftbook or inline fallback), persist the record, then —
 * off the request path — refresh the content index and dispatch.
 *
 * Locking mirrors the finding-lifecycle pattern: a per-project promise
 * chain serializes record mutations. Task-side calls that can re-enter
 * via the settle hook (`tasks.setStatus`) are deliberately made OUTSIDE
 * the record lock.
 */
export class CodeReviewManager {
  private readonly locks = new KeyedLock();

  constructor(private readonly deps: CodeReviewManagerDeps) {}

  /**
   * Kick off a review. Synchronous part (the HTTP response): concurrency
   * guard → git snapshot → artifacts written → task created → record
   * persisted. Background part: index refresh (bounded) → entry dispatch.
   */
  async start(project: ProjectDetail, kind: CodeReviewKind): Promise<CodeReviewRecord> {
    const { record, task } = await this.mutate(project.id, async (reviews) => {
      await this.reconcileLocked(project.id, reviews);
      const running = reviews.find((r) => r.kind === kind && r.status === 'running');
      if (running) throw new ReviewInProgressError(running);

      const snapshot =
        kind === 'commit'
          ? await this.deps.git.snapshotWorkingChanges(project)
          : await this.deps.git.snapshotBranchDiff(project);
      const reviewId = newReviewId(kind);
      const dir = `reviews/${reviewId}`;
      const manifestPath = `${dir}/manifest.json`;
      const diffPath = `${dir}/changes.diff`;
      const reportPath = `${dir}/report.md`;
      const manifest = manifestFromSnapshot(project.id, reviewId, snapshot);
      await this.deps.store.writeProjectArtifact(
        project.id,
        manifestPath,
        `${JSON.stringify(manifest, null, 2)}\n`,
      );
      await this.deps.store.writeProjectArtifact(project.id, diffPath, snapshot.diff);

      const created = await createReviewTask(
        {
          store: this.deps.store,
          catalog: this.deps.catalog,
          chat: this.deps.chat,
          tasks: this.deps.tasks,
        },
        {
          projectId: project.id,
          reviewId,
          kind,
          branch: snapshot.branch,
          ...(kind === 'pr' ? { defaultBranch: snapshot.baseRef.replace(/^origin\//, '') } : {}),
          manifestPath,
          diffPath,
          reportPath,
        },
      );

      const rec: CodeReviewRecord = {
        id: reviewId,
        kind,
        status: 'running',
        createdAt: nowIso(),
        taskRef: created.task.ref,
        gezelId: created.gezelId,
        branch: snapshot.branch,
        headSha: snapshot.headSha,
        baseRef: snapshot.baseRef,
        baseSha: snapshot.baseSha,
        filesChanged: snapshot.totalFiles,
        ...(sumStat(snapshot, 'additions') !== undefined
          ? { additions: sumStat(snapshot, 'additions') }
          : {}),
        ...(sumStat(snapshot, 'deletions') !== undefined
          ? { deletions: sumStat(snapshot, 'deletions') }
          : {}),
        ...(snapshot.commits ? { commitCount: snapshot.commits.length } : {}),
        filesTruncated: snapshot.filesTruncated,
        diffTruncated: snapshot.diffTruncated,
        manifestPath,
        diffPath,
        reportPath,
      };
      reviews.unshift(rec);
      return { record: { record: rec, task: created.task }, changed: true };
    });

    this.deps.history
      ?.log({
        kind: 'project.review.requested',
        projectId: project.id,
        ...(record.gezelId ? { gezelId: record.gezelId } : {}),
        summary: `Code review requested (${kind}) — ${record.filesChanged} file(s) on ${record.branch}`,
        details: {
          reviewId: record.id,
          kind,
          taskRef: record.taskRef,
          filesChanged: record.filesChanged,
          branch: record.branch,
          ...(record.baseRef ? { baseRef: record.baseRef } : {}),
        },
      })
      .catch(() => {});

    // Off the request path: freshen the content index the reviewer's
    // code-intel tools read (bounded — the mtime+size gate makes a warm
    // tree cheap), then dispatch the entry step.
    void (async () => {
      await Promise.race([
        this.deps.contentIndex.refresh(project.id).catch(() => null),
        new Promise((resolve) => {
          const t = setTimeout(resolve, INDEX_REFRESH_TIMEOUT_MS);
          t.unref?.();
        }),
      ]);
      void this.deps.workspaceIndex.refresh(project.id);
      await dispatchTaskEntry(
        { store: this.deps.store, taskRunner: this.deps.taskRunner, history: this.deps.history },
        task,
      );
    })().catch((err) => {
      log.warn(`[git] review ${record.id} background dispatch failed: ${String(err)}`);
    });

    return record;
  }

  /** All records, newest first, lazily reconciled against live task state. */
  async list(projectId: string): Promise<CodeReviewRecord[]> {
    return this.mutate(projectId, async (reviews) => {
      const changed = await this.reconcileLocked(projectId, reviews);
      return { record: [...reviews], changed };
    });
  }

  async get(projectId: string, reviewId: string): Promise<CodeReviewRecord | null> {
    const all = await this.list(projectId);
    return all.find((r) => r.id === reviewId) ?? null;
  }

  /**
   * Stop a running review. Idempotent. The task cancellation happens
   * OUTSIDE the record lock (its settle hook re-enters `settleForTask`);
   * the explicit settle after it makes the flip visible even if the hook
   * lost a race with a crash.
   */
  async cancel(project: ProjectDetail, reviewId: string): Promise<CodeReviewRecord> {
    const existing = await this.get(project.id, reviewId);
    if (!existing) throw new Error(`No review ${reviewId} in project ${project.id}.`);
    if (existing.status !== 'running') return existing;
    const parsed = parseTaskRef(existing.taskRef);
    if (parsed) {
      await this.deps.tasks
        .setStatus(parsed.projectId, parsed.num, 'canceled')
        .catch((err) => log.warn(`[git] cancel review ${reviewId}: ${String(err)}`));
    }
    await this.settleForTask(project.id, existing.taskRef, 'canceled');
    return (await this.get(project.id, reviewId)) ?? existing;
  }

  /**
   * Terminal-task hook target (composed into `tasks.setTaskSettledHook`).
   * Flips the matching running record; complete additionally verifies the
   * report landed. Returns how many records changed.
   */
  async settleForTask(
    projectId: string,
    taskRef: string,
    outcome: 'complete' | 'canceled',
  ): Promise<number> {
    return this.mutate(projectId, async (reviews) => {
      let changed = 0;
      for (const rec of reviews) {
        if (rec.taskRef !== taskRef || rec.status !== 'running') continue;
        rec.status = outcome;
        rec.outcome = outcome;
        rec.settledAt = nowIso();
        changed++;
        this.deps.history
          ?.log({
            kind: 'project.review.settled',
            projectId,
            ...(rec.gezelId ? { gezelId: rec.gezelId } : {}),
            summary: `Code review ${rec.id} ${outcome === 'complete' ? 'finished' : 'stopped'}`,
            details: { reviewId: rec.id, kind: rec.kind, taskRef, outcome },
          })
          .catch(() => {});
      }
      return { record: changed, changed: changed > 0 };
    });
  }

  /** Join live task state onto a record for the wire (best-effort). */
  async enrich(projectId: string, record: CodeReviewRecord): Promise<CodeReview> {
    const out: CodeReview = { ...record };
    if (record.gezelId) {
      const gezel = await this.deps.store.getGezel(record.gezelId).catch(() => null);
      if (gezel?.name) out.assigneeName = gezel.name;
    }
    if (record.status !== 'running') return out;
    const task = await this.deps.tasks.getByRef(record.taskRef).catch(() => null);
    if (!task) return out;
    out.taskStatus = task.status;
    if (task.status === 'paused') out.needsAttention = true;
    const steps = task.craftbook.steps;
    out.stepsTotal = steps.length;
    out.stepsComplete = steps.filter((s) => s.completedAt).length;
    const active = steps.find((s) => s.id === task.activeStepId);
    if (active?.name) out.activeStepName = active.name;
    return out;
  }

  /**
   * Heal records whose task moved without us: task gone → `error`; task
   * terminal (the settle hook lost a crash race) → settled with that
   * outcome. Runs inside the record lock; returns whether anything changed.
   */
  private async reconcileLocked(projectId: string, reviews: CodeReviewRecord[]): Promise<boolean> {
    let changed = false;
    for (const rec of reviews) {
      if (rec.status !== 'running') continue;
      const task: Task | null = await this.deps.tasks.getByRef(rec.taskRef).catch(() => null);
      if (!task) {
        rec.status = 'error';
        rec.error = 'The review task was deleted.';
        rec.settledAt = nowIso();
        changed = true;
        continue;
      }
      if (task.status === 'complete' || task.status === 'canceled') {
        rec.status = task.status;
        rec.outcome = task.status;
        rec.settledAt = nowIso();
        changed = true;
      }
    }
    return changed;
  }

  private async readRecords(projectId: string): Promise<CodeReviewRecord[]> {
    const file = projectCodeReviewsFile(this.deps.home, projectId);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(file, 'utf8'));
    } catch {
      return [];
    }
    const raw = (parsed as { reviews?: unknown } | null)?.reviews;
    if (!Array.isArray(raw)) return [];
    const out: CodeReviewRecord[] = [];
    for (const row of raw) {
      const res = CodeReviewRecordSchema.safeParse(row);
      if (res.success) out.push(res.data);
    }
    return out;
  }

  private async writeRecords(projectId: string, reviews: CodeReviewRecord[]): Promise<void> {
    const body: CodeReviewsFile = { version: 1, reviews: reviews.slice(0, MAX_REVIEW_RECORDS) };
    await writeFileAtomic(
      projectCodeReviewsFile(this.deps.home, projectId),
      `${JSON.stringify(body, null, 2)}\n`,
    );
  }

  /**
   * Per-project read → mutate → conditional-write under a promise-chain
   * lock. `fn` mutates the array in place and reports whether to persist.
   */
  private async mutate<T>(
    projectId: string,
    fn: (reviews: CodeReviewRecord[]) => Promise<{ record: T; changed: boolean }>,
  ): Promise<T> {
    return this.locks.run(projectId, async () => {
      const reviews = await this.readRecords(projectId);
      const { record, changed } = await fn(reviews);
      if (changed) await this.writeRecords(projectId, reviews);
      return record;
    });
  }
}

function newReviewId(kind: CodeReviewKind): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `${kind}-${stamp}-${randomBytes(2).toString('hex')}`;
}

function manifestFromSnapshot(
  projectId: string,
  reviewId: string,
  s: GitReviewSnapshot,
): CodeReviewManifest {
  return {
    version: 1,
    reviewId,
    kind: s.kind,
    projectId,
    createdAt: nowIso(),
    branch: s.branch,
    headSha: s.headSha,
    baseRef: s.baseRef,
    baseSha: s.baseSha,
    files: s.files,
    totalFiles: s.totalFiles,
    filesTruncated: s.filesTruncated,
    diffFile: 'changes.diff',
    diffChars: s.diff.length,
    diffTruncated: s.diffTruncated,
    ...(s.commits ? { commits: s.commits } : {}),
    ...(s.commitsTruncated !== undefined ? { commitsTruncated: s.commitsTruncated } : {}),
    notes: s.notes,
  };
}

function sumStat(s: GitReviewSnapshot, key: 'additions' | 'deletions'): number | undefined {
  let any = false;
  let total = 0;
  for (const f of s.files) {
    const v = f[key];
    if (typeof v === 'number') {
      any = true;
      total += v;
    }
  }
  return any ? total : undefined;
}
