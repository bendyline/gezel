import type { ChatSession } from '@bendyline/gezel';
import type { Store } from '../fs/store.js';

/**
 * Persists images returned by MCP tool calls (most commonly Playwright
 * `browser_*` screenshots) into the project's artifacts/ tree so the UI
 * can show thumbnails inline with the tool call AND so users can browse
 * them later via the Artifacts view.
 *
 * Layout chosen:
 *
 *   <project>/artifacts/sessions/<friendly-id>/tool-<n>-img-<i>.<ext>
 *
 * `friendly-id` is `<YYYY-MM-DD>_<HHMMSS>[_<title-slug>]` so the
 * artifacts pane sorts naturally by recency and the user can recognize
 * the conversation by its first prompt without having to memorize
 * session UUIDs. We fall back to the session's short id when there is no
 * title yet (a brand-new session whose first user message hasn't landed).
 */
export interface ToolImagePersister {
  /**
   * Write all images from a single tool result to the project artifacts
   * tree. The persister owns an internal monotonic counter so multiple
   * calls of the same tool inside one session don't collide on filename.
   * Returns the saved relative paths, parallel to the input array.
   */
  persist(
    images: ReadonlyArray<{ base64: string; mimeType: string }>,
  ): Promise<Array<{ path: string; mimeType: string }>>;
}

export interface CreateToolImagePersisterOptions {
  store: Store;
  projectId: string;
  session: Pick<ChatSession, 'id' | 'createdAt' | 'title'>;
}

/**
 * Build a persister bound to one (project, session) pair. ChatManager
 * creates one of these per active session and hands it down to the
 * provider's `OpenAISession` so it can write images as tool results
 * stream in. The friendly session subfolder name is computed lazily on
 * the first call — no empty `sessions/<…>/` directories are created
 * for sessions that never produce screenshots.
 */
export function createToolImagePersister(
  opts: CreateToolImagePersisterOptions,
): ToolImagePersister {
  const subfolder = sessionSubfolder(opts.session);
  let toolCallIndex = 0;
  return {
    async persist(images) {
      if (images.length === 0) return [];
      const idx = toolCallIndex++;
      const out: Array<{ path: string; mimeType: string }> = [];
      for (let i = 0; i < images.length; i++) {
        const img = images[i];
        if (!img) continue;
        const ext = extensionForMime(img.mimeType);
        const relPath = `sessions/${subfolder}/tool-${idx}-img-${i}${ext}`;
        const buf = Buffer.from(img.base64, 'base64');
        const written = await opts.store.writeProjectArtifactBinary(opts.projectId, relPath, buf);
        out.push({ path: written, mimeType: img.mimeType });
      }
      return out;
    },
  };
}

/**
 * Build the per-session subfolder name. Stable for a given session — the
 * same name is returned every time so re-runs of the same session append
 * into the same folder.
 *
 *   2026-04-19_143015_snake-game-debug
 *   2026-04-19_143015_a3f9b2c1               (no title yet)
 */
function sessionSubfolder(session: Pick<ChatSession, 'id' | 'createdAt' | 'title'>): string {
  const ts = formatTimestampForFolder(session.createdAt);
  const slug = slugifyTitle(session.title);
  if (slug) return `${ts}_${slug}`;
  // Use a short prefix of the session UUID so brand-new sessions still
  // land in distinct folders.
  return `${ts}_${session.id.slice(0, 8)}`;
}

function formatTimestampForFolder(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    // Defensive: a malformed createdAt shouldn't crash a tool result.
    return 'unknown-date';
  }
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}_${hh}${mi}${ss}`;
}

/**
 * Sanitize a session title into a filesystem-friendly slug. Drops
 * everything that isn't `[a-z0-9_-]` after lowercasing; collapses
 * runs of dashes; caps at 40 chars so paths stay readable.
 *
 * Returns the empty string for "no usable slug" so the caller can fall
 * back to a session-id suffix.
 */
function slugifyTitle(title: string | undefined): string {
  if (!title) return '';
  const s = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return s.replace(/-+$/, '');
}

function extensionForMime(mime: string): string {
  switch (mime.toLowerCase()) {
    case 'image/png':
      return '.png';
    case 'image/jpeg':
    case 'image/jpg':
      return '.jpg';
    case 'image/webp':
      return '.webp';
    case 'image/gif':
      return '.gif';
    default:
      return '.bin';
  }
}

// Internals exported for tests.
export const __testables = { sessionSubfolder, slugifyTitle, formatTimestampForFolder };
