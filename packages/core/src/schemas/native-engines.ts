import { z } from 'zod';

/** Native executables published in a `native-v*` release and downloadable at runtime. */
export const NativeEngineNameSchema = z.enum([
  'llama-server',
  'ds4-server',
  'sd-server',
  'whisper-server',
  'uv',
  'duckdb',
]);
export type NativeEngineName = z.infer<typeof NativeEngineNameSchema>;

/** Progress emitted while a verified native release archive is resolved. */
export const NativeEngineResolveEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('progress'),
    bytesWritten: z.number().nonnegative(),
    totalBytes: z.number().nonnegative(),
  }),
  z.object({
    type: z.literal('retrying'),
    attempt: z.number().int().positive(),
    maxAttempts: z.number().int().positive(),
    delayMs: z.number().nonnegative(),
    reason: z.string(),
  }),
  z.object({
    type: z.literal('verifying'),
    what: z.enum(['sha256', 'signature']),
  }),
  z.object({
    type: z.literal('done'),
    binPath: z.string(),
    cached: z.boolean(),
  }),
  z.object({
    type: z.literal('error'),
    error: z.string(),
  }),
]);
export type NativeEngineResolveEvent = z.infer<typeof NativeEngineResolveEventSchema>;

export const NativeEngineInstallStatusSchema = z.object({
  name: NativeEngineNameSchema,
  installed: z.boolean(),
  path: z.string().optional(),
});
export type NativeEngineInstallStatus = z.infer<typeof NativeEngineInstallStatusSchema>;

/**
 * The daemon's view of the source-pinned native toolkit. `installed` means
 * the executable is available to this running daemon, not merely that an
 * archive download is in flight.
 */
export const NativeEngineStatusResponseSchema = z.object({
  release: z.string(),
  pinned: z.boolean(),
  platformKey: z.string().nullable(),
  llamaBackend: z.enum(['cuda', 'vulkan', 'metal', 'cpu']).optional(),
  engines: z.array(NativeEngineInstallStatusSchema),
});
export type NativeEngineStatusResponse = z.infer<typeof NativeEngineStatusResponseSchema>;
