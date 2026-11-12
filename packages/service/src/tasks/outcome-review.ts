/**
 * The outcome review: once an outcome task's contract checks pass, either
 * the owner is asked to review its own deliverables (`self`) or the owner
 * reviews them again in a new read-only session with no transcript
 * (`fresh`, `ChatManager.askFreshEyes`) and its findings go back to the
 * owner's own conversation. Whether a task gets one is decided at
 * create (`resolveOutcomeReview`, core tasks/outcome-review.ts); the counted
 * test behind it is evals/runs/review-counted-2026-11-11/PREREG.md.
 *
 * Every round leaves a record under `artifacts/outcome-review/<num>/round-<n>/`:
 * the deliverables as they stood before the review (`before/`), what the
 * reviewer said, and which deliverables the reviewer itself changed, so the
 * analysis can judge the work before and after one review.
 */
import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import {
  type Task,
  createLogger,
  parseOutcomeReviewVerdict,
  renderFreshReviewBrief,
  renderOutcomeReviewFindings,
  renderSelfReviewMessage,
} from '@bendyline/gezel';
import { safeJoin } from '@bendyline/gezel-inference/internal/fs/safe-paths';
import { PROJECT_OUTCOME_REVIEW_DIR_NAME } from '@bendyline/gezel/paths';
import type { ChatManager } from '../chat/manager.js';
import type { Store } from '../fs/store.js';
import { type OutcomeReviewer, stepOwnerGezelId } from './manager.js';

const log = createLogger('tasks');

/** Long enough for a 27B to read a report and its sources on one engine. */
const FRESH_REVIEW_TIMEOUT_MS = 25 * 60 * 1000;
const SNAPSHOT_MAX_FILES = 200;
const SNAPSHOT_MAX_FILE_BYTES = 1024 * 1024;
const SNAPSHOT_SKIP = new Set(['node_modules', '.git']);

interface Deps {
  store: Store;
  chat: ChatManager;
}

interface DeliverableFile {
  /** Where the file is, relative to its drawer. */
  rel: string;
  drawer: 'artifacts' | 'workspace';
  abs: string;
}

export function createOutcomeReviewer(deps: Deps): OutcomeReviewer {
  return async ({ projectId, task, step, round, mode }) => {
    const contract = task.craftbook.contract;
    if (!contract) return { kind: 'pass' };
    const recordDir = `${PROJECT_OUTCOME_REVIEW_DIR_NAME}/${task.num}/round-${round}`;
    const files = await deliverableFiles(deps.store, projectId, task);
    await snapshot(deps.store, projectId, `${recordDir}/before`, files);

    if (mode === 'self') {
      const message = renderSelfReviewMessage(contract);
      await writeRecord(deps.store, projectId, recordDir, { mode, round, message });
      return { kind: 'hold', message };
    }

    const started = Date.now();
    const ownerGezelId = stepOwnerGezelId(task, step);
    const ownerSessionId = ownerGezelId
      ? await ownerSession(deps.store, ownerGezelId, task.ref)
      : null;
    if (!ownerGezelId || !ownerSessionId) {
      await writeRecord(deps.store, projectId, recordDir, {
        mode,
        round,
        error: 'no owner session to review for',
      });
      return { kind: 'pass' };
    }
    const before = await hashFiles(files);
    const answer = await deps.chat.askFreshEyes({
      gezelId: ownerGezelId,
      projectId,
      fromSessionId: ownerSessionId,
      text: renderFreshReviewBrief({
        taskRef: task.ref,
        title: task.title,
        request: task.description ?? task.title,
        contract,
      }),
      timeoutMs: FRESH_REVIEW_TIMEOUT_MS,
      subagentFor: { taskRef: task.ref, ownerSessionId },
    });
    const after = await hashFiles(await deliverableFiles(deps.store, projectId, task));
    const changedByReviewer = [...new Set([...before.keys(), ...after.keys()])].filter(
      (key) => before.get(key) !== after.get(key),
    );
    if (answer.outcome !== 'reply') {
      await writeRecord(deps.store, projectId, recordDir, {
        mode,
        round,
        error: `${answer.reason}: ${answer.message}`,
        durationMs: Date.now() - started,
        changedByReviewer,
      });
      return { kind: 'pass' };
    }
    const verdict = parseOutcomeReviewVerdict(answer.text);
    await writeRecord(deps.store, projectId, recordDir, {
      mode,
      round,
      reviewerSessionId: answer.sessionId,
      verdict: verdict.verdict,
      findings: verdict.findings,
      durationMs: Date.now() - started,
      changedByReviewer,
      reply: answer.text,
    });
    // A read-only session cannot change a file; a change here means a tool
    // reached past it, which the record keeps for the analysis.
    if (changedByReviewer.length > 0) {
      log.warn(
        `[tasks] ${task.ref} outcome reviewer changed ${changedByReviewer.length} deliverable file(s): ${changedByReviewer.slice(0, 5).join(', ')}`,
      );
    }
    return verdict.verdict === 'fail'
      ? { kind: 'hold', message: renderOutcomeReviewFindings(verdict.findings) }
      : { kind: 'pass' };
  };
}

/** The most recent session working this task for its owner, not a consultation. */
async function ownerSession(
  store: Store,
  ownerGezelId: string,
  taskRef: string,
): Promise<string | null> {
  const summaries = await store.listSessions({ gezelId: ownerGezelId }).catch(() => []);
  const candidates = summaries
    .filter((s) => s.taskRef === taskRef && !s.archived)
    .sort((a, b) => (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? ''));
  for (const summary of candidates) {
    const record = await store.getSession(ownerGezelId, summary.id).catch(() => null);
    if (record && !record.consultationMode && !record.subagentFor) return record.id;
  }
  return null;
}

async function deliverableFiles(
  store: Store,
  projectId: string,
  task: Task,
): Promise<DeliverableFile[]> {
  const contract = task.craftbook.contract;
  if (!contract) return [];
  const artifactsRoot = store.projectArtifactsDir(projectId);
  const workspaceRoot = await store.projectWorkspaceDir(projectId);
  const out: DeliverableFile[] = [];
  for (const d of contract.deliverables) {
    const drawer = d.artifact ? 'artifacts' : 'workspace';
    const root = d.artifact ? artifactsRoot : workspaceRoot;
    const abs = safeJoin(root, d.path);
    if (!abs) continue;
    for (const file of await walk(abs)) {
      if (out.length >= SNAPSHOT_MAX_FILES) return out;
      out.push({ rel: relative(root, file), drawer, abs: file });
    }
  }
  return out;
}

async function walk(abs: string): Promise<string[]> {
  const info = await stat(abs).catch(() => null);
  if (!info) return [];
  if (info.isFile()) return info.size <= SNAPSHOT_MAX_FILE_BYTES ? [abs] : [];
  if (!info.isDirectory()) return [];
  const out: string[] = [];
  const entries = await readdir(abs, { withFileTypes: true }).catch(() => []);
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (SNAPSHOT_SKIP.has(entry.name) || out.length >= SNAPSHOT_MAX_FILES) continue;
    out.push(...(await walk(join(abs, entry.name))));
  }
  return out;
}

async function snapshot(
  store: Store,
  projectId: string,
  dir: string,
  files: readonly DeliverableFile[],
): Promise<void> {
  for (const file of files) {
    const bytes = await readFile(file.abs).catch(() => null);
    if (!bytes) continue;
    await store
      .writeProjectArtifactBinary(projectId, `${dir}/${file.drawer}/${file.rel}`, bytes)
      .catch((err: unknown) =>
        log.warn(
          `[tasks] outcome review snapshot of ${file.rel} failed: ${err instanceof Error ? err.message : err}`,
        ),
      );
  }
}

async function hashFiles(files: readonly DeliverableFile[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const file of files) {
    const bytes = await readFile(file.abs).catch(() => null);
    if (bytes)
      out.set(`${file.drawer}/${file.rel}`, createHash('sha256').update(bytes).digest('hex'));
  }
  return out;
}

async function writeRecord(
  store: Store,
  projectId: string,
  dir: string,
  record: Record<string, unknown>,
): Promise<void> {
  await store
    .writeProjectArtifact(
      projectId,
      `${dir}/review.json`,
      `${JSON.stringify({ at: new Date().toISOString(), ...record }, null, 2)}\n`,
    )
    .catch((err: unknown) =>
      log.warn(`[tasks] outcome review record failed: ${err instanceof Error ? err.message : err}`),
    );
}
