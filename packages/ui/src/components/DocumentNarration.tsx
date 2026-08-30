import { useEditorContext } from '@bendyline/squisq-editor-react';
import { extractPlainText, parseMarkdown } from '@bendyline/squisq/markdown';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api.js';

type NarrationScope = 'document' | 'selection';
type NarrationStatus = 'idle' | 'creating' | 'ready' | 'error';

interface SelectionMenu {
  x: number;
  y: number;
  text: string;
}

export interface DocumentNarrationProps {
  fileName?: string;
  projectId?: string;
}

function normalizeNarrationText(text: string): string {
  return text
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function bytesFromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function ownedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function formatTime(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const minutes = Math.floor(safe / 60);
  return `${minutes}:${String(safe % 60).padStart(2, '0')}`;
}

function downloadName(fileName: string | undefined, scope: NarrationScope): string {
  const basename =
    fileName
      ?.split(/[\\/]/)
      .pop()
      ?.replace(/\.[^.]+$/, '') || 'document';
  const safe = basename.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'document';
  return `${safe}-${scope}-narration.mp3`;
}

function triggerDownload(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.style.display = 'none';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * Host-owned text-to-speech controls for Squisq document editors.
 *
 * The visible toolbar button narrates the complete parsed document. A capture
 * listener on this editor shell adds "Narrate selection" to the right-click
 * path without changing Squisq itself. Generation and playback live in a
 * body-portaled transport so they survive view changes inside the editor.
 */
export function DocumentNarration({ fileName, projectId }: DocumentNarrationProps) {
  const { activeView, markdownDoc, markdownSource, monacoEditor, tiptapEditor } =
    useEditorContext();
  const toolbarRootRef = useRef<HTMLSpanElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioCleanupRef = useRef<(() => void) | null>(null);
  const audioUrlRef = useRef<string | null>(null);
  const wavBlobRef = useRef<Blob | null>(null);
  const mp3BlobRef = useRef<Blob | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [menu, setMenu] = useState<SelectionMenu | null>(null);
  const [status, setStatus] = useState<NarrationStatus>('idle');
  const [scope, setScope] = useState<NarrationScope>('document');
  const [error, setError] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [encodingMp3, setEncodingMp3] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  const documentText = useMemo(() => {
    try {
      const parsed = markdownDoc ?? parseMarkdown(markdownSource);
      return normalizeNarrationText(extractPlainText(parsed));
    } catch {
      return normalizeNarrationText(markdownSource);
    }
  }, [markdownDoc, markdownSource]);

  const releaseAudio = useCallback(() => {
    audioCleanupRef.current?.();
    audioCleanupRef.current = null;
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.removeAttribute('src');
    }
    audioRef.current = null;
    if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
    audioUrlRef.current = null;
    wavBlobRef.current = null;
    mp3BlobRef.current = null;
  }, []);

  const closeNarration = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    releaseAudio();
    setStatus('idle');
    setError(null);
    setDownloadError(null);
    setEncodingMp3(false);
    setIsPlaying(false);
    setCurrentTime(0);
    setDuration(0);
  }, [releaseAudio]);

  useEffect(
    () => () => {
      abortRef.current?.abort();
      releaseAudio();
    },
    [releaseAudio],
  );

  const beginNarration = useCallback(
    async (text: string, nextScope: NarrationScope) => {
      const cleanText = normalizeNarrationText(text);
      if (!cleanText) return;

      abortRef.current?.abort();
      releaseAudio();
      const controller = new AbortController();
      abortRef.current = controller;
      setMenu(null);
      setScope(nextScope);
      setStatus('creating');
      setError(null);
      setDownloadError(null);
      setEncodingMp3(false);
      setIsPlaying(false);
      setCurrentTime(0);
      setDuration(0);

      try {
        const result = await api.synthesizeSpeech({
          text: cleanText,
          ...(projectId ? { projectId } : {}),
          inline: true,
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        if (!result.b64Wav) throw new Error('The speech engine did not return playable audio.');

        const wav = new Blob([ownedArrayBuffer(bytesFromBase64(result.b64Wav))], {
          type: 'audio/wav',
        });
        const url = URL.createObjectURL(wav);
        const audio = new Audio(url);
        const syncTime = () => {
          setCurrentTime(audio.currentTime || 0);
          if (Number.isFinite(audio.duration)) setDuration(audio.duration);
        };
        const onPlay = () => setIsPlaying(true);
        const onPause = () => setIsPlaying(false);
        const onEnded = () => setIsPlaying(false);
        const onError = () => {
          setError('The narration was created, but this device could not play it.');
          setStatus('error');
        };
        audio.addEventListener('loadedmetadata', syncTime);
        audio.addEventListener('durationchange', syncTime);
        audio.addEventListener('timeupdate', syncTime);
        audio.addEventListener('play', onPlay);
        audio.addEventListener('pause', onPause);
        audio.addEventListener('ended', onEnded);
        audio.addEventListener('error', onError);
        audioCleanupRef.current = () => {
          audio.removeEventListener('loadedmetadata', syncTime);
          audio.removeEventListener('durationchange', syncTime);
          audio.removeEventListener('timeupdate', syncTime);
          audio.removeEventListener('play', onPlay);
          audio.removeEventListener('pause', onPause);
          audio.removeEventListener('ended', onEnded);
          audio.removeEventListener('error', onError);
        };
        wavBlobRef.current = wav;
        audioUrlRef.current = url;
        audioRef.current = audio;
        setDuration(result.meta?.durationSeconds ?? 0);
        setStatus('ready');
        abortRef.current = null;
        await audio.play().catch(() => undefined);
      } catch (caught) {
        if (controller.signal.aborted) {
          if (abortRef.current === controller) setStatus('idle');
          return;
        }
        setError(caught instanceof Error ? caught.message : 'Could not create the narration.');
        setStatus('error');
        abortRef.current = null;
      }
    },
    [projectId, releaseAudio],
  );

  const selectedText = useCallback((): string => {
    if (activeView === 'raw' && monacoEditor) {
      const selection = monacoEditor.getSelection();
      const model = monacoEditor.getModel();
      if (selection && model && !selection.isEmpty()) {
        return normalizeNarrationText(model.getValueInRange(selection));
      }
      return '';
    }
    if (activeView === 'wysiwyg' && tiptapEditor) {
      const { from, to, empty } = tiptapEditor.state.selection;
      return empty
        ? ''
        : normalizeNarrationText(tiptapEditor.state.doc.textBetween(from, to, '\n'));
    }
    const selection = window.getSelection();
    const shell = toolbarRootRef.current?.closest('.squisq-editor-shell');
    if (selection?.anchorNode && shell && !shell.contains(selection.anchorNode)) return '';
    return normalizeNarrationText(selection?.toString() ?? '');
  }, [activeView, monacoEditor, tiptapEditor]);

  useEffect(() => {
    const shell = toolbarRootRef.current?.closest('.squisq-editor-shell');
    if (!shell) return;
    const openSelectionMenu = (event: Event) => {
      if (status === 'creating') return;
      const mouseEvent = event as MouseEvent;
      const target = mouseEvent.target;
      if (!(target instanceof Element) || !target.closest('.squisq-editor-content')) return;
      const text = selectedText();
      if (!text) return;
      mouseEvent.preventDefault();
      mouseEvent.stopPropagation();
      const menuWidth = 210;
      const menuHeight = 46;
      setMenu({
        x: Math.max(8, Math.min(mouseEvent.clientX, window.innerWidth - menuWidth - 8)),
        y: Math.max(8, Math.min(mouseEvent.clientY, window.innerHeight - menuHeight - 8)),
        text,
      });
    };
    shell.addEventListener('contextmenu', openSelectionMenu, true);
    return () => shell.removeEventListener('contextmenu', openSelectionMenu, true);
  }, [selectedText, status]);

  useEffect(() => {
    if (!menu) return;
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const dismiss = (event: Event) => {
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return;
      setMenu(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenu(null);
    };
    window.addEventListener('pointerdown', dismiss, true);
    window.addEventListener('scroll', dismiss, true);
    window.addEventListener('resize', dismiss);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', dismiss, true);
      window.removeEventListener('scroll', dismiss, true);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [menu]);

  const togglePlayback = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      if (Number.isFinite(audio.duration) && audio.currentTime >= audio.duration)
        audio.currentTime = 0;
      void audio.play().catch((caught: unknown) => {
        setError(caught instanceof Error ? caught.message : 'Could not play the narration.');
        setStatus('error');
      });
    } else {
      audio.pause();
    }
  }, []);

  const seekBy = useCallback((seconds: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    const upper = Number.isFinite(audio.duration) ? audio.duration : Number.POSITIVE_INFINITY;
    audio.currentTime = Math.max(0, Math.min(upper, audio.currentTime + seconds));
    setCurrentTime(audio.currentTime);
  }, []);

  const seekTo = useCallback((seconds: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = seconds;
    setCurrentTime(seconds);
  }, []);

  const downloadMp3 = useCallback(async () => {
    const wav = wavBlobRef.current;
    if (!wav || encodingMp3) return;
    setEncodingMp3(true);
    setDownloadError(null);
    try {
      const { encodeWavAsMp3 } = await import('./document-narration-mp3.js');
      mp3BlobRef.current ??= await encodeWavAsMp3(wav);
      triggerDownload(mp3BlobRef.current, downloadName(fileName, scope));
    } catch (caught) {
      setDownloadError(caught instanceof Error ? caught.message : 'Could not prepare the MP3.');
    } finally {
      setEncodingMp3(false);
    }
  }, [encodingMp3, fileName, scope]);

  const transport =
    status === 'idle'
      ? null
      : createPortal(
          <aside className="document-narration-transport" aria-label="Narration controls">
            {status === 'creating' && (
              <>
                <div className="document-narration-summary" aria-live="polite">
                  <strong>Creating narration…</strong>
                  <span>{scope === 'document' ? 'Full document' : 'Selected text'}</span>
                </div>
                <progress className="document-narration-progress" aria-label="Creating narration" />
                <button
                  type="button"
                  className="document-narration-cancel"
                  onClick={closeNarration}
                >
                  Cancel
                </button>
              </>
            )}
            {status === 'ready' && (
              <>
                <div className="document-narration-summary" aria-live="polite">
                  <strong>
                    {scope === 'document' ? 'Document narration' : 'Selection narration'}
                  </strong>
                  <span>{isPlaying ? 'Playing' : 'Paused'}</span>
                </div>
                <button
                  type="button"
                  className="document-narration-control"
                  aria-label="Back 30 seconds"
                  title="Back 30 seconds"
                  onClick={() => seekBy(-30)}
                >
                  ↶<small>30</small>
                </button>
                <button
                  type="button"
                  className="document-narration-control document-narration-play"
                  aria-label={isPlaying ? 'Pause narration' : 'Play narration'}
                  title={isPlaying ? 'Pause' : 'Play'}
                  onClick={togglePlayback}
                >
                  {isPlaying ? 'Ⅱ' : '▶'}
                </button>
                <button
                  type="button"
                  className="document-narration-control"
                  aria-label="Forward 30 seconds"
                  title="Forward 30 seconds"
                  onClick={() => seekBy(30)}
                >
                  ↷<small>30</small>
                </button>
                <label className="document-narration-timeline">
                  <span className="sr-only">Narration position</span>
                  <input
                    type="range"
                    min={0}
                    max={Math.max(duration, 0.1)}
                    step={0.1}
                    value={Math.min(currentTime, Math.max(duration, 0.1))}
                    onChange={(event) => seekTo(Number(event.currentTarget.value))}
                  />
                  <span aria-hidden="true">
                    {formatTime(currentTime)} / {formatTime(duration)}
                  </span>
                </label>
                <button
                  type="button"
                  className="document-narration-download"
                  disabled={encodingMp3}
                  onClick={() => void downloadMp3()}
                >
                  {encodingMp3 ? 'Preparing MP3…' : 'Download MP3'}
                </button>
                <button
                  type="button"
                  className="document-narration-close"
                  aria-label="Close narration"
                  title="Close"
                  onClick={closeNarration}
                >
                  ×
                </button>
                {downloadError && (
                  <span className="document-narration-error" role="alert">
                    {downloadError}
                  </span>
                )}
              </>
            )}
            {status === 'error' && (
              <>
                <div className="document-narration-summary" role="alert">
                  <strong>Narration unavailable</strong>
                  <span>{error}</span>
                </div>
                <button
                  type="button"
                  className="document-narration-cancel"
                  onClick={closeNarration}
                >
                  Close
                </button>
              </>
            )}
          </aside>,
          document.body,
        );

  return (
    <span ref={toolbarRootRef} className="document-narration-root">
      <button
        type="button"
        className="squisq-toolbar-button document-narration-trigger"
        aria-label="Narrate document"
        title="Narrate document"
        disabled={!documentText || status === 'creating'}
        onClick={() => void beginNarration(documentText, 'document')}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 9v6h4l5 4V5L8 9H4Zm12.5 3a4.5 4.5 0 0 0-2-3.74v7.48a4.5 4.5 0 0 0 2-3.74Zm-2-8.65v2.12a7.5 7.5 0 0 1 0 13.06v2.12a9.5 9.5 0 0 0 0-17.3Z" />
        </svg>
      </button>
      {menu &&
        createPortal(
          <div
            ref={menuRef}
            className="document-narration-context-menu"
            role="menu"
            aria-label="Selection actions"
            style={{ left: menu.x, top: menu.y }}
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => void beginNarration(menu.text, 'selection')}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M4 9v6h4l5 4V5L8 9H4Zm12.5 3a4.5 4.5 0 0 0-2-3.74v7.48a4.5 4.5 0 0 0 2-3.74Z" />
              </svg>
              Narrate selection
            </button>
          </div>,
          document.body,
        )}
      {transport}
    </span>
  );
}
