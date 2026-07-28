import { FolderView } from '@bendyline/squisq-editor-react';
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { type FileEntry, FileTree } from '../components/FileTree.js';
import { NewPathDialog } from '../components/NewPathDialog.js';
import { useEffectiveTheme } from '../theme.js';
import { DocumentDetail } from './DocumentDetail.js';

const SELECTED_DOC_STORAGE_KEY = 'gezel:documents:selectedPath';

function loadSelectedPath(): string | null {
  try {
    return window.localStorage.getItem(SELECTED_DOC_STORAGE_KEY);
  } catch {
    return null;
  }
}

function persistSelectedPath(path: string | null) {
  try {
    if (path) window.localStorage.setItem(SELECTED_DOC_STORAGE_KEY, path);
    else window.localStorage.removeItem(SELECTED_DOC_STORAGE_KEY);
  } catch {
    /* private mode / quota — fine to ignore */
  }
}

export function DocumentsView() {
  const editorTheme = useEffectiveTheme();
  const [entries, setEntries] = useState<FileEntry[]>([]);
  // Distinguishes "no documents" from "not loaded yet" so a persisted folder
  // selection doesn't briefly render the document editor (and a failed read)
  // before `entries` arrive and reveal that the path is a directory.
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string>('');
  const [showNewDoc, setShowNewDoc] = useState(false);
  const [showNewFolder, setShowNewFolder] = useState(false);
  // Seed value for the New document / New folder dialogs — a `folder/` prefix
  // when the action is launched from a selected folder, empty from the toolbar.
  const [newPathPrefix, setNewPathPrefix] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<FileEntry | null>(null);
  // Selected document for the right pane. Persisted in localStorage so the
  // selection survives switching to another tab and back (TabContent
  // remounts on key change) and across app restarts.
  const [selectedPath, setSelectedPathState] = useState<string | null>(() => loadSelectedPath());

  const setSelectedPath = useCallback((path: string | null) => {
    setSelectedPathState(path);
    persistSelectedPath(path);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const res = await api.listDocuments('', true);
      setEntries(res.files);
      setLoaded(true);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const selectDocument = useCallback(
    (entry: FileEntry) => {
      // Folders are selectable too (FileTree's `selectableFolders`): selecting
      // one shows the FolderView on the right; selecting a file opens it.
      setSelectedPath(entry.path);
    },
    [setSelectedPath],
  );

  // Land on the first document instead of an empty pane. Only when there is
  // no (surviving) stored selection — a user's pick or a deep link wins.
  // Uses the transient setter: an auto-pick shouldn't overwrite the
  // persisted selection slot.
  useEffect(() => {
    if (entries.length === 0) return;
    const firstFile = entries.find((e) => !e.isDirectory) ?? entries[0];
    if (!firstFile) return;
    setSelectedPathState((currentPath) => {
      // This effect may have been queued before a user selection. Resolve
      // against the latest state so the initial auto-pick cannot overwrite
      // a click that happened while the document list was settling.
      if (currentPath && entries.some((entry) => entry.path === currentPath)) {
        return currentPath;
      }
      return firstFile.path;
    });
  }, [entries]);

  const deleteDocument = useCallback((entry: FileEntry) => {
    setDeleteTarget(entry);
  }, []);

  const confirmDelete = useCallback(async () => {
    const entry = deleteTarget;
    if (!entry) return;
    try {
      await api.deleteDocument(entry.path);
      window.dispatchEvent(
        new CustomEvent('gezel:document-deleted', { detail: { path: entry.path } }),
      );
      // If the deleted entry was the right-pane selection (or contained it
      // when a folder is removed), clear the pane.
      if (
        selectedPath &&
        (selectedPath === entry.path || selectedPath.startsWith(`${entry.path}/`))
      ) {
        setSelectedPath(null);
      }
      await refresh();
    } catch (err) {
      setStatus(`delete failed: ${(err as Error).message}`);
    } finally {
      setDeleteTarget(null);
    }
  }, [deleteTarget, refresh, selectedPath, setSelectedPath]);

  const openNewDoc = useCallback((prefix = '') => {
    setNewPathPrefix(prefix);
    setShowNewDoc(true);
  }, []);
  const closeNewDoc = useCallback(() => setShowNewDoc(false), []);

  const handleCreateDoc = useCallback(
    async (path: string) => {
      const clean = path.trim();
      if (!clean) return;
      try {
        await api.writeDocument(clean, '');
        closeNewDoc();
        await refresh();
        setSelectedPath(clean);
        // Tell other surfaces (the sidebar's Documents tree) to refresh so
        // the new doc shows up there too — they don't poll.
        window.dispatchEvent(
          new CustomEvent('gezel:document-created', { detail: { path: clean } }),
        );
      } catch (err) {
        setStatus(`create failed: ${(err as Error).message}`);
      }
    },
    [closeNewDoc, refresh, setSelectedPath],
  );

  const openNewFolder = useCallback((prefix = '') => {
    setNewPathPrefix(prefix);
    setShowNewFolder(true);
  }, []);
  const closeNewFolder = useCallback(() => setShowNewFolder(false), []);

  const handleCreateFolder = useCallback(
    async (path: string) => {
      const clean = path.trim();
      if (!clean) return;
      try {
        await api.createDocumentFolder(clean);
        closeNewFolder();
        await refresh();
        window.dispatchEvent(
          new CustomEvent('gezel:document-created', { detail: { path: clean } }),
        );
      } catch (err) {
        setStatus(`create folder failed: ${(err as Error).message}`);
      }
    },
    [closeNewFolder, refresh],
  );

  // Resolve the current selection against the loaded entries to decide which
  // right-pane surface to show (folder browser vs. document editor).
  const selectedEntry = useMemo(
    () => (selectedPath ? (entries.find((e) => e.path === selectedPath) ?? null) : null),
    [entries, selectedPath],
  );
  const selectedIsDir = selectedEntry?.isDirectory ?? false;
  const selectedName = selectedPath ? selectedPath.slice(selectedPath.lastIndexOf('/') + 1) : '';
  // Immediate children of the selected folder (one level deep).
  const folderChildren = useMemo(() => {
    if (!selectedPath || !selectedIsDir) return [];
    const prefix = `${selectedPath}/`;
    return entries.filter(
      (e) => e.path.startsWith(prefix) && !e.path.slice(prefix.length).includes('/'),
    );
  }, [entries, selectedPath, selectedIsDir]);

  let rightPane: ReactNode;
  if (!selectedPath) {
    rightPane = <p className="placeholder">Select a document or folder on the left to view it.</p>;
  } else if (selectedIsDir) {
    rightPane = (
      <FolderView
        name={selectedName}
        entries={folderChildren}
        theme={editorTheme}
        onOpenFile={(e) => setSelectedPath(e.path)}
        onOpenFolder={(e) => setSelectedPath(e.path)}
        onNewDocument={() => openNewDoc(`${selectedPath}/`)}
        onNewFolder={() => openNewFolder(`${selectedPath}/`)}
      />
    );
  } else if (selectedEntry) {
    rightPane = <DocumentDetail key={selectedPath} path={selectedPath} />;
  } else if (loaded) {
    // Selection no longer exists (e.g. deleted elsewhere) — fall back.
    rightPane = <p className="placeholder">Select a document or folder on the left to view it.</p>;
  } else {
    rightPane = <p className="placeholder">Loading…</p>;
  }

  return (
    <div className="documents-listing" data-testid="documents-view">
      <NewPathDialog
        open={showNewDoc}
        title="New document"
        placeholder="e.g. guidelines/coding.md"
        submitLabel="Create"
        initialValue={newPathPrefix}
        onSubmit={handleCreateDoc}
        onCancel={closeNewDoc}
      />
      <NewPathDialog
        open={showNewFolder}
        title="New folder"
        placeholder="e.g. guidelines"
        submitLabel="Create"
        initialValue={newPathPrefix}
        onSubmit={handleCreateFolder}
        onCancel={closeNewFolder}
      />
      <div className="documents-split">
        <aside className="documents-tree">
          <div className="area-toolbar">
            {status && <span className="area-toolbar-status">{status}</span>}
            <div className="area-toolbar-actions">
              <button
                type="button"
                className="area-toolbar-btn area-toolbar-icon-btn"
                aria-label="New folder"
                title="New folder"
                onClick={() => openNewFolder()}
              >
                {/* biome-ignore lint/a11y/noAriaHiddenOnFocusable: decorative icon, not focusable */}
                <i className="fa-solid fa-folder-plus" aria-hidden="true" />
              </button>
              <button
                type="button"
                className="area-toolbar-btn area-toolbar-icon-btn"
                aria-label="New document"
                title="New document"
                onClick={() => openNewDoc()}
              >
                {/* biome-ignore lint/a11y/noAriaHiddenOnFocusable: decorative icon, not focusable */}
                <i className="fa-solid fa-file-circle-plus" aria-hidden="true" />
              </button>
            </div>
          </div>
          <div className="documents-tree-list">
            {entries.length === 0 ? (
              <p className="muted" style={{ padding: '0.5rem', fontSize: '0.85rem' }}>
                No documents yet. Create a mission statement, coding guidelines, or any shared
                reference.
              </p>
            ) : (
              <FileTree
                entries={entries}
                onSelect={(e) => selectDocument(e)}
                onDelete={(e) => deleteDocument(e)}
                selectedPath={selectedPath ?? undefined}
                selectableFolders
              />
            )}
          </div>
        </aside>
        <section className="documents-detail">{rightPane}</section>
      </div>
      {error && <p className="error">{error}</p>}

      <ConfirmDialog
        open={deleteTarget !== null}
        title={deleteTarget?.isDirectory ? 'Delete folder?' : 'Delete document?'}
        message={
          deleteTarget?.isDirectory
            ? `This will remove "${deleteTarget.path}" and everything inside it. This cannot be undone.`
            : deleteTarget
              ? `"${deleteTarget.path}" will be permanently removed.`
              : ''
        }
        confirmLabel="Delete"
        danger
        onCancel={() => setDeleteTarget(null)}
        onConfirm={confirmDelete}
      />
    </div>
  );
}
