import { FolderView } from '@bendyline/squisq-editor-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FileEntry } from '../components/FileTree.js';
import { isOutsideInInternalPath } from '../components/SquisqIntegration/index.js';
import { documentLabel } from '../components/document-label.js';
import {
  FileBrowserPane,
  NonTextFilePreview,
  documentsFileSource,
  mediaSentinel,
  useFileMutations,
} from '../components/file-browser/index.js';
import {
  DOCUMENTS_HIDDEN_STORAGE_KEY,
  DOCUMENTS_VIEW_STORAGE_KEY,
  DOCUMENT_VIEW_MODES,
  type FileViewMode,
  coerceFileViewMode,
} from '../components/file-view-modes.js';
import { useEffectiveTheme } from '../theme.js';
import { DocumentDetail } from './DocumentDetail.js';
import { useDocumentSearch } from './useDocumentSearch.js';

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

function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* private mode / quota — state still in memory */
  }
}

/**
 * The shared documents library, browsed through the same file panel as a
 * project's Workspace and Artifacts: one resizable, collapsible tree with the
 * same view modes, hidden-file key, mutations, and previews. What is specific
 * to the library is only what it shows on the right — a folder browser for a
 * selected folder, the documents editor for a file.
 */
export function DocumentsView() {
  const editorTheme = useEffectiveTheme();
  const source = useMemo(() => documentsFileSource(), []);
  const search = useDocumentSearch();
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [truncated, setTruncated] = useState(false);
  // Distinguishes "no documents" from "not loaded yet" so a persisted folder
  // selection doesn't briefly render the document editor (and a failed read)
  // before `entries` arrive and reveal that the path is a directory.
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewModeState] = useState<FileViewMode>(() =>
    coerceFileViewMode(readStored(DOCUMENTS_VIEW_STORAGE_KEY), 'documents'),
  );
  const [showHidden, setShowHiddenState] = useState<boolean>(
    () => readStored(DOCUMENTS_HIDDEN_STORAGE_KEY) === '1',
  );
  // Selected document for the right pane. Persisted in localStorage so the
  // selection survives switching to another tab and back (TabContent
  // remounts on key change) and across app restarts.
  const [selectedPath, setSelectedPathState] = useState<string | null>(() => loadSelectedPath());

  const setSelectedPath = useCallback((path: string | null) => {
    setSelectedPathState(path);
    persistSelectedPath(path);
  }, []);

  const setViewMode = useCallback((mode: FileViewMode) => {
    setViewModeState(mode);
    writeStored(DOCUMENTS_VIEW_STORAGE_KEY, mode);
  }, []);

  const setShowHidden = useCallback((next: boolean) => {
    setShowHiddenState(next);
    writeStored(DOCUMENTS_HIDDEN_STORAGE_KEY, next ? '1' : '0');
  }, []);

  const refresh = useCallback(async () => {
    try {
      const res = await source.list({ hidden: showHidden });
      setEntries(res.files);
      setTruncated(res.truncated === true);
      setLoaded(true);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [showHidden, source]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Outside-in companion folders contain editable Markdown, media, versions,
  // and the recovery copy for a visible Office/PDF/HTML document. They travel
  // with that document but are implementation detail, not extra library rows —
  // until the show-hidden key asks for everything.
  const visibleEntries = useMemo(
    () => (showHidden ? entries : entries.filter((entry) => !isOutsideInInternalPath(entry.path))),
    [entries, showHidden],
  );

  const mutations = useFileMutations({
    source,
    entries,
    selectedPath,
    onSelectPath: setSelectedPath,
    refresh,
  });

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

  const mediaContent = selectedPath && !selectedIsDir ? mediaSentinel(selectedPath) : null;

  let viewer: React.ReactNode;
  if (!selectedPath) {
    viewer = <p className="placeholder">Select a document or folder on the left to view it.</p>;
  } else if (selectedIsDir) {
    viewer = (
      <FolderView
        name={selectedName}
        entries={folderChildren}
        theme={editorTheme}
        onOpenFile={(e) => setSelectedPath(e.path)}
        onOpenFolder={(e) => setSelectedPath(e.path)}
        onNewDocument={() => mutations.newFile?.(`${selectedPath}/`)}
        onNewFolder={() => mutations.newFolder?.(`${selectedPath}/`)}
      />
    );
  } else if (mediaContent) {
    // Images, video, and audio are rendered from an authenticated blob — never
    // read as text and handed to the editor.
    viewer = (
      <NonTextFilePreview content={mediaContent} path={selectedPath} fetchBlob={source.fetchBlob} />
    );
  } else if (selectedEntry) {
    viewer = <DocumentDetail key={selectedPath} path={selectedPath} />;
  } else if (loaded) {
    // Selection no longer exists (e.g. deleted elsewhere) — fall back.
    viewer = <p className="placeholder">Select a document or folder on the left to view it.</p>;
  } else {
    viewer = <p className="placeholder">Loading…</p>;
  }

  const searchResultList = search.hits
    ? {
        entries: search.hits.map((hit) => hit.entry),
        emptyMessage: search.unavailable
          ? 'The library is still being indexed — search will work shortly.'
          : `Nothing in the library mentions “${search.query.trim()}”.`,
        trailingForEntry: (entry: FileEntry) => {
          const hit = search.hits?.find((h) => h.entry.path === entry.path);
          return hit ? <span className="documents-search-snippet">{hit.snippet}</span> : null;
        },
      }
    : null;

  return (
    <div className="documents-listing" data-testid="documents-view">
      <FileBrowserPane
        source={source}
        headerExtra={
          <div className="documents-search">
            <input
              type="search"
              className="documents-search-input"
              placeholder="Search documents…"
              aria-label="Search document contents"
              value={search.query}
              onChange={(e) => search.setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') search.clear();
              }}
            />
            {search.searching && <span className="muted documents-search-status">searching…</span>}
          </div>
        }
        customList={searchResultList}
        layoutClassName="project-files-layout-documents"
        entries={visibleEntries}
        truncated={truncated}
        viewMode={viewMode}
        modes={DOCUMENT_VIEW_MODES}
        onViewModeChange={setViewMode}
        showHidden={showHidden}
        onShowHiddenChange={setShowHidden}
        selectedPath={selectedPath ?? undefined}
        onSelect={(entry) => setSelectedPath(entry.path)}
        selectableFolders
        labelFor={(entry) => documentLabel(entry.name)}
        emptyMessage="No documents yet. Create a mission statement, coding guidelines, or any shared reference."
        mutations={mutations}
        viewer={viewer}
      />
      {error && <p className="error">{error}</p>}
    </div>
  );
}
