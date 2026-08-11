import type { Stats } from 'node:fs';
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative } from 'node:path';
import { type ProjectFileEntry, isOutsideInInternalPath } from '@bendyline/gezel';
import { type ExternalFolders, gezelPaths } from '@bendyline/gezel/paths';
import type { HistoryManager } from '../history/manager.js';
import { writeFileAtomic } from './atomic.js';
import { mimeTypeForFilename } from './media-types.js';
import { safeJoin } from './safe-paths.js';
import { listDirEntries, safeReadTextFile, safeResolveRead, walkDir } from './tree.js';

export interface DocumentsStoreOptions {
  home: string;
  external?: ExternalFolders;
  history?: HistoryManager;
  /**
   * Notified on every write/delete/rename — including overwrites of an existing
   * document, which deliberately emit NO history event (the `!existed`
   * gate below). The global search index relies on this hook to see edits.
   */
  onChange?: (ev: { type: 'write' | 'delete'; path: string }) => void;
}

/**
 * Owns the global shared documents library.
 *
 * Store remains the public facade for callers, but the implementation lives
 * here so document-library behavior can evolve without adding more weight to
 * the Store monolith.
 */
export class DocumentsStore {
  private readonly home: string;
  private readonly external?: ExternalFolders;
  private readonly history?: HistoryManager;
  private readonly onChange?: (ev: { type: 'write' | 'delete'; path: string }) => void;

  constructor(opts: DocumentsStoreOptions) {
    this.home = opts.home;
    this.external = opts.external;
    this.history = opts.history;
    this.onChange = opts.onChange;
  }

  private notifyChange(type: 'write' | 'delete', path: string): void {
    try {
      this.onChange?.({ type, path });
    } catch {
      /* listener errors never reach the write path */
    }
  }

  documentsDir(): string {
    return gezelPaths(this.home, this.external).documents;
  }

  async listDocuments(subpath = ''): Promise<ProjectFileEntry[]> {
    return listDirEntries(this.documentsDir(), subpath);
  }

  async listDocumentsRecursive(): Promise<ProjectFileEntry[]> {
    return walkDir(this.documentsDir());
  }

  async readDocument(filePath: string): Promise<string | null> {
    return safeReadTextFile(this.documentsDir(), filePath);
  }

  async readDocumentBinary(filePath: string): Promise<{ data: Buffer; mimeType: string } | null> {
    const full = await safeResolveRead(this.documentsDir(), filePath);
    if (!full) return null;
    try {
      return {
        data: await readFile(full),
        mimeType: mimeTypeForFilename(filePath),
      };
    } catch {
      return null;
    }
  }

  async writeDocument(filePath: string, content: string): Promise<void> {
    const full = this.resolveWritePath(filePath);
    const existed = await pathExists(full);
    await mkdir(dirname(full), { recursive: true });
    await writeFileAtomic(full, content);
    this.notifyChange('write', filePath);
    if (!existed && !isOutsideInInternalPath(filePath)) {
      await this.history?.log({
        kind: 'document.created',
        summary: `Created document ${filePath}`,
        details: { path: filePath, bytes: content.length },
      });
    }
  }

  async writeDocumentBinary(filePath: string, data: Uint8Array): Promise<void> {
    const full = this.resolveWritePath(filePath);
    const existed = await pathExists(full);
    await mkdir(dirname(full), { recursive: true });
    await writeFileAtomic(full, data);
    this.notifyChange('write', filePath);
    if (!existed && !isOutsideInInternalPath(filePath)) {
      await this.history?.log({
        kind: 'document.created',
        summary: `Created document ${filePath}`,
        details: { path: filePath, bytes: data.byteLength },
      });
    }
  }

  async deleteDocument(filePath: string): Promise<void> {
    const full = this.resolveWritePath(filePath);
    await rm(full, { recursive: true, force: true });
    this.notifyChange('delete', filePath);
    if (!isOutsideInInternalPath(filePath)) {
      await this.history?.log({
        kind: 'document.deleted',
        summary: `Deleted document ${filePath}`,
        details: { path: filePath },
      });
    }
  }

  async createDocumentFolder(folderPath: string): Promise<void> {
    const full = this.resolveWritePath(folderPath);
    await mkdir(full, { recursive: true });
  }

  async renameDocument(fromPath: string, toPath: string): Promise<void> {
    const fromFull = this.resolveWritePath(fromPath);
    const toFull = this.resolveWritePath(toPath);
    if (fromFull === this.documentsDir() || toFull === this.documentsDir()) {
      throw new Error('the documents root cannot be renamed');
    }
    if (fromFull === toFull) return;

    let sourceStat: Stats;
    try {
      sourceStat = await stat(fromFull);
    } catch {
      throw new DocumentPathNotFoundError(fromPath);
    }
    if (await pathExists(toFull)) throw new DocumentPathExistsError(toPath);

    if (sourceStat.isDirectory()) {
      const relativeTarget = relative(fromFull, toFull);
      if (relativeTarget && !relativeTarget.startsWith('..') && !isAbsolute(relativeTarget)) {
        throw new Error('a folder cannot be moved inside itself');
      }
    }

    const descendantFiles = sourceStat.isDirectory()
      ? (await walkDir(fromFull)).filter((entry) => !entry.isDirectory).map((entry) => entry.path)
      : [];

    await mkdir(dirname(toFull), { recursive: true });
    await rename(fromFull, toFull);

    if (sourceStat.isDirectory()) {
      for (const childPath of descendantFiles) {
        this.notifyChange('delete', `${fromPath}/${childPath}`);
        this.notifyChange('write', `${toPath}/${childPath}`);
      }
    } else {
      this.notifyChange('delete', fromPath);
      this.notifyChange('write', toPath);
    }

    if (!isOutsideInInternalPath(fromPath) && !isOutsideInInternalPath(toPath)) {
      await this.history?.log({
        kind: 'document.renamed',
        summary: `Renamed ${fromPath} → ${toPath}`,
        details: { fromPath, toPath, isDirectory: sourceStat.isDirectory() },
      });
    }
  }

  private resolveWritePath(filePath: string): string {
    const full = safeJoin(this.documentsDir(), filePath);
    if (!full) throw new Error('path traversal blocked');
    return full;
  }
}

export class DocumentPathExistsError extends Error {
  constructor(path: string) {
    super(`A document or folder already exists at ${path}`);
    this.name = 'DocumentPathExistsError';
  }
}

export class DocumentPathNotFoundError extends Error {
  constructor(path: string) {
    super(`No document or folder exists at ${path}`);
    this.name = 'DocumentPathNotFoundError';
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
