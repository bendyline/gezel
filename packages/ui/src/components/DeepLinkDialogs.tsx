import type { GezelSummary, Project } from '@bendyline/gezel';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { deriveLaunchProjectId } from '../views/home/utils.js';
import { NewProjectDialog } from '../views/projects/NewProjectDialog.js';
import { NewTaskDialog } from '../views/tasks/NewTaskDialog.js';
import { ModelImportDialog } from './ModelImportDialog.js';
import { navigateToTab } from './nav-actions.js';

export type DeepLinkDialogTarget =
  | {
      kind: 'app' | 'craftbook';
      id: string;
      /** A new link to the same item still opens a fresh dialog. */
      key: number;
    }
  | {
      /** Hugging Face's "Use this model": the review, never a download. */
      kind: 'model';
      repo: string;
      file?: string;
      key: number;
    };

interface LaunchContext {
  projectId: string;
  projects: Project[];
  gezels: GezelSummary[];
}

/** The forms a `gezel://` link opens, loaded with DeepLinkHost's first link. */
export function DeepLinkDialogs({
  target,
  onClose,
  onUnavailable,
}: {
  target: DeepLinkDialogTarget;
  onClose: () => void;
  onUnavailable: () => void;
}) {
  const [launch, setLaunch] = useState<LaunchContext | null>(null);
  // Read through a ref: the host passes a fresh callback on every render, and
  // refetching on each would reset a form the person is filling in.
  const unavailable = useRef(onUnavailable);
  unavailable.current = onUnavailable;

  useEffect(() => {
    if (target.kind !== 'craftbook') return;
    let canceled = false;
    void Promise.all([api.listProjects(), api.listGezels(), api.getConfig()])
      .then(([projectList, gezelList, config]) => {
        if (canceled) return;
        const projects = projectList.projects ?? [];
        setLaunch({
          projectId: deriveLaunchProjectId(config, projects),
          projects,
          gezels: gezelList.gezels ?? [],
        });
      })
      .catch(() => {
        if (!canceled) unavailable.current();
      });
    return () => {
      canceled = true;
    };
  }, [target.kind]);

  if (target.kind === 'model') {
    return (
      <ModelImportDialog
        open
        initial={{ repo: target.repo, ...(target.file ? { file: target.file } : {}) }}
        onClose={onClose}
      />
    );
  }
  if (target.kind === 'app') {
    return (
      <NewProjectDialog
        open
        mode="crew"
        initialTypeId={target.id}
        onClose={onClose}
        onCreated={(project) => {
          // Cached project reads are dropped before the new tab reads them.
          window.dispatchEvent(
            new CustomEvent('gezel:project-created', {
              detail: { id: project.id, name: project.name },
            }),
          );
          navigateToTab({ kind: 'project', id: project.id });
        }}
      />
    );
  }
  if (!launch) return null;
  return (
    <NewTaskDialog
      open
      quickLaunch
      initialCraftbookId={target.kind === 'craftbook' ? target.id : ''}
      defaultProjectId={launch.projectId}
      projects={launch.projects}
      gezels={launch.gezels}
      projectLocked
      onClose={onClose}
      onCreated={(task) => {
        navigateToTab({ kind: 'task', ref: task.ref });
      }}
    />
  );
}
