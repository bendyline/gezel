import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { createLogger } from '@bendyline/gezel';
import { writeFileAtomic } from '../fs/atomic.js';
import { resolveInside, safeJoin } from '../fs/safe-paths.js';
import type { Store } from '../fs/store.js';
import {
  type WorkspaceEditResult,
  buildWorkspaceEditResult,
  computeInsertAtMarker,
  computeReplaceInFile,
  computeReplaceLines,
} from '../workspace/edit.js';
import { WorkspaceEditError } from '../workspace/errors.js';

const log = createLogger('diffpack');

/**
 * The copy-on-write draft tree behind one diffpack.
 *
 * A drafting session's workspace-write tools are re-rooted here instead of at
 * the project workspace: `read` falls through to the real file until the pack
 * has its own copy, and every write lands under
 * `artifacts/diffpacks/<packId>/after/`. The workspace is never opened for
 * writing, which is what lets a developer gezel work on a folder gezels hold
 * no write grant for — and what lets the night shift run against a read-only
 * checkout.
 *
 * The transforms themselves (`computeReplaceInFile` and friends) are the
 * SAME functions the workspace path uses. That is deliberate: models are
 * trained by repetition on those error strings, and a second implementation
 * would drift into being the untested one.
 *
 * Nothing here consults `assertWorkspaceWritable` — there is nothing to gate.
 * The artifacts drawer is always project-owned, and a draft is a proposal.
 */
export class DiffpackDraftStore {
  constructor(private readonly store: Store) {}

  /**
   * `artifacts/diffpacks/<packId>/after` — absolute, pure. `packId` is a path
   * segment, so it goes through `safeJoin` even though every caller today
   * mints it from a task number.
   */
  private afterDir(projectId: string, packId: string): string {
    const dir = safeJoin(
      this.store.projectArtifactsDir(projectId),
      join('diffpacks', packId, 'after'),
    );
    if (!dir) throw new WorkspaceEditError(`invalid diffpack id "${packId}"`, 'invalid-range');
    return dir;
  }

  /**
   * Absolute path of one file inside the draft tree.
   *
   * `resolveInside` realpaths the base to catch symlink escape, which means
   * the base has to exist — so writes create the pack folder first. Reads
   * take the `create: false` path and the caller falls through to the
   * workspace when the folder isn't there yet, rather than conjuring an empty
   * pack directory as a side effect of reading a file.
   */
  private async draftPath(
    projectId: string,
    packId: string,
    path: string,
    opts: { create: boolean },
  ): Promise<string | null> {
    const base = this.afterDir(projectId, packId);
    if (opts.create) await mkdir(base, { recursive: true });
    else if (!(await exists(base))) return null;
    return resolveInside(base, path);
  }

  /**
   * Read the pack's view of a file: the drafted copy when one exists,
   * otherwise the live workspace file. Null when the file exists in neither
   * (and is not tombstoned) — the caller turns that into the model-facing
   * "use write_file to create it" error.
   */
  async read(projectId: string, packId: string, path: string): Promise<string | null> {
    if (await this.isDeleted(projectId, packId, path)) return null;
    const full = await this.draftPath(projectId, packId, path, { create: false });
    if (full !== null) {
      try {
        return await readFile(full, 'utf8');
      } catch {
        // Not drafted yet — fall through.
      }
    }
    return this.store.readProjectWorkspaceFile(projectId, path);
  }

  /**
   * Read for editing. Mirrors `readFileForEditOrThrow` — the error text
   * matters, because it is what teaches a model to reach for `write_file`
   * on a file that does not exist yet.
   */
  private async readForEdit(projectId: string, packId: string, path: string): Promise<string> {
    const content = await this.read(projectId, packId, path);
    if (content === null) {
      throw new WorkspaceEditError(
        `Cannot edit ${path}: file does not exist. Use \`write_file\` to create it first.`,
        'file-not-found',
      );
    }
    return content;
  }

  /** Full replacement — also the "create a new file" path. */
  async write(
    projectId: string,
    packId: string,
    path: string,
    content: string,
  ): Promise<WorkspaceEditResult> {
    const before = (await this.read(projectId, packId, path)) ?? '';
    await this.clearTombstone(projectId, packId, path);
    await this.commit(projectId, packId, path, content);
    return buildWorkspaceEditResult(path, before, content);
  }

  async replaceIn(
    projectId: string,
    packId: string,
    args: { path: string; find: string; replace: string; occurrence?: number | 'all' },
  ): Promise<WorkspaceEditResult> {
    const oldContent = await this.readForEdit(projectId, packId, args.path);
    const newContent = computeReplaceInFile(oldContent, args);
    await this.commit(projectId, packId, args.path, newContent);
    return buildWorkspaceEditResult(args.path, oldContent, newContent);
  }

  async replaceLines(
    projectId: string,
    packId: string,
    args: { path: string; startLine: number; endLine: number; content: string },
  ): Promise<WorkspaceEditResult> {
    const oldContent = await this.readForEdit(projectId, packId, args.path);
    const newContent = computeReplaceLines(oldContent, args);
    await this.commit(projectId, packId, args.path, newContent);
    return buildWorkspaceEditResult(args.path, oldContent, newContent);
  }

  async insertAtMarker(
    projectId: string,
    packId: string,
    args: { path: string; marker: string; content: string; where?: 'before' | 'after' },
  ): Promise<WorkspaceEditResult> {
    const oldContent = await this.readForEdit(projectId, packId, args.path);
    const newContent = computeInsertAtMarker(oldContent, args);
    await this.commit(projectId, packId, args.path, newContent);
    return buildWorkspaceEditResult(args.path, oldContent, newContent);
  }

  async appendTo(
    projectId: string,
    packId: string,
    path: string,
    content: string,
  ): Promise<WorkspaceEditResult> {
    const oldContent = (await this.read(projectId, packId, path)) ?? '';
    const separator = oldContent === '' || oldContent.endsWith('\n') ? '' : '\n';
    const newContent = oldContent + separator + content;
    await this.commit(projectId, packId, path, newContent);
    return buildWorkspaceEditResult(path, oldContent, newContent);
  }

  private async commit(
    projectId: string,
    packId: string,
    path: string,
    content: string,
  ): Promise<void> {
    const full = await this.draftPath(projectId, packId, path, { create: true });
    if (full === null) throw new WorkspaceEditError(`invalid path ${path}`, 'invalid-range');
    await mkdir(dirname(full), { recursive: true });
    await writeFileAtomic(full, content);
  }

  /* ─── Deletions ──────────────────────────────────────────────────── */
  //
  // A proposed deletion has no diff sidecar. A unified diff that removes
  // every line applies fine, but it leaves an empty file behind rather than
  // removing it — so deletions are carried as an explicit tombstone list and
  // executed by the apply route.

  private tombstoneFile(projectId: string, packId: string): string {
    return join(dirname(this.afterDir(projectId, packId)), 'deletions.json');
  }

  async listDeletions(projectId: string, packId: string): Promise<string[]> {
    try {
      const raw = await readFile(this.tombstoneFile(projectId, packId), 'utf8');
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === 'string') : [];
    } catch {
      return [];
    }
  }

  async isDeleted(projectId: string, packId: string, path: string): Promise<boolean> {
    return (await this.listDeletions(projectId, packId)).includes(normalizeDraftPath(path));
  }

  /**
   * Propose deleting a workspace file. Refuses a path the workspace does not
   * have — otherwise a model that mistyped a name gets a silent success and
   * the pack carries a deletion for a file nobody will ever find.
   */
  async delete(projectId: string, packId: string, path: string): Promise<void> {
    const normalized = normalizeDraftPath(path);
    const existsInWorkspace = (await this.store.readProjectWorkspaceFile(projectId, path)) !== null;
    const draftFull = await this.draftPath(projectId, packId, path, { create: false });
    const draftExists = draftFull !== null && (await exists(draftFull));
    if (!existsInWorkspace && !draftExists) {
      throw new WorkspaceEditError(
        `Cannot delete ${path}: no such file in the workspace or this change set.`,
        'file-not-found',
      );
    }
    // A file this pack created and then deleted is simply dropped: there is
    // nothing in the workspace to tombstone.
    if (draftExists && draftFull) await rm(draftFull, { force: true });
    if (!existsInWorkspace) return;
    const current = await this.listDeletions(projectId, packId);
    if (current.includes(normalized)) return;
    await this.writeDeletions(projectId, packId, [...current, normalized]);
  }

  private async clearTombstone(projectId: string, packId: string, path: string): Promise<void> {
    const normalized = normalizeDraftPath(path);
    const current = await this.listDeletions(projectId, packId);
    if (!current.includes(normalized)) return;
    await this.writeDeletions(
      projectId,
      packId,
      current.filter((p) => p !== normalized),
    );
  }

  private async writeDeletions(projectId: string, packId: string, paths: string[]): Promise<void> {
    const file = this.tombstoneFile(projectId, packId);
    await mkdir(dirname(file), { recursive: true });
    await writeFileAtomic(file, `${JSON.stringify(paths, null, 2)}\n`);
  }

  /**
   * Write a sealed diff sidecar into `diffpacks/<packId>/files/`.
   *
   * Goes straight to disk rather than through `writeProjectArtifact`, for the
   * same reason the indexer's shadow converter does: that subtree is
   * write-denied at the artifact store so a model cannot forge a diff it never
   * drafted, and the guard is only meaningful if it has no opt-out flag.
   */
  async writeSidecar(
    projectId: string,
    packId: string,
    name: string,
    content: string,
  ): Promise<void> {
    const dir = join(dirname(this.afterDir(projectId, packId)), 'files');
    await mkdir(dir, { recursive: true });
    const full = await resolveInside(dir, name);
    await writeFileAtomic(full, content);
  }

  /** Drop stale sidecars so a re-seal never leaves a previous run's diffs behind. */
  async clearSidecars(projectId: string, packId: string): Promise<void> {
    const dir = join(dirname(this.afterDir(projectId, packId)), 'files');
    await rm(dir, { recursive: true, force: true });
  }

  /* ─── Inspection ─────────────────────────────────────────────────── */

  /** Workspace-relative paths this pack has drafted content for. */
  async listDraftedPaths(projectId: string, packId: string): Promise<string[]> {
    const root = this.afterDir(projectId, packId);
    const out: string[] = [];
    await walk(root, root, out);
    return out.sort();
  }

  /**
   * True when the pack has produced no proposal at all. The gate script
   * behind the drafting step asks this — a step that "succeeded" with an
   * empty tree is the one failure a deliverable check would otherwise miss,
   * because `notes.md` exists and reads perfectly well.
   */
  async isEmpty(projectId: string, packId: string): Promise<boolean> {
    const [drafted, deletions] = await Promise.all([
      this.listDraftedPaths(projectId, packId),
      this.listDeletions(projectId, packId),
    ]);
    if (deletions.length > 0) return false;
    for (const path of drafted) {
      const before = await this.store.readProjectWorkspaceFile(projectId, path);
      const after = await this.read(projectId, packId, path);
      if (after !== before) return false;
    }
    return true;
  }

  /** Drop the whole draft tree — used when a drafting task is canceled. */
  async discard(projectId: string, packId: string): Promise<void> {
    const after = this.afterDir(projectId, packId);
    await rm(dirname(after), { recursive: true, force: true }).catch((err) => {
      log.warn(`[diffpack] could not discard draft ${packId}: ${String(err)}`);
    });
  }
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

export function normalizeDraftPath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

export function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

async function walk(root: string, dir: string, out: string[]): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(root, full, out);
    else if (entry.isFile()) out.push(relative(root, full).split(sep).join('/'));
  }
}
