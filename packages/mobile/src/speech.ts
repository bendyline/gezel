import { kokoroLexiconUrls } from 'virtual:gezel-kokoro-lexicon';
import {
  type KokoroLexicon,
  parseKokoroLexicon,
  phonemizeForKokoro,
  splitForKokoro,
  tokenizeKokoroPhonemes,
} from '@bendyline/gezel/kokoro';
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
    /** Padded Kokoro phoneme ids; the native side never sees text. */
    tokens: number[];
    voice?: string;
    model?: string;
    speed?: number;
  }): Promise<{ wav: string; meta: unknown }>;
  cancel(options: { requestId: string }): Promise<void>;
}
const plugin = registerPlugin<NativeSpeechPlugin>('GezelSpeech');

/**
 * Kokoro reads phoneme ids. The dictionary that produces them is published as
 * a gzipped web asset and read once, here, so the WebView and the desktop
 * daemon run the very same frontend over the very same data. It replaces
 * eSpeak NG, which is GPL-3 and cannot ship in a store build.
 */
const dictionaries = new Map<'us' | 'gb', Promise<KokoroLexicon>>();
function kokoroDictionary(language: 'us' | 'gb'): Promise<KokoroLexicon> {
  const cached = dictionaries.get(language);
  if (cached) return cached;
  const pending = (async () => {
    const response = await fetch(kokoroLexiconUrls[language]);
    if (!response.ok || !response.body)
      throw new OfflineSpeechError(
        'The speech dictionary is missing from this build',
        'unavailable',
      );
    const text = await new Response(
      response.body.pipeThrough(new DecompressionStream('gzip')),
    ).text();
    return parseKokoroLexicon(text);
  })();
  // A failed read must not be cached as a permanent failure.
  void pending.catch(() => dictionaries.delete(language));
  dictionaries.set(language, pending);
  return pending;
}

/**
 * One inference per sentence. Kokoro speaks at most 509 phonemes at a time,
 * and the retired sherpa runtime used to split sentences internally, so the
 * host does it now — the same way the daemon does.
 */
async function planUtterances(text: string, voice: string): Promise<number[][]> {
  const lexicon = await kokoroDictionary(voice.startsWith('b') ? 'gb' : 'us');
  const utterances: number[][] = [];
  const sentences = text
    .split(/(?<=[.!?\u2026])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  for (const sentence of sentences.length ? sentences : [text.trim()].filter(Boolean)) {
    const phonemes = phonemizeForKokoro(sentence, { lexicon });
    if (!phonemes) continue;
    for (const piece of splitForKokoro(phonemes)) {
      const { tokens } = tokenizeKokoroPhonemes(piece);
      // Two pad frames and nothing between them would be silence.
      if (tokens.length > 2) utterances.push([...tokens]);
    }
  }
  return utterances;
}

/** Join per-sentence WAVs into one, keeping the first header and its format. */
function joinWav(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0]!;
  let bodies: Uint8Array[];
  try {
    bodies = parts.map((part) => speechPcm16(part));
  } catch {
    throw new OfflineSpeechError('The speech engine returned audio Gezel cannot join', 'failed');
  }
  const total = bodies.reduce((sum, body) => sum + body.length, 0);
  const output = new Uint8Array(44 + total);
  output.set(parts[0]!.subarray(0, 44), 0);
  let offset = 44;
  for (const body of bodies) {
    output.set(body, offset);
    offset += body.length;
  }
  const view = new DataView(output.buffer);
  view.setUint32(4, output.length - 8, true);
  view.setUint32(40, total, true);
  return output;
}

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
        const voice = input.voice ?? 'af_heart';
        const utterances = await planUtterances(input.text, voice);
        if (utterances.length === 0)
          throw new OfflineSpeechError('There is nothing to read aloud here', 'failed');
        signal.throwIfAborted();
        const parts: Uint8Array[] = [];
        let meta: unknown;
        for (const [index, tokens] of utterances.entries()) {
          // Built explicitly rather than spread: the caller's `text` must not
          // cross the bridge, because nothing native reads it any more.
          const output = await native.synthesize({
            requestId,
            tokens,
            voice,
            ...(input.model === undefined ? {} : { model: input.model }),
            ...(input.speed === undefined ? {} : { speed: input.speed }),
          });
          signal.throwIfAborted();
          parts.push(speechBytes(output.wav));
          meta = output.meta;
          await hooks?.onProgress?.({
            phase: 'synthesizing',
            totalCharacters: input.text.length,
            completedCharacters: Math.round((input.text.length * (index + 1)) / utterances.length),
            completedChunks: index + 1,
          });
        }
        return { wav: joinWav(parts), meta: AudioSynthesizeMetaSchema.parse(meta) };
      }),
  };
}
