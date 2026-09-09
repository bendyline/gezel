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

const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Retarget media/link destinations after a document's companion is renamed.
 *
 * Text documents expose their companion name in portable Markdown references
 * (`notes_files/hero.png`). Moving the directory without changing those
 * destinations leaves every image pointing at the old name. Outside-in
 * companions can carry the same explicit form, even though their usual media
 * paths are relative to the companion root, so this helper is shared by both.
 *
 * The rewrite is deliberately syntax-scoped: Markdown destinations, reference
 * definitions, and `src`/`href` attributes are changed, while prose and fenced
 * examples remain byte-for-byte intact. Both literal and percent-encoded
 * companion names are understood.
 */
export function rewriteDocumentCompanionRefs(
  markdown: string,
  fromDocumentPath: string,
  toDocumentPath: string,
): string {
  const fromName = deriveContainerScope(fromDocumentPath).companionName;
  const toName = deriveContainerScope(toDocumentPath).companionName;
  const encodedFromName = encodeURIComponent(fromName);
  if (fromName === toName || (!markdown.includes(fromName) && !markdown.includes(encodedFromName)))
    return markdown;

  const variants = [...new Set([fromName, encodedFromName])];
  const names = variants.map(escapeRegExp).join('|');
  const markdownDestination = new RegExp(`(\\]\\(\\s*<?(?:\\./)?)(${names})(?=/)`, 'g');
  const htmlAttribute = new RegExp(`(\\b(?:src|href)\\s*=\\s*["'](?:\\./)?)(${names})(?=/)`, 'g');
  const referenceDefinition = new RegExp(
    `^(\\s{0,3}\\[[^\\]]+\\]:\\s*<?(?:\\./)?)(${names})(?=/)`,
    'g',
  );
  const replacement = (_all: string, opener: string, matchedName: string) => {
    const encodedInput = encodedFromName !== fromName && matchedName === encodedFromName;
    const acceptsLiteralSpaces = opener.includes('<') || /["']$/.test(opener);
    const nextName = encodedInput || !acceptsLiteralSpaces ? encodeURIComponent(toName) : toName;
    return `${opener}${nextName}`;
  };

  const lines = markdown.split('\n');
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fenceMatch = FENCE_RE.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1]!;
      if (fence === null) {
        fence = marker[0]!.repeat(marker.length);
      } else if (marker[0] === fence[0] && marker.length >= fence.length) {
        fence = null;
      }
      continue;
    }
    if (fence !== null) continue;
    lines[i] = line
      .replace(markdownDestination, replacement)
      .replace(htmlAttribute, replacement)
      .replace(referenceDefinition, replacement);
  }
  return lines.join('\n');
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
