import type { AudioSynthesizeProgress } from '@bendyline/gezel';
import {
  type EditorContextMenuItem,
  useEditorContext,
  useEditorContextMenuItems,
} from '@bendyline/squisq-editor-react';
import { extractPlainText, parseMarkdown } from '@bendyline/squisq/markdown';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api.js';
import { ProgressiveNarrationPlayer } from './progressive-narration-player.js';

type NarrationScope = 'document' | 'selection';
type NarrationStatus = 'idle' | 'creating' | 'ready' | 'error';

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
 * The visible toolbar button narrates the complete parsed document. The
 * selection action registers with Squisq's shared context menu. Generation
 * and playback live in a body-portaled transport so they survive view changes
 * inside the editor.
 */
export function DocumentNarration({ fileName, projectId }: DocumentNarrationProps) {
  const { markdownDoc, markdownSource } = useEditorContext();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioCleanupRef = useRef<(() => void) | null>(null);
  const audioUrlRef = useRef<string | null>(null);
  const wavBlobRef = useRef<Blob | null>(null);
  const mp3BlobRef = useRef<Blob | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const progressivePlayerRef = useRef<ProgressiveNarrationPlayer | null>(null);
  const creationProgressRef = useRef<AudioSynthesizeProgress | null>(null);
  const creationStartedAtRef = useRef(0);
  const firstChunkAtRef = useRef(0);
  const firstChunkDurationRef = useRef(0);
  const firstChunkCharactersRef = useRef(0);
  const userPausedRef = useRef(false);
  const [status, setStatus] = useState<NarrationStatus>('idle');
  const [scope, setScope] = useState<NarrationScope>('document');
  const [error, setError] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [encodingMp3, setEncodingMp3] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [creationProgress, setCreationProgress] = useState<AudioSynthesizeProgress | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [bufferedDuration, setBufferedDuration] = useState(0);
  const [waitingForAudio, setWaitingForAudio] = useState(false);

  const documentText = useMemo(() => {
    try {
      const parsed = markdownDoc ?? parseMarkdown(markdownSource);
      return normalizeNarrationText(extractPlainText(parsed));
    } catch {
      return normalizeNarrationText(markdownSource);
    }
  }, [markdownDoc, markdownSource]);

  const releaseAudio = useCallback(() => {
    progressivePlayerRef.current?.dispose();
    progressivePlayerRef.current = null;
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
    setBufferedDuration(0);
    setWaitingForAudio(false);
    setCreationProgress(null);
    creationProgressRef.current = null;
    userPausedRef.current = false;
  }, [releaseAudio]);

  useEffect(
    () => () => {
      abortRef.current?.abort();
      releaseAudio();
    },
    [releaseAudio],
  );

  useEffect(() => {
    if (status !== 'creating') return;
    const startedAt = creationStartedAtRef.current || performance.now();
    setElapsedSeconds(0);
    const timer = window.setInterval(() => {
      setElapsedSeconds(Math.floor((performance.now() - startedAt) / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [status]);

  useEffect(() => {
    if (status === 'idle' || !progressivePlayerRef.current) return;
    const timer = window.setInterval(() => {
      const snapshot = progressivePlayerRef.current?.snapshot();
      if (!snapshot) return;
      setCurrentTime(snapshot.currentTime);
      setBufferedDuration(snapshot.bufferedDuration);
      setIsPlaying(snapshot.isPlaying);
      setWaitingForAudio(snapshot.waitingForAudio);
    }, 200);
    return () => window.clearInterval(timer);
  }, [status]);

  const beginNarration = useCallback(
    async (text: string, nextScope: NarrationScope) => {
      const cleanText = normalizeNarrationText(text);
      if (!cleanText) return;

      abortRef.current?.abort();
      releaseAudio();
      const player = ProgressiveNarrationPlayer.create((snapshot) => {
        setCurrentTime(snapshot.currentTime);
        setBufferedDuration(snapshot.bufferedDuration);
        setIsPlaying(snapshot.isPlaying);
        setWaitingForAudio(snapshot.waitingForAudio);
      });
      progressivePlayerRef.current = player;
      player?.prime();
      const controller = new AbortController();
      abortRef.current = controller;
      creationStartedAtRef.current = performance.now();
      firstChunkAtRef.current = 0;
      firstChunkDurationRef.current = 0;
      firstChunkCharactersRef.current = 0;
      creationProgressRef.current = null;
      userPausedRef.current = false;
      setScope(nextScope);
      setStatus('creating');
      setError(null);
      setDownloadError(null);
      setEncodingMp3(false);
      setIsPlaying(false);
      setCurrentTime(0);
      setDuration(0);
      setBufferedDuration(0);
      setWaitingForAudio(false);
      setCreationProgress(null);

      try {
        const result = await api.synthesizeSpeechWithProgress(
          {
            text: cleanText,
            ...(projectId ? { projectId } : {}),
            inline: true,
          },
          {
            onProgress: (progress) => {
              creationProgressRef.current = progress;
              setCreationProgress(progress);
            },
            onChunk: async (chunk) => {
              if (controller.signal.aborted || progressivePlayerRef.current !== player || !player)
                return;
              const snapshot = await player.appendWav(
                chunk.index,
                ownedArrayBuffer(bytesFromBase64(chunk.b64Wav)),
              );
              const now = performance.now();
              const progress = creationProgressRef.current;
              if (firstChunkAtRef.current === 0) {
                firstChunkAtRef.current = now;
                firstChunkDurationRef.current = snapshot.bufferedDuration;
                firstChunkCharactersRef.current = progress?.completedCharacters ?? 0;
              }
              if (snapshot.isPlaying || userPausedRef.current) return;

              const secondsSinceFirstChunk = (now - firstChunkAtRef.current) / 1000;
              const generatedSinceFirst = snapshot.bufferedDuration - firstChunkDurationRef.current;
              const audioGenerationRate =
                secondsSinceFirstChunk > 0.25 ? generatedSinceFirst / secondsSinceFirstChunk : 0;
              const charactersSinceFirst =
                (progress?.completedCharacters ?? 0) - firstChunkCharactersRef.current;
              const characterRate =
                secondsSinceFirstChunk > 0.25 ? charactersSinceFirst / secondsSinceFirstChunk : 0;
              const remainingGenerationSeconds =
                progress && characterRate > 0
                  ? (progress.totalCharacters - progress.completedCharacters) / characterRate
                  : Number.POSITIVE_INFINITY;
              const bufferAhead = snapshot.bufferedDuration - snapshot.currentTime;
              const safeToStart =
                bufferAhead >= 4 &&
                (audioGenerationRate >= 1.15 || bufferAhead >= remainingGenerationSeconds + 3);
              if (safeToStart) await player.play();
            },
          },
          controller.signal,
        );
        if (controller.signal.aborted) return;
        if (!result.b64Wav) throw new Error('The speech engine did not return playable audio.');

        const wav = new Blob([ownedArrayBuffer(bytesFromBase64(result.b64Wav))], {
          type: 'audio/wav',
        });
        wavBlobRef.current = wav;
        if (player && player.snapshot().bufferedDuration > 0) {
          player.finish();
          setBufferedDuration(player.snapshot().bufferedDuration);
          setDuration(result.meta?.durationSeconds ?? player.snapshot().bufferedDuration);
          setStatus('ready');
          abortRef.current = null;
          if (!player.snapshot().isPlaying && !userPausedRef.current) await player.play();
          return;
        }

        player?.dispose();
        if (progressivePlayerRef.current === player) progressivePlayerRef.current = null;
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
        player?.dispose();
        if (progressivePlayerRef.current === player) progressivePlayerRef.current = null;
        setError(caught instanceof Error ? caught.message : 'Could not create the narration.');
        setStatus('error');
        abortRef.current = null;
      }
    },
    [projectId, releaseAudio],
  );

  const contextMenuItems = useMemo<readonly EditorContextMenuItem[]>(
    () => [
      {
        id: 'gezel.narrate-selection',
        label: 'Narrate selection',
        group: 'narration',
        when: 'selection',
        disabled: status === 'creating',
        icon: (
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 9v6h4l5 4V5L8 9H4Zm12.5 3a4.5 4.5 0 0 0-2-3.74v7.48a4.5 4.5 0 0 0 2-3.74Z" />
          </svg>
        ),
        onSelect: ({ selectedText }) => beginNarration(selectedText, 'selection'),
      },
    ],
    [beginNarration, status],
  );
  useEditorContextMenuItems(contextMenuItems);

  const togglePlayback = useCallback(() => {
    const progressive = progressivePlayerRef.current;
    if (progressive) {
      if (progressive.snapshot().isPlaying) {
        userPausedRef.current = true;
        progressive.pause();
      } else {
        userPausedRef.current = false;
        void progressive.play().catch((caught: unknown) => {
          setError(caught instanceof Error ? caught.message : 'Could not play the narration.');
          setStatus('error');
        });
      }
      return;
    }
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
    const progressive = progressivePlayerRef.current;
    if (progressive) {
      const snapshot = progressive.snapshot();
      progressive.seek(snapshot.currentTime + seconds);
      return;
    }
    const audio = audioRef.current;
    if (!audio) return;
    const upper = Number.isFinite(audio.duration) ? audio.duration : Number.POSITIVE_INFINITY;
    audio.currentTime = Math.max(0, Math.min(upper, audio.currentTime + seconds));
    setCurrentTime(audio.currentTime);
  }, []);

  const seekTo = useCallback((seconds: number) => {
    const progressive = progressivePlayerRef.current;
    if (progressive) {
      progressive.seek(seconds);
      return;
    }
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

  const creationPercent =
    creationProgress?.phase === 'encoding'
      ? 100
      : Math.min(
          100,
          Math.round(
            ((creationProgress?.completedCharacters ?? 0) /
              (creationProgress?.totalCharacters || 1)) *
              100,
          ),
        );
  const playedPercent =
    bufferedDuration > 0
      ? Math.min(creationPercent, (currentTime / bufferedDuration) * creationPercent)
      : 0;

  const transport =
    status === 'idle'
      ? null
      : createPortal(
          <aside className="document-narration-transport" aria-label="Narration controls">
            {status === 'creating' && (
              <>
                <div className="document-narration-summary" aria-live="polite">
                  <strong>
                    {isPlaying
                      ? 'Playing while creating…'
                      : waitingForAudio && !userPausedRef.current
                        ? 'Buffering narration…'
                        : 'Creating narration…'}
                  </strong>
                  <span>
                    {bufferedDuration > 0
                      ? `${formatTime(currentTime)} played · ${formatTime(bufferedDuration)} buffered`
                      : `${scope === 'document' ? 'Full document' : 'Selected text'} · ${
                          creationProgress?.phase === 'loading'
                            ? 'Preparing voice'
                            : 'Starting speech'
                        } · ${formatTime(elapsedSeconds)} elapsed`}
                  </span>
                </div>
                {bufferedDuration > 0 && (
                  <>
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
                      aria-label={isPlaying ? 'Pause narration' : 'Play buffered narration'}
                      title={isPlaying ? 'Pause' : 'Play buffered audio'}
                      onClick={togglePlayback}
                    >
                      {isPlaying ? 'Ⅱ' : '▶'}
                    </button>
                    <button
                      type="button"
                      className="document-narration-control"
                      aria-label="Forward 30 seconds"
                      title="Forward within buffered audio"
                      onClick={() => seekBy(30)}
                    >
                      ↷<small>30</small>
                    </button>
                  </>
                )}
                <div
                  className="document-narration-progress"
                  role="progressbar"
                  aria-label="Creating narration"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  tabIndex={0}
                  aria-valuenow={creationPercent}
                  title={`${formatTime(bufferedDuration)} generated · ${creationPercent}% complete`}
                >
                  <span
                    className="document-narration-progress-buffered"
                    style={{ width: `${creationPercent}%` }}
                  />
                  <span
                    className="document-narration-progress-played"
                    style={{ width: `${playedPercent}%` }}
                  />
                </div>
                <span className="document-narration-progress-value">
                  {creationPercent}% · {formatTime(bufferedDuration)}
                </span>
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
                  aria-label={encodingMp3 ? 'Preparing MP3' : 'Download MP3'}
                  aria-busy={encodingMp3}
                  title={encodingMp3 ? 'Preparing MP3…' : 'Download MP3'}
                  disabled={encodingMp3}
                  onClick={() => void downloadMp3()}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M12 3v11m0 0 4-4m-4 4-4-4M5 17v3h14v-3" />
                  </svg>
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
    <span className="document-narration-root">
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
      {transport}
    </span>
  );
}
