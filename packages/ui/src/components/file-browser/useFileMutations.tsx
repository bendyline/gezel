import {
  type DragEvent as ReactDragEvent,
  type ReactNode,
  useCallback,
  useMemo,
  useState,
} from 'react';
import { flushSerializedAutosave } from '../../hooks/useSerializedAutosave.js';
import { ConfirmDialog } from '../ConfirmDialog.js';
import type { FileEntry } from '../FileTree.js';
import { NewPathDialog } from '../NewPathDialog.js';
import {
  chooseOutsideInSource,
  importDroppedFiles,
  isMarkdownDocumentPath,
  markdownCompanionDirectory,
  moveFileWithCompanion,
  resolveOutsideInLayout,
  withOutsideInMetadata,
} from '../SquisqIntegration/index.js';
import type { FileBrowserSource } from './source.js';

export type DropZoneId = 'tree' | 'detail';

export interface FileMutations {
  /** Rendered by the browser shell; holds the create/rename/delete dialogs. */
  dialogs: ReactNode;
  /** Transient one-line result of the last create/delete/import. */
  status: string;
  setStatus: (message: string) => void;
  newFile: ((prefix?: string) => void) | undefined;
  newFolder: ((prefix?: string) => void) | undefined;
  rename: ((entry: FileEntry) => void) | undefined;
  remove: ((entry: FileEntry) => void) | undefined;
  activeDropZone: DropZoneId | null;
  /** Spread onto a drop target; `undefined` when the source is read-only. */
  dropZoneProps: (
    zone: DropZoneId,
    destination: string,
  ) => Record<string, unknown> | Record<string, never>;
}

function isFileDrag(event: ReactDragEvent<HTMLElement>): boolean {
  return Array.from(event.dataTransfer.types).includes('Files');
}

function renameSuffix(entry: FileEntry | null): string | undefined {
  if (!entry || entry.isDirectory) return undefined;
  if (!entry.name.includes('.')) return '.md';
  const markdown = entry.name.match(/\.(md|markdown|mdx)$/i);
  return markdown ? `.${markdown[1]!.toLowerCase()}` : undefined;
}

function containsPath(entries: readonly FileEntry[], path: string): boolean {
  return entries.some((entry) => entry.path === path || entry.path.startsWith(`${path}/`));
}

function autosaveLanesFor(source: FileBrowserSource, path: string): string[] {
  // Mirror of the lane keys the editors register. A rename/delete has to land
  // the in-flight draft first, or the autosave completes afterwards and
  // recreates the file at its old path.
  const lanes =
    source.kind === 'documents'
      ? [`document:${path}`]
      : [`file:${source.kind}:${path}`, `document:${path}`];
  const layout = resolveOutsideInLayout(path);
  if (layout) {
    lanes.push(
      source.kind === 'documents'
        ? `outside-in:documents:${layout.markdownPath}`
        : `outside-in:${source.kind}:${layout.markdownPath}`,
    );
  }
  return lanes;
}

/**
 * Create / rename / delete / drop-import for one file tree, with the dialogs
 * and confirmations that go with them.
 *
 * Lives beside the shared browser rather than inside a view so the Documents
 * library, the Artifacts drawer, and a writable Workspace all get the same
 * safety behavior: a rename that keeps a rendered document's companion folder
 * in step, a delete that confirms first and flushes any in-flight autosave,
 * and an import that suffixes rather than overwrites.
 */
export function useFileMutations(options: {
  source: FileBrowserSource;
  entries: readonly FileEntry[];
  selectedPath: string | null;
  onSelectPath: (path: string | null) => void;
  refresh: () => Promise<void>;
  /**
   * Extension the New file dialog appends. Defaults to `.md` for the
   * documents library (a markdown library names files for you) and to nothing
   * for a project tree, which holds whatever the work needs.
   */
  newFileSuffix?: string;
}): FileMutations {
  const { source, entries, selectedPath, onSelectPath, refresh } = options;
  const newFileSuffix = options.newFileSuffix ?? (source.kind === 'documents' ? '.md' : undefined);
  const [status, setStatus] = useState('');
  const [showNewFile, setShowNewFile] = useState(false);
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [newPathPrefix, setNewPathPrefix] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<FileEntry | null>(null);
  const [renameTarget, setRenameTarget] = useState<FileEntry | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [activeDropZone, setActiveDropZone] = useState<DropZoneId | null>(null);

  const writable = source.canWrite;

  const announce = useCallback(
    (prefix: string, path: string) => {
      if (!source.changeEventPrefix) return;
      window.dispatchEvent(
        new CustomEvent(`${source.changeEventPrefix}-${prefix}`, {
          detail: { path },
        }),
      );
    },
    [source.changeEventPrefix],
  );

  const flushOpenDrafts = useCallback(
    async (entry: FileEntry) => {
      if (!selectedPath) return;
      if (selectedPath !== entry.path && !selectedPath.startsWith(`${entry.path}/`)) return;
      for (const lane of autosaveLanesFor(source, selectedPath)) {
        await flushSerializedAutosave(lane);
      }
    },
    [selectedPath, source],
  );

  const confirmDelete = useCallback(async () => {
    const entry = deleteTarget;
    if (!entry) return;
    try {
      await flushOpenDrafts(entry);
      const layout = entry.isDirectory ? null : resolveOutsideInLayout(entry.path);
      const companionDirectory =
        layout?.companionDirectory ??
        (entry.isDirectory ? null : markdownCompanionDirectory(entry.path));
      const hasCompanion = companionDirectory ? containsPath(entries, companionDirectory) : false;
      await source.remove(entry.path);
      if (companionDirectory && hasCompanion) await source.remove(companionDirectory);
      announce('deleted', entry.path);
      if (
        selectedPath &&
        (selectedPath === entry.path || selectedPath.startsWith(`${entry.path}/`))
      ) {
        onSelectPath(null);
      }
      await refresh();
    } catch (err) {
      setStatus(`delete failed: ${(err as Error).message}`);
    } finally {
      setDeleteTarget(null);
    }
  }, [
    announce,
    deleteTarget,
    entries,
    flushOpenDrafts,
    onSelectPath,
    refresh,
    selectedPath,
    source,
  ]);

  const confirmRename = useCallback(
    async (newName: string) => {
      const entry = renameTarget;
      const renameAt = source.rename;
      if (!entry || !renameAt) return;
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
      const oldCompanionDirectory =
        oldLayout?.companionDirectory ??
        (entry.isDirectory ? null : markdownCompanionDirectory(entry.path));
      const nextCompanionDirectory =
        nextLayout?.companionDirectory ??
        (entry.isDirectory ? null : markdownCompanionDirectory(toPath));
      if (
        !entry.isDirectory &&
        isMarkdownDocumentPath(entry.path) &&
        !isMarkdownDocumentPath(toPath)
      ) {
        setRenameError('Keep the Markdown extension when renaming this document.');
        return;
      }
      if (
        nextCompanionDirectory &&
        entries.some(
          (candidate) =>
            candidate.path === toPath ||
            ((candidate.path === nextCompanionDirectory ||
              candidate.path.startsWith(`${nextCompanionDirectory}/`)) &&
              !(
                oldCompanionDirectory &&
                (candidate.path === oldCompanionDirectory ||
                  candidate.path.startsWith(`${oldCompanionDirectory}/`))
              )),
        )
      ) {
        setRenameError('A document or companion folder with that name already exists.');
        return;
      }

      try {
        await flushOpenDrafts(entry);
        const hasCompanion = oldCompanionDirectory
          ? containsPath(entries, oldCompanionDirectory)
          : false;
        await moveFileWithCompanion(
          renameAt,
          entry.path,
          toPath,
          hasCompanion && oldCompanionDirectory && nextCompanionDirectory
            ? { from: oldCompanionDirectory, to: nextCompanionDirectory }
            : null,
        );
        // A rendered document's companion folder carries its editable markdown
        // and media; it has to travel with the rename, and the metadata inside
        // has to be relinked or the next open resolves the old directory.
        if (oldLayout && nextLayout) {
          const filePaths = entries
            .filter((candidate) => !candidate.isDirectory)
            .map((candidate) => candidate.path);
          const oldSourcePath = chooseOutsideInSource(oldLayout, filePaths);
          if (hasCompanion) {
            if (oldSourcePath) {
              let sourcePath = `${nextLayout.companionDirectory}${oldSourcePath.slice(oldLayout.companionDirectory.length)}`;
              if (
                oldSourcePath === oldLayout.markdownPath &&
                sourcePath !== nextLayout.markdownPath
              ) {
                await renameAt(sourcePath, nextLayout.markdownPath);
                sourcePath = nextLayout.markdownPath;
              }
              const response = await source.read(sourcePath);
              const linked = withOutsideInMetadata(response.content, nextLayout);
              if (linked !== response.content) await source.write(sourcePath, linked);
            }
          }
        }
        await refresh();

        if (
          selectedPath &&
          (selectedPath === entry.path || selectedPath.startsWith(`${entry.path}/`))
        ) {
          onSelectPath(`${toPath}${selectedPath.slice(entry.path.length)}`);
        }
        if (source.changeEventPrefix) {
          window.dispatchEvent(
            new CustomEvent(`${source.changeEventPrefix}-renamed`, {
              detail: { fromPath: entry.path, toPath, isDirectory: entry.isDirectory },
            }),
          );
        }
        setRenameTarget(null);
        setRenameError(null);
      } catch (err) {
        setRenameError((err as Error).message || 'Rename failed.');
      }
    },
    [entries, flushOpenDrafts, onSelectPath, refresh, renameTarget, selectedPath, source],
  );

  const handleCreateFile = useCallback(
    async (path: string) => {
      const clean = path.trim();
      if (!clean) return;
      try {
        await source.write(clean, '');
        setShowNewFile(false);
        await refresh();
        onSelectPath(clean);
        announce('created', clean);
      } catch (err) {
        setStatus(`create failed: ${(err as Error).message}`);
      }
    },
    [announce, onSelectPath, refresh, source],
  );

  const handleCreateFolder = useCallback(
    async (path: string) => {
      const clean = path.trim();
      const mkdir = source.mkdir;
      if (!clean || !mkdir) return;
      try {
        await mkdir(clean);
        setShowNewFolder(false);
        await refresh();
        announce('created', clean);
      } catch (err) {
        setStatus(`create folder failed: ${(err as Error).message}`);
      }
    },
    [announce, refresh, source],
  );

  const handleDrop = useCallback(
    async (event: ReactDragEvent<HTMLElement>, destination: string) => {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      event.stopPropagation();
      setActiveDropZone(null);
      const files = Array.from(event.dataTransfer.files);
      if (files.length === 0) return;
      setStatus(`Adding ${files.length === 1 ? files[0]?.name : `${files.length} files`}…`);

      const result = await importDroppedFiles({
        target: {
          writeText: (path, content) => source.write(path, content),
          writeBinary: (path, data, mimeType) => source.writeBinary(path, data, mimeType),
        },
        files,
        destination,
        existingPaths: entries.map((entry) => entry.path),
      });
      if (result.importedPaths.length > 0) {
        await refresh();
        const lastPath = result.importedPaths.at(-1)!;
        onSelectPath(lastPath);
        if (source.changeEventPrefix) {
          window.dispatchEvent(
            new CustomEvent(`${source.changeEventPrefix}-created`, {
              detail: { path: lastPath, paths: result.importedPaths },
            }),
          );
        }
      }

      const added = result.importedPaths.length;
      const rejected = result.rejected.length;
      if (rejected > 0) {
        const first = result.rejected[0]!;
        setStatus(
          `${added > 0 ? `Added ${added}; ` : ''}couldn't add ${first.name}: ${first.reason}${rejected > 1 ? ` (+${rejected - 1} more)` : ''}`,
        );
      } else {
        setStatus(`Added ${added} ${added === 1 ? 'file' : 'files'}.`);
      }
    },
    [entries, onSelectPath, refresh, source],
  );

  const dropZoneProps = useCallback(
    (zone: DropZoneId, destination: string) => {
      if (!writable) return {};
      return {
        onDragEnterCapture: (event: ReactDragEvent<HTMLElement>) => {
          if (!isFileDrag(event)) return;
          event.preventDefault();
          event.stopPropagation();
          event.dataTransfer.dropEffect = 'copy';
          setActiveDropZone(zone);
        },
        onDragOverCapture: (event: ReactDragEvent<HTMLElement>) => {
          if (!isFileDrag(event)) return;
          event.preventDefault();
          event.stopPropagation();
          event.dataTransfer.dropEffect = 'copy';
          setActiveDropZone((current) => (current === zone ? current : zone));
        },
        onDragLeaveCapture: (event: ReactDragEvent<HTMLElement>) => {
          if (!isFileDrag(event)) return;
          const next = event.relatedTarget;
          if (next instanceof Node && event.currentTarget.contains(next)) return;
          setActiveDropZone(null);
        },
        onDropCapture: (event: ReactDragEvent<HTMLElement>) => void handleDrop(event, destination),
      };
    },
    [handleDrop, writable],
  );

  const dialogs = useMemo(
    () => (
      <>
        <NewPathDialog
          open={showNewFile}
          title={`New ${source.kind === 'documents' ? 'document' : 'file'}`}
          placeholder={
            source.kind === 'documents' ? 'e.g. guidelines/coding' : 'e.g. notes/report.md'
          }
          submitLabel="Create"
          initialValue={newPathPrefix}
          // The library is a markdown library, so it names files for you. A
          // project tree holds whatever the work needs — appending `.md` there
          // would turn `main.ts` into `main.ts.md`.
          suffix={newFileSuffix}
          onSubmit={handleCreateFile}
          onCancel={() => setShowNewFile(false)}
        />
        <NewPathDialog
          open={showNewFolder}
          title="New folder"
          placeholder="e.g. guidelines"
          submitLabel="Create"
          initialValue={newPathPrefix}
          onSubmit={handleCreateFolder}
          onCancel={() => setShowNewFolder(false)}
        />
        <NewPathDialog
          open={renameTarget !== null}
          title={renameTarget?.isDirectory ? 'Rename folder' : 'Rename file'}
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
        <ConfirmDialog
          open={deleteTarget !== null}
          title={deleteTarget?.isDirectory ? 'Delete folder?' : 'Delete file?'}
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
      </>
    ),
    [
      confirmDelete,
      confirmRename,
      deleteTarget,
      handleCreateFile,
      handleCreateFolder,
      newFileSuffix,
      newPathPrefix,
      renameError,
      renameTarget,
      showNewFile,
      showNewFolder,
      source.kind,
    ],
  );

  return {
    dialogs,
    status,
    setStatus,
    newFile: writable
      ? (prefix = '') => {
          setNewPathPrefix(prefix);
          setShowNewFile(true);
        }
      : undefined,
    newFolder:
      writable && source.mkdir
        ? (prefix = '') => {
            setNewPathPrefix(prefix);
            setShowNewFolder(true);
          }
        : undefined,
    rename:
      writable && source.rename
        ? (entry: FileEntry) => {
            setRenameError(null);
            setRenameTarget(entry);
          }
        : undefined,
    remove: writable ? (entry: FileEntry) => setDeleteTarget(entry) : undefined,
    activeDropZone,
    dropZoneProps,
  };
}
