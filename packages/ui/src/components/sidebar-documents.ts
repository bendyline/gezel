import { api } from '../api.js';
import { flushSerializedAutosave } from '../hooks/useSerializedAutosave.js';
import type { FileEntry } from './FileTree.js';
import {
  isMarkdownDocumentPath,
  markdownCompanionDirectory,
  moveFileWithCompanion,
  rewriteDocumentCompanionRefs,
} from './SquisqIntegration/document-companion.js';
import type { OutsideInLayout } from './SquisqIntegration/outside-in.js';

/**
 * The rail's document operations: create, rename, delete and drop-to-add,
 * with their companion folders and outside-in twins. They live outside the
 * Sidebar component so it stays a view (and React Compiler can memoize it:
 * the compiler leaves alone any component holding a try/finally, an inline
 * `import()` or a conditional inside a try).
 */

// Loaded on first use, keeping the conversion stack out of the
// always-mounted rail until a person drops, renames or deletes a file.
const loadOutsideIn = () => import('./SquisqIntegration/outside-in.js');
const loadDocumentImport = () => import('./SquisqIntegration/document-import.js');

export async function outsideInLayout(path: string): Promise<OutsideInLayout | null> {
  if (!/\.(?:html?|docx|pdf|pptx|xlsx)$/i.test(path)) return null;
  const { resolveOutsideInLayout } = await loadOutsideIn();
  return resolveOutsideInLayout(path);
}

/** Remember a rail preference; private windows and full quotas just forget it. */
export function writeStoredSetting(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* private mode / quota */
  }
}

/** Create an empty document. Answers whether it was created. */
export async function createDocument(path: string): Promise<boolean> {
  try {
    await api.writeDocument(path, '');
    window.dispatchEvent(new CustomEvent('gezel:document-created', { detail: { path } }));
    return true;
  } catch {
    return false;
  }
}

/** Add files dropped on the Documents group; answers the status line to show. */
export async function importDroppedDocuments(
  files: File[],
  noteUsed: (path: string) => void,
): Promise<string> {
  try {
    // Read a fresh, unfiltered listing for collision detection. Managed
    // outside-in companion folders stay hidden in the rail, but still
    // reserve their names when an OS drop chooses a destination.
    const current = await api.listDocuments('', true, { stats: true, hidden: false });
    const { importDroppedFiles } = await loadDocumentImport();
    const result = await importDroppedFiles({
      target: {
        writeText: async (path, content) => {
          await api.writeDocument(path, content);
        },
        writeBinary: async (path, data, mimeType) => {
          await api.writeDocumentBinary(path, data, mimeType);
        },
      },
      files,
      destination: '',
      existingPaths: current.files.map((entry) => entry.path),
    });

    if (result.importedPaths.length > 0) {
      const lastPath = result.importedPaths.at(-1)!;
      noteUsed(lastPath);
      window.dispatchEvent(
        new CustomEvent('gezel:document-created', {
          detail: { path: lastPath, paths: result.importedPaths },
        }),
      );
    }

    const added = result.importedPaths.length;
    if (result.rejected.length > 0) {
      const first = result.rejected[0]!;
      return `${added > 0 ? `Added ${added}; ` : ''}couldn't add ${first.name}: ${first.reason}${result.rejected.length > 1 ? ` (+${result.rejected.length - 1} more)` : ''}`;
    }
    return `Added ${added} ${added === 1 ? 'file' : 'files'}.`;
  } catch (error) {
    return `Couldn't add files: ${(error as Error).message || 'Unknown error.'}`;
  }
}

function within(path: string, folder: string): boolean {
  return path === folder || path.startsWith(`${folder}/`);
}

/** Save the open editor first when it shows the document (or a file inside the folder) about to move. */
async function flushOpenEditor(
  entry: FileEntry,
  selectedPath: string | null,
  layout: OutsideInLayout | null,
): Promise<void> {
  if (!selectedPath || !within(selectedPath, entry.path)) return;
  await flushSerializedAutosave(`document:${selectedPath}`);
  if (layout) await flushSerializedAutosave(`outside-in:documents:${layout.markdownPath}`);
}

/**
 * Rename a document or folder, carrying its companion folder and relinking
 * what refers to it. Answers an error to show, or null when it is done (or
 * there was nothing to do).
 */
export async function renameDocument(
  entry: FileEntry,
  newName: string,
  selectedPath: string | null,
): Promise<string | null> {
  const cleanName = newName.trim();
  if (!cleanName || /[\\/]/.test(cleanName)) return 'Enter a name without slashes.';

  const slash = entry.path.lastIndexOf('/');
  const parent = slash >= 0 ? entry.path.slice(0, slash + 1) : '';
  const toPath = `${parent}${cleanName}`;
  if (toPath === entry.path) return null;

  try {
    const oldLayout = entry.isDirectory ? null : await outsideInLayout(entry.path);
    const nextLayout = entry.isDirectory ? null : await outsideInLayout(toPath);
    if (oldLayout && nextLayout?.format !== oldLayout.format) {
      return `Keep the .${oldLayout.format} extension when renaming this document.`;
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
      return 'Keep the Markdown extension when renaming this document.';
    }
    const companionListing = oldCompanionDirectory ? await api.listDocuments('', true) : null;
    if (
      nextCompanionDirectory &&
      companionListing?.files.some(
        (candidate) =>
          candidate.path === toPath ||
          (within(candidate.path, nextCompanionDirectory) &&
            !(oldCompanionDirectory && within(candidate.path, oldCompanionDirectory))),
      )
    ) {
      return 'A document or companion folder with that name already exists.';
    }
    await flushOpenEditor(entry, selectedPath, oldLayout);
    const hasCompanion = Boolean(
      oldCompanionDirectory &&
        companionListing?.files.some((candidate) => within(candidate.path, oldCompanionDirectory)),
    );
    await moveFileWithCompanion(
      (fromPath, nextPath) => api.renameDocument(fromPath, nextPath).then(() => undefined),
      entry.path,
      toPath,
      hasCompanion && oldCompanionDirectory && nextCompanionDirectory
        ? { from: oldCompanionDirectory, to: nextCompanionDirectory }
        : null,
    );
    if (oldLayout && nextLayout && hasCompanion && companionListing) {
      const { relinkMovedOutsideInCompanion } = await loadOutsideIn();
      await relinkMovedOutsideInCompanion({
        from: oldLayout,
        to: nextLayout,
        filePaths: companionListing.files
          .filter((candidate) => !candidate.isDirectory)
          .map((candidate) => candidate.path),
        rename: (fromPath, nextPath) =>
          api.renameDocument(fromPath, nextPath).then(() => undefined),
        read: async (path) => (await api.readDocument(path)).content,
        write: async (path, content) => {
          await api.writeDocument(path, content);
        },
      });
    } else if (
      hasCompanion &&
      !entry.isDirectory &&
      isMarkdownDocumentPath(entry.path) &&
      isMarkdownDocumentPath(toPath)
    ) {
      const response = await api.readDocument(toPath);
      const relinked = rewriteDocumentCompanionRefs(response.content, entry.path, toPath);
      if (relinked !== response.content) await api.writeDocument(toPath, relinked);
    }
    window.dispatchEvent(
      new CustomEvent('gezel:document-renamed', {
        detail: { fromPath: entry.path, toPath, isDirectory: entry.isDirectory },
      }),
    );
    return null;
  } catch (err) {
    return (err as Error).message || 'Rename failed.';
  }
}

/** Delete a document or folder and its companion folder. Answers an error to show, or null. */
export async function deleteDocument(
  entry: FileEntry,
  selectedPath: string | null,
): Promise<string | null> {
  try {
    const layout = entry.isDirectory ? null : await outsideInLayout(entry.path);
    const companionDirectory =
      layout?.companionDirectory ??
      (entry.isDirectory ? null : markdownCompanionDirectory(entry.path));
    await flushOpenEditor(entry, selectedPath, layout);
    const hasCompanion = companionDirectory
      ? (await api.listDocuments('', true)).files.some((candidate) =>
          within(candidate.path, companionDirectory),
        )
      : false;
    await api.deleteDocument(entry.path);
    if (companionDirectory && hasCompanion) await api.deleteDocument(companionDirectory);
    window.dispatchEvent(
      new CustomEvent('gezel:document-deleted', { detail: { path: entry.path } }),
    );
    return null;
  } catch (err) {
    return (err as Error).message || 'Delete failed.';
  }
}
