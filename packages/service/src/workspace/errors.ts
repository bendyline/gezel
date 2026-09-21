import { MANAGED_WORKSPACE_WRITE_SETTING_LABEL } from '@bendyline/gezel';

/**
 * Thrown when a workspace-mutating op (`write_file`, `delete_path`, `make_dir`,
 * `rename`, `run_nodejs_script`, `npm_install`) is attempted against a
 * project whose per-project write contract denies it: an **external**
 * external `workingDir` without an explicit managed-write opt-in
 * (`external-consent-required`), or any project where the user explicitly
 * set the managed-write policy to `deny` (`disabled-by-project`). The caller
 * (HTTP route or MCP tool) translates this into a 403 response with a
 * clear pointer to the Settings toggle the user needs to flip.
 *
 * A separate error type from `PathSafetyError` (paths.ts) because this
 * one is a policy failure — the path was fine, the project just
 * doesn't permit gezel writes yet. Callers typically want to catch
 * them together but render different copy.
 */
export type WorkspaceWriteDeniedReason = 'external-consent-required' | 'disabled-by-project';

function deniedMessage(info: { reason: WorkspaceWriteDeniedReason; workingDir: string }): string {
  switch (info.reason) {
    case 'disabled-by-project':
      return `Managed workspace writes are turned off for this project ("${MANAGED_WORKSPACE_WRITE_SETTING_LABEL}" in Project → Settings). Flip it on to let built-in tools modify files here.`;
    default:
      return `Managed writes are disabled for this project's external workspace (${info.workingDir}). Enable "${MANAGED_WORKSPACE_WRITE_SETTING_LABEL}" in Project → Settings.`;
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

export { WorkspaceEditError, type WorkspaceEditFailureCode } from '@bendyline/gezel';
