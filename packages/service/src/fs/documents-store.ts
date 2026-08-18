import type { Stats } from 'node:fs';
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative } from 'node:path';
import { type ProjectFileEntry, isOutsideInInternalPath } from '@bendyline/gezel';
import { type ExternalFolders, gezelPaths } from '@bendyline/gezel/paths';
import type { HistoryManager } from '../history/manager.js';
import { convertDocToMarkdown, isConvertibleDoc } from '../index-store/docs.js';
import { writeFileAtomic } from './atomic.js';
import { DocumentAuditCoalescer } from './document-audit.js';
import { mimeTypeForFilename } from './media-types.js';
import { safeJoin } from './safe-paths.js';
import {
  type WalkDirResult,
  listDirEntries,
  safeReadTextFile,
  safeResolveRead,
  safeStatFileSize,
  walkDir,
  walkDirDetailed,
} from './tree.js';

/**
 * A utf8 decode of binary bytes yields replacement characters rather than
 * failing, so "did this read produce text?" has to be answered after the fact.
 */
function looksBinary(text: string): boolean {
  const sample = text.slice(0, 4096);
  if (sample.includes('\u0000')) return true;
  const replacements = sample.match(/�/g)?.length ?? 0;
  return replacements > sample.length * 0.02;
}

export interface DocumentsStoreOptions {
  home: string;
  external?: ExternalFolders;
  history?: HistoryManager;
  /**
   * Notified on every write/delete/rename, including overwrites. The search
   * index relies on this hook to see edits.
   */
  onChange?: (ev: { type: 'write' | 'delete' | 'mkdir'; path: string }) => void;
  /** Test seam: shorten the audit coalescer's quiet window. */
  auditQuietWindowMs?: number;
}

/** Who is writing. Absent means the person, editing in the app. */
export interface DocumentWriteActor {
  gezelId?: string;
  sessionId?: string;
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
  private readonly onChange?: (ev: { type: 'write' | 'delete' | 'mkdir'; path: string }) => void;
  private readonly audit: DocumentAuditCoalescer;

  constructor(opts: DocumentsStoreOptions) {
    this.home = opts.home;
    this.external = opts.external;
    this.history = opts.history;
    this.onChange = opts.onChange;
    this.audit = new DocumentAuditCoalescer({
      ...(opts.history ? { history: opts.history } : {}),
      ...(opts.auditQuietWindowMs !== undefined ? { quietWindowMs: opts.auditQuietWindowMs } : {}),
    });
    this.audit.readAfter = (path) => this.readDocument(path);
  }

  /** Close any open edit windows — called on service shutdown. */
  async flushAudit(): Promise<void> {
    await this.audit.flushAll();
  }

  private notifyChange(type: 'write' | 'delete' | 'mkdir', path: string): void {
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

  /**
   * Same walk with the walker's full result. The library browser is the same
   * surface as the project file panels, so it needs what they need: mtimes to
   * sort by recency, the hidden entries behind the show-hidden key, and the
   * truncation flag (a library over the walker's cap otherwise renders as a
   * complete listing).
   */
  async listDocumentsRecursiveDetailed(
    opts: { withStats?: boolean; includeHidden?: boolean } = {},
  ): Promise<WalkDirResult> {
    return walkDirDetailed(this.documentsDir(), opts);
  }

  async readDocument(filePath: string): Promise<string | null> {
    return safeReadTextFile(this.documentsDir(), filePath);
  }

  /** On-disk byte size of a library document, or null when it is not a readable file. */
  async documentSize(filePath: string): Promise<number | null> {
    return safeStatFileSize(this.documentsDir(), filePath);
  }

  /**
   * Model-facing read. A plain utf8 read of a .docx hands the caller
   * mojibake, and `search_documents` can match inside one (the indexer
   * converts them), so the tool that follows up a hit has to be able to open
   * it. Office formats come back as markdown via the same sandboxed
   * converter the indexer uses; other binaries return an explicit refusal
   * rather than garbage the model would try to reason about.
   */
  async readDocumentAsMarkdown(
    filePath: string,
  ): Promise<{ content: string; converted: boolean } | null> {
    const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
    if (isConvertibleDoc(ext)) {
      const abs = await safeResolveRead(this.documentsDir(), filePath);
      if (!abs) return null;
      const conversion = await convertDocToMarkdown(abs).catch(() => null);
      if (conversion?.markdown) {
        return { content: conversion.markdown, converted: true };
      }
      return {
        content: `read_document: '${filePath}' could not be converted to text${
          conversion?.blocked ? ' (held for safety)' : ''
        }. Ask the user what it should contain, or work from another source.`,
        converted: false,
      };
    }
    const text = await safeReadTextFile(this.documentsDir(), filePath);
    if (text === null) return null;
    if (looksBinary(text)) {
      return {
        content: `read_document: '${filePath}' is a binary file (${mimeTypeForFilename(
          filePath,
        )}) and cannot be shown as text.`,
        converted: false,
      };
    }
    return { content: text, converted: false };
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

  async writeDocument(
    filePath: string,
    content: string,
    actor?: DocumentWriteActor,
  ): Promise<void> {
    const full = this.resolveWritePath(filePath);
    const existed = await pathExists(full);
    // Read the prior content before overwriting so the audit trail can say
    // how much moved, not merely that something did.
    const before =
      existed && !isOutsideInInternalPath(filePath) ? await this.readDocument(filePath) : null;
    await mkdir(dirname(full), { recursive: true });
    await writeFileAtomic(full, content);
    this.notifyChange('write', filePath);
    if (isOutsideInInternalPath(filePath)) return;
    if (!existed) {
      await this.history?.log({
        kind: 'document.created',
        summary: `Created document ${filePath}`,
        ...(actor?.gezelId ? { gezelId: actor.gezelId } : {}),
        details: { path: filePath, bytes: content.length },
      });
      return;
    }
    this.audit.note({
      path: filePath,
      before,
      bytes: content.length,
      source: actor?.gezelId ? 'gezel' : 'ui',
      ...(actor ? { actor } : {}),
    });
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

  async deleteDocument(filePath: string, actor?: DocumentWriteActor): Promise<void> {
    const full = this.resolveWritePath(filePath);
    // The edits belong to the document while it still exists.
    await this.audit.flushPath(filePath);
    await rm(full, { recursive: true, force: true });
    this.notifyChange('delete', filePath);
    if (!isOutsideInInternalPath(filePath)) {
      await this.history?.log({
        kind: 'document.deleted',
        summary: `Deleted document ${filePath}`,
        ...(actor?.gezelId ? { gezelId: actor.gezelId } : {}),
        details: { path: filePath },
      });
    }
  }

  async createDocumentFolder(folderPath: string): Promise<void> {
    const full = this.resolveWritePath(folderPath);
    await mkdir(full, { recursive: true });
    this.notifyChange('mkdir', folderPath);
    if (!isOutsideInInternalPath(folderPath)) {
      await this.history?.log({
        kind: 'document.folder.created',
        summary: `Created document folder ${folderPath}`,
        details: { path: folderPath },
      });
    }
  }

  async renameDocument(fromPath: string, toPath: string): Promise<void> {
    // Close the sitting against the name the edits were made under.
    await this.audit.flushPath(fromPath);
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
