import { z } from 'zod';

/** OS-managed capabilities, separate from what Gezel's adapter exposes. */
export const AppleModelCapabilitiesSchema = z.object({
  tools: z.boolean(),
  guidedGeneration: z.boolean(),
  vision: z.boolean(),
  reasoning: z.boolean(),
});

export const AppleFoundationModelsHelloSchema = z.object({
  version: z.string().min(1),
  os: z.string().min(1),
  available: z.boolean(),
  reason: z.string().optional(),
  contextTokens: z.number().int().min(512),
  maxOutputTokens: z.number().int().positive(),
  supportsTokenUsage: z.boolean().optional(),
  modelCapabilities: AppleModelCapabilitiesSchema.optional(),
});
export type AppleFoundationModelsHello = z.infer<typeof AppleFoundationModelsHelloSchema>;

/** A live user-session probe; installed alone never means ready. */
export const AppleFoundationModelsStatusSchema = z.object({
  supported: z.boolean(),
  installed: z.boolean(),
  available: z.boolean(),
  reason: z.string().optional(),
  runtime: AppleFoundationModelsHelloSchema.optional(),
});
export type AppleFoundationModelsStatus = z.infer<typeof AppleFoundationModelsStatusSchema>;

/** OS 27 reports complete generation usage, including native tool traffic. */
export const AppleFoundationModelsUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
});
export type AppleFoundationModelsUsage = z.infer<typeof AppleFoundationModelsUsageSchema>;
