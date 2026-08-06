import { readFile, realpath, stat } from 'node:fs/promises';
import { extname } from 'node:path';
import { ReferencePreviewRequestSchema, ReferencePreviewResponseSchema } from '@bendyline/gezel';
import { Hono } from 'hono';
import { realpathContained, safeJoin } from '../../fs/safe-paths.js';
import {
  adjacentDocFilesPaths,
  docFilesPaths,
  ensureConvertedMarkdownSidecar,
  isConvertibleDoc,
} from '../../index-store/docs.js';
import type { ServiceContext } from '../context.js';

const IMAGE_EXTS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.svg',
  '.webp',
  '.bmp',
  '.ico',
  '.avif',
]);
const VIDEO_EXTS = new Set(['.mp4', '.webm', '.ogv', '.mov', '.m4v', '.avi', '.mkv']);
const AUDIO_EXTS = new Set(['.mp3', '.wav', '.ogg', '.oga', '.m4a', '.aac', '.flac', '.opus']);

function mediaKind(path: string): 'image' | 'video' | 'audio' | null {
  const ext = extname(path).toLowerCase();
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  return null;
}

/**
 * A strict UTF-8 decode catches most binary formats; the control-byte ratio
 * catches the remaining ASCII-heavy containers. This runs in the daemon so
 * arbitrary bytes never cross the JSON/text preview boundary.
 */
function decodeText(bytes: Uint8Array): string | null {
  if (bytes.length === 0) return '';
  let content: string;
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  const sample = content.slice(0, 8192);
  let controls = 0;
  for (let i = 0; i < sample.length; i++) {
    const code = sample.charCodeAt(i);
    if (code < 9 || (code > 13 && code < 32)) controls++;
  }
  return controls / Math.max(sample.length, 1) > 0.1 ? null : content;
}

/**
 * Safe, typed preview preparation for the References rail. Media is left as a
 * blob, convertible documents become markdown companions, unknown binaries
 * become a machine-file card, and only verified UTF-8 reaches the text editor.
 */
export function referencePreviewRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  app.get('/:id/reference-preview', async (c) => {
    const projectId = c.req.param('id');
    const request = ReferencePreviewRequestSchema.parse({
      kind: c.req.query('kind'),
      path: c.req.query('path'),
    });
    const base =
      request.kind === 'artifact'
        ? ctx.store.projectArtifactsDir(projectId)
        : request.kind === 'workspace'
          ? await ctx.store.projectWorkspaceDir(projectId)
          : ctx.store.documentsDir();
    const joined = safeJoin(base, request.path);
    if (!joined || !(await realpathContained(base, joined))) {
      return c.json({ error: 'path traversal' }, 400);
    }

    let sourcePath: string;
    try {
      const file = await stat(joined);
      if (!file.isFile()) return c.json({ error: 'not found' }, 404);
      sourcePath = await realpath(joined);
    } catch {
      return c.json({ error: 'not found' }, 404);
    }

    const media = mediaKind(request.path);
    if (media) {
      return c.json(ReferencePreviewResponseSchema.parse({ mode: 'media', mediaKind: media }));
    }

    if (isConvertibleDoc(extname(request.path))) {
      const paths =
        request.kind === 'workspace'
          ? docFilesPaths(base, request.path)
          : adjacentDocFilesPaths(base, request.path);
      if (!(await realpathContained(base, paths.mdPath))) {
        return c.json({ error: 'sidecar path traversal' }, 400);
      }
      const converted = await ensureConvertedMarkdownSidecar(sourcePath, paths);
      if (converted.markdown !== null) {
        return c.json(
          ReferencePreviewResponseSchema.parse({
            mode: 'markdown',
            content: converted.markdown,
            sidecarPath: paths.mdRel,
          }),
        );
      }
      return c.json(ReferencePreviewResponseSchema.parse({ mode: 'binary' }));
    }

    const content = decodeText(await readFile(sourcePath));
    return c.json(
      ReferencePreviewResponseSchema.parse(
        content === null ? { mode: 'binary' } : { mode: 'text', content },
      ),
    );
  });

  return app;
}
