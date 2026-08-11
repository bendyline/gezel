import type { MediaEntry, MediaProvider } from '@bendyline/squisq';
import { api } from '../api.js';

/**
 * Media provider for the chat composer — bridges Squisq's pluggable
 * image storage to the gezel service's project-scoped attachment
 * endpoints.
 *
 * Attachments are **project-scoped**, not session-scoped: one paste
 * shows up in every chat in the same project and appears in the
 * Artifacts tab. Markdown refs use the relative form
 * `attachments/<filename>`, which `extractImageAttachments` resolves
 * server-side to raw bytes for the provider's vision input.
 *
 * Legacy `images/<filename>` refs (session-scoped, from chats that
 * pre-date this) still resolve via the session-image endpoint, so
 * archived conversations continue to render.
 *
 * Because `<img src>` can't carry a bearer token, `resolveUrl` fetches
 * the image via the authenticated client and hands back a `blob:` URL
 * that the browser can render directly. The blob URLs are cached for
 * the lifetime of this provider and revoked on `dispose()`.
 */

/**
 * Cached read-only media providers keyed on `projectId:sessionId`. The
 * session id identifies the cache scope but no longer scopes storage —
 * it just lets legacy `images/<filename>` refs resolve against the
 * right session's old folder for archived chats.
 */
const readonlyProviders = new Map<string, MediaProvider>();

/** Inert replacement for model-authored remote media references. */
export const BLOCKED_REMOTE_MEDIA_URL =
  'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';

function isRemoteOrUnsafeMediaUrl(value: string): boolean {
  const url = value.trim();
  if (/^(?:data|blob):/i.test(url)) return false;
  return url.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(url);
}

export function getReadonlyGezelMediaProvider(projectId: string, sessionId: string): MediaProvider {
  const key = `${projectId}:${sessionId}`;
  let hit = readonlyProviders.get(key);
  if (!hit) {
    hit = createGezelMediaProvider({ projectId, legacySessionId: sessionId });
    readonlyProviders.set(key, hit);
  }
  return hit;
}

export function createGezelMediaProvider(opts: {
  projectId: string;
  /**
   * Optional — when present, `resolveUrl` can fall back to the
   * session-scoped legacy image endpoint for markdown that references
   * `images/<filename>` from an archived conversation. New uploads
   * always target the project-scoped attachments endpoint regardless.
   */
  legacySessionId?: string;
}): MediaProvider {
  // Resolved blob URLs keyed by the relative path the doc holds
  // (e.g. "attachments/abc.png" or the legacy "images/abc.png"). Revoked
  // on dispose().
  const blobUrlCache = new Map<string, string>();
  // In-flight resolution promises so concurrent `<img>` mounts on the same
  // ref coalesce to a single fetch.
  const inflight = new Map<string, Promise<string>>();

  const toBlob = async (data: ArrayBuffer | Blob | Uint8Array, mimeType: string): Promise<Blob> => {
    if (data instanceof Blob) return data;
    // Copy through a fresh ArrayBuffer so TS is satisfied about
    // SharedArrayBuffer and so the blob owns its bytes.
    const src = data instanceof Uint8Array ? data : new Uint8Array(data);
    const copy = new Uint8Array(src.byteLength);
    copy.set(src);
    return new Blob([copy.buffer as ArrayBuffer], { type: mimeType });
  };

  const parseRelative = (
    relPath: string,
  ):
    | { scope: 'attachments'; filename: string }
    | { scope: 'images'; filename: string }
    | { scope: 'artifact'; path: string }
    | null => {
    const mAtt = /^attachments\/([^/]+)$/.exec(relPath);
    if (mAtt) return { scope: 'attachments', filename: mAtt[1]! };
    const mImg = /^images\/([^/]+)$/.exec(relPath);
    if (mImg) return { scope: 'images', filename: mImg[1]! };
    // Project-scoped artifact under `projects/<id>/artifacts/<…>`. The
    // model is told by `generate_image` to reference its output as
    // `artifacts/<path>`; without this branch a `![alt](artifacts/foo.png)`
    // embed in the assistant's reply renders as a broken-image icon.
    // Multi-segment paths are allowed (`artifacts/generated/foo.png`),
    // and bare `generated/foo.png` is accepted too as a courtesy for
    // models that drop the leading `artifacts/`.
    const mArt = /^artifacts\/(.+)$/.exec(relPath);
    if (mArt) return { scope: 'artifact', path: mArt[1]! };
    if (/^generated\/[^/].*\.(png|jpe?g|gif|webp|svg)$/i.test(relPath)) {
      return { scope: 'artifact', path: relPath };
    }
    return null;
  };

  return {
    async addMedia(
      _name: string,
      data: ArrayBuffer | Blob | Uint8Array,
      mimeType: string,
    ): Promise<string> {
      const blob = await toBlob(data, mimeType);
      const res = await api.uploadProjectAttachment(opts.projectId, blob, mimeType);
      // Prime the cache so the editor renders the just-pasted image
      // instantly — no round-trip through `resolveUrl`.
      blobUrlCache.set(res.relativePath, URL.createObjectURL(blob));
      return res.relativePath;
    },

    async resolveUrl(relPath: string): Promise<string> {
      // Model-authored network URLs are passive egress: merely displaying a
      // reply would disclose the request URL and client metadata. Keep inert
      // in-memory media, but replace every remote/custom scheme before it can
      // reach an <img>, even when a browser shell has no Electron hook.
      if (isRemoteOrUnsafeMediaUrl(relPath)) return BLOCKED_REMOTE_MEDIA_URL;
      if (/^(?:data|blob):/i.test(relPath.trim())) {
        return relPath;
      }
      const cached = blobUrlCache.get(relPath);
      if (cached) return cached;
      const existing = inflight.get(relPath);
      if (existing) return existing;
      const parsed = parseRelative(relPath);
      if (!parsed) return relPath;
      const p = (async () => {
        try {
          let blob: Blob;
          if (parsed.scope === 'attachments') {
            blob = await api.fetchProjectAttachment(opts.projectId, parsed.filename);
          } else if (parsed.scope === 'artifact') {
            // `artifacts/<path>` reference — typically a `generate_image`
            // output the model decided to embed inline as
            // `![alt](artifacts/generated/foo.png)`. Stream it back via
            // the artifact-read endpoint so the embed renders without
            // having to round-trip through the user pasting it.
            blob = await api.fetchProjectArtifactBlob(opts.projectId, parsed.path);
          } else {
            // Legacy session-scoped image. Skip if we don't know which
            // session this was authored in.
            if (!opts.legacySessionId) return relPath;
            blob = await api.fetchSessionImage(
              opts.projectId,
              opts.legacySessionId,
              parsed.filename,
            );
          }
          const url = URL.createObjectURL(blob);
          blobUrlCache.set(relPath, url);
          return url;
        } finally {
          inflight.delete(relPath);
        }
      })();
      inflight.set(relPath, p);
      return p;
    },

    async listMedia(): Promise<MediaEntry[]> {
      const res = await api.listProjectAttachments(opts.projectId);
      // Return the `attachments/<filename>` form as the entry name so
      // the MediaBin's thumbnail path (`resolveUrl(entry.name)`) hits
      // our parseRelative branch and fetches the bytes. Previously we
      // returned bare filenames and every thumbnail 404'd.
      return res.attachments.map((a) => ({
        name: `attachments/${a.filename}`,
        mimeType: a.mimeType,
        size: a.size,
      }));
    },

    async removeMedia(relPath: string): Promise<void> {
      const parsed = parseRelative(relPath);
      if (!parsed) return;
      if (parsed.scope === 'attachments') {
        await api.deleteProjectAttachment(opts.projectId, parsed.filename);
      } else if (parsed.scope === 'images' && opts.legacySessionId) {
        await api.deleteSessionImage(opts.projectId, opts.legacySessionId, parsed.filename);
      }
      // Artifacts aren't a managed-media scope from the editor's POV —
      // they're project artifacts the user manages elsewhere. We resolve
      // them for inline rendering but don't expose deletion through this
      // provider; users delete artifacts via the Artifacts tab.
      const cached = blobUrlCache.get(relPath);
      if (cached) {
        URL.revokeObjectURL(cached);
        blobUrlCache.delete(relPath);
      }
    },

    dispose(): void {
      for (const url of blobUrlCache.values()) URL.revokeObjectURL(url);
      blobUrlCache.clear();
      inflight.clear();
    },
  };
}
