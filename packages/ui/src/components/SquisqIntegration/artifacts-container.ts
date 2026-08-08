/**
 * ContentContainer adapter over project artifacts. Sibling of
 * {@link createDocumentsContentContainer} but scoped to a single
 * project's `artifacts/` tree — the per-project surface squisq's editor
 * mounts when the user opens a markdown file out of the Projects view.
 *
 * The wiring mirrors the documents variant: text I/O goes through the
 * existing JSON-bodied write endpoint, binary I/O goes through the
 * `?raw=1` reader and the dedicated `PUT /raw` writer added for this
 * integration. MIME-type guessing is identical (artifacts are organized
 * by extension; the listing API doesn't carry a type field).
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
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
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

export interface ArtifactsContentContainerOptions {
  /** Project id whose `artifacts/` tree this container wraps. */
  projectId: string;
  /**
   * Sub-path within `artifacts/` this container is rooted at. Use the
   * directory of the currently-open artifact. Empty string = the
   * project's artifacts root.
   */
  root: string;
  /** Authenticated gezel client. */
  client: GezelClient;
  /** Primary-doc filename override — basename of the file the user opened. */
  primaryDocumentFilename?: string;
  /** Storage tree to wrap. Defaults to the project artifact drawer. */
  source?: 'artifacts' | 'workspace';
}

export function createProjectContentContainer(
  options: ArtifactsContentContainerOptions,
): ContentContainer {
  const { projectId, root, client, primaryDocumentFilename, source = 'artifacts' } = options;

  return {
    async readFile(path: string): Promise<ArrayBuffer | null> {
      const full = joinRoot(root, path);
      const mime = guessMime(path);
      try {
        if (isTextMime(mime)) {
          const res =
            source === 'workspace'
              ? await client.readProjectWorkspaceFile(projectId, full)
              : await client.readProjectArtifact(projectId, full);
          return new TextEncoder().encode(res.content).buffer as ArrayBuffer;
        }
        const blob =
          source === 'workspace'
            ? await client.fetchProjectWorkspaceBlob(projectId, full)
            : await client.fetchProjectArtifactBlob(projectId, full);
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
        if (source === 'workspace') {
          await client.writeProjectWorkspaceFile(projectId, { path: full, content: text });
        } else {
          await client.writeProjectArtifact(projectId, full, text);
        }
        return;
      }
      if (source === 'workspace') {
        await client.writeProjectWorkspaceBinary(projectId, full, data, mime);
      } else {
        await client.writeProjectArtifactBinary(projectId, full, data, mime);
      }
    },

    async removeFile(path: string): Promise<void> {
      const full = joinRoot(root, path);
      try {
        if (source === 'workspace') {
          await client.rmProjectWorkspacePath(projectId, full, { recursive: true });
        } else {
          await client.deleteProjectArtifact(projectId, full);
        }
      } catch {
        // no-op
      }
    },

    async listFiles(prefix?: string): Promise<ContentEntry[]> {
      const subpath = prefix ? joinRoot(root, prefix) : root || undefined;
      const res =
        source === 'workspace'
          ? await client.listProjectWorkspace(projectId, subpath, true)
          : await client.listProjectArtifacts(projectId, subpath, true);
      const out: ContentEntry[] = [];
      const rootPrefix = root ? `${root.replace(/\/+$/, '')}/` : '';
      for (const f of res.files) {
        if (f.isDirectory) continue;
        if (rootPrefix && !f.path.startsWith(rootPrefix)) continue;
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

export function createArtifactsContentContainer(
  options: ArtifactsContentContainerOptions,
): ContentContainer {
  return createProjectContentContainer({ ...options, source: 'artifacts' });
}
