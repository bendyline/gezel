import type { Project } from '@bendyline/gezel';
import { type ReactElement, useState } from 'react';
import { api } from '../api.js';
import { ContextMenu, DropdownMenu } from '../primitives/index.js';
import { ConfirmDialog } from './ConfirmDialog.js';

interface ProjectActionProps {
  project: Pick<Project, 'id' | 'name' | 'workingDir' | 'github' | 'storageScope'>;
  /**
   * Whether the project currently shows the red failed-turn indicator.
   * Gates the "Clear error indicator" item so the menu never offers a
   * dead action. Callers that don't track poisoned state leave it unset.
   */
  hasError?: boolean;
  onDeleted?: (projectId: string) => void;
}

interface ProjectActionsMenuProps extends ProjectActionProps {
  align?: 'start' | 'center' | 'end';
}

function useProjectActions({ project, onDeleted }: ProjectActionProps) {
  const [confirming, setConfirming] = useState(false);
  const [removeWorkspace, setRemoveWorkspace] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isDefault = project.id === 'default';
  const isShared = project.storageScope === 'machine-shared';
  const hasInternalWorkspace = !project.workingDir && !project.github?.checkoutDir;

  const openConfirm = () => {
    setRemoveWorkspace(false);
    setError(null);
    setConfirming(true);
  };

  const runDelete = async () => {
    setError(null);
    try {
      await api.deleteProject(project.id, {
        removeWorkspace: hasInternalWorkspace && removeWorkspace,
      });
      setConfirming(false);
      window.dispatchEvent(
        new CustomEvent('gezel:project-deleted', { detail: { projectId: project.id } }),
      );
      onDeleted?.(project.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      // Keep the dialog open so the user sees the failure and can retry.
      throw err;
    }
  };

  // Clearing is project-wide on purpose: one engine crash poisons several
  // of a project's sessions, so per-session clearing would leave the
  // indicator up after the user just dismissed it. Same call the chat
  // banner's "Continue" makes.
  const clearErrors = async () => {
    try {
      await api.clearProjectErrors(project.id);
      window.dispatchEvent(
        new CustomEvent('gezel:session-error-cleared', { detail: { projectId: project.id } }),
      );
    } catch {
      // Nothing to surface from a dropdown that's already closed — the
      // indicator simply stays up and the user can retry.
    }
  };

  const reveal = async (which: 'workspace' | 'artifacts') => {
    try {
      await api.revealProject(project.id, which);
    } catch {
      // The menu has already closed by the time the OS launcher answers.
      // A failed launch is safe to retry from the same action.
    }
  };

  return {
    clearErrors,
    confirming,
    error,
    hasInternalWorkspace,
    isDefault,
    isShared,
    openConfirm,
    removeWorkspace,
    reveal,
    runDelete,
    setConfirming,
    setRemoveWorkspace,
  };
}

type ProjectActions = ReturnType<typeof useProjectActions>;

function ProjectMenuItems({
  actions,
  hasError,
  kind,
}: {
  actions: ProjectActions;
  hasError: boolean;
  kind: 'context' | 'dropdown';
}) {
  const Item = kind === 'context' ? ContextMenu.Item : DropdownMenu.Item;

  return (
    <>
      <Item
        className="app-nav-menu-item"
        onSelect={() => {
          void actions.reveal('workspace');
        }}
      >
        Open workspace folder
      </Item>
      <Item
        className="app-nav-menu-item"
        onSelect={() => {
          void actions.reveal('artifacts');
        }}
      >
        Open artifacts folder
      </Item>
      {hasError && (
        <Item
          className="app-nav-menu-item"
          onSelect={() => {
            void actions.clearErrors();
          }}
        >
          Clear error indicator
        </Item>
      )}
      <Item
        className="app-nav-menu-item danger"
        disabled={actions.isDefault || actions.isShared}
        onSelect={() => {
          if (actions.isDefault || actions.isShared) return;
          actions.openConfirm();
        }}
      >
        {actions.isShared ? 'Shared project removal is unavailable' : 'Delete project…'}
      </Item>
    </>
  );
}

/**
 * Deletion is deliberately conservative about the user's files: the default
 * only removes the project record, leaving the workspace + artifacts on disk.
 * When (and only when) the project's workspace is gezel-internal, the dialog
 * offers an explicit opt-in to also delete those files. A project pointing at
 * an external `workingDir` never has that directory touched — the server is
 * the final backstop, but we also don't offer the option here.
 */
function ProjectDeleteDialog({
  actions,
  project,
}: {
  actions: ProjectActions;
  project: ProjectActionProps['project'];
}) {
  const {
    confirming,
    error,
    hasInternalWorkspace,
    removeWorkspace,
    runDelete,
    setConfirming,
    setRemoveWorkspace,
  } = actions;

  return (
    <ConfirmDialog
      open={confirming}
      title={`Delete "${project.name}"?`}
      message={
        <>
          The project and its chats will be removed.{' '}
          {hasInternalWorkspace ? (
            <>
              Its workspace files and artifacts are kept on disk unless you choose to remove them.
            </>
          ) : (
            <>
              Its workspace folder (<code>{project.workingDir ?? 'the linked repository'}</code>) is
              left untouched — only the project record is removed.
            </>
          )}
          {hasInternalWorkspace && (
            <label className="project-delete-optout">
              <input
                type="checkbox"
                checked={removeWorkspace}
                onChange={(e) => setRemoveWorkspace(e.target.checked)}
              />
              <span>Also permanently delete the workspace files and artifacts</span>
            </label>
          )}
          {error && <span className="project-delete-error">{error}</span>}
        </>
      }
      confirmLabel={
        hasInternalWorkspace && removeWorkspace ? 'Delete project + files' : 'Delete project'
      }
      danger
      onConfirm={runDelete}
      onCancel={() => setConfirming(false)}
    />
  );
}

/**
 * Per-project "⋯" actions menu. Exposes "Clear error indicator" when the
 * project is carrying a failed turn, plus the destructive Delete action
 * behind a confirmation dialog.
 */
export function ProjectActionsMenu({
  project,
  hasError = false,
  onDeleted,
  align = 'end',
}: ProjectActionsMenuProps) {
  const actions = useProjectActions({ project, onDeleted });

  return (
    <>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            className="project-actions-trigger"
            aria-label={`Actions for ${project.name}`}
            title="Project actions"
            onClick={(e) => e.stopPropagation()}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <circle cx="12" cy="5" r="1.6" />
              <circle cx="12" cy="12" r="1.6" />
              <circle cx="12" cy="19" r="1.6" />
            </svg>
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content className="app-nav-menu" sideOffset={4} align={align}>
            <ProjectMenuItems actions={actions} hasError={hasError} kind="dropdown" />
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      <ProjectDeleteDialog actions={actions} project={project} />
    </>
  );
}

/**
 * Right-click actions for a whole project row. This deliberately shares the
 * same action list and confirmation flow as the visible "⋯" affordance.
 */
export function ProjectContextMenu({
  children,
  project,
  hasError = false,
  onDeleted,
}: ProjectActionProps & { children: ReactElement }) {
  const actions = useProjectActions({ project, onDeleted });

  return (
    <>
      <ContextMenu.Root>
        <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content className="app-nav-menu">
            <ProjectMenuItems actions={actions} hasError={hasError} kind="context" />
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>

      <ProjectDeleteDialog actions={actions} project={project} />
    </>
  );
}
