import { z } from 'zod';
import { LicenseMetaShape, RecoMetaShape } from './catalog.js';

/**
 * Wire schemas for the audio (STT + TTS) feature.
 *
 * Mirrors `schemas/image.ts` — provider-agnostic shapes; the service
 * routes each request through whichever audio provider is active
 * (`MockSpeechToTextProvider` / `WhisperCppProvider` for STT,
 * `MockTextToSpeechProvider` / `KokoroProvider` for TTS).
 */

// ── transcribe (STT) ──────────────────────────────────────────────

export const AudioTranscribeRequestSchema = z.object({
  /**
   * Source audio. Either an inline base64 blob OR a project-relative
   * artifact path (resolved server-side). MCP `transcribe_audio` uses
   * the artifact path so audio bytes don't round-trip through model
   * context.
   */
  audio: z.union([
    z.object({
      data: z.string().min(1).describe('Base64-encoded audio bytes.'),
      mimeType: z.string().default('audio/wav'),
    }),
    z.object({
      artifactPath: z
        .string()
        .min(1)
        .describe('Project-relative artifact path under `audio/` or `audio/uploaded/`.'),
    }),
  ]),
  /** Manifest id of the STT model. Provider falls back to first installed. */
  model: z.string().optional(),
  /** BCP-47 language hint. Whisper auto-detects when omitted. */
  language: z.string().optional(),
  /** Project the audio belongs to. Defaults to 'default'. */
  projectId: z.string().optional(),
});
export type AudioTranscribeRequest = z.infer<typeof AudioTranscribeRequestSchema>;

export const AudioTranscribeSegmentSchema = z.object({
  start: z.number(),
  end: z.number(),
  text: z.string(),
});
export type AudioTranscribeSegment = z.infer<typeof AudioTranscribeSegmentSchema>;

export const AudioTranscribeResponseSchema = z.object({
  text: z.string(),
  language: z.string().optional(),
  segments: z.array(AudioTranscribeSegmentSchema).optional(),
  durationMs: z.number().int().nonnegative(),
});
export type AudioTranscribeResponse = z.infer<typeof AudioTranscribeResponseSchema>;

// ── synthesize (TTS) ──────────────────────────────────────────────

export const AudioSynthesizeRequestSchema = z.object({
  text: z.string().min(1),
  voice: z.string().optional(),
  model: z.string().optional(),
  /** 0.5–2.0 multiplier; clamped server-side. Defaults to 1.0. */
  speed: z.number().min(0.25).max(4).optional(),
  /** Project the artifact belongs to. Defaults to 'default'. */
  projectId: z.string().optional(),
  /** Session that originated this synthesis (artifact lands under it). */
  sessionId: z.string().optional(),
  gezelId: z.string().optional(),
  /**
   * Set to true to receive the synthesized WAV bytes inline (base64) on
   * the response, in addition to the artifact write. Used by the MCP
   * `synthesize_speech` tool so the bridge can attach the bytes as a
   * tool-call audio content block — mirrors the `inline` flag on
   * `ImageGenerationRequestSchema`.
   */
  inline: z.boolean().optional(),
});
export type AudioSynthesizeRequest = z.infer<typeof AudioSynthesizeRequestSchema>;

export const AudioSynthesizeMetaSchema = z.object({
  voice: z.string(),
  model: z.string(),
  sampleRate: z.number().int().positive(),
  durationSeconds: z.number().nonnegative(),
  durationMs: z.number().int().nonnegative(),
});
export type AudioSynthesizeMeta = z.infer<typeof AudioSynthesizeMetaSchema>;

export const AudioSynthesizeResponseSchema = z.object({
  artifactPath: z.string(),
  meta: AudioSynthesizeMetaSchema,
  /** Base64 WAV bytes when caller asked for inline. Empty otherwise. */
  b64Wav: z.string().optional(),
});
export type AudioSynthesizeResponse = z.infer<typeof AudioSynthesizeResponseSchema>;

/** Live progress emitted while a speech request is being synthesized. */
export const AudioSynthesizeProgressSchema = z.object({
  phase: z.enum(['loading', 'synthesizing', 'encoding']),
  completedCharacters: z.number().int().nonnegative(),
  totalCharacters: z.number().int().positive(),
  completedChunks: z.number().int().nonnegative(),
});
export type AudioSynthesizeProgress = z.infer<typeof AudioSynthesizeProgressSchema>;

/** One independently playable sentence emitted before the final WAV is assembled. */
export const AudioSynthesizeChunkSchema = z.object({
  index: z.number().int().nonnegative(),
  b64Wav: z.string(),
  sampleRate: z.number().int().positive(),
  durationSeconds: z.number().positive(),
});
export type AudioSynthesizeChunk = z.infer<typeof AudioSynthesizeChunkSchema>;

/** Finite SSE stream used by document narration and other progress-aware callers. */
export const AudioSynthesizeEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('progress'), progress: AudioSynthesizeProgressSchema }),
  z.object({ type: z.literal('chunk'), chunk: AudioSynthesizeChunkSchema }),
  z.object({ type: z.literal('done'), result: AudioSynthesizeResponseSchema }),
  z.object({ type: z.literal('error'), error: z.string() }),
]);
export type AudioSynthesizeEvent = z.infer<typeof AudioSynthesizeEventSchema>;

// ── installed model lists ────────────────────────────────────────

export const InstalledAudioModelSchema = z.object({
  id: z.string(),
  name: z.string(),
  approxSizeBytes: z.number().int().nonnegative(),
  installedAt: z.string(),
});
export type InstalledAudioModel = z.infer<typeof InstalledAudioModelSchema>;

export const ListInstalledAudioModelsResponseSchema = z.object({
  models: z.array(InstalledAudioModelSchema),
});
export type ListInstalledAudioModelsResponse = z.infer<
  typeof ListInstalledAudioModelsResponseSchema
>;

// ── catalog (what's available to pull) ───────────────────────────

export const AudioCatalogModelSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  approxSizeBytes: z.number().int().nonnegative(),
  /** `'stt'` for whisper.cpp models, `'tts'` for Kokoro. */
  kind: z.enum(['stt', 'tts']),
  /** Full upstream license name, e.g. "MIT" / "Apache 2.0". */
  license: z.string().optional(),
  ...LicenseMetaShape,
  ...RecoMetaShape,
});
export type AudioCatalogModel = z.infer<typeof AudioCatalogModelSchema>;

export const ListAudioCatalogResponseSchema = z.object({
  stt: z.array(AudioCatalogModelSchema),
  tts: z.array(AudioCatalogModelSchema),
});
export type ListAudioCatalogResponse = z.infer<typeof ListAudioCatalogResponseSchema>;

// ── voices ───────────────────────────────────────────────────────

export const AudioVoiceSchema = z.object({
  id: z.string(),
  name: z.string(),
  language: z.string(),
  gender: z.enum(['female', 'male', 'neutral']).optional(),
  modelId: z.string(),
});
export type AudioVoice = z.infer<typeof AudioVoiceSchema>;

export const ListAudioVoicesResponseSchema = z.object({
  voices: z.array(AudioVoiceSchema),
});
export type ListAudioVoicesResponse = z.infer<typeof ListAudioVoicesResponseSchema>;

// ── engine status (combined STT + TTS) ───────────────────────────

export const AudioEngineHealthSchema = z.object({
  status: z.enum(['ok', 'unreachable', 'not-configured', 'no-model']),
  baseUrl: z.string().optional(),
  error: z.string().optional(),
  provider: z.string().optional(),
  modelCount: z.number().int().nonnegative(),
});
export type AudioEngineHealth = z.infer<typeof AudioEngineHealthSchema>;

export const AudioEngineStatusResponseSchema = z.object({
  stt: AudioEngineHealthSchema,
  tts: AudioEngineHealthSchema,
});
export type AudioEngineStatusResponse = z.infer<typeof AudioEngineStatusResponseSchema>;

// ── pull-model SSE event envelope ────────────────────────────────

export const AudioModelPullEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('progress'),
    bytesWritten: z.number().int().nonnegative(),
    totalBytes: z.number().int().nonnegative().optional(),
  }),
  z.object({
    type: z.literal('error'),
    error: z.string(),
  }),
  z.object({
    type: z.literal('done'),
    id: z.string(),
  }),
]);
export type AudioModelPullEvent = z.infer<typeof AudioModelPullEventSchema>;
