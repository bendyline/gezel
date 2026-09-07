import { z } from 'zod';

export const LlamaCppLoadModeSchema = z.enum([
  'auto',
  'none',
  'mmap',
  'mlock',
  'mmap+mlock',
  'dio',
]);

export const LlamaCppLazyModeSchema = z.enum(['on', 'auto', 'off']);

/** llama.cpp v0.4 settings shared by the persisted config and its API schema. */
export const LlamaCppV4ConfigSchema = z.object({
  /**
   * Model file loading policy (`--load-mode`). Unset leaves the server on
   * Auto; the legacy `llamaCppMlock: true` setting maps to `mlock`.
   */
  llamaCppLoadMode: LlamaCppLoadModeSchema.optional(),
  /** On-demand loading for large row-addressable tensors (`--lazy-mode`). */
  llamaCppLazyMode: LlamaCppLazyModeSchema.optional(),
  /** Preserve and replay private reasoning across assistant history. */
  llamaCppReasoningPreserve: z.boolean().optional(),
  /**
   * Keep dense FFN weights from the first N blocks in RAM. Unset delegates
   * to the hardware planner; zero explicitly disables automatic planning.
   */
  llamaCppNCpuFfn: z.number().int().min(0).optional(),
});

/** Nullable variants used by Settings to restore each value to Auto/default. */
export const LlamaCppV4ConfigResetSchema = z.object({
  llamaCppMlock: z.boolean().nullable().optional(),
  llamaCppLoadMode: LlamaCppLoadModeSchema.nullable().optional(),
  llamaCppLazyMode: LlamaCppLazyModeSchema.nullable().optional(),
  llamaCppReasoningPreserve: z.boolean().nullable().optional(),
  llamaCppNCpuFfn: z.number().int().min(0).nullable().optional(),
});
