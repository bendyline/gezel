import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, posix } from 'node:path';
import {
  type DocumentMediaExportRequest,
  DocumentMediaExportRequestSchema,
} from '@bendyline/gezel';
import { playwrightBrowsersDir } from '@bendyline/gezel/paths';
import { markdownToDoc, resolveAudioMapping } from '@bendyline/squisq/doc';
import { parseMarkdown } from '@bendyline/squisq/markdown';
import type { Doc } from '@bendyline/squisq/schemas';
import type { ContentContainer, ContentEntry } from '@bendyline/squisq/storage';
import { Hono } from 'hono';
import { mimeTypeForFilename } from '../../fs/media-types.js';
import type { Store } from '../../fs/store.js';
import { resolveManagedChromiumBinary } from '../../rendering/managed-chromium.js';
import type { ServiceContext } from '../context.js';

interface NativeDocumentMediaRenderer {
  renderDocToMp4(
    doc: Doc,
    container: ContentContainer,
    options: { outputPath: string; signal?: AbortSignal },
  ): Promise<unknown>;
  renderDocToGif(
    doc: Doc,
    container: ContentContainer,
    options: { outputPath: string; signal?: AbortSignal },
  ): Promise<unknown>;
}

async function loadNativeRenderer(): Promise<NativeDocumentMediaRenderer> {
  return import('@bendyline/squisq-cli/api');
}

type ManagedBrowserRunner = <T>(home: string, task: () => Promise<T>) => Promise<T>;

let managedBrowserQueue: Promise<unknown> = Promise.resolve();

/**
 * Squisq's renderer uses its exact-pinned `playwright-core`, while Gezel's
 * system toolset may have downloaded Chromium with another Playwright
 * revision. Serialize the small launch override so Squisq reuses Gezel's
 * managed executable instead of looking for a second revision-specific copy.
 */
const runWithManagedBrowser: ManagedBrowserRunner = async (home, task) => {
  const run = async () => {
    const browsersDir = playwrightBrowsersDir(home);
    const executablePath = await resolveManagedChromiumBinary(browsersDir);
    if (!executablePath) {
      throw new Error(
        `Playwright Chromium is not installed under ${browsersDir}. Wait for browser setup to finish and try again.`,
      );
    }

    process.env.PLAYWRIGHT_BROWSERS_PATH ||= browsersDir;
    const { chromium } = await import('playwright-core');
    const ownLaunch = Object.getOwnPropertyDescriptor(chromium, 'launch');
    const originalLaunch = chromium.launch;
    chromium.launch = ((options = {}) =>
      originalLaunch.call(chromium, {
        ...options,
        executablePath,
        args: Array.from(
          new Set([...(options.args ?? []), '--disable-dev-shm-usage', '--no-sandbox']),
        ),
      })) as typeof chromium.launch;

    try {
      return await task();
    } finally {
      if (ownLaunch) Object.defineProperty(chromium, 'launch', ownLaunch);
      else delete (chromium as unknown as { launch?: unknown }).launch;
    }
  };

  const result = managedBrowserQueue.then(run, run);
  managedBrowserQueue = result.catch(() => undefined);
  return result;
};

/**
 * Native rendered-media export for Squisq documents.
 *
 * Unlike the ordinary DOCX/PDF/PPTX exporters, MP4/GIF rendering needs a
 * browser for deterministic frame capture and a native encoder. Squisq's Node
 * API supplies both pieces and deliberately discovers ffmpeg from
 * `SQUISQ_FFMPEG`, PATH, or an optional user-installed `ffmpeg-static`.
 */
export function documentMediaExportRoutes(
  ctx: ServiceContext,
  loadRenderer: () => Promise<NativeDocumentMediaRenderer> = loadNativeRenderer,
  withManagedBrowser: ManagedBrowserRunner = runWithManagedBrowser,
): Hono {
  const app = new Hono();

  app.post('/', async (c) => {
    const body = DocumentMediaExportRequestSchema.parse(await c.req.json());
    const outputDir = await mkdtemp(join(tmpdir(), 'gezel-document-media-export-'));
    const filename = mediaExportFilename(body.selectedFile, body.format);
    const outputPath = join(outputDir, filename);

    try {
      const container = createStoreBackedContainer(ctx.store, body);
      const parsed = parseMarkdown(body.markdown);
      const doc = await resolveAudioMapping(markdownToDoc(parsed), container);
      const renderer = await loadRenderer();
      await withManagedBrowser(ctx.home, async () => {
        if (body.format === 'gif') {
          await renderer.renderDocToGif(doc, container, {
            outputPath,
            signal: c.req.raw.signal,
          });
        } else {
          await renderer.renderDocToMp4(doc, container, {
            outputPath,
            signal: c.req.raw.signal,
          });
        }
      });
      const bytes = await readFile(outputPath);
      const contentType = body.format === 'gif' ? 'image/gif' : 'video/mp4';
      return c.body(bytes, 200, {
        'content-type': contentType,
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      });
    } catch (error) {
      if (c.req.raw.signal.aborted) {
        return c.json({ error: 'Document media export was cancelled.' }, 408);
      }
      const detail =
        error instanceof Error && error.message.trim()
          ? error.message.trim().slice(0, 4_000)
          : 'Native document media export failed.';
      const missingRuntime =
        detail.includes('ffmpeg is required but not found') ||
        detail.includes('SQUISQ_FFMPEG is set') ||
        detail.includes('Playwright Chromium is not installed');
      return c.json({ error: detail }, missingRuntime ? 409 : 500);
    } finally {
      await rm(outputDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  return app;
}

function mediaExportFilename(selectedFile: string, format: 'mp4' | 'gif'): string {
  const tail = basename(selectedFile.replace(/\\/g, '/'));
  const stem = tail.replace(/\.[^.]+$/, '') || 'document';
  const safeStem = stem.replace(/[^A-Za-z0-9._ -]/g, '_').slice(0, 160) || 'document';
  return `${safeStem}.${format}`;
}

function createStoreBackedContainer(
  store: Store,
  request: DocumentMediaExportRequest,
): ContentContainer {
  const selectedFile = request.selectedFile.replace(/\\/g, '/');
  const root = posix.dirname(selectedFile) === '.' ? '' : posix.dirname(selectedFile);
  const primaryDocument = posix.basename(selectedFile);
  const source = request.source;

  const scopedPath = (relativePath: string): string | null => {
    const normalized = relativePath.replace(/\\/g, '/');
    if (
      normalized.startsWith('/') ||
      /^[A-Za-z]:\//.test(normalized) ||
      normalized.split('/').includes('..')
    ) {
      return null;
    }
    return root ? posix.join(root, normalized) : posix.normalize(normalized);
  };

  const readBinary = async (relativePath: string): Promise<ArrayBuffer | null> => {
    const path = scopedPath(relativePath);
    if (!path) return null;
    const value =
      source.kind === 'documents'
        ? await store.readDocumentBinary(path)
        : await store.readProjectArtifactBinary(source.projectId, path);
    if (!value) return null;
    const copy = new Uint8Array(value.data.byteLength);
    copy.set(value.data);
    return copy.buffer;
  };

  const listEntries = async (prefix?: string): Promise<ContentEntry[]> => {
    const entries =
      source.kind === 'documents'
        ? await store.listDocumentsRecursive()
        : await store.listProjectArtifactsRecursive(source.projectId);
    const rootPrefix = root ? `${root}/` : '';
    const scopedPrefix = prefix?.replace(/^\/+/, '') ?? '';
    return entries
      .filter((entry) => !entry.isDirectory)
      .filter((entry) => !rootPrefix || entry.path.startsWith(rootPrefix))
      .map((entry) =>
        rootPrefix && entry.path.startsWith(rootPrefix)
          ? { ...entry, path: entry.path.slice(rootPrefix.length) }
          : entry,
      )
      .filter((entry) => !scopedPrefix || entry.path.startsWith(scopedPrefix))
      .map((entry) => ({
        path: entry.path,
        mimeType: mimeTypeForFilename(entry.path),
        size: 0,
      }));
  };

  const readOnly = async (): Promise<never> => {
    throw new Error('The native document export container is read-only.');
  };

  return {
    readFile: readBinary,
    writeFile: readOnly,
    removeFile: readOnly,
    listFiles: listEntries,
    exists: async (path) => (await readBinary(path)) !== null,
    getDocumentPath: async () => primaryDocument,
    readDocument: async () => request.markdown,
    writeDocument: readOnly,
  };
}
