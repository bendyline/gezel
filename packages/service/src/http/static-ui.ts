import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { Readable } from 'node:stream';
import { safeJoin } from '@bendyline/gezel-inference/internal/fs/safe-paths';
import { type Context, Hono } from 'hono';
import { mimeTypeForPath } from './mime.js';

export const UI_DOCUMENT_CACHE_CONTROL = 'no-cache';
export const UI_IMMUTABLE_ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable';

/** Files larger than this stream from disk instead of being read whole first. */
export const UI_STREAM_THRESHOLD_BYTES = 1024 * 1024;

/**
 * Vite content-hashes files below `assets/` (the app) and `startup/assets/`
 * (the startup page), so they can be cached forever.
 */
export function isImmutableUiAsset(relativePath: string): boolean {
  return relativePath.startsWith('assets/') || relativePath.startsWith('startup/assets/');
}

/**
 * Hashed assets are cached forever. Everything else (the HTML shell, which
 * names the hashed files, `theme-init.js`, the startup page's entry, the
 * proofing engine) revalidates, which is cheap with {@link uiFileEtag}.
 */
export function staticUiCacheControl(relativePath: string): string {
  return isImmutableUiAsset(relativePath)
    ? UI_IMMUTABLE_ASSET_CACHE_CONTROL
    : UI_DOCUMENT_CACHE_CONTROL;
}

/**
 * A validator for a revalidated file, from its size and modification time.
 * Without one, `no-cache` meant a full download on every use: the 31.5 MB
 * proofing engine each time a document opened, and the shell on every load.
 * Answered with 304, the browser also keeps its compiled copy of a script or
 * WebAssembly module.
 */
export function uiFileEtag(file: { size: number; mtimeMs: number }): string {
  return `W/"${file.size.toString(36)}-${Math.floor(file.mtimeMs).toString(36)}"`;
}

/** Whether an `If-None-Match` header names this validator (or `*`). */
export function ifNoneMatchHits(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  const weak = (tag: string) => tag.trim().replace(/^W\//, '');
  const target = weak(etag);
  return header.split(',').some((tag) => tag.trim() === '*' || weak(tag) === target);
}

/**
 * Only extensionless client routes receive the SPA shell. Returning
 * index.html for a missing script makes the browser report a misleading
 * module parse/fetch error and prevents stale-build recovery from seeing a
 * genuine 404.
 */
export function shouldServeUiShell(relativePath: string): boolean {
  if (relativePath === 'assets' || relativePath.startsWith('assets/')) return false;
  return relativePath === 'index.html' || extname(relativePath) === '';
}

/**
 * The bundled web UI at `/`: hashed assets cached forever, everything else
 * revalidated with a validator (304 when unchanged), large files streamed,
 * and client-side routes answered with the HTML shell.
 */
export function staticUiRoutes(uiDir: string): Hono {
  const app = new Hono();
  const serveFile = async (
    c: Context,
    path: string,
    servedRel: string,
    file: { size: number; mtimeMs: number },
  ) => {
    const headers: Record<string, string> = {
      'content-type': mimeTypeForPath(path),
      'cache-control': staticUiCacheControl(servedRel),
    };
    if (!isImmutableUiAsset(servedRel)) {
      const etag = uiFileEtag(file);
      headers.etag = etag;
      if (ifNoneMatchHits(c.req.header('if-none-match'), etag)) return c.body(null, 304, headers);
    }
    if (file.size > UI_STREAM_THRESHOLD_BYTES) {
      headers['content-length'] = String(file.size);
      return c.body(Readable.toWeb(createReadStream(path)) as ReadableStream, 200, headers);
    }
    return c.body(await readFile(path), 200, headers);
  };
  const serveShell = async (c: Context) => {
    const shell = join(uiDir, 'index.html');
    try {
      return await serveFile(c, shell, 'index.html', await stat(shell));
    } catch {
      return c.notFound();
    }
  };
  app.get('/*', async (c) => {
    const rel = c.req.path === '/' ? 'index.html' : c.req.path.replace(/^\/+/, '');
    const file = safeJoin(uiDir, rel);
    if (!file) return c.notFound();
    let found: Awaited<ReturnType<typeof stat>>;
    try {
      found = await stat(file);
    } catch {
      return shouldServeUiShell(rel) ? serveShell(c) : c.notFound();
    }
    if (!found.isFile()) return shouldServeUiShell(rel) ? serveShell(c) : c.notFound();
    return serveFile(c, file, rel, found);
  });
  return app;
}
