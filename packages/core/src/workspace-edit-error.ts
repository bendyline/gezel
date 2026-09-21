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
