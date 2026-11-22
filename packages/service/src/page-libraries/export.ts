import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { realpathContained, safeJoin } from '@bendyline/gezel-inference/internal/fs/safe-paths';
import type { PageLibraryStore } from '@bendyline/gezel-inference/internal/page-libraries/store';
import {
  compilePreviewModule,
  scanPreviewModuleImports,
} from '@bendyline/gezel-script-runtime/preview-module';
import {
  type PageExportResult,
  type PageExportSource,
  exportPageFolder,
  exportPageSingleFile,
} from '@bendyline/gezel/pages';
import * as yazl from 'yazl';
import type { Store } from '../fs/store.js';

/** A page folder holding more than this is not exported: it is a project, not a page. */
const MAX_EXPORT_FILES = 2_000;
const MAX_EXPORT_BYTES = 256 * 1024 * 1024;
/** Folders a page never loads from, and that would bloat a copy. */
const SKIPPED_FOLDERS = new Set(['node_modules', '.git', '.gezel', 'dist-ssr', '__pycache__']);

export interface ExportedPage {
  filename: string;
  contentType: string;
  body: Uint8Array;
  notes: string[];
}

/**
 * A workspace page with its libraries, as a zip of its folder or as one HTML
 * file (docs/page-libraries.md, `exportPageFolder` / `exportPageSingleFile`).
 * Reads only inside the project's workspace and the shelf's own files.
 */
export async function exportWorkspacePage(opts: {
  store: Store;
  shelf: PageLibraryStore;
  projectId: string;
  entry: string;
  format: 'folder' | 'single';
}): Promise<ExportedPage> {
  const baseDir = await opts.store.projectWorkspaceDir(opts.projectId);
  const inWorkspace = async (path: string): Promise<string | null> => {
    const full = safeJoin(baseDir, path);
    return full && (await realpathContained(baseDir, full).catch(() => false)) ? full : null;
  };
  const installed = await opts.shelf.installed();
  const pins = await opts.store.readPageLibraryPins(opts.projectId);

  const source: PageExportSource = {
    entry: opts.entry,
    readText: async (path) => {
      const full = await inWorkspace(path);
      const info = full ? await stat(full).catch(() => null) : null;
      return full && info?.isFile() ? readFile(full, 'utf8').catch(() => null) : null;
    },
    readBytes: async (path) => {
      const full = await inWorkspace(path);
      const info = full ? await stat(full).catch(() => null) : null;
      return full && info?.isFile() ? readFile(full).catch(() => null) : null;
    },
    listFiles: async (folder) => {
      const found: string[] = [];
      let bytes = 0;
      const walk = async (relative: string): Promise<void> => {
        const full = await inWorkspace(relative || '.');
        if (!full) return;
        const entries = await readdir(full, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
          if (entry.name.startsWith('.') || SKIPPED_FOLDERS.has(entry.name)) continue;
          const path = `${relative}${entry.name}`;
          if (entry.isDirectory()) {
            await walk(`${path}/`);
          } else if (entry.isFile()) {
            const size = (await stat(join(full, entry.name)).catch(() => null))?.size ?? 0;
            bytes += size;
            found.push(path);
            if (found.length > MAX_EXPORT_FILES || bytes > MAX_EXPORT_BYTES) {
              throw new Error(
                'This page sits in a folder too large to export. Move the page into a folder of its own.',
              );
            }
          }
        }
      };
      await walk(folder);
      return found;
    },
    lines: installed.map((entry) => entry.line),
    ...(Object.keys(pins).length ? { pins } : {}),
    readLibrary: async (line, path) => {
      const full = await opts.shelf.file(line.library, line.version, path);
      return full ? readFile(full).catch(() => null) : null;
    },
    readNotice: async (line) => {
      if (!line.notice) return null;
      const full = await opts.shelf.file(line.library, line.version, line.notice);
      return full ? readFile(full, 'utf8').catch(() => null) : null;
    },
    compile: (code, path, format) => compilePreviewModule(code, path, format),
    scanImports: (code, path) => scanPreviewModuleImports(code, path),
  };

  const stem = opts.entry.split('/').at(-2) ?? opts.entry.replace(/\.html?$/i, '');
  const name = (stem || 'page').replace(/[^\w.-]+/g, '-');
  if (opts.format === 'single') {
    const result = await exportPageSingleFile(source);
    const file = result.files[0]!;
    return {
      filename: `${name}.html`,
      contentType: 'text/html; charset=utf-8',
      body: typeof file.data === 'string' ? new TextEncoder().encode(file.data) : file.data,
      notes: result.notes,
    };
  }
  const result = await exportPageFolder(source);
  return {
    filename: `${name}.zip`,
    contentType: 'application/zip',
    body: await zip(result, name),
    notes: result.notes,
  };
}

function zip(result: PageExportResult, folder: string): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const archive = new yazl.ZipFile();
    for (const file of result.files) {
      const data =
        typeof file.data === 'string' ? Buffer.from(file.data, 'utf8') : Buffer.from(file.data);
      archive.addBuffer(data, `${folder}/${file.path}`);
    }
    archive.end();
    const chunks: Buffer[] = [];
    archive.outputStream.on('data', (chunk: Buffer) => chunks.push(chunk));
    archive.outputStream.on('error', reject);
    archive.outputStream.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks))));
  });
}
