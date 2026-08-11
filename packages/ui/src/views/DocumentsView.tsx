import { FolderView } from '@bendyline/squisq-editor-react';
import {
  type DragEvent as ReactDragEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { api } from '../api.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { type FileEntry, FileTree } from '../components/FileTree.js';
import { NewPathDialog } from '../components/NewPathDialog.js';
import {
  chooseOutsideInSource,
  importDroppedDocumentFiles,
  isOutsideInInternalPath,
  resolveOutsideInLayout,
  withOutsideInMetadata,
} from '../components/SquisqIntegration/index.js';
import { documentLabel } from '../components/document-label.js';
import { flushSerializedAutosave } from '../hooks/useSerializedAutosave.js';
import { useEffectiveTheme } from '../theme.js';
import { DocumentDetail } from './DocumentDetail.js';

const SELECTED_DOC_STORAGE_KEY = 'gezel:documents:selectedPath';

function renameSuffix(entry: FileEntry | null): string | undefined {
  if (!entry || entry.isDirectory) return undefined;
  return !entry.name.includes('.') || /\.md$/i.test(entry.name) ? '.md' : undefined;
}

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

function parentDirectory(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
}

function isFileDrag(event: ReactDragEvent<HTMLElement>): boolean {
  return Array.from(event.dataTransfer.types).includes('Files');
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
  const [renameTarget, setRenameTarget] = useState<FileEntry | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [activeDropZone, setActiveDropZone] = useState<'tree' | 'detail' | null>(null);
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

  // Outside-in companion folders contain editable Markdown, media, versions,
  // and the recovery copy for a visible Office/PDF/HTML document. They travel
  // with that document but are implementation detail, not extra library rows.
  const visibleEntries = useMemo(
    () => entries.filter((entry) => !isOutsideInInternalPath(entry.path)),
    [entries],
  );

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
    if (visibleEntries.length === 0) return;
    const firstFile = visibleEntries.find((e) => !e.isDirectory) ?? visibleEntries[0];
    if (!firstFile) return;
    setSelectedPathState((currentPath) => {
      // This effect may have been queued before a user selection. Resolve
      // against the latest state so the initial auto-pick cannot overwrite
      // a click that happened while the document list was settling.
      if (currentPath && visibleEntries.some((entry) => entry.path === currentPath)) {
        return currentPath;
      }
      return firstFile.path;
    });
  }, [visibleEntries]);

  const deleteDocument = useCallback((entry: FileEntry) => {
    setDeleteTarget(entry);
  }, []);

  const renameDocument = useCallback((entry: FileEntry) => {
    setRenameError(null);
    setRenameTarget(entry);
  }, []);

  const confirmDelete = useCallback(async () => {
    const entry = deleteTarget;
    if (!entry) return;
    try {
      if (
        selectedPath &&
        (selectedPath === entry.path || selectedPath.startsWith(`${entry.path}/`))
      ) {
        await flushSerializedAutosave(`document:${selectedPath}`);
        const layout = resolveOutsideInLayout(selectedPath);
        if (layout) {
          await flushSerializedAutosave(`outside-in:documents:${layout.markdownPath}`);
        }
      }
      await api.deleteDocument(entry.path);
      const layout = entry.isDirectory ? null : resolveOutsideInLayout(entry.path);
      if (layout) await api.deleteDocument(layout.companionDirectory);
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

  const confirmRename = useCallback(
    async (newName: string) => {
      const entry = renameTarget;
      if (!entry) return;
      const cleanName = newName.trim();
      if (!cleanName || /[\\/]/.test(cleanName)) {
        setRenameError('Enter a name without slashes.');
        return;
      }
      const slash = entry.path.lastIndexOf('/');
      const parent = slash >= 0 ? entry.path.slice(0, slash + 1) : '';
      const toPath = `${parent}${cleanName}`;
      if (toPath === entry.path) {
        setRenameTarget(null);
        setRenameError(null);
        return;
      }
      const oldLayout = entry.isDirectory ? null : resolveOutsideInLayout(entry.path);
      const nextLayout = entry.isDirectory ? null : resolveOutsideInLayout(toPath);
      if (oldLayout && nextLayout?.format !== oldLayout.format) {
        setRenameError(`Keep the .${oldLayout.format} extension when renaming this document.`);
        return;
      }
      if (
        oldLayout &&
        nextLayout &&
        entries.some(
          (candidate) =>
            candidate.path === toPath ||
            candidate.path === nextLayout.companionDirectory ||
            candidate.path.startsWith(`${nextLayout.companionDirectory}/`),
        )
      ) {
        setRenameError('A document or companion folder with that name already exists.');
        return;
      }

      try {
        if (
          selectedPath &&
          (selectedPath === entry.path || selectedPath.startsWith(`${entry.path}/`))
        ) {
          await flushSerializedAutosave(`document:${selectedPath}`);
          if (oldLayout) {
            await flushSerializedAutosave(`outside-in:documents:${oldLayout.markdownPath}`);
          }
        }
        await api.renameDocument(entry.path, toPath);
        if (oldLayout && nextLayout) {
          const filePaths = entries
            .filter((candidate) => !candidate.isDirectory)
            .map((candidate) => candidate.path);
          const oldSourcePath = chooseOutsideInSource(oldLayout, filePaths);
          const hasCompanion = entries.some(
            (candidate) =>
              candidate.path === oldLayout.companionDirectory ||
              candidate.path.startsWith(`${oldLayout.companionDirectory}/`),
          );
          if (hasCompanion) {
            await api.renameDocument(oldLayout.companionDirectory, nextLayout.companionDirectory);
            if (oldSourcePath) {
              let sourcePath = `${nextLayout.companionDirectory}${oldSourcePath.slice(oldLayout.companionDirectory.length)}`;
              if (
                oldSourcePath === oldLayout.markdownPath &&
                sourcePath !== nextLayout.markdownPath
              ) {
                await api.renameDocument(sourcePath, nextLayout.markdownPath);
                sourcePath = nextLayout.markdownPath;
              }
              const response = await api.readDocument(sourcePath);
              const linked = withOutsideInMetadata(response.content, nextLayout);
              if (linked !== response.content) await api.writeDocument(sourcePath, linked);
            }
          }
        }
        await refresh();

        if (
          selectedPath &&
          (selectedPath === entry.path || selectedPath.startsWith(`${entry.path}/`))
        ) {
          setSelectedPath(`${toPath}${selectedPath.slice(entry.path.length)}`);
        }

        window.dispatchEvent(
          new CustomEvent('gezel:document-renamed', {
            detail: { fromPath: entry.path, toPath, isDirectory: entry.isDirectory },
          }),
        );
        setRenameTarget(null);
        setRenameError(null);
      } catch (err) {
        setRenameError((err as Error).message || 'Rename failed.');
      }
    },
    [entries, refresh, renameTarget, selectedPath, setSelectedPath],
  );

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
    () => (selectedPath ? (visibleEntries.find((e) => e.path === selectedPath) ?? null) : null),
    [visibleEntries, selectedPath],
  );
  const selectedIsDir = selectedEntry?.isDirectory ?? false;
  const selectedName = selectedPath ? selectedPath.slice(selectedPath.lastIndexOf('/') + 1) : '';
  // Immediate children of the selected folder (one level deep).
  const folderChildren = useMemo(() => {
    if (!selectedPath || !selectedIsDir) return [];
    const prefix = `${selectedPath}/`;
    return visibleEntries.filter(
      (e) => e.path.startsWith(prefix) && !e.path.slice(prefix.length).includes('/'),
    );
  }, [visibleEntries, selectedPath, selectedIsDir]);

  const detailDropDestination = selectedIsDir
    ? (selectedPath ?? '')
    : selectedPath
      ? parentDirectory(selectedPath)
      : '';
  const detailDropLabel = detailDropDestination
    ? detailDropDestination.slice(detailDropDestination.lastIndexOf('/') + 1)
    : 'Documents';

  const handleDragEnter = useCallback(
    (event: ReactDragEvent<HTMLElement>, zone: 'tree' | 'detail') => {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = 'copy';
      setActiveDropZone(zone);
    },
    [],
  );

  const handleDragOver = useCallback(
    (event: ReactDragEvent<HTMLElement>, zone: 'tree' | 'detail') => {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = 'copy';
      if (activeDropZone !== zone) setActiveDropZone(zone);
    },
    [activeDropZone],
  );

  const handleDragLeave = useCallback((event: ReactDragEvent<HTMLElement>) => {
    if (!isFileDrag(event)) return;
    const next = event.relatedTarget;
    if (next instanceof Node && event.currentTarget.contains(next)) return;
    setActiveDropZone(null);
  }, []);

  const handleDrop = useCallback(
    async (event: ReactDragEvent<HTMLElement>, destination: string) => {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      event.stopPropagation();
      setActiveDropZone(null);
      const files = Array.from(event.dataTransfer.files);
      if (files.length === 0) return;
      setStatus(`Adding ${files.length === 1 ? files[0]?.name : `${files.length} files`}…`);
      setError(null);

      const result = await importDroppedDocumentFiles({
        client: api,
        files,
        destination,
        existingPaths: entries.map((entry) => entry.path),
      });
      if (result.importedPaths.length > 0) {
        await refresh();
        const lastPath = result.importedPaths.at(-1)!;
        setSelectedPath(lastPath);
        window.dispatchEvent(
          new CustomEvent('gezel:document-created', {
            detail: { path: lastPath, paths: result.importedPaths },
          }),
        );
      }

      const added = result.importedPaths.length;
      const rejected = result.rejected.length;
      if (rejected > 0) {
        const first = result.rejected[0]!;
        setStatus(
          `${added > 0 ? `Added ${added}; ` : ''}couldn't add ${first.name}: ${first.reason}${rejected > 1 ? ` (+${rejected - 1} more)` : ''}`,
        );
      } else {
        setStatus(`Added ${added} ${added === 1 ? 'document' : 'documents'}.`);
      }
    },
    [entries, refresh, setSelectedPath],
  );

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
        placeholder="e.g. guidelines/coding"
        submitLabel="Create"
        initialValue={newPathPrefix}
        suffix=".md"
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
      <NewPathDialog
        open={renameTarget !== null}
        title={renameTarget?.isDirectory ? 'Rename folder' : 'Rename document'}
        fieldLabel="Name"
        placeholder="New name"
        submitLabel="Rename"
        initialValue={renameTarget?.name ?? ''}
        suffix={renameSuffix(renameTarget)}
        error={renameError}
        onSubmit={confirmRename}
        onCancel={() => {
          setRenameTarget(null);
          setRenameError(null);
        }}
      />
      <div className="documents-split">
        <aside
          className={`documents-tree document-drop-zone${activeDropZone === 'tree' ? ' document-drop-zone-active' : ''}`}
          onDragEnterCapture={(event) => handleDragEnter(event, 'tree')}
          onDragOverCapture={(event) => handleDragOver(event, 'tree')}
          onDragLeaveCapture={handleDragLeave}
          onDropCapture={(event) => void handleDrop(event, '')}
        >
          <div className="area-toolbar">
            {status && <output className="area-toolbar-status">{status}</output>}
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
            {visibleEntries.length === 0 ? (
              <p className="muted" style={{ padding: '0.5rem', fontSize: '0.85rem' }}>
                No documents yet. Create a mission statement, coding guidelines, or any shared
                reference.
              </p>
            ) : (
              <FileTree
                entries={visibleEntries}
                labelFor={(e) => documentLabel(e.name)}
                onSelect={(e) => selectDocument(e)}
                onRename={(e) => renameDocument(e)}
                onDelete={(e) => deleteDocument(e)}
                selectedPath={selectedPath ?? undefined}
                selectableFolders
              />
            )}
          </div>
          {activeDropZone === 'tree' && (
            <div className="document-drop-overlay" aria-hidden="true">
              <i className="fa-solid fa-file-arrow-down" />
              <span>Drop to add to Documents</span>
            </div>
          )}
        </aside>
        <section
          className={`documents-detail document-drop-zone${activeDropZone === 'detail' ? ' document-drop-zone-active' : ''}`}
          onDragEnterCapture={(event) => handleDragEnter(event, 'detail')}
          onDragOverCapture={(event) => handleDragOver(event, 'detail')}
          onDragLeaveCapture={handleDragLeave}
          onDropCapture={(event) => void handleDrop(event, detailDropDestination)}
        >
          {rightPane}
          {activeDropZone === 'detail' && (
            <div className="document-drop-overlay" aria-hidden="true">
              <i className="fa-solid fa-file-arrow-down" />
              <span>Drop to add to {detailDropLabel}</span>
            </div>
          )}
        </section>
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
