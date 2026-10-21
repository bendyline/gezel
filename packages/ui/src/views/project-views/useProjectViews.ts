import {
  type ProjectDetail,
  type ProjectViewId,
  availableProjectViews,
  isKnownProjectView,
  resolveProjectView,
} from '@bendyline/gezel';
import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { api } from '../../api.js';
import type { FittedTabMenu } from '../../components/FittedTabsList.js';
import type { ProjectSectionTab } from '../../components/ProjectSectionTabs.js';
import {
  OPEN_PROJECT_VIEW_EVENT,
  type OpenProjectViewDetail,
} from '../../components/pending-project-section.js';
import type { ViewSelection } from './ViewInspectorHost.js';
import { OFFERED_PROJECT_VIEWS, preloadProjectView, projectViewDefinition } from './registry.js';

/**
 * The project Views tab's state: which views fit this project, which one is
 * showing, and the file selected in it. The choice lives on project.json
 * (`selectedView`) so it survives the desktop shell's moving origin; an
 * optimistic override shows it at once while the write lands.
 */
export function useProjectViews({
  project,
  setProject,
  onError,
  onOpenRequested,
}: {
  project: ProjectDetail | null;
  setProject: Dispatch<SetStateAction<ProjectDetail | null>>;
  onError: (message: string) => void;
  /** A link asked for the Views tab of the project on screen; switch to it. */
  onOpenRequested?: () => void;
}) {
  const available = useMemo(
    () => (project ? availableProjectViews(project, OFFERED_PROJECT_VIEWS) : []),
    [project],
  );
  const [override, setOverride] = useState<{ projectId: string; view: ProjectViewId } | null>(null);
  const storedView =
    override && override.projectId === project?.id ? override.view : project?.selectedView;
  const view = project
    ? resolveProjectView({ ...project, selectedView: storedView }, available)
    : null;

  const chooseView = useCallback(
    (next: ProjectViewId) => {
      if (!project || next === view) return;
      const projectId = project.id;
      setOverride({ projectId, view: next });
      void api
        .updateProject(projectId, { selectedView: next })
        .then((updated) => {
          setProject((current) => (current?.id === projectId ? updated : current));
        })
        .catch((err: unknown) => onError(err instanceof Error ? err.message : String(err)));
    },
    [onError, project, setProject, view],
  );

  // The file selected in the Views tab, kept here so it outlives a switch of
  // view (and of tab) within the same project.
  const [selection, setSelection] = useState<(ViewSelection & { projectId: string }) | null>(null);
  const selectPath = useCallback(
    (path: string | null, opts?: { line?: number }) => {
      if (!project) return;
      setSelection(
        path ? { projectId: project.id, path, ...(opts?.line ? { line: opts.line } : {}) } : null,
      );
    },
    [project],
  );
  const currentSelection = selection && selection.projectId === project?.id ? selection : null;

  // A request to show a view (and select a file), from the section mailbox
  // or the live event. Held until its project is the one on screen, because
  // it can arrive while the project is still loading.
  const [request, setRequest] = useState<OpenProjectViewDetail | null>(null);
  useEffect(() => {
    if (!request || !project || request.projectId !== project.id) return;
    setRequest(null);
    if (isKnownProjectView(request.view) && available.includes(request.view)) {
      chooseView(request.view);
    }
    if (request.path) setSelection({ projectId: project.id, path: request.path });
  }, [available, chooseView, project, request]);

  useEffect(() => {
    const onOpen = (event: Event) => {
      const detail = (event as CustomEvent<OpenProjectViewDetail>).detail;
      if (!detail?.projectId || detail.projectId !== project?.id) return;
      setRequest(detail);
      onOpenRequested?.();
    };
    window.addEventListener(OPEN_PROJECT_VIEW_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_PROJECT_VIEW_EVENT, onOpen);
  }, [onOpenRequested, project?.id]);

  const definition = view ? projectViewDefinition(view) : undefined;
  const menu: FittedTabMenu | undefined =
    view && available.length > 1
      ? {
          label: 'Choose a view',
          value: view,
          items: available.flatMap((id) => {
            const def = projectViewDefinition(id);
            return def ? [{ value: id, label: def.label, hint: def.hint, icon: def.icon }] : [];
          }),
          onSelect: (next) => chooseView(next as ProjectViewId),
          onPreview: (next) => preloadProjectView(next as ProjectViewId),
        }
      : undefined;
  const tabItem: ProjectSectionTab = {
    value: 'map',
    label: definition ? `${definition.label} view` : 'Views',
    icon: definition?.icon ?? 'village',
    ...(menu ? { menu } : {}),
  };

  return {
    available,
    view,
    chooseView,
    tabItem,
    selection: currentSelection,
    selectPath,
    /** Apply a request the section mailbox held for a project being opened. */
    queueRequest: setRequest,
  };
}
