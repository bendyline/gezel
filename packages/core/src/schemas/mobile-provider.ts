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

export const MobileModelSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-zA-Z0-9_-]+$/),
    name: z.string().min(1).max(200),
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
