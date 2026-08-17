import { useEffect, useState } from 'react';
import { formatFileSize } from '../file-view-modes.js';

/** Sentinels stored in place of file content for things the editor must not open. */
export const MEDIA_IMAGE = '__IMAGE__';
export const MEDIA_VIDEO = '__VIDEO__';
export const MEDIA_AUDIO = '__AUDIO__';
export const BINARY_FILE = '__BINARY__';
export const NON_TEXT_CONTENT: ReadonlySet<string> = new Set([
  MEDIA_IMAGE,
  MEDIA_VIDEO,
  MEDIA_AUDIO,
  BINARY_FILE,
]);

export function isImage(name: string): boolean {
  return /\.(png|jpe?g|gif|svg|webp|bmp)$/i.test(name);
}

export function isVideo(name: string): boolean {
  return /\.(mp4|webm|mov|m4v|avi|mkv|ogv)$/i.test(name);
}

export function isAudio(name: string): boolean {
  return /\.(mp3|wav|ogg|oga|m4a|aac|flac|opus)$/i.test(name);
}

/** Which non-text sentinel a filename maps to, or null for "read it as text". */
export function mediaSentinel(name: string): string | null {
  if (isImage(name)) return MEDIA_IMAGE;
  if (isVideo(name)) return MEDIA_VIDEO;
  if (isAudio(name)) return MEDIA_AUDIO;
  return null;
}

/**
 * Backstop for binary types not recognized by extension: a high density of
 * replacement chars or control bytes means the content is not text, whatever
 * the name says. Keeps raw bytes out of the editor.
 */
export function looksBinary(content: string): boolean {
  const sample = content.slice(0, 4096);
  if (!sample) return false;
  let suspicious = 0;
  for (let i = 0; i < sample.length; i++) {
    const code = sample.charCodeAt(i);
    // U+FFFD (replacement char) or a control byte that isn't tab/LF/CR.
    if (code === 0xfffd || code < 9 || (code > 13 && code < 32)) suspicious++;
  }
  return suspicious / sample.length > 0.1;
}

/**
 * Media preview that fetches through the authenticated client and renders via
 * a blob URL. `<img src="/api/...?raw=1">` would 401 — the element cannot send
 * a bearer token — so every source hands us a `fetchBlob` instead.
 */
export function AuthedMediaPreview({
  kind,
  path,
  fetchBlob,
}: {
  kind: 'image' | 'video' | 'audio';
  path: string;
  fetchBlob: (path: string) => Promise<Blob>;
}) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    let currentUrl: string | null = null;
    void (async () => {
      try {
        const blob = await fetchBlob(path);
        if (cancelled) return;
        currentUrl = URL.createObjectURL(blob);
        setBlobUrl(currentUrl);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    })();
    return () => {
      cancelled = true;
      if (currentUrl) URL.revokeObjectURL(currentUrl);
    };
  }, [fetchBlob, path]);
  if (error) return <p className="muted small">Preview failed: {error}</p>;
  if (!blobUrl) return <p className="muted small">Loading…</p>;
  if (kind === 'image') return <img src={blobUrl} alt={path} />;
  if (kind === 'audio') {
    // biome-ignore lint/a11y/useMediaCaption: user-supplied audio file; no caption track exists.
    return <audio src={blobUrl} controls style={{ width: '100%' }} />;
  }
  // biome-ignore lint/a11y/useMediaCaption: user-supplied video file; no caption track exists.
  return <video src={blobUrl} controls style={{ maxWidth: '100%', maxHeight: '100%' }} />;
}

/** The whole non-text branch of the viewer: media players plus the binary stop. */
export function NonTextFilePreview({
  content,
  path,
  fetchBlob,
  sizeBytes,
}: {
  content: string;
  path: string;
  fetchBlob: (path: string) => Promise<Blob>;
  /** On-disk size, when the source knew it. The only fact we can offer about a file we cannot show. */
  sizeBytes?: number;
}) {
  const kind =
    content === MEDIA_IMAGE
      ? 'image'
      : content === MEDIA_VIDEO
        ? 'video'
        : content === MEDIA_AUDIO
          ? 'audio'
          : null;
  return (
    <div className="image-preview">
      {kind ? (
        <AuthedMediaPreview kind={kind} path={path} fetchBlob={fetchBlob} />
      ) : (
        <p className="muted" style={{ textAlign: 'center' }}>
          Binary file — no text preview available.
        </p>
      )}
      <p className="muted" style={{ textAlign: 'center' }}>
        {sizeBytes === undefined ? path : `${path} · ${formatFileSize(sizeBytes)}`}
      </p>
    </div>
  );
}
