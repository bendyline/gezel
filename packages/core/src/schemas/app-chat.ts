import { z } from 'zod';

/** Request-local inference metadata, deliberately excluding model/private text. */
export const AppChatProgressSchema = z
  .object({
    phase: z.enum(['starting', 'queued', 'loading_model', 'prefill', 'reasoning', 'generating']),
    percent: z.number().finite().min(0).max(100).nullable(),
    outputTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
    tokensPerSecond: z.number().finite().min(0).max(10_000_000).nullable(),
  })
  .strict()
  .refine(
    (value) =>
      value.percent === null || value.phase === 'prefill' || value.phase === 'loading_model',
    'Only loading and prefill have measurable percentage progress',
  );

export type AppChatProgress = z.infer<typeof AppChatProgressSchema>;
