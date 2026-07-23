import { mkdir, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ProjectFileEntry } from '@bendyline/gezel';
import { type ExternalFolders, gezelPaths } from '@bendyline/gezel/paths';
import type { HistoryManager } from '../history/manager.js';
import { writeFileAtomic } from './atomic.js';
import { safeJoin } from './safe-paths.js';
import { listDirEntries, safeReadTextFile, walkDir } from './tree.js';

export interface DocumentsStoreOptions {
  home: string;
  external?: ExternalFolders;
  history?: HistoryManager;
  /**
   * Notified on every write/delete — including overwrites of an existing
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

  async writeDocument(filePath: string, content: string): Promise<void> {
    const full = this.resolveWritePath(filePath);
    const existed = await pathExists(full);
    await mkdir(dirname(full), { recursive: true });
    await writeFileAtomic(full, content);
    this.notifyChange('write', filePath);
    if (!existed) {
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
    if (!existed) {
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
    await this.history?.log({
      kind: 'document.deleted',
      summary: `Deleted document ${filePath}`,
      details: { path: filePath },
    });
  }

  async createDocumentFolder(folderPath: string): Promise<void> {
    const full = this.resolveWritePath(folderPath);
    await mkdir(full, { recursive: true });
  }

  private resolveWritePath(filePath: string): string {
    const full = safeJoin(this.documentsDir(), filePath);
    if (!full) throw new Error('path traversal blocked');
    return full;
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
