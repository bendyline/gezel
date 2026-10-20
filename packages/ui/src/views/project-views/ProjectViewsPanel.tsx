import type { BoekwachterIssue, ProjectDetail, ProjectViewId } from '@bendyline/gezel';
import { Suspense } from 'react';
import { Select } from '../../primitives/index.js';
import { ViewInspectorHost, type ViewSelection } from './ViewInspectorHost.js';
import { lazyProjectView, projectViewDefinition } from './registry.js';
import '../../styles/project-views.css';

/**
 * The body of the project Views tab: the current view with the shared file
 * inspector beside it. On a phone the tab shows only its icon, so the panel
 * names the view and offers the others in a picker of its own.
 */
export function ProjectViewsPanel({
  project,
  view,
  available,
  onChooseView,
  selection,
  onSelectPath,
  compact,
  onFixIssue,
}: {
  project: ProjectDetail;
  view: ProjectViewId;
  available: readonly ProjectViewId[];
  onChooseView: (view: ProjectViewId) => void;
  selection: ViewSelection | null;
  onSelectPath: (path: string | null, opts?: { line?: number }) => void;
  compact: boolean;
  onFixIssue?: (path: string, issue: BoekwachterIssue) => void;
}) {
  const definition = projectViewDefinition(view);
  const View = lazyProjectView(view);
  if (!definition || !View) return null;
  const viewLabel = `${definition.label} view`;

  return (
    <div className="project-views">
      {compact && available.length > 1 && (
        <div className="project-views-picker">
          <span className="project-views-picker-label">Showing</span>
          <Select.Root value={view} onValueChange={(next) => onChooseView(next as ProjectViewId)}>
            <Select.Trigger aria-label="Choose a view">
              <Select.Value />
            </Select.Trigger>
            <Select.Content>
              {available.map((id) => {
                const def = projectViewDefinition(id);
                return def ? (
                  <Select.Item key={id} value={id}>
                    {def.label} view
                  </Select.Item>
                ) : null;
              })}
            </Select.Content>
          </Select.Root>
        </div>
      )}
      <div className="project-views-body">
        <ViewInspectorHost
          projectId={project.id}
          selection={selection}
          onSelectPath={onSelectPath}
          compact={compact}
          backLabel={viewLabel}
          onFixIssue={onFixIssue}
        >
          {({ setInspectorExtras }) => (
            <Suspense fallback={null}>
              <View
                key={view}
                projectId={project.id}
                project={project}
                compact={compact}
                selectedPath={selection?.path ?? null}
                onSelectPath={onSelectPath}
                setInspectorExtras={setInspectorExtras}
              />
            </Suspense>
          )}
        </ViewInspectorHost>
      </div>
    </div>
  );
}
