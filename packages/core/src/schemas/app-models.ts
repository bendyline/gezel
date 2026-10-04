import { z } from 'zod';

const id = z.string().min(1).max(512);
const bytes = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const AppModelCapabilitiesSchema = z.object({
  text: z.boolean(),
  tools: z.boolean(),
  structuredOutput: z.boolean(),
  images: z.boolean(),
  foregroundOnly: z.boolean(),
});
/** v1 permits additive server fields, but validates every field used for decisions. */
export const AppModelSchema = z
  .object({
    id,
    object: z.literal('model'),
    created: z.number().finite(),
    owned_by: id,
    name: z.string().max(512).optional(),
    role: z.string().max(4096).optional(),
    gezel_id: id.optional(),
    is_fallback: z.boolean().optional(),
    supports_reasoning: z.boolean().optional(),
    context_window: z.number().int().positive().optional(),
    max_output_tokens: z.number().int().positive().optional(),
    default_output_tokens: z.number().int().positive().optional(),
    aliases: z.array(id).max(32).optional(),
    availability: z
      .enum(['available', 'unavailable', 'download-required', 'downloading'])
      .optional(),
    unavailable_reason: z.string().max(4096).optional(),
    reason_code: z.string().max(128).optional(),
    recovery_actions: z
      .array(z.enum(['prepare', 'open-system-settings', 'retry', 'choose-model']))
      .max(8)
      .optional(),
    locality: z.enum(['on-device', 'network', 'unknown']).optional(),
    preparation: z
      .enum(['none', 'app-download', 'system-download', 'system-settings', 'unknown'])
      .optional(),
    download_bytes: bytes.optional(),
    capabilities: AppModelCapabilitiesSchema.optional(),
    native_capabilities: AppModelCapabilitiesSchema.extend({
      structuredChat: z.boolean().optional(),
    }).optional(),
    supported_options: z.array(z.string().max(64)).max(32).optional(),
  })
  .passthrough();
export const AppModelListSchema = z.object({
  object: z.literal('list'),
  data: z.array(AppModelSchema).max(10000),
});
export type AppModel = z.infer<typeof AppModelSchema>;
export type AppModelList = z.infer<typeof AppModelListSchema>;
export const AppEnsureResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ready'), model_id: id, job_id: id.optional() }),
  z.object({ status: z.literal('downloading'), model_id: id, job_id: id }),
]);
const job = { jobId: id, modelId: id };
export const AppEnsureEventSchema = z.discriminatedUnion('type', [
  z.object({ ...job, type: z.literal('progress'), bytesWritten: bytes, totalBytes: bytes }),
  z.object({ ...job, type: z.literal('verifying'), file: z.string().max(4096).optional() }),
  z.object({ ...job, type: z.literal('extracting-metadata') }),
  z.object({
    ...job,
    type: z.literal('retrying'),
    attempt: bytes,
    maxAttempts: bytes,
    delayMs: bytes,
    reason: z.string().max(4096),
  }),
  z.object({ ...job, type: z.literal('done'), warning: z.string().max(4096).optional() }),
  z.object({ ...job, type: z.literal('error'), error: z.string().max(4096) }),
]);
export type AppEnsureResult = z.infer<typeof AppEnsureResultSchema>;
export type AppEnsureEvent = z.infer<typeof AppEnsureEventSchema>;

const packageNative = z
  .object({
    version: z.string().max(128),
    abi: z.literal(1),
    settings: z.record(z.string(), z.unknown()),
    toolchains: z.record(z.string(), z.string().max(1024)),
    deviceInference: z.string().max(128),
    licenses: z.array(z.string().max(1024)).min(1).max(1000),
    privacyManifests: z.array(z.string().max(1024)).max(100),
  })
  .strict();
export const EmbeddingPackageManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    package: z.literal('@bendyline/gezel-capacitor'),
    version: z.string().min(1).max(128),
    capacitor: z.string().min(1).max(128),
    native: z.object({ ios: packageNative, android: packageNative }).strict(),
    files: z
      .record(
        z
          .string()
          .min(1)
          .max(1024)
          .refine(
            (path) =>
              !path.includes('\\') &&
              !path.includes(':') &&
              ![...path].some((c) => c.charCodeAt(0) < 32) &&
              path.split('/').every((part) => part !== '' && part !== '.' && part !== '..'),
          ),
        z.string().regex(/^[a-f0-9]{64}$/),
      )
      .refine((files) => Object.keys(files).length > 0 && Object.keys(files).length <= 10000),
  })
  .strict();
export type EmbeddingPackageManifest = z.infer<typeof EmbeddingPackageManifestSchema>;
