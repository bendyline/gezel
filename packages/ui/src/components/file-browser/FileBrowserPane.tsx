import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useCallback,
  useRef,
  useState,
} from 'react';
import { formatAbsoluteTime } from '../../relative-time.js';
import { FileFlatList } from '../FileFlatList.js';
import { type FileEntry, FileTree, type FileTreeAction } from '../FileTree.js';
import { FileHiddenKey, FileRevealKey, FileViewModeKeys } from '../FileViewModeKeys.js';
import {
  type FileViewMode,
  compareFilesByMtimeDesc,
  formatRelativeFileTime,
} from '../file-view-modes.js';
import type { FileBrowserSource } from './source.js';
import type { FileMutations } from './useFileMutations.js';

// File-tree pane width for every file browser. Stored in pixels rather than
// as a fraction of the layout: the useful width of a file tree is set by how
// long filenames are, not by how wide the window is, and the collapse
// threshold below is a physical size for the same reason. Shared across
// projects, tabs, and the documents library.
const FILE_TREE_WIDTH_STORAGE_KEY = 'gezel:project-file-tree-width:v1';
const FILE_TREE_COLLAPSED_STORAGE_KEY = 'gezel:project-file-tree-collapsed:v1';
const MIN_FILE_TREE_WIDTH = 150;
const MAX_FILE_TREE_WIDTH = 560;
const DEFAULT_FILE_TREE_WIDTH = 240;
// Below this the tree can no longer show a filename, so the drag snaps to
// the collapsed rail instead of leaving an unreadable sliver.
const FILE_TREE_COLLAPSE_WIDTH = 100;
const FILE_TREE_RAIL_WIDTH = 34;

export function clampFileTreeWidth(px: number): number {
  if (!Number.isFinite(px)) return DEFAULT_FILE_TREE_WIDTH;
  return Math.max(MIN_FILE_TREE_WIDTH, Math.min(MAX_FILE_TREE_WIDTH, Math.round(px)));
}

function readStoredFileTreeWidth(): number {
  if (typeof window === 'undefined') return DEFAULT_FILE_TREE_WIDTH;
  try {
    const raw = window.localStorage.getItem(FILE_TREE_WIDTH_STORAGE_KEY);
    if (!raw) return DEFAULT_FILE_TREE_WIDTH;
    return clampFileTreeWidth(Number.parseFloat(raw));
  } catch {
    return DEFAULT_FILE_TREE_WIDTH;
  }
}

function readStoredFileTreeCollapsed(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(FILE_TREE_COLLAPSED_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

/** A list branch the host supplies for a mode this shell does not compute itself. */
export interface FileBrowserCustomList {
  entries: FileEntry[];
  trailingForEntry?: (entry: FileEntry) => ReactNode;
  emptyMessage: string;
  onSelect?: (entry: FileEntry) => void;
}

export interface FileBrowserPaneProps {
  source: FileBrowserSource;
  entries: FileEntry[];
  truncated?: boolean;
  viewMode: FileViewMode;
  modes: readonly FileViewMode[];
  onViewModeChange: (mode: FileViewMode) => void;
  showHidden: boolean;
  onShowHiddenChange: (next: boolean) => void;
  selectedPath?: string;
  onSelect: (entry: FileEntry) => void;
  selectableFolders?: boolean;
  labelFor?: (entry: FileEntry) => string;
  emptyMessage: ReactNode;
  mutations: FileMutations;
  /** The right-hand pane: viewer, editor, or folder browser. */
  viewer: ReactNode;
  /** Optional fourth column (the workspace's index/review pane). */
  extraPane?: ReactNode;
  /** Status/summary chip rendered in the tree header (index state). */
  headerExtra?: ReactNode;
  /** Notices between the header and the list (index freshness). */
  notices?: ReactNode;
  trailingForEntry?: (entry: FileEntry) => ReactNode;
  actionsForEntry?: (entry: FileEntry) => readonly FileTreeAction[];
  /** Replaces the computed list for host-owned modes (the issue triage views). */
  customList?: FileBrowserCustomList | null;
  /** Extra class on the layout root, e.g. `project-files-layout-workspace`. */
  layoutClassName?: string;
}

/**
 * The one file browser: a resizable, collapsible tree beside a viewer.
 *
 * Every surface that browses a tree of files — the project Workspace, the
 * project Artifacts drawer, and the global Documents library — renders this
 * component against a `FileBrowserSource`. Panels differ only in what their
 * source can do and which extras they slot in; the layout, view modes, hidden
 * toggle, mutations, and truncation reporting are shared so the surfaces
 * cannot drift apart again.
 */
export function FileBrowserPane({
  source,
  entries,
  truncated,
  viewMode,
  modes,
  onViewModeChange,
  showHidden,
  onShowHiddenChange,
  selectedPath,
  onSelect,
  selectableFolders,
  labelFor,
  emptyMessage,
  mutations,
  viewer,
  extraPane,
  headerExtra,
  notices,
  trailingForEntry,
  actionsForEntry,
  customList,
  layoutClassName,
}: FileBrowserPaneProps) {
  const [width, setWidth] = useState<number>(() => readStoredFileTreeWidth());
  const [collapsed, setCollapsed] = useState<boolean>(() => readStoredFileTreeCollapsed());
  const dragState = useRef<{ startX: number; startWidth: number } | null>(null);

  const commitWidth = useCallback((next: number) => {
    const clamped = clampFileTreeWidth(next);
    setWidth(clamped);
    try {
      window.localStorage.setItem(FILE_TREE_WIDTH_STORAGE_KEY, String(clamped));
    } catch {
      /* quota / private mode — state still in memory */
    }
  }, []);
  const commitCollapsed = useCallback((next: boolean) => {
    setCollapsed(next);
    try {
      window.localStorage.setItem(FILE_TREE_COLLAPSED_STORAGE_KEY, next ? '1' : '0');
    } catch {
      /* quota / private mode — state still in memory */
    }
  }, []);

  const onGripMouseDown = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      e.preventDefault();
      dragState.current = {
        startX: e.clientX,
        startWidth: collapsed ? FILE_TREE_RAIL_WIDTH : width,
      };
      document.body.classList.add('chat-rail-resizing');
      document.body.style.cursor = 'col-resize';
      const onMove = (ev: MouseEvent) => {
        const st = dragState.current;
        if (!st) return;
        const next = st.startWidth + (ev.clientX - st.startX);
        if (next < FILE_TREE_COLLAPSE_WIDTH) {
          commitCollapsed(true);
          return;
        }
        commitCollapsed(false);
        commitWidth(next);
      };
      const onUp = () => {
        dragState.current = null;
        document.body.style.cursor = '';
        document.body.classList.remove('chat-rail-resizing');
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [collapsed, commitCollapsed, commitWidth, width],
  );

  const onGripKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      const step = e.shiftKey ? 24 : 8;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        const delta = e.key === 'ArrowLeft' ? -step : step;
        if (collapsed) {
          if (delta < 0) return;
          commitCollapsed(false);
          return;
        }
        const next = width + delta;
        if (next < FILE_TREE_COLLAPSE_WIDTH) {
          commitCollapsed(true);
          return;
        }
        commitWidth(next);
      } else if (e.key === 'Home') {
        e.preventDefault();
        commitCollapsed(false);
        commitWidth(MAX_FILE_TREE_WIDTH);
      } else if (e.key === 'End') {
        e.preventDefault();
        commitCollapsed(true);
      }
    },
    [collapsed, commitCollapsed, commitWidth, width],
  );

  const treeMode = viewMode === 'tree-alpha' || viewMode === 'tree-modified';
  const flatModified = viewMode === 'flat-modified' && !customList;
  const flatEntries = flatModified
    ? entries
        .filter((entry) => !entry.isDirectory)
        .slice()
        .sort(compareFilesByMtimeDesc)
    : [];

  const listLabel = source.title.toLowerCase();

  return (
    <div
      className={`project-files-layout has-tree-grip${collapsed ? ' tree-collapsed' : ''}${
        extraPane ? ' has-index-pane' : ''
      }${layoutClassName ? ` ${layoutClassName}` : ''}`}
      style={{ ['--file-tree-user-width' as string]: `${width}px` }}
    >
      {mutations.dialogs}
      {collapsed && (
        <div className="file-tree-panel file-tree-panel-collapsed">
          <button
            type="button"
            className="file-tree-expand-btn"
            onClick={() => commitCollapsed(false)}
            aria-expanded={false}
            aria-label={`Show ${source.title} files`}
            title={`Show ${source.title} files`}
          >
            <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
              <path
                d="M6 3.5 10.5 8 6 12.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span className="file-tree-collapsed-label">{source.title}</span>
          </button>
        </div>
      )}
      {!collapsed && (
        <div
          className={`file-tree-panel document-drop-zone${
            mutations.activeDropZone === 'tree' ? ' document-drop-zone-active' : ''
          }`}
          {...mutations.dropZoneProps('tree', '')}
        >
          <div className="file-tree-header">
            <span className="file-tree-title">{source.title}</span>
            {/* Create actions ride the title row rather than the key toolbar:
                at the pane's default width the workspace's five view-mode keys
                already fill a row on their own. */}
            <div className="file-tree-header-actions">
              {(mutations.newFolder || mutations.newFile) && (
                <div className="gz-tray file-create-tray">
                  {mutations.newFolder && (
                    <button
                      type="button"
                      className="gz-key gz-key--icon"
                      aria-label="New folder"
                      title="New folder"
                      onClick={() => mutations.newFolder?.()}
                    >
                      {/* biome-ignore lint/a11y/noAriaHiddenOnFocusable: decorative icon, not focusable */}
                      <i className="fa-solid fa-folder-plus" aria-hidden="true" />
                    </button>
                  )}
                  {mutations.newFile && (
                    <button
                      type="button"
                      className="gz-key gz-key--icon"
                      aria-label={source.kind === 'documents' ? 'New document' : 'New file'}
                      title={source.kind === 'documents' ? 'New document' : 'New file'}
                      onClick={() => mutations.newFile?.()}
                    >
                      {/* biome-ignore lint/a11y/noAriaHiddenOnFocusable: decorative icon, not focusable */}
                      <i className="fa-solid fa-file-circle-plus" aria-hidden="true" />
                    </button>
                  )}
                </div>
              )}
            </div>
            {headerExtra}
            <div className="file-tree-toolbar">
              <FileViewModeKeys value={viewMode} modes={modes} onChange={onViewModeChange} />
              <FileHiddenKey kind={source.kind} value={showHidden} onChange={onShowHiddenChange} />
              {source.reveal && <FileRevealKey onReveal={() => void source.reveal?.()} />}
            </div>
          </div>
          {mutations.status && <output className="file-tree-status">{mutations.status}</output>}
          {notices}
          <div className="file-tree">
            {customList ? (
              <FileFlatList
                entries={customList.entries}
                selectedPath={selectedPath}
                onSelect={customList.onSelect ?? onSelect}
                trailingForEntry={customList.trailingForEntry}
                emptyMessage={customList.emptyMessage}
              />
            ) : treeMode ? (
              entries.length === 0 ? (
                <p className="muted" style={{ padding: '0.5rem', fontSize: '0.85rem' }}>
                  {emptyMessage}
                </p>
              ) : (
                <FileTree
                  entries={entries}
                  selectedPath={selectedPath}
                  sortMode={viewMode === 'tree-modified' ? 'modified' : 'alpha'}
                  labelFor={labelFor}
                  selectableFolders={selectableFolders}
                  onSelect={onSelect}
                  onRename={mutations.rename}
                  onDelete={mutations.remove}
                  trailingForEntry={trailingForEntry}
                  actionsForEntry={actionsForEntry}
                />
              )
            ) : (
              <FileFlatList
                entries={flatEntries}
                selectedPath={selectedPath}
                onSelect={onSelect}
                trailingForEntry={(entry) =>
                  entry.mtimeMs !== undefined ? (
                    <span
                      className="file-flat-time"
                      title={formatAbsoluteTime(new Date(entry.mtimeMs))}
                    >
                      {formatRelativeFileTime(new Date(entry.mtimeMs).toISOString())}
                    </span>
                  ) : null
                }
                emptyMessage={`No ${listLabel} files yet.`}
              />
            )}
            {!customList && truncated && (
              <p className="muted" style={{ padding: '0.5rem', fontSize: '0.8rem' }}>
                This folder has more files than can be shown — the listing is incomplete.
                {source.reveal ? ' Use "Open in file manager" above to browse everything.' : ''}
              </p>
            )}
          </div>
          {mutations.activeDropZone === 'tree' && (
            <div className="document-drop-overlay" aria-hidden="true">
              <i className="fa-solid fa-file-arrow-down" />
              <span>Drop to add to {source.title}</span>
            </div>
          )}
        </div>
      )}

      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={`Resize ${listLabel} files`}
        tabIndex={0}
        className="chat-rail-grip file-tree-grip"
        onMouseDown={onGripMouseDown}
        onKeyDown={onGripKeyDown}
        onDoubleClick={() => commitCollapsed(!collapsed)}
      />

      <div
        className={`file-viewer-panel document-drop-zone${
          mutations.activeDropZone === 'detail' ? ' document-drop-zone-active' : ''
        }`}
        {...mutations.dropZoneProps('detail', dropDestination(selectedPath, entries))}
      >
        {viewer}
        {mutations.activeDropZone === 'detail' && (
          <div className="document-drop-overlay" aria-hidden="true">
            <i className="fa-solid fa-file-arrow-down" />
            <span>Drop to add to {dropLabel(selectedPath, entries, source.title)}</span>
          </div>
        )}
      </div>
      {extraPane}
    </div>
  );
}

function parentDirectory(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
}

/** A drop on the viewer lands beside what it is showing, not at the root. */
function dropDestination(selectedPath: string | undefined, entries: readonly FileEntry[]): string {
  if (!selectedPath) return '';
  const entry = entries.find((candidate) => candidate.path === selectedPath);
  return entry?.isDirectory ? selectedPath : parentDirectory(selectedPath);
}

function dropLabel(
  selectedPath: string | undefined,
  entries: readonly FileEntry[],
  fallback: string,
): string {
  const destination = dropDestination(selectedPath, entries);
  return destination ? destination.slice(destination.lastIndexOf('/') + 1) : fallback;
}
