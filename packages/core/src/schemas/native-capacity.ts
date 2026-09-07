import { z } from 'zod';

const id = z.string().uuid();
const bytes = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const pid = z.number().int().positive().max(2_147_483_647);

/** Inference-only coordination. Contains no paths, prompts, or executable commands. */
export const NativeCapacityCommandSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('acquire'),
      id,
      ownerPid: pid,
      label: z.string().min(1).max(160),
      bytes: bytes.positive(),
      gpuBytes: bytes,
      exclusive: z.boolean().default(false),
      priority: z.enum(['interactive', 'background']).default('interactive'),
    })
    .strict(),
  z.object({ action: z.literal('bind'), id, childPid: pid }).strict(),
  z.object({ action: z.enum(['ready', 'release', 'status']), id }).strict(),
]);
export type NativeCapacityCommand = z.infer<typeof NativeCapacityCommandSchema>;

export const NativeCapacityReplySchema = z.object({
  state: z.enum(['waiting', 'granted', 'released']),
  releaseRequested: z.boolean(),
  reason: z.string().optional(),
});
export type NativeCapacityReply = z.infer<typeof NativeCapacityReplySchema>;
