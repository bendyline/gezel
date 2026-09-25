import { z } from 'zod';
import { AudioVoiceSchema, InstalledAudioModelSchema } from './audio.js';

export const OfflineSpeechEngineSchema = z.enum(['system', 'whisper', 'kokoro']);
export type OfflineSpeechEngine = z.infer<typeof OfflineSpeechEngineSchema>;

/** Readiness never initiates a download, asks for permission, or warms a model. */
export const OfflineSpeechReadinessSchema = z.object({
  state: z.enum(['ready', 'download-required', 'permission-required', 'unavailable']),
  reason: z.string().optional(),
  language: z.string().optional(),
  model: z.string().optional(),
});
export type OfflineSpeechReadiness = z.infer<typeof OfflineSpeechReadinessSchema>;

export const OfflineSpeechStatusSchema = z.object({
  system: OfflineSpeechReadinessSchema,
  whisper: OfflineSpeechReadinessSchema,
  kokoro: OfflineSpeechReadinessSchema,
  voices: z.array(AudioVoiceSchema),
  models: z
    .object({
      stt: z.array(InstalledAudioModelSchema),
      tts: z.array(InstalledAudioModelSchema),
    })
    .optional(),
});
export type OfflineSpeechStatus = z.infer<typeof OfflineSpeechStatusSchema>;
