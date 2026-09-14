/**
 * Which folders belong to a running task, and who is allowed to write there.
 *
 * A craftbook task declares its own working folders: `workPath` in the
 * artifacts drawer (defaulting to `tasks/<num>/`) and `outputDir` in the
 * workspace (defaulting to a task-specific path like `powerpoint/task-2/`).
 * Those folders exist so concurrent tasks cannot collide — the whole point of
 * ADR 0008's per-task artifact folder.
 *
 * Nothing enforced that. A gezel session with NO task binding could write
 * straight into a running task's declared output.
 *
 * Wild-caught on the first true end-to-end PowerPoint pass: the reviewer's turn
 * aborted on a read loop, a recovery nudge arrived in a fresh unbound chat
 * session, and that session — holding no task context, no outline, and no
 * topic — wrote `powerpoint/task-2/deck.md`. It replaced an eleven-slide deck
 * about lighthouses with a one-slide deck about the phrase "Review narrative
 * and grounding", which was the only subject matter its prompt contained. The
 * review gate then correctly rejected the wreckage three times and paused the
 * task. A well-formed deliverable was destroyed by a writer that had no way to
 * know what it was overwriting.
 *
 * The rule implemented here is deliberately narrow: only a session with NO
 * task binding at all is refused. A session bound to a DIFFERENT task is a
 * separate policy question (cross-task writes have legitimate uses, such as a
 * fanout host tidying a shard's folder) and is left alone. User-initiated
 * writes are never refused — the person at the keyboard owns their files.
 */

/** The surfaces a task can declare a folder on. */
export type TaskPathSurface = 'workspace' | 'artifacts';

export interface TaskOwnedPrefix {
  /** `<projectId>/<num>` — the task whose work lives under `prefix`. */
  taskRef: string;
  surface: TaskPathSurface;
  /** Normalized folder prefix, no leading or trailing slash. */
  prefix: string;
}

/** The shape this module needs from a task; deliberately minimal. */
export interface TaskPathSource {
  ref: string;
  num: number;
  status: string;
  craftbookParams?: Record<string, string> | undefined;
}

/** Strip leading `./`, collapse separators, drop surrounding slashes. */
export function normalizeFolder(value: string | undefined): string {
  if (!value) return '';
  return value
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+|\/+$/g, '');
}

/**
 * A task owns a folder only while it can still write there. A complete or
 * canceled task's outputs are ordinary files again — refusing writes to them
 * would strand anyone trying to revise finished work.
 */
const LIVE_STATUSES = new Set(['active', 'paused']);

export function taskOwnedPrefixes(tasks: readonly TaskPathSource[]): TaskOwnedPrefix[] {
  const out: TaskOwnedPrefix[] = [];
  for (const task of tasks) {
    if (!LIVE_STATUSES.has(task.status)) continue;
    const params = task.craftbookParams ?? {};
    // The artifact folder is a convention with a default, so it holds even
    // when the book never named `workPath`.
    const artifactPrefix = normalizeFolder(params.workPath) || `tasks/${task.num}`;
    out.push({ taskRef: task.ref, surface: 'artifacts', prefix: artifactPrefix });
    // The workspace folder only exists when the book declared one. Inferring
    // it from the deliverable's parent would claim shared directories — a book
    // writing `README.md` at the root would own the entire workspace.
    const workspacePrefix = normalizeFolder(params.outputDir);
    if (workspacePrefix) {
      out.push({ taskRef: task.ref, surface: 'workspace', prefix: workspacePrefix });
    }
  }
  return out;
}

/** True when `path` sits inside `prefix` (or IS it), on folder boundaries. */
export function isInsideFolder(path: string, prefix: string): boolean {
  if (!prefix) return false;
  const p = normalizeFolder(path);
  if (p === prefix) return true;
  return p.startsWith(`${prefix}/`);
}

export interface TaskScopedWriteDenial {
  taskRef: string;
  prefix: string;
  surface: TaskPathSurface;
}

/**
 * Decide whether an unbound gezel write must be refused.
 *
 * `writerTaskRef` is the task the writing SESSION is bound to. Undefined means
 * unbound, which is the only case this refuses.
 */
export function deniedTaskScopedWrite(opts: {
  path: string;
  surface: TaskPathSurface;
  writerTaskRef?: string | undefined;
  owned: readonly TaskOwnedPrefix[];
}): TaskScopedWriteDenial | null {
  if (opts.writerTaskRef) return null;
  for (const owned of opts.owned) {
    if (owned.surface !== opts.surface) continue;
    if (!isInsideFolder(opts.path, owned.prefix)) continue;
    return { taskRef: owned.taskRef, prefix: owned.prefix, surface: owned.surface };
  }
  return null;
}

/**
 * The refusal the model sees. Names the owner and the one legitimate route, so
 * a capable model can act on it rather than retrying the same write — the
 * lesson from every other corrective in this codebase.
 */
export function taskScopedWriteDeniedMessage(denial: TaskScopedWriteDenial, path: string): string {
  return (
    `"${path}" belongs to task ${denial.taskRef}, whose ${denial.surface} folder is ` +
    `"${denial.prefix}/". This session is not working that task, so it cannot write there — ` +
    'a task\'s deliverables are only safe to edit from inside its own step, which has the ' +
    'outline, the source packet and the rest of the context this session does not. ' +
    `If you are meant to be doing that work, continue it from the task's step session; ` +
    'otherwise write somewhere outside that folder.'
  );
}
