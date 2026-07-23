import type { Store } from '../fs/store.js';
import type { ImageAttachment } from '../providers/types.js';

/**
 * Extract any image refs the user embedded in their message markdown and
 * load them off disk into provider-agnostic base64 attachments.
 *
 * Two ref shapes are supported:
 *   - `attachments/<filename>` — project-scoped, stored under
 *     `artifacts/attachments/`. Resolved via `readProjectAttachment`.
 *     Preferred for new chats.
 *   - `images/<filename>`      — legacy, session-scoped, stored under
 *     `artifacts/sessions/{sid}/images/`. Resolved via
 *     `readSessionImage`. Kept so archived conversations still render.
 *
 * Anything absolute (`http(s)://`, `data:`, `file://`) is left alone —
 * the provider decides what to do with it. Refs that can't be resolved
 * (typo, already-deleted) are dropped silently so the user's turn
 * still goes through with the text.
 */
export async function extractImageAttachments(
  store: Store,
  projectId: string,
  sessionId: string,
  markdown: string,
): Promise<ImageAttachment[]> {
  const refs = findImageRefs(markdown);
  if (refs.length === 0) return [];
  const out: ImageAttachment[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    const key = `${ref.scope}:${ref.filename}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const hit =
      ref.scope === 'attachments'
        ? await store.readProjectAttachment(projectId, ref.filename)
        : await store.readSessionImage(projectId, sessionId, ref.filename);
    if (!hit) continue;
    out.push({
      base64: hit.data.toString('base64'),
      mimeType: hit.mimeType,
      filename: ref.filename,
    });
  }
  return out;
}

export interface ParsedImageRef {
  /** Which folder the filename lives in on disk. */
  scope: 'attachments' | 'images';
  filename: string;
}

/**
 * Pull every `![…](<scope>/<filename>)` markdown image reference in the
 * input where `<scope>` is `attachments` (preferred) or `images`
 * (legacy session-scoped). Permissive on the alt text, strict on the
 * path shape so we don't match unrelated links.
 */
export function findImageRefs(markdown: string): ParsedImageRef[] {
  const out: ParsedImageRef[] = [];
  const re = /!\[[^\]]*\]\(\s*(attachments|images)\/([^)\s]+?)\s*\)/g;
  for (const m of markdown.matchAll(re)) {
    const scope = m[1] as 'attachments' | 'images';
    const filename = m[2];
    if (filename) out.push({ scope, filename });
  }
  return out;
}
