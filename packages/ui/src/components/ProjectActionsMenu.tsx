import type { Project } from '@bendyline/gezel';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useState } from 'react';
import { api } from '../api.js';
import { ConfirmDialog } from './ConfirmDialog.js';

/**
 * Per-project "⋯" actions menu. Currently exposes a single destructive
 * action — Delete — behind a confirmation dialog.
 *
 * Deletion is deliberately conservative about the user's files: the default
 * only removes the project record, leaving the workspace + artifacts on disk.
 * When (and only when) the project's workspace is gezel-internal, the dialog
 * offers an explicit opt-in to also delete those files. A project pointing at
 * an external `workingDir` never has that directory touched — the server is
 * the final backstop, but we also don't offer the option here.
 */
export function ProjectActionsMenu({
  project,
  onDeleted,
  align = 'end',
}: {
  project: Pick<Project, 'id' | 'name' | 'workingDir' | 'github'>;
  onDeleted?: (projectId: string) => void;
  align?: 'start' | 'center' | 'end';
}) {
  const [confirming, setConfirming] = useState(false);
  const [removeWorkspace, setRemoveWorkspace] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isDefault = project.id === 'default';
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
            <DropdownMenu.Item
              className="app-nav-menu-item danger"
              disabled={isDefault}
              onSelect={() => {
                if (isDefault) return;
                openConfirm();
              }}
            >
              Delete project…
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

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
                Its workspace folder (<code>{project.workingDir ?? 'the linked repository'}</code>)
                is left untouched — only the project record is removed.
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
    </>
  );
}
