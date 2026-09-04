import type { ContentContainer, ContentEntry } from '@bendyline/squisq/storage';

function encodePath(path: string): string {
  return path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function decodePath(path: string): string {
  try {
    return path
      .split('/')
      .map((segment) => decodeURIComponent(segment))
      .join('/');
  } catch {
    return path;
  }
}

/**
 * Present sidecar paths to Squisq as URI-safe Markdown references while
 * retaining the user's original filenames in the backing filesystem.
 *
 * Squisq's data-card recognizer operates on the editor link href. A CommonMark
 * `<destination with spaces>` is currently preserved there verbatim, leaving
 * the recognizer with a `.csv>` suffix. URI-safe paths avoid that ambiguity;
 * this adapter translates them back at the Gezel storage boundary.
 */
export function createDataReferenceContainer(container: ContentContainer): ContentContainer {
  const wrapped: ContentContainer = {
    mutationLock: container.mutationLock ?? container,
    readFile: (path) => container.readFile(decodePath(path)),
    writeFile: (path, data, mimeType) => container.writeFile(decodePath(path), data, mimeType),
    removeFile: (path) => container.removeFile(decodePath(path)),
    async listFiles(prefix?: string): Promise<ContentEntry[]> {
      const entries = await container.listFiles(prefix ? decodePath(prefix) : undefined);
      return entries.map((entry) => ({ ...entry, path: encodePath(entry.path) }));
    },
    exists: (path) => container.exists(decodePath(path)),
    async getDocumentPath() {
      const path = await container.getDocumentPath();
      return path === null ? null : encodePath(path);
    },
    async readDocument() {
      const path = await wrapped.getDocumentPath();
      if (path === null) return null;
      const bytes = await wrapped.readFile(path);
      return bytes === null ? null : new TextDecoder().decode(bytes);
    },
    writeDocument: (markdown, filename) =>
      container.writeDocument(markdown, filename ? decodePath(filename) : undefined),
  };

  if (container.writeFileExclusive) {
    wrapped.writeFileExclusive = (path, data, mimeType) =>
      container.writeFileExclusive!(decodePath(path), data, mimeType);
  }
  return wrapped;
}
