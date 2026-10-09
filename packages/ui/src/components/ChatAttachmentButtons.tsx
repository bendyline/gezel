import type { MediaProvider } from '@bendyline/squisq';
import { useEditorContext } from '@bendyline/squisq-editor-react';
import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import {
  type CameraCaptureMode,
  cameraCaptureMode,
  hasVideoInput,
  normalizeCapturedPhoto,
  supportsCameraViewfinder,
} from './camera-photo.js';

const CameraCaptureDialog = lazy(() =>
  import('./CameraCaptureDialog.js').then((module) => ({ default: module.CameraCaptureDialog })),
);

interface ChatAttachmentButtonsProps {
  mediaProvider: MediaProvider;
  onError: (message: string | null) => void;
}

type UploadKind = 'image' | 'file' | 'photo';

const PHOTO_LABEL = 'Photo';

function attachmentLabel(filename: string): string {
  return filename.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ');
}

function escapeMarkdownLabel(label: string): string {
  return label.replace(/([\\\[\]])/g, '\\$1');
}

function ImageIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect
        x="2"
        y="2.5"
        width="12"
        height="11"
        rx="1.5"
        stroke="currentColor"
        strokeWidth="1.35"
      />
      <circle cx="5.25" cy="5.75" r="1.1" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="m3.5 12 3.1-3.25 2.05 1.9 1.55-1.55 2.3 2.9"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CameraIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M2 5.5A1.5 1.5 0 0 1 3.5 4h1.6l1.05-1.4a1 1 0 0 1 .8-.4h2.1a1 1 0 0 1 .8.4L10.9 4h1.6A1.5 1.5 0 0 1 14 5.5v6A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5z"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinejoin="round"
      />
      <circle cx="8" cy="8.4" r="2.35" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

/**
 * Whether to offer Take photo, and how. A phone always has a camera and opens
 * its own; a desktop gets the in-app viewfinder only when it can capture and
 * a camera is actually attached, re-checked as cameras come and go.
 */
function useCameraCapture(): CameraCaptureMode | null {
  const [mode] = useState(cameraCaptureMode);
  const [available, setAvailable] = useState(mode === 'native');
  useEffect(() => {
    if (mode === 'native' || !supportsCameraViewfinder()) return;
    let live = true;
    const refresh = () => {
      void hasVideoInput().then((present) => {
        if (live) setAvailable(present);
      });
    };
    refresh();
    navigator.mediaDevices.addEventListener?.('devicechange', refresh);
    return () => {
      live = false;
      navigator.mediaDevices.removeEventListener?.('devicechange', refresh);
    };
  }, [mode]);
  return available ? mode : null;
}

function PaperclipIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="m5.25 8.7 4.2-4.2a2.1 2.1 0 0 1 2.97 2.97l-5.1 5.1a3.2 3.2 0 0 1-4.53-4.52l5-5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Chat-specific shortcuts for Squisq's project-scoped media storage. The
 * generic Insert menu remains available for less-common rich blocks; these
 * controls keep the everyday image/photo/file paths one click away.
 *
 * This component must render inside an EditorShell toolbar slot so its public
 * insertAtCursor action targets the live chat editor and preserves undo.
 */
export function ChatAttachmentButtons({ mediaProvider, onError }: ChatAttachmentButtonsProps) {
  const { bumpMediaRevision, insertAtCursor } = useEditorContext();
  const imageInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState<UploadKind | null>(null);
  const [viewfinderOpen, setViewfinderOpen] = useState(false);
  const camera = useCameraCapture();

  const store = useCallback(
    async (file: File, kind: UploadKind) => {
      const mimeType = file.type || 'application/octet-stream';
      const relativePath = await mediaProvider.addMedia(
        file.name,
        await file.arrayBuffer(),
        mimeType,
      );
      bumpMediaRevision();
      const label = escapeMarkdownLabel(
        kind === 'photo' ? PHOTO_LABEL : attachmentLabel(file.name),
      );
      insertAtCursor(
        kind === 'file' ? `[${label}](${relativePath})` : `![${label}](${relativePath})`,
      );
    },
    [bumpMediaRevision, insertAtCursor, mediaProvider],
  );

  const upload = useCallback(
    async (file: File, kind: UploadKind) => {
      setUploading(kind);
      onError(null);
      try {
        await store(kind === 'photo' ? await normalizeCapturedPhoto(file) : file, kind);
      } catch (err: unknown) {
        onError(err instanceof Error ? err.message : 'Could not attach that file.');
      } finally {
        setUploading(null);
      }
    },
    [onError, store],
  );

  // The viewfinder already produced a capped JPEG; errors stay in its review
  // so the photo is not lost to a failed upload.
  const insertViewfinderPhoto = useCallback(
    async (photo: File) => {
      onError(null);
      await store(photo, 'photo');
    },
    [onError, store],
  );

  const handleSelection = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>, kind: UploadKind) => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (file) void upload(file, kind);
    },
    [upload],
  );

  return (
    <div className="chat-composer-attachment-actions">
      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(event) => handleSelection(event, 'image')}
      />
      <input
        ref={fileInputRef}
        type="file"
        hidden
        onChange={(event) => handleSelection(event, 'file')}
      />
      {camera === 'native' && (
        <input
          ref={cameraInputRef}
          type="file"
          // Exactly `image/*`: Android's WebView only opens the camera for it.
          accept="image/*"
          capture="environment"
          hidden
          data-testid="chat-camera-input"
          onChange={(event) => handleSelection(event, 'photo')}
        />
      )}
      <button
        type="button"
        className="squisq-toolbar-button"
        onClick={() => imageInputRef.current?.click()}
        disabled={uploading !== null}
        aria-label={uploading === 'image' ? 'Inserting image…' : 'Insert image'}
        aria-busy={uploading === 'image'}
        title="Insert image"
        data-tooltip="Insert image"
      >
        <ImageIcon />
      </button>
      {camera && (
        <button
          type="button"
          className="squisq-toolbar-button"
          onClick={() =>
            camera === 'native' ? cameraInputRef.current?.click() : setViewfinderOpen(true)
          }
          disabled={uploading !== null}
          aria-label={uploading === 'photo' ? 'Inserting photo…' : 'Take photo'}
          aria-busy={uploading === 'photo'}
          title="Take photo"
          data-tooltip="Take photo"
          data-testid="chat-camera"
        >
          <CameraIcon />
        </button>
      )}
      <button
        type="button"
        className="squisq-toolbar-button"
        onClick={() => fileInputRef.current?.click()}
        disabled={uploading !== null}
        aria-label={uploading === 'file' ? 'Attaching file…' : 'Attach file'}
        aria-busy={uploading === 'file'}
        title="Attach file"
        data-tooltip="Attach file"
      >
        <PaperclipIcon />
      </button>
      {viewfinderOpen && (
        <Suspense fallback={null}>
          <CameraCaptureDialog
            open
            onClose={() => setViewfinderOpen(false)}
            onCapture={insertViewfinderPhoto}
          />
        </Suspense>
      )}
    </div>
  );
}
