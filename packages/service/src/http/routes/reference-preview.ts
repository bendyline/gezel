import { readFile, realpath, stat } from 'node:fs/promises';
import { extname } from 'node:path';
import { ReferencePreviewRequestSchema, ReferencePreviewResponseSchema } from '@bendyline/gezel';
import { Hono } from 'hono';
import { normalizeArtifactPath } from '../../fs/project-artifacts-store.js';
import { realpathContained, safeJoin } from '../../fs/safe-paths.js';
import {
  adjacentDocFilesPaths,
  ensureConvertedMarkdownSidecar,
  ensureShadowDocSidecar,
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

function isMissingPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
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
    // Only the artifacts drawer: a workspace tree may legitimately own an
    // `artifacts/` folder of its own.
    const path = request.kind === 'artifact' ? normalizeArtifactPath(request.path) : request.path;
    const joined = safeJoin(base, path);
    if (!joined) {
      return c.json({ error: 'path traversal' }, 400);
    }
    if (!(await realpathContained(base, joined))) {
      // A deleted project can leave historical chat references behind. When
      // its entire drawer is gone, realpath containment cannot establish a
      // trusted base; that is a missing reference, not an unsafe request.
      try {
        await stat(base);
      } catch (error) {
        if (isMissingPathError(error)) return c.json({ error: 'not found' }, 404);
        throw error;
      }
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

    const media = mediaKind(path);
    if (media) {
      return c.json(ReferencePreviewResponseSchema.parse({ mode: 'media', mediaKind: media }));
    }

    if (isConvertibleDoc(extname(path))) {
      if (request.kind === 'workspace') {
        // Workspace sources share the indexer's shadow cache under
        // artifacts/shadow — one sidecar per doc, wherever it's requested
        // from, and nothing written into a possibly read-only workspace.
        const converted = await ensureShadowDocSidecar(
          sourcePath,
          ctx.store.projectArtifactsDir(projectId),
          path,
        );
        if (converted?.markdown != null) {
          return c.json(
            ReferencePreviewResponseSchema.parse({
              mode: 'markdown',
              content: converted.markdown,
              sidecarPath: `artifacts/${converted.paths.mdRel}`,
            }),
          );
        }
        return c.json(ReferencePreviewResponseSchema.parse({ mode: 'binary' }));
      }
      const paths = adjacentDocFilesPaths(base, path);
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
