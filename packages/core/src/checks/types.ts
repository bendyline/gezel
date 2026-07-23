/**
 * ─ Shared deliverable checks ─────────────────────────────────────────
 *
 * Pure, dependency-free predicates over file content and file listings.
 * The ONE source of truth consumed by three surfaces that must agree:
 *
 *   1. the gate engine's declarative checks (service/tasks/gate-eval.ts)
 *   2. the standard gate-script library (packages/script-stdlib, via the
 *      bundled `@bendyline/gezel-sdk/checks` re-export)
 *   3. the eval harness's success sniffs (evals/src)
 *
 * Keep this directory zod-free and Node-API-free: it is bundled into the
 * sandbox SDK (`noExternal`), and its failure prose is shown verbatim to
 * users and models.
 */

/** Read-only view of a workspace the file checks evaluate against. */
export interface WorkspaceLike {
  /** File content (relative path), or null if absent. */
  read(file: string): Promise<string | null>;
  /** Relative paths of all files (for count/scan checks). */
  list(): Promise<string[]>;
}

export interface CheckResult {
  ok: boolean;
  /**
   * One human-readable line. On failure: the concrete gap to fix (this
   * exact prose lands in gate-rejection messages). On success: a brief
   * diagnostic ("index.html is 4312 bytes").
   */
  detail: string;
}
