import type { BoekwachterIssue } from '@bendyline/gezel';
import { type ReactNode, useCallback, useMemo, useState } from 'react';
import { FileInspector } from '../../components/file-inspector/FileInspector.js';
import { InspectorLayout } from '../../components/file-inspector/InspectorLayout.js';
import type { InspectorExtras } from './types.js';

/** A selected file, and the line the view asked to show. */
export interface ViewSelection {
  path: string;
  line?: number;
}

/**
 * Hangs the shared file inspector beside one view. The selection is owned
 * by the caller (so it can outlive the view); what the view knows about the
 * selected file arrives through `setInspectorExtras`.
 */
export function ViewInspectorHost({
  projectId,
  selection,
  onSelectPath,
  compact = false,
  backLabel,
  onFixIssue,
  children,
}: {
  projectId: string;
  selection: ViewSelection | null;
  onSelectPath: (path: string | null, opts?: { line?: number }) => void;
  compact?: boolean;
  backLabel?: string;
  onFixIssue?: (path: string, issue: BoekwachterIssue) => void;
  children: (host: { setInspectorExtras: (extras: InspectorExtras | null) => void }) => ReactNode;
}) {
  const [extras, setExtras] = useState<InspectorExtras | null>(null);
  const setInspectorExtras = useCallback((next: InspectorExtras | null) => setExtras(next), []);
  // A fresh object per selection, so picking the same line twice reveals it twice.
  const sourceReveal = useMemo(
    () => (selection?.line ? { path: selection.path, line: selection.line } : null),
    [selection],
  );
  const selectWithin = useCallback(
    (path: string, line?: number) => onSelectPath(path, line ? { line } : undefined),
    [onSelectPath],
  );
  const close = useCallback(() => onSelectPath(null), [onSelectPath]);
  // The view updates its extras in an effect after a selection changes;
  // until then they still describe the previous file.
  const about = selection && extras?.forPath === selection.path ? extras : null;

  return (
    <InspectorLayout
      compact={compact}
      backLabel={backLabel}
      onBack={close}
      main={children({ setInspectorExtras })}
      inspector={
        selection ? (
          <FileInspector
            projectId={projectId}
            path={selection.path}
            known={about?.known}
            chips={about?.chips}
            connections={about?.connections}
            sourceReveal={sourceReveal}
            onSelectPath={selectWithin}
            onClose={close}
            onFindingsChanged={extras?.onFindingsChanged}
            onFixIssue={onFixIssue}
            revision={extras?.revision}
          />
        ) : null
      }
    />
  );
}
