/**
 * Inline media attachments a tool call returned — audio, images, video —
 * as they appear under a tool row in the chat timeline.
 *
 * All three share one auth fence: an artifact blob is fetched through the
 * authenticated API client and handed to the DOM as an object URL, never as
 * a bare path the browser would request unauthenticated.
 */
import type { ToolCallAudio, ToolCallImage, ToolCallVideo } from '@bendyline/gezel';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { AudioPlayer } from './AudioPlayer.js';
import { ImagePreview } from './ImagePreview.js';

/**
 * Inline playback rows for audio artifacts a tool returned
 * (synthesize_speech narrations). Renders one AudioPlayer per audio,
 * stacked. Each player loads its blob via the authenticated API
 * client — same auth fence as ToolImageRow.
 */
export function ToolAudioRow({
  projectId,
  audios,
}: {
  projectId: string;
  audios: ToolCallAudio[];
}) {
  return (
    <ul className="thinking-tool-audios">
      {audios.map((a, i) => (
        <li key={`${a.path}-${i}`} className="thinking-tool-audio-cell">
          <AudioPlayer
            projectId={projectId}
            path={a.path}
            {...(a.durationSeconds !== undefined ? { durationSeconds: a.durationSeconds } : {})}
            {...(a.voice ? { voice: a.voice } : {})}
          />
        </li>
      ))}
    </ul>
  );
}

/**
 * Thumbnails for image artifacts a tool returned (Playwright screenshots
 * etc.). Each thumbnail loads its blob via the authenticated API client
 * (an `<img src="/api/...">` URL would fail because it can't carry a
 * bearer token) and opens a full-screen ImagePreview on click. Lives
 * inside the `<li>` so its margin-left aligns with the tool row's text.
 */
export function ToolImageRow({
  projectId,
  images,
}: { projectId: string; images: ToolCallImage[] }) {
  const [previewIdx, setPreviewIdx] = useState<number | null>(null);
  // Streaming turns re-render this row whenever new text/tool events land.
  // Keep the callback stable so ToolImagePreviewLoader does not treat an
  // unrelated parent update as a new load, revoke the live blob URL, and
  // leave the dialog's image pointing at that revoked URL while it refetches.
  const closePreview = useCallback(() => setPreviewIdx(null), []);
  return (
    <>
      <ul className="thinking-tool-images">
        {images.map((img, i) => (
          <li key={`${img.path}-${i}`} className="thinking-tool-image-cell">
            <button
              type="button"
              className="thinking-tool-image"
              onClick={() => setPreviewIdx(i)}
              title={img.path}
              aria-label={`Open screenshot ${i + 1}`}
            >
              <ToolImageThumbnail projectId={projectId} path={img.path} />
            </button>
            <ImageActionsMenu projectId={projectId} path={img.path} />
          </li>
        ))}
      </ul>
      {previewIdx !== null && images[previewIdx] && (
        <ToolImagePreviewLoader
          projectId={projectId}
          image={images[previewIdx]}
          onClose={closePreview}
        />
      )}
    </>
  );
}

/**
 * Inline `<video>` player(s) under a tool row — the video sibling of
 * {@link ToolImageRow}. Used by `generate_video`: the mp4 is an artifact
 * (never base64 in the transcript), streamed from the artifact-blob
 * endpoint. Same auth fence as images — the blob is fetched with the
 * bearer token and handed to the element as an object URL.
 */
export function ToolVideoRow({
  projectId,
  videos,
}: { projectId: string; videos: ToolCallVideo[] }) {
  return (
    <ul className="thinking-tool-videos">
      {videos.map((vid, i) => (
        <li key={`${vid.path}-${i}`} className="thinking-tool-video-cell">
          <ToolVideoPlayer projectId={projectId} video={vid} />
        </li>
      ))}
    </ul>
  );
}

function ToolVideoPlayer({ projectId, video }: { projectId: string; video: ToolCallVideo }) {
  const [src, setSrc] = useState<string | null>(null);
  const [posterSrc, setPosterSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let revoked = false;
    const urls: string[] = [];
    void (async () => {
      try {
        const blob = await api.fetchProjectArtifactBlob(projectId, video.path);
        if (revoked) return;
        const url = URL.createObjectURL(blob);
        urls.push(url);
        setSrc(url);
      } catch (err) {
        console.warn('[tool-video] load failed', { path: video.path, err });
        if (!revoked) setFailed(true);
      }
      if (video.posterPath) {
        try {
          const poster = await api.fetchProjectArtifactBlob(projectId, video.posterPath);
          if (revoked) return;
          const purl = URL.createObjectURL(poster);
          urls.push(purl);
          setPosterSrc(purl);
        } catch {
          /* poster is optional */
        }
      }
    })();
    return () => {
      revoked = true;
      for (const u of urls) URL.revokeObjectURL(u);
    };
  }, [projectId, video.path, video.posterPath]);
  if (failed) {
    return <span className="thinking-tool-video-error">Couldn't load video ({video.path})</span>;
  }
  if (!src) return <span className="thinking-tool-video-loading" aria-hidden />;
  return (
    <video
      className="thinking-tool-video"
      src={src}
      {...(posterSrc ? { poster: posterSrc } : {})}
      controls
      preload="metadata"
      playsInline
    />
  );
}

/**
 * Trigger downloading an artifact image via a synthetic `<a download>`
 * click. The artifact tree is bearer-token-gated, so we can't just put
 * the URL on the link directly — fetch the blob through the
 * authenticated client first and serve it via a one-shot
 * `URL.createObjectURL` reference. The object URL is revoked on a
 * short delay so the browser has time to start the download before
 * the source goes away (revoking synchronously cancels the download
 * on Chromium-based engines).
 */
async function downloadProjectArtifact(projectId: string, path: string): Promise<void> {
  const blob = await api.fetchProjectArtifactBlob(projectId, path);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  // Pull the trailing filename out of the path so the user gets
  // `image-2026-…-42.png` rather than `generated_image-2026-…-42.png`
  // or some browser-default name.
  a.download = path.split(/[/\\]/).pop() ?? 'image';
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Three-dot menu pinned to the corner of an image thumbnail. Hidden
 * until hover or until the menu opens — same pattern as the cancel
 * button on a streaming bubble. Today the menu offers Download and
 * Copy path; future entries (regenerate, send to gezel, etc.) plug
 * in here without touching the thumbnail layout.
 */
function ImageActionsMenu({ projectId, path }: { projectId: string; path: string }) {
  const [open, setOpen] = useState(false);
  const handleDownload = async () => {
    try {
      await downloadProjectArtifact(projectId, path);
    } catch (err) {
      console.warn('[tool-image] download failed', { path, err });
    }
  };
  const handleCopyPath = async () => {
    try {
      await navigator.clipboard.writeText(`artifacts/${path.replace(/^artifacts\//, '')}`);
    } catch (err) {
      console.warn('[tool-image] copy path failed', { path, err });
    }
  };
  return (
    <DropdownMenu.Root open={open} onOpenChange={setOpen}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className={`thinking-tool-image-menu-btn${open ? ' open' : ''}`}
          aria-label="Image actions"
          title="More"
          onClick={(e) => e.stopPropagation()}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="currentColor"
            role="img"
            aria-label="Image actions"
          >
            <title>Image actions</title>
            <circle cx="3" cy="8" r="1.4" />
            <circle cx="8" cy="8" r="1.4" />
            <circle cx="13" cy="8" r="1.4" />
          </svg>
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="app-nav-menu" sideOffset={4} align="end">
          <DropdownMenu.Item
            className="app-nav-menu-item"
            onSelect={() => {
              void handleDownload();
            }}
          >
            <span>Download</span>
          </DropdownMenu.Item>
          <DropdownMenu.Item
            className="app-nav-menu-item"
            onSelect={() => {
              void handleCopyPath();
            }}
          >
            <span>Copy artifact path</span>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/**
 * Per-thumbnail image loader. Fetches the artifact blob via the
 * authenticated client, renders an `<img>` against a `blob:` URL.
 * Revokes the URL on unmount so we don't leak per-render.
 */
function ToolImageThumbnail({ projectId, path }: { projectId: string; path: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let revoked = false;
    let url: string | null = null;
    void (async () => {
      try {
        const blob = await api.fetchProjectArtifactBlob(projectId, path);
        if (revoked) return;
        url = URL.createObjectURL(blob);
        setSrc(url);
      } catch (err) {
        console.warn('[tool-image] thumbnail load failed', { path, err });
      }
    })();
    return () => {
      revoked = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [projectId, path]);
  if (!src) return <span className="thinking-tool-image-loading" aria-hidden />;
  return <img src={src} alt="" />;
}

/**
 * Loads the full-resolution blob for the preview overlay. Separate from
 * the thumbnail loader so the modal opens instantly with whatever's in
 * the cache (the same path is fetched again — browser cache short-
 * circuits the second request) and the user can re-click the X without
 * re-downloading.
 */
function ToolImagePreviewLoader({
  projectId,
  image,
  onClose,
}: {
  projectId: string;
  image: ToolCallImage;
  onClose: () => void;
}) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let revoked = false;
    let url: string | null = null;
    void (async () => {
      try {
        const blob = await api.fetchProjectArtifactBlob(projectId, image.path);
        if (revoked) return;
        url = URL.createObjectURL(blob);
        setSrc(url);
      } catch (err) {
        console.warn('[tool-image] preview load failed', { path: image.path, err });
        // If load failed, close the preview rather than show a blank overlay.
        onClose();
      }
    })();
    return () => {
      revoked = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [projectId, image.path, onClose]);
  if (!src) return null;
  return (
    <ImagePreview
      src={src}
      alt="Tool screenshot"
      caption={image.path}
      onClose={onClose}
      downloadFilename={image.path.split(/[/\\]/).pop() ?? 'image'}
    />
  );
}
