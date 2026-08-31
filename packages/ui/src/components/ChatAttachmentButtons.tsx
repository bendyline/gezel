import type { MediaProvider } from '@bendyline/squisq';
import { useEditorContext } from '@bendyline/squisq-editor-react';
import { useCallback, useRef, useState } from 'react';

interface ChatAttachmentButtonsProps {
  mediaProvider: MediaProvider;
  onError: (message: string | null) => void;
}

type UploadKind = 'image' | 'file';

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
 * two controls keep the everyday image/file paths one click away.
 *
 * This component must render inside an EditorShell toolbar slot so its public
 * insertAtCursor action targets the live chat editor and preserves undo.
 */
export function ChatAttachmentButtons({ mediaProvider, onError }: ChatAttachmentButtonsProps) {
  const { bumpMediaRevision, insertAtCursor } = useEditorContext();
  const imageInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState<UploadKind | null>(null);

  const upload = useCallback(
    async (file: File, kind: UploadKind) => {
      setUploading(kind);
      onError(null);
      try {
        const mimeType = file.type || 'application/octet-stream';
        const relativePath = await mediaProvider.addMedia(
          file.name,
          await file.arrayBuffer(),
          mimeType,
        );
        bumpMediaRevision();
        const label = escapeMarkdownLabel(attachmentLabel(file.name));
        insertAtCursor(
          kind === 'image' ? `![${label}](${relativePath})` : `[${label}](${relativePath})`,
        );
      } catch (err: unknown) {
        onError(err instanceof Error ? err.message : 'Could not attach that file.');
      } finally {
        setUploading(null);
      }
    },
    [bumpMediaRevision, insertAtCursor, mediaProvider, onError],
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
    <>
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
      </div>
      <span className="chat-composer-toolbar-spacer" aria-hidden="true" />
    </>
  );
}
