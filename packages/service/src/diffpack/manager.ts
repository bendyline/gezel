import { readFile } from 'node:fs/promises';
import {
  type Diffpack,
  type DiffpackFile,
  type DiffpackManifest,
  type DiffpackOrigin,
  type DiffpackOverlap,
  type DiffpackRecord,
  DiffpackRecordSchema,
  type DiffpackStatus,
  createLogger,
  isActiveDiffpackStatus,
  nowIso,
} from '@bendyline/gezel';
import { projectDiffpacksFile } from '@bendyline/gezel/paths';
import { applyPatch, parsePatch } from 'diff';
import { writeFileAtomic } from '../fs/atomic.js';
import type { Store } from '../fs/store.js';
import type { HistoryManager } from '../history/manager.js';
import type { TaskManager } from '../tasks/manager.js';
import { buildWorkspaceEditResult } from '../workspace/edit.js';
import { DiffpackDraftStore, normalizeDraftPath, sha256 } from './draft-store.js';

const log = createLogger('diffpack');

/** Records kept per project; older rows are pruned (their artifact folders stay). */
const MAX_DIFFPACK_RECORDS = 200;

export interface DiffpackManagerDeps {
  home: string;
  store: Store;
  tasks: TaskManager;
  history?: HistoryManager;
}

interface DiffpacksFile {
  version: 1;
  diffpacks: DiffpackRecord[];
}

export class DiffpackNotFoundError extends Error {
  constructor(packId: string) {
    super(`No change proposal ${packId} in this project.`);
    this.name = 'DiffpackNotFoundError';
  }
}

/**
 * A pack targets files that moved since it was sealed. Carried as an error so
 * the route can answer 409 with the specific paths — a model-authored patch
 * that "did not apply cleanly" is a confusing thing to show a user who has no
 * idea the file changed underneath it.
 */
export class DiffpackDriftedError extends Error {
  constructor(readonly paths: string[]) {
    super(`These files changed since the proposal was drafted: ${paths.join(', ')}`);
    this.name = 'DiffpackDriftedError';
  }
}

/**
 * Owns the durable per-project diffpack records
 * (`~/.gezel/projects/{id}/diffpacks.json`) and the pack lifecycle:
 * ensure → draft (via {@link DiffpackDraftStore}) → seal → apply/dismiss.
 *
 * Locking mirrors the code-review and finding-lifecycle pattern: a per-project
 * promise chain serializes record mutations.
 *
 * Drift and overlap are never persisted. Both are functions of the *current*
 * workspace and the *other* live packs, so storing them would need a writer on
 * every external edit — and the one that mattered would be the edit made
 * outside gezel. They are recomputed on every read instead, the same call the
 * Boekwachter issue's `stale` bit makes.
 */
export class DiffpackManager {
  private readonly locks = new Map<string, Promise<unknown>>();
  /** Packs this process has already confirmed a record for. */
  private readonly known = new Set<string>();
  readonly drafts: DiffpackDraftStore;

  constructor(private readonly deps: DiffpackManagerDeps) {
    this.drafts = new DiffpackDraftStore(deps.store);
  }

  /* ─── Lifecycle ──────────────────────────────────────────────────── */

  /**
   * Register a pack the moment its drafting task exists, so the pack is
   * visible (as `drafting`) while the gezel works rather than appearing from
   * nowhere when the task settles. Idempotent on `packId`.
   */
  async ensure(
    projectId: string,
    packId: string,
    init: {
      title: string;
      origin: DiffpackOrigin;
      taskRef: string;
      gezelId?: string;
      gezelName?: string;
      windowKey?: string;
    },
  ): Promise<DiffpackRecord> {
    return this.mutate(projectId, async (packs) => {
      const existing = packs.find((p) => p.packId === packId);
      if (existing) return { record: existing, changed: false };
      const record: DiffpackRecord = {
        packId,
        projectId,
        title: init.title,
        summary: '',
        status: 'drafting',
        origin: init.origin,
        taskRef: init.taskRef,
        ...(init.gezelId ? { gezelId: init.gezelId } : {}),
        ...(init.gezelName ? { gezelName: init.gezelName } : {}),
        ...(init.windowKey ? { windowKey: init.windowKey } : {}),
        files: [],
        notesPath: `diffpacks/${packId}/notes.md`,
        manifestPath: `diffpacks/${packId}/manifest.json`,
        createdAt: nowIso(),
      };
      packs.unshift(record);
      return { record, changed: true };
    });
  }

  /**
   * Make sure a pack record exists for a draft that is about to be written
   * to, deriving its metadata from the task that owns the id.
   *
   * Called lazily from the draft routes rather than eagerly at task-create
   * time because a fanout shard's id is minted when the runtime materializes
   * it, not when the host is planned — and a draft with no record would seal
   * into nothing, silently losing a night of work. Idempotent and guarded by
   * an in-process set so the common case costs nothing.
   */
  async ensureForDraft(projectId: string, packId: string): Promise<void> {
    const key = `${projectId}\u0000${packId}`;
    if (this.known.has(key)) return;
    if (await this.getRecord(projectId, packId)) {
      this.known.add(key);
      return;
    }
    const task = (await this.deps.tasks.list({ projectId }).catch(() => [])).find(
      (t) => t.diffpackId === packId,
    );
    if (!task) {
      log.warn(`[diffpack] draft ${packId} has no owning task in ${projectId}`);
      return;
    }
    const issueRefs =
      task.origin?.kind === 'boekwachter-issue' && task.origin.issueRef
        ? [task.origin.issueRef]
        : [];
    await this.ensure(projectId, packId, {
      title: task.title,
      origin: issueRefs.length > 0 ? { kind: 'boekwachter-issue', issueRefs } : { kind: 'manual' },
      taskRef: task.ref,
      ...(task.assignee.kind === 'gezel' ? { gezelId: task.assignee.gezelId } : {}),
    });
    this.known.add(key);
  }

  /**
   * Turn a finished draft tree into a reviewable pack: diff every drafted
   * file against the workspace as it stands *now*, write the sidecars, record
   * each file's base hash, and flip to `ready`.
   *
   * Identity drafts are dropped rather than sealed — a gezel that opened a
   * file, thought about it, and changed nothing should not produce a pack
   * entry the user has to dismiss.
   */
  async seal(projectId: string, packId: string): Promise<DiffpackRecord> {
    const record = await this.getRecord(projectId, packId);
    if (!record) throw new DiffpackNotFoundError(packId);

    const [drafted, deletions] = await Promise.all([
      this.drafts.listDraftedPaths(projectId, packId),
      this.drafts.listDeletions(projectId, packId),
    ]);

    await this.drafts.clearSidecars(projectId, packId);
    const files: DiffpackFile[] = [];
    let index = 0;
    for (const path of drafted) {
      const after = await this.drafts.read(projectId, packId, path);
      if (after === null) continue;
      const before = await this.deps.store.readProjectWorkspaceFile(projectId, path);
      if (before === after) continue;
      const result = buildWorkspaceEditResult(path, before ?? '', after);
      index += 1;
      const sidecar = `${String(index).padStart(2, '0')}-${slugify(path)}.diff`;
      await this.drafts.writeSidecar(projectId, packId, sidecar, result.diff);
      const diffArtifact = `diffpacks/${packId}/files/${sidecar}`;
      files.push({
        path: normalizeDraftPath(path),
        diffArtifact,
        baseHash: before === null ? '' : sha256(before),
        additions: result.addedLines,
        deletions: result.removedLines,
        change: before === null ? 'add' : 'modify',
      });
    }

    for (const path of deletions) {
      const before = await this.deps.store.readProjectWorkspaceFile(projectId, path);
      if (before === null) continue;
      files.push({
        path,
        diffArtifact: '',
        baseHash: sha256(before),
        additions: 0,
        deletions: before.split('\n').length,
        change: 'delete',
      });
    }

    const summary = await this.summaryFromNotes(projectId, record.notesPath);
    const sealed = await this.mutate(projectId, async (packs) => {
      const draft = packs.find((p) => p.packId === packId);
      if (!draft) throw new DiffpackNotFoundError(packId);
      draft.files = files;
      draft.summary = summary;
      draft.sealedAt = nowIso();
      if (files.length === 0) {
        draft.status = 'failed';
        draft.error = 'The gezel finished without proposing any change.';
      } else {
        draft.status = 'ready';
        delete draft.error;
      }
      return { record: { ...draft }, changed: true };
    });

    await this.writeManifest(projectId, sealed, deletions);
    this.deps.history
      ?.log({
        kind: 'project.diffpack.sealed',
        projectId,
        ...(sealed.gezelId ? { gezelId: sealed.gezelId } : {}),
        summary:
          files.length === 0
            ? `Change proposal DP-${packId} produced no changes`
            : `Change proposal DP-${packId} ready — ${files.length} file(s)`,
        details: { packId, taskRef: sealed.taskRef, files: files.map((f) => f.path) },
      })
      .catch(() => {});
    return sealed;
  }

  /**
   * Terminal-task hook. A completed drafting task seals; a canceled one
   * discards the draft tree, because a half-finished proposal is worse than
   * none — the user cannot tell which parts the gezel stood behind.
   */
  async settleForTask(
    projectId: string,
    taskRef: string,
    outcome: 'complete' | 'canceled',
  ): Promise<number> {
    const packs = await this.readRecords(projectId);
    const affected = packs.filter((p) => p.taskRef === taskRef && p.status === 'drafting');
    for (const pack of affected) {
      if (outcome === 'complete') {
        await this.seal(projectId, pack.packId).catch((err) => {
          log.warn(`[diffpack] seal failed for ${pack.packId}: ${String(err)}`);
        });
        continue;
      }
      await this.drafts.discard(projectId, pack.packId);
      await this.mutate(projectId, async (rows) => {
        const row = rows.find((p) => p.packId === pack.packId);
        if (!row) return { record: null, changed: false };
        row.status = 'failed';
        row.error = 'The drafting task was stopped before it finished.';
        row.sealedAt = nowIso();
        return { record: null, changed: true };
      });
    }
    return affected.length;
  }

  /* ─── Reads ──────────────────────────────────────────────────────── */

  async getRecord(projectId: string, packId: string): Promise<DiffpackRecord | null> {
    return (await this.readRecords(projectId)).find((p) => p.packId === packId) ?? null;
  }

  async list(projectId: string): Promise<Diffpack[]> {
    const records = await this.readRecords(projectId);
    return Promise.all(records.map((record) => this.enrich(projectId, record, records)));
  }

  async get(projectId: string, packId: string): Promise<Diffpack> {
    const records = await this.readRecords(projectId);
    const record = records.find((p) => p.packId === packId);
    if (!record) throw new DiffpackNotFoundError(packId);
    return this.enrich(projectId, record, records);
  }

  /** Join the read-time projections (drift, overlap, live task state). */
  private async enrich(
    projectId: string,
    record: DiffpackRecord,
    siblings: DiffpackRecord[],
  ): Promise<Diffpack> {
    const drifted = await this.driftedPaths(projectId, record);
    const overlaps = overlapsFor(record, siblings);
    const out: Diffpack = {
      ...record,
      drifted,
      overlaps,
      additions: record.files.reduce((n, f) => n + f.additions, 0),
      deletions: record.files.reduce((n, f) => n + f.deletions, 0),
    };
    if (record.status !== 'drafting') return out;
    const task = await this.deps.tasks.getByRef(record.taskRef).catch(() => null);
    if (!task) return out;
    out.taskStatus = task.status;
    if (task.status === 'paused') out.needsAttention = true;
    return out;
  }

  /**
   * Files whose current content no longer hashes to what the pack was drafted
   * against. An `add` whose path now exists counts as drift too — the pack
   * would silently overwrite a file someone else created.
   */
  private async driftedPaths(projectId: string, record: DiffpackRecord): Promise<string[]> {
    if (!isActiveDiffpackStatus(record.status)) return [];
    const out: string[] = [];
    for (const file of record.files) {
      const current = await this.deps.store
        .readProjectWorkspaceFile(projectId, file.path)
        .catch(() => null);
      if (file.change === 'add') {
        if (current !== null) out.push(file.path);
        continue;
      }
      if (current === null || sha256(current) !== file.baseHash) out.push(file.path);
    }
    return out;
  }

  /* ─── Apply / dismiss ────────────────────────────────────────────── */

  /**
   * Apply some or all of a pack to the workspace.
   *
   * `userInitiated` is passed through to the write gate: the gezel never
   * wrote here, so the user's click is the write, and it must succeed on an
   * external folder gezels have no grant for. That is the entire point of the
   * feature — see `Store.assertWorkspaceWritable`.
   */
  async apply(
    projectId: string,
    packId: string,
    opts: { paths?: string[]; allowDrifted?: boolean } = {},
  ): Promise<{ ok: boolean; results: Array<{ path: string; ok: boolean; error?: string }> }> {
    const record = await this.getRecord(projectId, packId);
    if (!record) throw new DiffpackNotFoundError(packId);

    const wanted = opts.paths ? new Set(opts.paths.map(normalizeDraftPath)) : null;
    const selected = record.files.filter((f) => !wanted || wanted.has(f.path));
    if (selected.length === 0) return { ok: true, results: [] };

    if (!opts.allowDrifted) {
      const drifted = (await this.driftedPaths(projectId, record)).filter(
        (p) => !wanted || wanted.has(p),
      );
      if (drifted.length > 0) throw new DiffpackDriftedError(drifted);
    }

    // Three groups, because a unified diff cannot express two of them: an
    // `add` has no file for the patcher to read, and a `delete` applied as a
    // diff leaves an empty file rather than removing one. Adds are still
    // reconstructed FROM the sealed sidecar rather than from the draft tree,
    // so the bytes that land are exactly the bytes the exported zip carries.
    const patches: Array<{ path: string; diff: string }> = [];
    const adds: Array<{ path: string; content: string }> = [];
    const results: Array<{ path: string; ok: boolean; error?: string }> = [];
    const deletions: string[] = [];
    for (const file of selected) {
      if (file.change === 'delete') {
        deletions.push(file.path);
        continue;
      }
      const diff = await this.deps.store
        .readProjectArtifact(projectId, file.diffArtifact)
        .catch(() => null);
      if (diff === null) {
        results.push({ path: file.path, ok: false, error: 'the diff for this file is missing' });
        continue;
      }
      if (file.change === 'add') {
        const content = contentFromCreationPatch(diff);
        if (content === null) {
          results.push({
            path: file.path,
            ok: false,
            error: 'the diff for this new file could not be read back',
          });
          continue;
        }
        adds.push({ path: file.path, content });
        continue;
      }
      patches.push({ path: file.path, diff });
    }

    // A missing sidecar fails the whole pack before anything is written —
    // same validate-all-first stance as the pack applier itself.
    if (results.some((r) => !r.ok)) {
      const skipped = (path: string) => ({
        path,
        ok: false,
        error: 'skipped — proposal validation failed',
      });
      const failed = {
        ok: false,
        results: [
          ...results,
          ...patches.map((p) => skipped(p.path)),
          ...adds.map((a) => skipped(a.path)),
          ...deletions.map(skipped),
        ],
      };
      await this.recordApplyOutcome(projectId, packId, failed, selected.length);
      return failed;
    }

    const outcome =
      patches.length > 0
        ? await this.deps.store.applyEditPackToProjectWorkspace(projectId, patches, undefined, {
            userInitiated: true,
          })
        : { ok: true, results: [] as Array<{ path: string; ok: boolean; error?: string }> };

    const applied = { ok: outcome.ok, results: [...outcome.results] };
    const run = async (path: string, act: () => Promise<void>): Promise<void> => {
      try {
        await act();
        applied.results.push({ path, ok: true });
      } catch (err) {
        applied.ok = false;
        applied.results.push({
          path,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    };
    if (outcome.ok) {
      for (const add of adds) {
        await run(add.path, () =>
          this.deps.store.writeProjectWorkspaceFile(projectId, add.path, add.content, undefined, {
            userInitiated: true,
          }),
        );
      }
      for (const path of deletions) {
        await run(path, () =>
          this.deps.store.rmProjectWorkspacePath(projectId, path, { userInitiated: true }),
        );
      }
    } else {
      for (const path of [...adds.map((a) => a.path), ...deletions]) {
        applied.results.push({ path, ok: false, error: 'skipped — proposal validation failed' });
      }
    }

    await this.recordApplyOutcome(projectId, packId, applied, selected.length);
    this.deps.history
      ?.log({
        kind: 'project.diffpack.applied',
        projectId,
        summary: `${applied.ok ? 'Applied' : 'Failed to apply'} change proposal DP-${packId}`,
        details: {
          packId,
          ok: applied.ok,
          files: applied.results.map((r) => r.path),
          partial: selected.length !== record.files.length,
        },
      })
      .catch(() => {});
    return applied;
  }

  private async recordApplyOutcome(
    projectId: string,
    packId: string,
    outcome: { ok: boolean; results: Array<{ path: string; ok: boolean; error?: string }> },
    selectedCount: number,
  ): Promise<void> {
    await this.mutate(projectId, async (packs) => {
      const record = packs.find((p) => p.packId === packId);
      if (!record) return { record: null, changed: false };
      record.results = outcome.results;
      if (!outcome.ok) {
        record.status = 'failed';
      } else {
        record.status = selectedCount === record.files.length ? 'applied' : 'partially-applied';
        record.appliedAt = nowIso();
      }
      return { record: null, changed: true };
    });
  }

  async dismiss(projectId: string, packId: string): Promise<DiffpackRecord> {
    const record = await this.mutate(projectId, async (packs) => {
      const row = packs.find((p) => p.packId === packId);
      if (!row) throw new DiffpackNotFoundError(packId);
      row.status = 'dismissed';
      return { record: { ...row }, changed: true };
    });
    await this.drafts.discard(projectId, packId);
    return record;
  }

  /* ─── Persistence ────────────────────────────────────────────────── */

  private async summaryFromNotes(projectId: string, notesPath: string): Promise<string> {
    const notes = await this.deps.store.readProjectArtifact(projectId, notesPath).catch(() => null);
    if (!notes) return '';
    for (const line of notes.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '' || trimmed.startsWith('#')) continue;
      return trimmed.slice(0, 400);
    }
    return '';
  }

  private async writeManifest(
    projectId: string,
    record: DiffpackRecord,
    deletions: string[],
  ): Promise<void> {
    const manifest: DiffpackManifest = {
      version: 1,
      packId: record.packId,
      projectId,
      title: record.title,
      summary: record.summary,
      origin: record.origin,
      createdAt: record.createdAt,
      ...(record.sealedAt ? { sealedAt: record.sealedAt } : {}),
      ...(record.gezelName ? { gezelName: record.gezelName } : {}),
      files: record.files,
      deletions,
    };
    await this.deps.store
      .writeProjectArtifact(
        projectId,
        record.manifestPath,
        `${JSON.stringify(manifest, null, 2)}\n`,
      )
      .catch((err) => log.warn(`[diffpack] manifest write failed: ${String(err)}`));
  }

  private async readRecords(projectId: string): Promise<DiffpackRecord[]> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(projectDiffpacksFile(this.deps.home, projectId), 'utf8'));
    } catch {
      return [];
    }
    const raw = (parsed as { diffpacks?: unknown } | null)?.diffpacks;
    if (!Array.isArray(raw)) return [];
    const out: DiffpackRecord[] = [];
    for (const row of raw) {
      const res = DiffpackRecordSchema.safeParse(row);
      if (res.success) out.push(res.data);
    }
    return out;
  }

  private async writeRecords(projectId: string, packs: DiffpackRecord[]): Promise<void> {
    const body: DiffpacksFile = { version: 1, diffpacks: packs.slice(0, MAX_DIFFPACK_RECORDS) };
    await writeFileAtomic(
      projectDiffpacksFile(this.deps.home, projectId),
      `${JSON.stringify(body, null, 2)}\n`,
    );
  }

  /** Per-project read → mutate → conditional-write under a promise-chain lock. */
  private async mutate<T>(
    projectId: string,
    fn: (packs: DiffpackRecord[]) => Promise<{ record: T; changed: boolean }>,
  ): Promise<T> {
    const previous = this.locks.get(projectId) ?? Promise.resolve();
    const run = previous.then(async () => {
      const packs = await this.readRecords(projectId);
      const { record, changed } = await fn(packs);
      if (changed) await this.writeRecords(projectId, packs);
      return record;
    });
    const tracked: Promise<unknown> = run.then(
      () => undefined,
      () => undefined,
    );
    this.locks.set(projectId, tracked);
    void tracked.then(() => {
      if (this.locks.get(projectId) === tracked) this.locks.delete(projectId);
    });
    return run;
  }
}

/**
 * Recover a new file's content from the creation patch the sealer wrote
 * (`createPatch(path, '', content)`). Reading it back from the sidecar rather
 * than from the draft tree keeps one source of truth: what applies here is
 * byte-for-byte what the exported zip hands to `git apply`.
 */
function contentFromCreationPatch(diff: string): string | null {
  let parsed: ReturnType<typeof parsePatch>;
  try {
    parsed = parsePatch(diff);
  } catch {
    return null;
  }
  const first = parsed[0];
  if (!first || parsed.length !== 1) return null;
  const applied = applyPatch('', first);
  return applied === false ? null : applied;
}

/**
 * Other still-live packs that touch this pack's files. Applying one of a
 * colliding pair is legal — the sibling simply reads back as drifted
 * afterwards — but the user deserves to know before, not after.
 */
export function overlapsFor(record: DiffpackRecord, siblings: DiffpackRecord[]): DiffpackOverlap[] {
  if (!isActiveDiffpackStatus(record.status)) return [];
  const out: DiffpackOverlap[] = [];
  for (const file of record.files) {
    const packIds = siblings
      .filter(
        (other) =>
          other.packId !== record.packId &&
          isActiveDiffpackStatus(other.status) &&
          other.files.some((f) => f.path === file.path),
      )
      .map((other) => other.packId);
    if (packIds.length > 0) out.push({ path: file.path, packIds });
  }
  return out;
}

/** Path → a short, filesystem-safe slug for the diff sidecar's basename. */
export function slugify(path: string): string {
  return (
    path
      .replaceAll('\\', '/')
      .split('/')
      .pop()
      ?.replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'file'
  );
}

export type { DiffpackStatus };
