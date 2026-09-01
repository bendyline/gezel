import {
  requestMicStream,
  resolveFormat,
  supportsMediaRecorder,
  supportsUserMedia,
} from '@bendyline/squisq-editor-react/recorder';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { listMicrophoneInputs, resolveMicrophoneInput } from './microphone-input.js';
import {
  ProgressiveSpeechToText,
  normalizeSpeechTranscript,
} from './progressive-speech-to-text.js';
import { microphoneTakeAsWav } from './speech-audio-wav.js';

type NarrateStatus = 'idle' | 'requesting' | 'recording' | 'transcribing';
const WAVEFORM_BAR_COUNT = 12;

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
  const [waveformLevels, setWaveformLevels] = useState<number[]>(() => emptyWaveform());
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
    setWaveformLevels(emptyWaveform());
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
    setWaveformLevels(emptyWaveform());
    onError(null);
    let stream: MediaStream | null = null;
    try {
      const config = await api.getConfig().catch(() => undefined);
      const microphonePreference = {
        ...(config?.microphoneDeviceId ? { deviceId: config.microphoneDeviceId } : {}),
        ...(config?.microphoneDeviceLabel ? { label: config.microphoneDeviceLabel } : {}),
      };
      const inputs =
        microphonePreference.deviceId || microphonePreference.label
          ? await listMicrophoneInputs().catch(() => [])
          : [];
      const preferredInput = resolveMicrophoneInput(inputs, microphonePreference);
      const preferredDeviceId = preferredInput?.deviceId ?? microphonePreference.deviceId;
      // Squisq's requestMicStream is the shared wrapper around
      // navigator.mediaDevices.getUserMedia({ audio: …, video: false }).
      stream = await requestMicStream({
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        ...(preferredDeviceId ? { deviceId: { exact: preferredDeviceId } } : {}),
      });
      if (!mountedRef.current || lifecycle !== lifecycleRef.current) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      const activeMicrophoneLabel =
        stream.getAudioTracks?.()[0]?.label?.trim() ||
        preferredInput?.label ||
        microphonePreference.label;
      const format = resolveFormat('audio');
      const session = new ProgressiveSpeechToText({
        stream,
        ...(format.mimeType ? { mimeType: format.mimeType } : {}),
        transcribe: async (blob, mimeType, signal, prompt) => {
          const upload = await microphoneTakeAsWav(blob);
          const response = await api.transcribeAudio({
            audio: { data: await blobToBase64(upload), mimeType: upload.type || mimeType },
            projectId,
            signal,
            ...(prompt ? { prompt } : {}),
          });
          const text = normalizeSpeechTranscript(response.text);
          if (!text) return '';
          onError(null);
          return text;
        },
        onTranscript,
        onAudioLevel: (level) => {
          if (!mountedRef.current || lifecycle !== lifecycleRef.current) return;
          const visualLevel = normalizeWaveformLevel(level);
          setWaveformLevels((current) => [...current.slice(1), visualLevel]);
        },
        onLongPause: (hadTranscript) => {
          if (!hadTranscript) {
            onError(
              `No speech detected${activeMicrophoneLabel ? ` from ${activeMicrophoneLabel}` : ''}. Choose the microphone in Settings → Device Integration if this isn't the expected input.`,
            );
          }
          void stop();
        },
        onError: (caught) => {
          // A failed take will not become more useful by keeping the mic open
          // and sending another one. Release it immediately and surface one
          // actionable error.
          session.cancel();
          if (sessionRef.current !== session) return;
          sessionRef.current = null;
          if (mountedRef.current && lifecycle === lifecycleRef.current) {
            setStatus('idle');
            onError(humanizeNarrationError(caught));
          }
        },
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
  }, [disabled, onError, onTranscript, projectId, stop, supported]);

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
      ? 'Listening — short pauses add speech; click to finish now'
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
      {recording && <MicrophoneWaveform levels={waveformLevels} />}
      {recording && <span className="chat-narrate-live-dot" aria-hidden="true" />}
    </button>
  );
}

function emptyWaveform(): number[] {
  return Array.from({ length: WAVEFORM_BAR_COUNT }, () => 0);
}

/** Map typical microphone RMS values into a legible 0–1 display envelope. */
function normalizeWaveformLevel(level: number): number {
  return Math.min(1, Math.max(0, level * 14));
}

function MicrophoneWaveform({ levels }: { levels: readonly number[] }) {
  return (
    <span className="chat-narrate-waveform" data-testid="microphone-waveform" aria-hidden="true">
      {levels.map((level, index) => (
        <span
          // Position is the identity in this fixed-length rolling buffer.
          // biome-ignore lint/suspicious/noArrayIndexKey: bars never reorder.
          key={index}
          className="chat-narrate-waveform-bar"
          style={{ height: `${2 + level * 14}px` }}
        />
      ))}
    </span>
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
  const message = apiErrorDetail(error) ?? error.message;
  if (error.name === 'NotAllowedError' || /permission|not allowed|denied/i.test(message)) {
    return 'Microphone access was not granted. Allow it in your system settings, then try again.';
  }
  if (error.name === 'OverconstrainedError' || /constraint|selected microphone/i.test(message)) {
    return 'The selected microphone is unavailable. Choose another in Settings → Device Integration.';
  }
  if (error.name === 'NotFoundError' || /requested device not found|no microphone/i.test(message)) {
    return 'No microphone is available.';
  }
  if (
    /speech_to_text_not_ready|no stt model|download one from settings|speech-to-text model/i.test(
      message,
    )
  ) {
    return 'Speech-to-text is not ready. Download a model in Settings → Audio, then try again.';
  }
  if (/speech_to_text_failed/i.test(message)) {
    return 'Speech-to-text could not transcribe this recording. Check Settings → Audio, then try again.';
  }
  return `Could not narrate this prompt: ${message}`;
}

function apiErrorDetail(error: Error): string | null {
  const details = (error as Error & { details?: unknown }).details;
  if (details && typeof details === 'object' && 'error' in details) {
    const value = (details as { error?: unknown }).error;
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return typeof details === 'string' && details.trim() ? details.trim() : null;
}

function MicrophoneGlyph() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false">
      <rect x="5.25" y="1.5" width="5.5" height="8" rx="2.75" stroke="currentColor" />
      <path d="M3.5 7.5a4.5 4.5 0 0 0 9 0M8 12v2.5M5.75 14.5h4.5" stroke="currentColor" />
    </svg>
  );
}
