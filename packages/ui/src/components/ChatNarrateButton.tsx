import {
  requestMicStream,
  resolveFormat,
  supportsMediaRecorder,
  supportsUserMedia,
} from '@bendyline/squisq-editor-react/recorder';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { ProgressiveSpeechToText } from './progressive-speech-to-text.js';

type NarrateStatus = 'idle' | 'requesting' | 'recording' | 'transcribing';

export interface ChatNarrateButtonProps {
  projectId: string;
  disabled?: boolean;
  onTranscript: (text: string) => void;
  onError: (message: string | null) => void;
}

export function ChatNarrateButton({
  projectId,
  disabled = false,
  onTranscript,
  onError,
}: ChatNarrateButtonProps) {
  const [status, setStatus] = useState<NarrateStatus>('idle');
  const sessionRef = useRef<ProgressiveSpeechToText | null>(null);
  const mountedRef = useRef(true);
  const startingRef = useRef(false);
  const lifecycleRef = useRef(0);
  const previousProjectIdRef = useRef(projectId);
  const supported = supportsUserMedia() && supportsMediaRecorder();

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      lifecycleRef.current += 1;
      sessionRef.current?.cancel();
      sessionRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (previousProjectIdRef.current === projectId) return;
    previousProjectIdRef.current = projectId;
    lifecycleRef.current += 1;
    sessionRef.current?.cancel();
    sessionRef.current = null;
    startingRef.current = false;
    setStatus('idle');
  }, [projectId]);

  const stop = useCallback(async () => {
    const session = sessionRef.current;
    if (!session) return;
    setStatus('transcribing');
    try {
      await session.stop();
    } finally {
      if (sessionRef.current === session) sessionRef.current = null;
      if (mountedRef.current) setStatus('idle');
    }
  }, []);

  const start = useCallback(async () => {
    if (!supported || disabled || startingRef.current || sessionRef.current) return;
    startingRef.current = true;
    const lifecycle = lifecycleRef.current;
    setStatus('requesting');
    onError(null);
    let stream: MediaStream | null = null;
    try {
      // Squisq's requestMicStream is the shared wrapper around
      // navigator.mediaDevices.getUserMedia({ audio: …, video: false }).
      stream = await requestMicStream({
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      });
      if (!mountedRef.current || lifecycle !== lifecycleRef.current) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      const format = resolveFormat('audio');
      const session = new ProgressiveSpeechToText({
        stream,
        ...(format.mimeType ? { mimeType: format.mimeType } : {}),
        transcribe: async (blob, mimeType, signal) => {
          const response = await api.transcribeAudio({
            audio: { data: await blobToBase64(blob), mimeType },
            projectId,
            signal,
          });
          return response.text;
        },
        onTranscript,
        onError: (caught) => onError(humanizeNarrationError(caught)),
      });
      sessionRef.current = session;
      session.start();
      stream = null; // ownership moved to ProgressiveSpeechToText
      setStatus('recording');
    } catch (caught) {
      if (stream) {
        for (const track of stream.getTracks()) track.stop();
      }
      if (mountedRef.current && lifecycle === lifecycleRef.current) {
        setStatus('idle');
        onError(humanizeNarrationError(caught));
      }
    } finally {
      if (lifecycle === lifecycleRef.current) startingRef.current = false;
    }
  }, [disabled, onError, onTranscript, projectId, supported]);

  const recording = status === 'recording';
  const unavailable = !supported;
  const buttonDisabled =
    status === 'requesting' ||
    status === 'transcribing' ||
    (status === 'idle' && (disabled || unavailable));
  const label =
    status === 'requesting'
      ? 'Starting microphone…'
      : recording
        ? 'Stop narrating'
        : status === 'transcribing'
          ? 'Finishing transcription…'
          : 'Narrate prompt';
  const title = unavailable
    ? 'Voice input is unavailable in this browser'
    : recording
      ? 'Stop narrating and add the remaining speech to this prompt'
      : status === 'transcribing'
        ? 'Adding the remaining speech to this prompt'
        : 'Narrate this prompt with your microphone';

  return (
    <button
      type="button"
      className={`chat-narrate-btn${recording ? ' chat-narrate-btn-recording' : ''}`}
      data-testid="chat-narrate"
      onClick={recording ? () => void stop() : () => void start()}
      disabled={buttonDisabled}
      aria-label={label}
      aria-pressed={recording}
      aria-busy={status === 'requesting' || status === 'transcribing'}
      title={title}
    >
      <MicrophoneGlyph />
      {recording && <span className="chat-narrate-live-dot" aria-hidden="true" />}
    </button>
  );
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const batchSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += batchSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + batchSize));
  }
  return btoa(binary);
}

function humanizeNarrationError(caught: unknown): string {
  const error = caught instanceof Error ? caught : new Error(String(caught));
  if (error.name === 'NotAllowedError' || /permission|not allowed|denied/i.test(error.message)) {
    return 'Microphone access was not granted. Allow it in your system settings, then try again.';
  }
  if (
    error.name === 'NotFoundError' ||
    /requested device not found|no microphone/i.test(error.message)
  ) {
    return 'No microphone is available.';
  }
  if (/no stt model|download one from settings|speech-to-text model/i.test(error.message)) {
    return 'Speech-to-text is not ready. Download a model in Settings → Audio, then try again.';
  }
  return `Could not narrate this prompt: ${error.message}`;
}

function MicrophoneGlyph() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false">
      <rect x="5.25" y="1.5" width="5.5" height="8" rx="2.75" stroke="currentColor" />
      <path d="M3.5 7.5a4.5 4.5 0 0 0 9 0M8 12v2.5M5.75 14.5h4.5" stroke="currentColor" />
    </svg>
  );
}
