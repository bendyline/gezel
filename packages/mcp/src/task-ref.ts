/**
 * Tolerant task-ref resolution for the MCP task tools.
 *
 * The canonical ref shape is `projectId/num` (see core `taskRef` /
 * `parseTaskRef`). Small local models routinely fail to reproduce it
 * from the prompt — wild-caught ("Space War Arcade",
 * gemma4-e4b, a Planner in a task-scoped chat):
 *
 *   read_task_notes("arcade-game")        — dropped the num entirely
 *   get_task("arcade-game#1")             — "#" separator, truncated id
 *   read_task_notes("arcade-game`#1")     — stray backtick, truncated id
 *
 * The correct ref (`space-war-arcade-game/1`) was printed verbatim in
 * the prompt, but the model truncated the slug and swapped the
 * separator. Since these sessions are scoped to exactly one task, the
 * resolver leans on that context: when a ref is missing, unparseable,
 * or names a different project than the session's task, fall back to
 * the session task rather than 404 on a mangled ref.
 */

export interface TaskRefParts {
  projectId: string;
  num: number;
}

/** Strict `projectId/num` parse. Returns null if the shape doesn't match. */
export function strictParseTaskRef(ref: string): TaskRefParts | null {
  const idx = ref.lastIndexOf('/');
  if (idx < 0) return null;
  const projectId = ref.slice(0, idx).trim();
  const numStr = ref.slice(idx + 1).trim();
  if (!projectId) return null;
  const num = Number.parseInt(numStr, 10);
  if (!Number.isFinite(num) || num <= 0 || String(num) !== numStr) return null;
  return { projectId, num };
}

/**
 * Coerce the common mangles into the canonical shape: strip wrapping /
 * stray quotes and backticks, drop whitespace, and accept `#` / `:` as
 * the separator before a trailing number (`task#1` / `task:1` →
 * `task/1`).
 */
function normalizeTaskRef(ref: string): string {
  return ref
    .replace(/[`'"]/g, '')
    .replace(/\s+/g, '')
    .replace(/[#:](?=\d+$)/, '/');
}

/**
 * Resolve a (possibly mangled or absent) task ref against the session's
 * own task. Resolution order:
 *
 *   1. A bare positive number (`1`, `#1`) → the session project's task N.
 *   2. A ref that parses (strictly, or after normalization) →
 *      honored when it has no session to compare against OR its
 *      projectId matches the session's. A parseable ref naming a
 *      *different* project inside a task-scoped session is treated as a
 *      truncation mangle and resolves to the session task.
 *   3. Nothing parseable → the session task, if any.
 *   4. Otherwise throw a message that names the session task when known.
 *
 * `sessionTaskRef` is the session's `record.taskRef` (plumbed via
 * `GEZEL_TASK_REF`); empty/undefined for lobby sessions, where the
 * resolver behaves like the old strict parser (honor what parses,
 * throw otherwise).
 */
export function resolveTaskRef(
  ref: string | undefined,
  sessionTaskRef: string | undefined,
): TaskRefParts {
  const session = sessionTaskRef?.trim() ? strictParseTaskRef(sessionTaskRef.trim()) : null;
  const raw = (ref ?? '').trim();

  if (raw) {
    const bare = raw.replace(/^#/, '');
    if (session && /^\d+$/.test(bare)) {
      const num = Number.parseInt(bare, 10);
      if (num > 0) return { projectId: session.projectId, num };
    }
    const parsed = strictParseTaskRef(raw) ?? strictParseTaskRef(normalizeTaskRef(raw));
    if (parsed) {
      if (!session || parsed.projectId === session.projectId) return parsed;
      // Parseable but names a different project than the session task —
      // almost always a small-model truncation of the session's own
      // projectId. Prefer the task this session is actually scoped to.
      return session;
    }
  }

  if (session) return session;

  const hint = sessionTaskRef?.trim() ? ` This session's task is "${sessionTaskRef.trim()}".` : '';
  throw new Error(
    `invalid task ref "${ref ?? ''}" — expected projectId/num (e.g. "myproject/1").${hint}`,
  );
}
