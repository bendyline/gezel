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
 * the deliverables as they stood before the review (`before/`, listed in
 * `before.json`), what the reviewer said, and which deliverables the reviewer
 * itself changed, so the analysis can judge the work before and after one
 * review. The same copy lets the task finish on the work that passed when the
 * revision cannot (`createOutcomeReviewRestore`).
 */
import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
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
import { type OutcomeReviewRestore, type OutcomeReviewer, stepOwnerGezelId } from './manager.js';

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
  /** Where the file is, relative to its drawer, with `/` on every platform. */
  rel: string;
  drawer: 'artifacts' | 'workspace';
  abs: string;
}

interface DeliverableSet {
  files: DeliverableFile[];
  /** False when a file was left out for its size or the file cap. */
  complete: boolean;
}

/** What a snapshot folder holds: `<drawer>/<rel>` keys, and whether that is every deliverable file. */
interface SnapshotManifest {
  files: string[];
  complete: boolean;
}

const fileKey = (file: Pick<DeliverableFile, 'drawer' | 'rel'>) => `${file.drawer}/${file.rel}`;

export function createOutcomeReviewer(deps: Deps): OutcomeReviewer {
  return async ({ projectId, task, step, round, mode }) => {
    const contract = task.craftbook.contract;
    if (!contract) return { kind: 'pass' };
    const recordDir = reviewRecordDir(task, round);
    const { files, complete } = await deliverableFiles(deps.store, projectId, task);
    await snapshot(deps.store, projectId, `${recordDir}/before`, files, complete);

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
    const after = await hashFiles((await deliverableFiles(deps.store, projectId, task)).files);
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

function reviewRecordDir(task: Pick<Task, 'num'>, round: number): string {
  return `${PROJECT_OUTCOME_REVIEW_DIR_NAME}/${task.num}/round-${round}`;
}

async function deliverableFiles(
  store: Store,
  projectId: string,
  task: Task,
): Promise<DeliverableSet> {
  const contract = task.craftbook.contract;
  if (!contract) return { files: [], complete: true };
  const artifactsRoot = store.projectArtifactsDir(projectId);
  const workspaceRoot = await store.projectWorkspaceDir(projectId);
  const out: DeliverableFile[] = [];
  const seen = new Set<string>();
  const state = { complete: true };
  for (const d of contract.deliverables) {
    const drawer = d.artifact ? 'artifacts' : 'workspace';
    const root = d.artifact ? artifactsRoot : workspaceRoot;
    const abs = safeJoin(root, d.path);
    if (!abs) continue;
    for (const file of await walk(abs, state)) {
      const rel = relative(root, file).split(sep).join('/');
      if (seen.has(`${drawer}/${rel}`)) continue;
      if (out.length >= SNAPSHOT_MAX_FILES) return { files: out, complete: false };
      seen.add(`${drawer}/${rel}`);
      out.push({ rel, drawer, abs: file });
    }
  }
  return { files: out, complete: state.complete };
}

async function walk(abs: string, state: { complete: boolean }): Promise<string[]> {
  const info = await stat(abs).catch(() => null);
  if (!info) return [];
  if (info.isFile()) {
    if (info.size <= SNAPSHOT_MAX_FILE_BYTES) return [abs];
    state.complete = false;
    return [];
  }
  if (!info.isDirectory()) return [];
  const out: string[] = [];
  const entries = await readdir(abs, { withFileTypes: true }).catch(() => []);
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (SNAPSHOT_SKIP.has(entry.name)) continue;
    if (out.length >= SNAPSHOT_MAX_FILES) {
      state.complete = false;
      break;
    }
    out.push(...(await walk(join(abs, entry.name), state)));
  }
  return out;
}

/** Copy the files into `<dir>/<drawer>/<rel>` and list them in `<dir>.json`. */
async function snapshot(
  store: Store,
  projectId: string,
  dir: string,
  files: readonly DeliverableFile[],
  complete: boolean,
): Promise<SnapshotManifest> {
  const manifest: SnapshotManifest = { files: [], complete };
  for (const file of files) {
    const bytes = await readFile(file.abs).catch(() => null);
    const written =
      bytes &&
      (await store
        .writeProjectArtifactBinary(projectId, `${dir}/${fileKey(file)}`, bytes)
        .then(() => true)
        .catch((err: unknown) => {
          log.warn(
            `[tasks] outcome review snapshot of ${file.rel} failed: ${err instanceof Error ? err.message : err}`,
          );
          return false;
        }));
    if (written) manifest.files.push(fileKey(file));
    else manifest.complete = false;
  }
  await store
    .writeProjectArtifact(projectId, `${dir}.json`, `${JSON.stringify(manifest, null, 2)}\n`)
    .catch(() => {
      manifest.complete = false;
    });
  return manifest;
}

async function readManifest(
  store: Store,
  projectId: string,
  path: string,
): Promise<SnapshotManifest | null> {
  const text = await store.readProjectArtifact(projectId, path).catch(() => null);
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as Partial<SnapshotManifest>;
    return Array.isArray(parsed.files) && typeof parsed.complete === 'boolean'
      ? {
          files: parsed.files.filter((f): f is string => typeof f === 'string'),
          complete: parsed.complete,
        }
      : null;
  } catch {
    return null;
  }
}

/**
 * Put a snapshot's files back in their drawers and remove deliverable files it
 * does not hold, which the revision added. A file whose bytes already match is
 * left alone.
 */
async function applySnapshot(
  store: Store,
  projectId: string,
  dir: string,
  manifest: SnapshotManifest,
  current: readonly DeliverableFile[],
): Promise<{ restored: string[]; removed: string[] }> {
  const wanted = new Map<string, Buffer>();
  for (const key of manifest.files) {
    const copy = await store.readProjectArtifactBinary(projectId, `${dir}/${key}`);
    if (!copy) throw new Error(`the copy of ${key} is missing`);
    wanted.set(key, copy.data);
  }
  const restored: string[] = [];
  for (const [key, data] of wanted) {
    const drawer = key.startsWith('artifacts/') ? 'artifacts' : 'workspace';
    const rel = key.slice(drawer.length + 1);
    const live = current.find((f) => fileKey(f) === key);
    const now = live ? await readFile(live.abs).catch(() => null) : null;
    if (now?.equals(data)) continue;
    if (drawer === 'artifacts') await store.writeProjectArtifactBinary(projectId, rel, data);
    else await store.writeProjectWorkspaceBinary(projectId, rel, data);
    restored.push(key);
  }
  const removed: string[] = [];
  for (const file of current) {
    if (wanted.has(fileKey(file))) continue;
    if (file.drawer === 'artifacts') await store.deleteProjectArtifact(projectId, file.rel);
    else await store.rmProjectWorkspacePath(projectId, file.rel);
    removed.push(fileKey(file));
  }
  return { restored, removed };
}

/**
 * Sets the revision after a review aside and puts back the deliverables as
 * they stood before it, which had passed the contract checks. The revision is
 * kept in `round-<n>/revision/`, and `undo` puts it back. Refuses, changing
 * nothing, when either copy would be incomplete.
 */
export function createOutcomeReviewRestore(deps: { store: Store }): OutcomeReviewRestore {
  return async ({ projectId, task, round }) => {
    const recordDir = reviewRecordDir(task, round);
    const before = await readManifest(deps.store, projectId, `${recordDir}/before.json`);
    if (!before) return { refused: 'there is no record of the work before the review' };
    if (!before.complete) return { refused: 'the copy from before the review is incomplete' };
    const current = await deliverableFiles(deps.store, projectId, task);
    if (!current.complete) return { refused: 'the revised work is too large to set aside' };
    const revision = await snapshot(
      deps.store,
      projectId,
      `${recordDir}/revision`,
      current.files,
      current.complete,
    );
    if (!revision.complete) return { refused: 'the revised work could not be set aside' };
    const touchesWorkspace = [...before.files, ...revision.files].some((key) =>
      key.startsWith('workspace/'),
    );
    if (touchesWorkspace && !(await deps.store.assertWorkspaceWritable(projectId)).ok) {
      return { refused: 'the workspace cannot be written' };
    }
    let result: { restored: string[]; removed: string[] };
    try {
      result = await applySnapshot(
        deps.store,
        projectId,
        `${recordDir}/before`,
        before,
        current.files,
      );
    } catch (err) {
      // Never leave a mix of the two copies: put the revision back whole.
      const now = await deliverableFiles(deps.store, projectId, task);
      await applySnapshot(
        deps.store,
        projectId,
        `${recordDir}/revision`,
        revision,
        now.files,
      ).catch((undoErr: unknown) =>
        log.error(
          `[tasks] ${task.ref} could not put the revision back after a failed restore: ${undoErr instanceof Error ? undoErr.message : undoErr}`,
        ),
      );
      return { refused: `restoring failed: ${err instanceof Error ? err.message : err}` };
    }
    await writeRestoreRecord(deps.store, projectId, recordDir, { state: 'restored', ...result });
    return {
      ...result,
      undo: async () => {
        const now = await deliverableFiles(deps.store, projectId, task);
        await applySnapshot(deps.store, projectId, `${recordDir}/revision`, revision, now.files);
        await writeRestoreRecord(deps.store, projectId, recordDir, { state: 'undone', ...result });
      },
    };
  };
}

async function writeRestoreRecord(
  store: Store,
  projectId: string,
  dir: string,
  record: Record<string, unknown>,
): Promise<void> {
  await store
    .writeProjectArtifact(
      projectId,
      `${dir}/restore.json`,
      `${JSON.stringify({ at: new Date().toISOString(), ...record }, null, 2)}\n`,
    )
    .catch((err: unknown) =>
      log.warn(
        `[tasks] outcome review restore record failed: ${err instanceof Error ? err.message : err}`,
      ),
    );
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
