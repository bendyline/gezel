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
  /**
   * Set when the request fits the device budget and leads the queue, but no
   * other claim is loading or resident — so the memory standing in its way is
   * held outside this protocol and no amount of waiting here can free it.
   * Waiters use it to give up in seconds instead of burning the full
   * admission budget on a queue that will never move.
   */
  externalShortfall: z.boolean().optional(),
  /** Working set the blocked request needs; paired with `availableBytes`. */
  requiredBytes: bytes.optional(),
  /** What the host had free at the refusal, for a message that names both. */
  availableBytes: bytes.optional(),
});
export type NativeCapacityReply = z.infer<typeof NativeCapacityReplySchema>;
