import type {
  AudioSynthesizeChunk,
  AudioSynthesizeMeta,
  AudioSynthesizeProgress,
  AudioTranscribeResponse,
} from '../schemas/audio.js';
import type { OfflineSpeechEngine, OfflineSpeechStatus } from '../schemas/offline-speech.js';

export interface PortableSpeechInput {
  audio: Uint8Array;
  mimeType: string;
  language?: string;
  prompt?: string;
  model?: string;
}
export interface PortableSpeechSynthesis {
  text: string;
  voice?: string;
  model?: string;
  speed?: number;
}
export interface PortableSpeechOutput {
  wav: Uint8Array;
  meta: AudioSynthesizeMeta;
}
export interface PortableSpeechHooks {
  onProgress?(progress: AudioSynthesizeProgress): Promise<void> | void;
  onChunk?(chunk: AudioSynthesizeChunk): Promise<void> | void;
}

/** An offline-only host port. Preparation/downloads are separate user actions.
 * Adapters must settle cancelled operations only after releasing native work. */
export interface PortableSpeech {
  status(language?: string): Promise<OfflineSpeechStatus>;
  transcribe(
    engine: 'system' | 'whisper',
    input: PortableSpeechInput,
    signal: AbortSignal,
  ): Promise<AudioTranscribeResponse>;
  synthesize(
    input: PortableSpeechSynthesis,
    signal: AbortSignal,
    hooks?: PortableSpeechHooks,
  ): Promise<PortableSpeechOutput>;
}

export class OfflineSpeechError extends Error {
  constructor(
    message: string,
    readonly code: 'unavailable' | 'download-required' | 'permission-required' | 'failed',
  ) {
    super(message);
    this.name = 'OfflineSpeechError';
  }
}

export function requireOfflineSpeech(status: OfflineSpeechStatus, engine: OfflineSpeechEngine) {
  const readiness = status[engine];
  if (readiness.state !== 'ready')
    throw new OfflineSpeechError(
      readiness.reason ??
        `${engine === 'kokoro' ? 'Kokoro voices' : 'Offline speech recognition'} are not ready on this device.`,
      readiness.state,
    );
}

/** A named model is authoritative. Automatic fallback is only for unavailable
 * system recognition, never for denied consent, cancellation, or bad audio. */
export async function transcribeOffline(
  speech: PortableSpeech,
  input: PortableSpeechInput,
  signal: AbortSignal,
): Promise<AudioTranscribeResponse> {
  signal.throwIfAborted();
  const status = await speech.status(input.language);
  signal.throwIfAborted();
  if (input.model) {
    const engine = input.model === 'system' ? 'system' : 'whisper';
    if (engine !== 'system' || status.system.state !== 'permission-required')
      requireOfflineSpeech(status, engine);
    return speech.transcribe(engine, input, signal);
  }
  if (status.system.state === 'ready' || status.system.state === 'permission-required') {
    try {
      return await speech.transcribe('system', input, signal);
    } catch (error) {
      signal.throwIfAborted();
      if (
        !(error instanceof OfflineSpeechError) ||
        !['unavailable', 'download-required'].includes(error.code)
      )
        throw error;
    }
  }
  signal.throwIfAborted();
  requireOfflineSpeech(status, 'whisper');
  return speech.transcribe('whisper', input, signal);
}
