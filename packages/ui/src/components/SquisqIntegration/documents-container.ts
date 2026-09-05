/**
 * ContentContainer adapter over the gezel documents API.
 *
 * Squisq's editor + format converters consume a `ContentContainer` —
 * a virtual file system that serves the document and its sidecar files
 * (images, audio, version snapshots). The gezel daemon exposes the
 * shared documents library at `~/.gezel/documents/` via the HTTP
 * `/api/documents/*` routes; this adapter wraps those routes so we can
 * plug the documents library into squisq without reinventing storage.
 *
 * **Scope**: an instance wraps a *single directory*. Paths handed to `readFile` /
 * `writeFile` are interpreted relative to that root. So if the user
 * opens `notes/diary.md`, the container's root is `notes/` and a
 * markdown image reference like `![](hero.jpg)` resolves to
 * `notes/hero.jpg` on disk. Text-document editors instead root their working
 * container at `notes/diary_files/` and expose portable references through
 * the prefixed media adapter below.
 *
 * **Constraints**: the gezel documents API is text-first. Markdown
 * reads/writes use `readDocument` / `writeDocument` (JSON-bodied);
 * binary reads use `?raw=1` and binary writes go through the dedicated
 * `PUT /raw` endpoint added for this integration. The adapter MIME-
 * guesses from extension because the listing API doesn't surface a
 * type field today.
 */

import type { GezelClient } from '@bendyline/gezel-client';
import type { MediaProvider } from '@bendyline/squisq';
import { type ContentContainer, createMediaProviderFromContainer } from '@bendyline/squisq/storage';
import { createContentContainer, stripReferencePrefix } from './content-container.js';

export interface DocumentsContentContainerOptions {
  /**
   * Root path inside the documents library this container is scoped to.
   * Use the directory of the currently-open document. Empty string =
   * documents-library root.
   */
  root: string;
  /** Authenticated gezel client. */
  client: GezelClient;
  /**
   * Optional override for the primary-document filename. When set,
   * `getDocumentPath()` returns this without doing a directory walk.
   * Pass the basename of the file the user opened.
   */
  primaryDocumentFilename?: string;
  /**
   * Optional path prefix used by Markdown references outside this container.
   *
   * A visible `notes.md` document keeps its assets in `notes_files/`, so its
   * Markdown says `notes_files/hero.png` while the document-scoped container
   * sees `hero.png`. Supplying `notes_files` lets reads accept either form.
   */
  referencePrefix?: string;
}

/** Shared-library authority stays on the documents API. */
export function createDocumentsContentContainer(
  options: DocumentsContentContainerOptions,
): ContentContainer {
  const { client } = options;
  return createContentContainer(options, {
    readText: (path) => client.readDocument(path),
    readBlob: (path) => client.fetchDocumentBlob(path),
    writeText: (path, content) => client.writeDocument(path, content),
    writeBinary: (path, data, mime) => client.writeDocumentBinary(path, data, mime),
    remove: (path) => client.deleteDocument(path),
    list: (path) => client.listDocuments(path, true),
  });
}

/**
 * Adapt a document-scoped ContentContainer into the editor's MediaProvider.
 * Stored paths stay relative to the companion container, while paths exposed
 * to Markdown carry the companion prefix so the source remains portable next
 * to the visible document.
 */
export function createDocumentMediaProvider(
  container: ContentContainer,
  referencePrefix: string,
  legacyParentContainer?: ContentContainer,
): MediaProvider {
  const base = createMediaProviderFromContainer(container);
  const legacy = legacyParentContainer
    ? createMediaProviderFromContainer(legacyParentContainer)
    : null;
  const prefix = referencePrefix.replace(/^\/+|\/+$/g, '');
  const expose = (path: string) => `${prefix}/${stripReferencePrefix(path, prefix)}`;
  const internal = (path: string) => stripReferencePrefix(path, prefix);

  return {
    async resolveUrl(relativePath) {
      const path = internal(relativePath);
      const resolved = await base.resolveUrl(path);
      if (resolved !== path) return resolved;
      // Before document companions were enforced, text-editor uploads landed
      // beside the document and produced unprefixed references. Keep those
      // existing documents readable, but never fall through for an explicit
      // sibling `<stem>_files/...` path — cross-document assets stay isolated.
      const normalized = relativePath.replace(/^\.\//, '').replace(/^\/+/, '');
      const firstSegment = normalized.split('/')[0] ?? '';
      if (legacy && !firstSegment.toLocaleLowerCase('en-US').endsWith('_files')) {
        return legacy.resolveUrl(normalized);
      }
      // The container-backed provider returns its input on a miss. Preserve
      // the Markdown path in that case instead of leaking the stripped path.
      return relativePath;
    },
    async listMedia() {
      const entries = await base.listMedia();
      return entries.map((entry) => ({ ...entry, name: expose(entry.name) }));
    },
    async addMedia(name, data, mimeType) {
      return expose(await base.addMedia(internal(name), data, mimeType));
    },
    async removeMedia(relativePath) {
      await base.removeMedia(internal(relativePath));
    },
    dispose() {
      base.dispose();
      legacy?.dispose();
    },
  };
}

/**
 * Resolve the dedicated companion scope for a visible text document.
 * `notes/diary.md` owns `notes/diary_files/`; an extensionless `test` owns
 * `test_files/`. This mirrors the outside-in companion naming contract.
 */
export { deriveContainerScope } from './document-companion.js';
