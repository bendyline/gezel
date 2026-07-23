/**
 * AudioProvider — service-side abstractions for speech-to-text (STT)
 * and text-to-speech (TTS).
 *
 * Two distinct provider shapes because the two capabilities have
 * different surface areas and different engines back them: STT is
 * implemented by `WhisperCppProvider`, TTS by `KokoroProvider`. They
 * share the model-pull / installed-list / health envelope conventions
 * with `ImageProvider` so the Settings UI looks symmetric.
 *
 * Streaming methods are defined here but **not implemented** for the
 * narration MVP — both providers throw "not yet supported" if called.
 * They live on the interface so an audio-chat feature can fill them in
 * without retrofitting the type. See the plan's "Architectural gaps to
 * design around now" section for the rationale.
 */

export interface AudioInputBytes {
  /** Raw audio bytes — typically a WAV file the route resolved from disk. */
  data: Buffer;
  mimeType: string;
}

export interface TranscribeInput {
  /**
   * The audio to transcribe. Either pre-resolved bytes or an absolute
   * filesystem path (the provider opens it locally — used by sd-server-
   * style flows where bytes already sit in the artifact tree).
   */
  audio: AudioInputBytes | { path: string };
  /**
   * Manifest id of the STT model to use. Provider falls back to the
   * first installed model when omitted.
   */
  model?: string;
  /**
   * BCP-47 language hint (e.g. "en", "es"). When omitted, whisper.cpp
   * runs its language-detection step on the first 30 seconds — slower
   * cold-start but free-form.
   */
  language?: string;
}

export interface TranscribeSegment {
  /** Segment start time in seconds. */
  start: number;
  end: number;
  text: string;
}

export interface TranscribeOutput {
  text: string;
  /** Per-segment timestamps when the engine reports them. */
  segments?: TranscribeSegment[];
  /** Detected (or supplied) language code. */
  language?: string;
  /** Wall-clock duration of the transcription itself. */
  durationMs: number;
}

export interface SynthesizeInput {
  text: string;
  /**
   * Voice identifier. Kokoro ships 54+ named voices (`af_heart`,
   * `am_adam`, …); falls back to the provider's default when omitted.
   */
  voice?: string;
  /**
   * Manifest id of the TTS model. The narration MVP ships Kokoro v1.0
   * as the only model so this is informational today.
   */
  model?: string;
  /**
   * Playback speed multiplier. 1.0 = engine default. Kokoro's natural
   * range is 0.5–2.0; values outside clamp at the engine.
   */
  speed?: number;
}

export interface SynthesizeOutput {
  /**
   * Generated WAV (RIFF/PCM) bytes. Routes write this under
   * `artifacts/audio/<sessionId>/…wav` and surface a thumbnail-style
   * audio-row in chat the same way generated images render today.
   */
  wav: Buffer;
  meta: {
    voice: string;
    model: string;
    sampleRate: number;
    durationSeconds: number;
    durationMs: number;
  };
}

export interface InstalledAudioModelInfo {
  id: string;
  name: string;
  approxSizeBytes: number;
  installedAt: string;
}

export type AudioModelPullEvent =
  | { type: 'progress'; bytesWritten: number; totalBytes?: number }
  | { type: 'error'; error: string }
  | { type: 'done'; id: string };

export interface AudioModelFile {
  /**
   * Role of the file inside the manifest directory. The provider
   * decides what each role means — e.g. whisper.cpp uses `weights`
   * only; Kokoro uses `weights` (ONNX) plus per-voice `voice:<id>`
   * entries.
   */
  role: string;
  downloadUrl: string;
  sha256: string;
  approxSizeBytes: number;
}

export interface AudioModelPullSpec {
  name: string;
  files: AudioModelFile[];
}

export interface AudioEngineHealth {
  /**
   * `ok` — engine reachable and at least one model installed.
   * `unreachable` — configured engine URL is not responding.
   * `not-configured` — no engine binary or runtime wired up.
   * `no-model` — engine reachable but the user hasn't pulled a model
   *   yet. Distinct UI state so we can guide them straight to the
   *   model picker.
   */
  status: 'ok' | 'unreachable' | 'not-configured' | 'no-model';
  baseUrl?: string;
  error?: string;
}

/** Speech-to-text provider. Implemented today by `WhisperCppProvider`. */
export interface SpeechToTextProvider {
  readonly name: string;
  transcribe(input: TranscribeInput): Promise<TranscribeOutput>;
  listInstalledModels(): Promise<InstalledAudioModelInfo[]>;
  pullModel(id: string, spec: AudioModelPullSpec): AsyncIterable<AudioModelPullEvent>;
  deleteModel(id: string): Promise<void>;
  health(): Promise<AudioEngineHealth>;
  /** Best-effort shutdown of any backing engine. Called when the service stops. */
  shutdown?(): Promise<void>;
}

/** Text-to-speech provider. Implemented today by `KokoroProvider`. */
export interface TextToSpeechProvider {
  readonly name: string;
  synthesize(input: SynthesizeInput): Promise<SynthesizeOutput>;
  listInstalledModels(): Promise<InstalledAudioModelInfo[]>;
  pullModel(id: string, spec: AudioModelPullSpec): AsyncIterable<AudioModelPullEvent>;
  deleteModel(id: string): Promise<void>;
  /** All voices currently available, across installed models. */
  listVoices(): Promise<AudioVoiceInfo[]>;
  health(): Promise<AudioEngineHealth>;
  /** Best-effort shutdown of any backing engine. Called when the service stops. */
  shutdown?(): Promise<void>;
}

export interface AudioVoiceInfo {
  /** Stable id passed back to `synthesize({ voice })`. */
  id: string;
  /** Human-friendly label for the picker. */
  name: string;
  /** BCP-47 language tag (e.g. `en-US`). */
  language: string;
  /** `'female' | 'male' | 'neutral'` — informational only. */
  gender?: 'female' | 'male' | 'neutral';
  /** Manifest id of the model that provides this voice. */
  modelId: string;
}
