/**
 * Thrown when a workspace-mutating op (`write_file`, `delete_path`, `make_dir`,
 * `rename`, `run_nodejs_script`, `npm_install`) is attempted against a
 * project whose per-project write contract denies it: an **external**
 * `workingDir` without the `allowGezelWrites: true` opt-in
 * (`missing-flag-external`), or any project where the user explicitly
 * set `allowGezelWrites: false` (`disabled-by-project`). The caller
 * (HTTP route or MCP tool) translates this into a 403 response with a
 * clear pointer to the Settings toggle the user needs to flip.
 *
 * A separate error type from `PathSafetyError` (paths.ts) because this
 * one is a policy failure — the path was fine, the project just
 * doesn't permit gezel writes yet. Callers typically want to catch
 * them together but render different copy.
 */
export type WorkspaceWriteDeniedReason =
  | 'missing-flag-external'
  | 'disabled-by-project'
  | 'data-subtree-readonly';

function deniedMessage(info: { reason: WorkspaceWriteDeniedReason; workingDir: string }): string {
  switch (info.reason) {
    case 'disabled-by-project':
      return 'Gezel writes are turned off for this project ("Allow gezels to modify the workspace directory" in Project → Settings). Flip it on to let gezels modify files here.';
    case 'data-subtree-readonly':
      return 'The data/ directory holds mirrored connector corpora and is read-only to gezels: editing or deleting a synced record causes permanent, silent data loss (a deleted record is never re-fetched). Write analysis and conclusions to another folder, such as artifacts/.';
    default:
      return `Gezel writes are disabled for this project's external workspace (${info.workingDir}). Enable "Allow gezels to modify the workspace directory" in Project → Settings.`;
  }
}

export class WorkspaceWriteDeniedError extends Error {
  readonly code = 'workspace-write-denied' as const;
  readonly reason: WorkspaceWriteDeniedReason;
  readonly workingDir: string;
  constructor(info: { reason: WorkspaceWriteDeniedReason; workingDir: string }) {
    super(deniedMessage(info));
    this.name = 'WorkspaceWriteDeniedError';
    this.reason = info.reason;
    this.workingDir = info.workingDir;
  }
}

/**
 * Thrown by the surgical-edit Store methods (`replaceInProjectWorkspaceFile`,
 * `applyPatchToProjectWorkspaceFile`, `insertAtMarkerInProjectWorkspaceFile`)
 * when the edit cannot be applied as specified. The model-facing error
 * message is the `Error.message` — it should be self-explanatory enough
 * that the next turn can correct course (e.g. "pattern matches 3 places;
 * specify occurrence" → model retries with occurrence=1).
 *
 * The HTTP layer maps these to a 400 with the message in `error`. The
 * `code` discriminator lets future callers branch on cause without
 * regex-matching the prose.
 */
export type WorkspaceEditFailureCode =
  | 'file-not-found'
  | 'pattern-not-found'
  | 'ambiguous-match'
  | 'occurrence-out-of-range'
  | 'invalid-range'
  | 'line-out-of-range'
  | 'identity-edit'
  | 'patch-parse-failed'
  | 'patch-rejected'
  | 'patch-multi-file'
  | 'marker-not-found'
  | 'marker-ambiguous';

export class WorkspaceEditError extends Error {
  readonly code: WorkspaceEditFailureCode;
  constructor(message: string, code: WorkspaceEditFailureCode) {
    super(message);
    this.name = 'WorkspaceEditError';
    this.code = code;
  }
}
