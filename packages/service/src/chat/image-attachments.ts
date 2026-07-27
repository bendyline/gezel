import type { Store } from '../fs/store.js';
import type { ImageAttachment } from '../providers/types.js';

/**
 * Extract any image refs the user embedded in their message markdown and
 * load them off disk into provider-agnostic base64 attachments.
 *
 * Three ref shapes are supported:
 *   - `attachments/<filename>` — project-scoped, stored under
 *     `artifacts/attachments/`. Resolved via `readProjectAttachment`.
 *     Preferred for new chats.
 *   - `images/<filename>`      — legacy, session-scoped, stored under
 *     `artifacts/sessions/{sid}/images/`. Resolved via
 *     `readSessionImage`. Kept so archived conversations still render.
 *   - `artifacts/<path>`       — anything under the project's artifacts
 *     tree, which is where `generate_image` and `render_image` write. The
 *     chat UI already renders these, so without this scope a model could
 *     display an image it produced but never look at it on a later turn.
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
  return (await extractResolvedImages(store, projectId, sessionId, markdown)).map(
    (r) => r.attachment,
  );
}

/** One resolved image, keyed by the markdown ref it came from. */
export interface ResolvedImage {
  /** `<scope>/<path>` exactly as it appears in the message body. */
  ref: string;
  attachment: ImageAttachment;
  bytes: Buffer;
}

/**
 * Same resolution as {@link extractImageAttachments}, but keeps the original
 * ref and the decoded bytes. The recognition path needs the ref to key its
 * digest onto the right image, and the raw bytes to hash and to feed the
 * vision engine without a base64 round-trip.
 */
export async function extractResolvedImages(
  store: Store,
  projectId: string,
  sessionId: string,
  markdown: string,
): Promise<ResolvedImage[]> {
  const refs = findImageRefs(markdown);
  if (refs.length === 0) return [];
  const out: ResolvedImage[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    const key = `${ref.scope}:${ref.filename}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const hit =
      ref.scope === 'attachments'
        ? await store.readProjectAttachment(projectId, ref.filename)
        : ref.scope === 'artifacts'
          ? await store.readProjectArtifactBinary(projectId, ref.filename)
          : await store.readSessionImage(projectId, sessionId, ref.filename);
    if (!hit) continue;
    out.push({
      ref: `${ref.scope}/${ref.filename}`,
      bytes: hit.data,
      attachment: {
        base64: hit.data.toString('base64'),
        mimeType: hit.mimeType,
        filename: ref.filename,
      },
    });
  }
  return out;
}

export type ImageRefScope = 'attachments' | 'images' | 'artifacts';

export interface ParsedImageRef {
  /** Which folder the filename lives in on disk. */
  scope: ImageRefScope;
  /** Path within the scope. May contain slashes for the `artifacts` scope. */
  filename: string;
}

/**
 * Pull every `![…](<scope>/<path>)` markdown image reference in the input.
 * Permissive on the alt text, strict on the path shape so we don't match
 * unrelated links.
 */
export function findImageRefs(markdown: string): ParsedImageRef[] {
  const out: ParsedImageRef[] = [];
  const re = /!\[[^\]]*\]\(\s*(attachments|images|artifacts)\/([^)\s]+?)\s*\)/g;
  for (const m of markdown.matchAll(re)) {
    const scope = m[1] as ImageRefScope;
    const filename = m[2];
    if (filename) out.push({ scope, filename });
  }
  return out;
}
