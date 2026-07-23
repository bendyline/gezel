import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { formatFolderLabel } from './terminal-folder-label.js';

interface FolderNode {
  path: string;
  name: string;
  depth: number;
}

/**
 * Folder picker for terminal mode. A one-line trigger (label + current
 * folder + refresh) that opens a popup with the indented workspace
 * tree on click. The trigger is what carries the user value when the
 * popup is closed; the popup only surfaces while picking.
 *
 * Folder data comes from `listProjectWorkspace(recursive)`, which the
 * indexer already caps at `maxEntries: 500` / `maxDepth: 6` and skips
 * `node_modules` / `dist` / `.git`, so the listing stays manageable
 * for normal projects without expand/collapse machinery.
 */
export function FolderTreeSwitcher({
  projectId,
  workingDir,
  onChangeWorkingDir,
}: {
  projectId: string;
  workingDir: string;
  onChangeWorkingDir: (next: string) => void;
}) {
  const [folders, setFolders] = useState<FolderNode[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Re-fetch whenever the popup opens (and once on mount via the
  // initial render). Cheap on the server side and keeps the list
  // fresh after the user creates a new folder elsewhere, without
  // needing a manual refresh button on the row. `folders.length`
  // is read inside but intentionally NOT in the deps — listing it
  // would re-trigger the effect on every fetch result, defeating
  // the "only refetch on open" intent.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see comment above
  useEffect(() => {
    if (!open && folders.length > 0) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await api.listProjectWorkspace(projectId, undefined, true);
        if (cancelled) return;
        const nodes: FolderNode[] = res.files
          .filter((f) => f.isDirectory)
          .map((f) => {
            const depth = f.path.split('/').length - 1;
            return { path: f.path, name: f.name, depth };
          });
        nodes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
        setFolders(nodes);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, open]);

  // Close the popup on any click outside the container. Bound only
  // while open so an idle picker doesn't sit on a global listener.
  useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [open]);

  const allRows: FolderNode[] = useMemo(
    () => [{ path: '', name: '/', depth: 0 }, ...folders],
    [folders],
  );

  const currentLabel = formatFolderLabel(workingDir);

  return (
    <div className="folder-tree-switcher" ref={containerRef}>
      <span className="folder-tree-label">Folder:</span>
      <button
        type="button"
        className="folder-tree-trigger"
        onClick={() => setOpen((v) => !v)}
        title="Pick a working folder"
        aria-expanded={open}
      >
        <span className="folder-tree-trigger-value">{currentLabel}</span>
        <span className="folder-tree-trigger-caret">▾</span>
      </button>
      {open && (
        // biome-ignore lint/a11y/useSemanticElements: a native <select> can't render the indented project-tree layout this picker needs (variable depth, custom row styling, hover affordances).
        // biome-ignore lint/a11y/useFocusableInteractive: keyboard navigation belongs on the trigger button above; the popup is mouse-driven for the v1 picker. Outside-click + selection both close it.
        <div className="folder-tree-popup" role="listbox">
          {error && <div className="terminal-error-banner">{error}</div>}
          {allRows.map((node) => {
            const active = node.path === workingDir;
            return (
              <button
                key={node.path || '__root__'}
                type="button"
                // biome-ignore lint/a11y/useSemanticElements: paired with the listbox biome-ignore above; <option> would lose our custom row affordances.
                role="option"
                aria-selected={active}
                className={`folder-tree-node${active ? ' active' : ''}`}
                style={{ paddingLeft: `${0.4 + node.depth * 0.9}rem` }}
                onClick={() => {
                  onChangeWorkingDir(node.path);
                  setOpen(false);
                }}
                title={node.path || '/'}
              >
                <span>{node.path === '' ? '/' : node.name}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
