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
 * **Scope**: an instance wraps a *single directory* — the parent of the
 * currently-open markdown document. Paths handed to `readFile` /
 * `writeFile` are interpreted relative to that root. So if the user
 * opens `notes/diary.md`, the container's root is `notes/` and a
 * markdown image reference like `![](hero.jpg)` resolves to
 * `notes/hero.jpg` on disk. This matches squisq's per-document
 * convention used by docblocks's `FileSystemContentContainer`.
 *
 * **Constraints**: the gezel documents API is text-first. Markdown
 * reads/writes use `readDocument` / `writeDocument` (JSON-bodied);
 * binary reads use `?raw=1` and binary writes go through the dedicated
 * `PUT /raw` endpoint added for this integration. The adapter MIME-
 * guesses from extension because the listing API doesn't surface a
 * type field today.
 */

import type { GezelClient } from '@bendyline/gezel-client';
import type { ContentContainer, ContentEntry } from '@bendyline/squisq/storage';

const EXTENSION_MIME: Record<string, string> = {
  md: 'text/markdown',
  markdown: 'text/markdown',
  txt: 'text/plain',
  json: 'application/json',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  css: 'text/css',
  html: 'text/html',
  js: 'application/javascript',
};

function guessMime(path: string): string {
  const dot = path.lastIndexOf('.');
  if (dot === -1) return 'application/octet-stream';
  const ext = path.slice(dot + 1).toLowerCase();
  return EXTENSION_MIME[ext] ?? 'application/octet-stream';
}

function isTextMime(mime: string): boolean {
  return (
    mime === 'text/markdown' ||
    mime === 'text/plain' ||
    mime === 'application/json' ||
    mime === 'text/css' ||
    mime === 'text/html' ||
    mime === 'application/javascript' ||
    mime === 'image/svg+xml'
  );
}

function joinRoot(root: string, relative: string): string {
  if (!root) return relative;
  if (!relative) return root;
  const r = root.replace(/\/+$/, '');
  const p = relative.replace(/^\/+/, '');
  return `${r}/${p}`;
}

function basename(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? path : path.slice(slash + 1);
}

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
}

/**
 * Build a `ContentContainer` whose files live under `<documents>/<root>/`.
 *
 * Squisq's image rendering, Files panel, and format-converters all go
 * through this single interface — wiring it once gives the editor the
 * full storage story.
 */
export function createDocumentsContentContainer(
  options: DocumentsContentContainerOptions,
): ContentContainer {
  const { root, client, primaryDocumentFilename } = options;

  return {
    async readFile(path: string): Promise<ArrayBuffer | null> {
      const full = joinRoot(root, path);
      const mime = guessMime(path);
      try {
        if (isTextMime(mime)) {
          const res = await client.readDocument(full);
          return new TextEncoder().encode(res.content).buffer as ArrayBuffer;
        }
        const blob = await client.fetchDocumentBlob(full);
        return await blob.arrayBuffer();
      } catch {
        return null;
      }
    },

    async writeFile(
      path: string,
      data: ArrayBuffer | Uint8Array,
      mimeType?: string,
    ): Promise<void> {
      const full = joinRoot(root, path);
      const mime = mimeType ?? guessMime(path);
      if (isTextMime(mime)) {
        const text = new TextDecoder().decode(data);
        await client.writeDocument(full, text);
        return;
      }
      await client.writeDocumentBinary(full, data, mime);
    },

    async removeFile(path: string): Promise<void> {
      const full = joinRoot(root, path);
      try {
        await client.deleteDocument(full);
      } catch {
        // no-op on missing
      }
    },

    async listFiles(prefix?: string): Promise<ContentEntry[]> {
      const subpath = prefix ? joinRoot(root, prefix) : root || undefined;
      const res = await client.listDocuments(subpath, true);
      const out: ContentEntry[] = [];
      const rootPrefix = root ? `${root.replace(/\/+$/, '')}/` : '';
      for (const f of res.files) {
        if (f.isDirectory) continue;
        const relative =
          rootPrefix && f.path.startsWith(rootPrefix) ? f.path.slice(rootPrefix.length) : f.path;
        out.push({
          path: relative,
          mimeType: guessMime(relative),
          size: 0,
        });
      }
      return out;
    },

    async exists(path: string): Promise<boolean> {
      const buf = await this.readFile(path);
      return buf !== null;
    },

    async getDocumentPath(): Promise<string | null> {
      if (primaryDocumentFilename) return primaryDocumentFilename;
      const entries = await this.listFiles();
      const rootFiles = entries.filter((e) => !e.path.includes('/'));
      const priority = ['index.md', 'doc.md', 'document.md'];
      for (const name of priority) {
        const hit = rootFiles.find((e) => e.path.toLowerCase() === name);
        if (hit) return hit.path;
      }
      return rootFiles.find((e) => e.path.toLowerCase().endsWith('.md'))?.path ?? null;
    },

    async readDocument(): Promise<string | null> {
      const docPath = await this.getDocumentPath();
      if (!docPath) return null;
      const buf = await this.readFile(docPath);
      if (!buf) return null;
      return new TextDecoder().decode(buf);
    },

    async writeDocument(markdown: string, filename?: string): Promise<void> {
      const name = filename ?? primaryDocumentFilename ?? 'index.md';
      const data = new TextEncoder().encode(markdown);
      await this.writeFile(name, data, 'text/markdown');
    },
  };
}

/**
 * Resolve `(root, primaryFilename)` from a full document path. Empty
 * `root` is returned when the document sits at the library root.
 */
export function deriveContainerScope(documentPath: string): {
  root: string;
  primaryDocumentFilename: string;
} {
  const trimmed = documentPath.replace(/^\/+/, '');
  const slash = trimmed.lastIndexOf('/');
  if (slash === -1) {
    return { root: '', primaryDocumentFilename: trimmed };
  }
  return {
    root: trimmed.slice(0, slash),
    primaryDocumentFilename: basename(trimmed),
  };
}
