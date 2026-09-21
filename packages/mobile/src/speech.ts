import {
  OfflineSpeechError,
  type PortableSpeech,
  speechBase64,
  speechBytes,
  speechPcm16,
} from '@bendyline/gezel/runtime';
import {
  AudioSynthesizeMetaSchema,
  AudioTranscribeResponseSchema,
  OfflineSpeechStatusSchema,
} from '@bendyline/gezel/schemas';
import { registerPlugin } from '@capacitor/core';

export interface NativeSpeechPlugin {
  status(options: { language?: string }): Promise<unknown>;
  transcribe(options: {
    requestId: string;
    engine: 'system' | 'whisper';
    audio: string;
    mimeType: string;
    language?: string;
    model?: string;
    prompt?: string;
  }): Promise<unknown>;
  synthesize(options: {
    requestId: string;
    text: string;
    voice?: string;
    model?: string;
    speed?: number;
  }): Promise<{ wav: string; meta: unknown }>;
  cancel(options: { requestId: string }): Promise<void>;
}
const plugin = registerPlugin<NativeSpeechPlugin>('GezelSpeech');

export function createNativeSpeech(native: NativeSpeechPlugin = plugin): PortableSpeech {
  let busy = false;
  let pendingStatus:
    | { language?: string; promise: Promise<ReturnType<typeof OfflineSpeechStatusSchema.parse>> }
    | undefined;
  async function operation<T>(
    signal: AbortSignal,
    execute: (id: string) => Promise<T>,
  ): Promise<T> {
    signal.throwIfAborted();
    if (busy) throw new Error('Speech is already running.');
    busy = true;
    const requestId = crypto.randomUUID();
    let cancellation: Promise<void> | undefined;
    const abort = () => {
      cancellation ??= native.cancel({ requestId }).catch(() => {});
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
      const result = await execute(requestId);
      signal.throwIfAborted();
      return result;
    } catch (error) {
      signal.throwIfAborted();
      const code = (error as { code?: unknown })?.code;
      if (code === 'unavailable' || code === 'download-required' || code === 'permission-required')
        throw new OfflineSpeechError(
          error instanceof Error ? error.message : 'Offline speech is unavailable',
          code,
        );
      throw error;
    } finally {
      signal.removeEventListener('abort', abort);
      await cancellation;
      busy = false;
    }
  }
  return {
    status: (language) => {
      if (pendingStatus?.language === language && pendingStatus) return pendingStatus.promise;
      const promise = native
        .status({ language })
        .then((value) => OfflineSpeechStatusSchema.parse(value))
        .finally(() => {
          if (pendingStatus?.promise === promise) pendingStatus = undefined;
        });
      pendingStatus = { language, promise };
      return promise;
    },
    transcribe: (engine, input, signal) =>
      operation(signal, async (requestId) =>
        AudioTranscribeResponseSchema.parse(
          await native.transcribe({
            ...input,
            audio: speechBase64(speechPcm16(input.audio)),
            mimeType: 'audio/pcm;rate=16000;channels=1',
            engine,
            requestId,
          }),
        ),
      ),
    synthesize: (input, signal, hooks) =>
      operation(signal, async (requestId) => {
        await hooks?.onProgress?.({
          phase: 'loading',
          totalCharacters: input.text.length,
          completedCharacters: 0,
          completedChunks: 0,
        });
        signal.throwIfAborted();
        const output = await native.synthesize({ ...input, requestId });
        signal.throwIfAborted();
        return { wav: speechBytes(output.wav), meta: AudioSynthesizeMetaSchema.parse(output.meta) };
      }),
  };
}
