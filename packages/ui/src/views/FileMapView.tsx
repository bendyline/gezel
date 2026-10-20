import { useCallback, useState } from 'react';
import { ViewInspectorHost, type ViewSelection } from './project-views/ViewInspectorHost.js';
import { VillageView } from './project-views/village/VillageView.js';

export { reviewIssueLabel } from '../components/file-inspector/FileInspector.js';

/**
 * The Village on its own, with the shared file inspector beside it — the
 * same composition the project Views tab hosts, for surfaces that show the
 * Village without the rest of the tab.
 */
export function FileMapView({
  projectId,
  hasGitHub = false,
}: {
  projectId: string;
  /** Only a GitHub-linked project has pull requests; others answer 400. */
  hasGitHub?: boolean;
}) {
  const [selection, setSelection] = useState<ViewSelection | null>(null);
  const onSelectPath = useCallback(
    (path: string | null, opts?: { line?: number }) =>
      setSelection(path ? { path, ...(opts?.line ? { line: opts.line } : {}) } : null),
    [],
  );
  return (
    <ViewInspectorHost projectId={projectId} selection={selection} onSelectPath={onSelectPath}>
      {({ setInspectorExtras }) => (
        <VillageView
          projectId={projectId}
          hasGitHub={hasGitHub}
          selectedPath={selection?.path ?? null}
          onSelectPath={onSelectPath}
          setInspectorExtras={setInspectorExtras}
        />
      )}
    </ViewInspectorHost>
  );
}
