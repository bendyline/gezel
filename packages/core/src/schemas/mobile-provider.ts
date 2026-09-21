import { z } from 'zod';

export const MobileProviderIdSchema = z.enum([
  'llama-cpp',
  'apple-foundation-models',
  'android-mlkit',
]);
export type MobileProviderId = z.infer<typeof MobileProviderIdSchema>;

export const MobileProviderSchema = z
  .object({
    id: MobileProviderIdSchema,
    name: z.string().min(1).max(100),
    locality: z.literal('on-device'),
    availability: z.enum(['available', 'unavailable', 'download-required', 'downloading']),
    reason: z.string().max(1_000).optional(),
    contextTokens: z.number().int().min(1).max(1_048_576),
    maxOutputTokens: z.number().int().min(1).max(64_000),
    capabilities: z
      .object({
        text: z.literal(true),
        tools: z.literal(false),
        structuredOutput: z.literal(false),
        images: z.literal(false),
        foregroundOnly: z.literal(true),
      })
      .strict(),
  })
  .strict()
  .refine((provider) => provider.maxOutputTokens < provider.contextTokens, {
    message: 'A provider must leave context space for its input',
  });
export type MobileProvider = z.infer<typeof MobileProviderSchema>;

export const MobileProviderListSchema = z
  .array(MobileProviderSchema)
  .max(3)
  .refine((providers) => new Set(providers.map(({ id }) => id)).size === providers.length, {
    message: 'Duplicate mobile provider id',
  });

/** Immutable identity from the canonical catalog, before native HEAD resolves length. */
export const MobileModelSourceIdentitySchema = z
  .object({
    catalogId: z.string().min(1).max(160),
    catalogVersion: z.string().min(1).max(80),
    sourceId: z.string().min(1).max(160),
    huggingfaceRepo: z
      .string()
      .regex(/^[A-Za-z0-9_-][A-Za-z0-9_.-]*\/[A-Za-z0-9_-][A-Za-z0-9_.-]*$/)
      .max(200),
    revision: z.string().regex(/^[a-f0-9]{40}$/),
    filename: z
      .string()
      .min(6)
      .max(400)
      .refine(
        (value) =>
          value.endsWith('.gguf') &&
          value.split('/').every((part) => part !== '' && part !== '.' && part !== '..') &&
          !value.includes('\\') &&
          [...value].every(
            (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
          ),
        'Expected a confined GGUF filename',
      ),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type MobileModelSourceIdentity = z.infer<typeof MobileModelSourceIdentitySchema>;
export const MobileModelSourceSchema = MobileModelSourceIdentitySchema.extend({
  sizeBytes: z
    .number()
    .int()
    .min(4)
    .max(4 * 1024 * 1024 * 1024),
}).strict();
export type MobileModelSource = z.infer<typeof MobileModelSourceSchema>;

export const MobileModelDownloadSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().min(1).max(200),
    source: MobileModelSourceSchema,
    state: z.enum(['queued', 'downloading', 'paused', 'verifying', 'complete', 'failed']),
    downloadedBytes: z
      .number()
      .int()
      .nonnegative()
      .max(4 * 1024 * 1024 * 1024),
    error: z.string().max(1000).optional(),
    modelId: z.string().uuid().optional(),
  })
  .strict()
  .refine(
    (value) => value.downloadedBytes <= value.source.sizeBytes,
    'Download exceeds expected model size',
  );
export type MobileModelDownload = z.infer<typeof MobileModelDownloadSchema>;
export const MobileModelDownloadsSchema = z
  .object({ downloads: z.array(MobileModelDownloadSchema).max(16) })
  .strict();

export const MobileModelSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-zA-Z0-9_-]+$/),
    name: z.string().min(1).max(200),
    source: MobileModelSourceSchema.optional(),
    sizeBytes: z
      .number()
      .int()
      .positive()
      .max(4 * 1024 * 1024 * 1024),
  })
  .strict();
export type MobileModel = z.infer<typeof MobileModelSchema>;

export const MobileModelInventorySchema = z
  .object({
    models: z.array(MobileModelSchema).max(100),
    selectedModelId: MobileModelSchema.shape.id.optional(),
  })
  .strict()
  .superRefine((inventory, ctx) => {
    const ids = new Set(inventory.models.map(({ id }) => id));
    if (ids.size !== inventory.models.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate mobile model id' });
    if (inventory.selectedModelId && !ids.has(inventory.selectedModelId))
      ctx.addIssue({ code: 'custom', message: 'The selected mobile model is missing' });
  });
export type MobileModelInventory = z.infer<typeof MobileModelInventorySchema>;

/** Host admission limits, separate from the model's trained window. Native
 * inference still validates the actual tokenized prompt before generation. */
export const MobileInferenceBudgetSchema = z
  .object({
    contextSize: z.number().int().min(512).max(8192),
    maxTokens: z.number().int().min(1).max(4096),
  })
  .strict()
  .refine(({ contextSize, maxTokens }) => maxTokens + 128 < contextSize, {
    message: 'Leave room for conversation and instructions before the reply budget',
  });
export type MobileInferenceBudget = z.infer<typeof MobileInferenceBudgetSchema>;

/** Explicit choices fail instead of being silently replaced by defaults. */
export function resolveMobileInferenceBudget(
  provider: Pick<MobileProvider, 'contextTokens' | 'maxOutputTokens'>,
  requested: Partial<MobileInferenceBudget> = {},
): MobileInferenceBudget {
  const contextSize = requested.contextSize ?? Math.min(4096, provider.contextTokens);
  const budget = MobileInferenceBudgetSchema.parse({
    contextSize,
    maxTokens:
      requested.maxTokens ?? Math.min(1024, provider.maxOutputTokens, Math.floor(contextSize / 4)),
  });
  if (budget.contextSize > provider.contextTokens || budget.maxTokens > provider.maxOutputTokens)
    throw new Error('These token limits exceed what this on-device provider supports');
  return budget;
}
