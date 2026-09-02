/**
 * Pure path helpers for the visible-document + hidden-companion convention.
 *
 * Keep this module free of Squisq runtime imports: the app sidebar uses these
 * helpers during startup and should not pull the editor bundle into its chunk.
 */

function basename(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/^\/+/, '');
  const slash = normalized.lastIndexOf('/');
  return slash === -1 ? normalized : normalized.slice(slash + 1);
}

function join(parent: string, child: string): string {
  return parent ? `${parent.replace(/\/+$/, '')}/${child.replace(/^\/+/, '')}` : child;
}

/** Markdown-like files that receive an editable document companion. */
export function isMarkdownDocumentPath(path: string): boolean {
  const name = basename(path);
  return !name.includes('.') || /\.(?:md|markdown|mdx)$/i.test(name);
}

/** Strip only the final extension from a document basename. */
export function documentVersionBasename(path: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

/**
 * Resolve the dedicated companion scope for a visible document.
 * `notes/diary.md` owns `notes/diary_files/`; an extensionless `test` owns
 * `test_files/`.
 */
export function deriveContainerScope(documentPath: string): {
  root: string;
  parentDirectory: string;
  companionName: string;
  primaryDocumentFilename: string;
} {
  const trimmed = documentPath.replace(/\\/g, '/').replace(/^\/+/, '');
  const slash = trimmed.lastIndexOf('/');
  const parentDirectory = slash === -1 ? '' : trimmed.slice(0, slash);
  const primaryDocumentFilename = basename(trimmed);
  const companionName = `${documentVersionBasename(primaryDocumentFilename)}_files`;
  return {
    root: join(parentDirectory, companionName),
    parentDirectory,
    companionName,
    primaryDocumentFilename,
  };
}

/** Return a regular Markdown document's companion, or null for other files. */
export function markdownCompanionDirectory(path: string): string | null {
  return isMarkdownDocumentPath(path) ? deriveContainerScope(path).root : null;
}

export interface CompanionRename {
  from: string;
  to: string;
}

/**
 * Move a visible file and its companion as one recoverable operation.
 *
 * The companion moves first so a companion failure leaves the visible file
 * untouched. If the visible-file move then fails, the companion is rolled
 * back before the original error is rethrown.
 */
export async function moveFileWithCompanion(
  rename: (fromPath: string, toPath: string) => Promise<void>,
  fromPath: string,
  toPath: string,
  companion?: CompanionRename | null,
): Promise<void> {
  const moveCompanion = companion && companion.from !== companion.to ? companion : null;
  if (moveCompanion) await rename(moveCompanion.from, moveCompanion.to);
  try {
    await rename(fromPath, toPath);
  } catch (error) {
    if (!moveCompanion) throw error;
    try {
      await rename(moveCompanion.to, moveCompanion.from);
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        'Rename failed and the document companion could not be restored.',
      );
    }
    throw error;
  }
}
