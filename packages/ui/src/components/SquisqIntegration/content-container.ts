import type { ContentContainer, ContentEntry } from '@bendyline/squisq/storage';
import { isContentNotFound } from './container-errors.js';

/** Endpoint selection is owned by each authority adapter, never by these mechanics. */
export interface ContentStorage {
  readText(path: string): Promise<{ content: string }>;
  readBlob(path: string): Promise<Blob>;
  writeText(path: string, content: string): Promise<unknown>;
  writeBinary(path: string, data: ArrayBuffer | Uint8Array, mime: string): Promise<unknown>;
  remove(path: string): Promise<unknown>;
  list(path?: string): Promise<{ files: { path: string; isDirectory: boolean }[] }>;
}

export interface ContentScope {
  root: string;
  primaryDocumentFilename?: string;
  referencePrefix?: string;
}

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

export function stripReferencePrefix(path: string, prefix?: string): string {
  const normalized = path.replace(/^\.\//, '').replace(/^\/+/, '');
  if (!prefix) return normalized;
  const canonicalPrefix = prefix.replace(/^\/+|\/+$/g, '');
  return normalized.startsWith(`${canonicalPrefix}/`)
    ? normalized.slice(canonicalPrefix.length + 1)
    : normalized;
}

/** Shared encoding, listing, and primary-document mechanics for a scoped API. */
export function createContentContainer(
  { root, primaryDocumentFilename, referencePrefix }: ContentScope,
  storage: ContentStorage,
): ContentContainer {
  const fullPath = (path: string) => joinRoot(root, stripReferencePrefix(path, referencePrefix));
  return {
    async readFile(path): Promise<ArrayBuffer | null> {
      const full = fullPath(path);
      try {
        if (isTextMime(guessMime(path))) {
          const { content } = await storage.readText(full);
          return new TextEncoder().encode(content).buffer as ArrayBuffer;
        }
        return await (await storage.readBlob(full)).arrayBuffer();
      } catch (error) {
        if (isContentNotFound(error)) return null;
        throw error;
      }
    },
    async writeFile(path, data, mimeType): Promise<void> {
      const full = fullPath(path);
      const mime = mimeType ?? guessMime(path);
      if (isTextMime(mime)) await storage.writeText(full, new TextDecoder().decode(data));
      else await storage.writeBinary(full, data, mime);
    },
    async removeFile(path): Promise<void> {
      try {
        await storage.remove(fullPath(path));
      } catch (error) {
        if (!isContentNotFound(error)) throw error;
      }
    },
    async listFiles(prefix): Promise<ContentEntry[]> {
      const { files } = await storage.list(prefix ? fullPath(prefix) : root || undefined);
      const rootPrefix = root ? `${root.replace(/\/+$/, '')}/` : '';
      return files.flatMap((file) => {
        if (file.isDirectory || (rootPrefix && !file.path.startsWith(rootPrefix))) return [];
        const path = rootPrefix ? file.path.slice(rootPrefix.length) : file.path;
        return [{ path, mimeType: guessMime(path), size: 0 }];
      });
    },
    async exists(path): Promise<boolean> {
      return (await this.readFile(path)) !== null;
    },
    async getDocumentPath(): Promise<string | null> {
      if (primaryDocumentFilename) return primaryDocumentFilename;
      const rootFiles = (await this.listFiles()).filter((entry) => !entry.path.includes('/'));
      for (const name of ['index.md', 'doc.md', 'document.md']) {
        const hit = rootFiles.find((entry) => entry.path.toLowerCase() === name);
        if (hit) return hit.path;
      }
      return rootFiles.find((entry) => entry.path.toLowerCase().endsWith('.md'))?.path ?? null;
    },
    async readDocument(): Promise<string | null> {
      const path = await this.getDocumentPath();
      if (!path) return null;
      const bytes = await this.readFile(path);
      return bytes === null ? null : new TextDecoder().decode(bytes);
    },
    async writeDocument(markdown, filename): Promise<void> {
      await this.writeFile(
        filename ?? primaryDocumentFilename ?? 'index.md',
        new TextEncoder().encode(markdown),
        'text/markdown',
      );
    },
  };
}
