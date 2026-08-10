import { z } from 'zod';

/** A local inference model that can safely sit behind Codex's tool loop. */
export const CodexSetupModelOptionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
  provider: z.string().min(1),
  contextWindow: z.number().int().positive().optional(),
  supportsReasoning: z.boolean().optional(),
  supportsTools: z.boolean().optional(),
});
export type CodexSetupModelOption = z.infer<typeof CodexSetupModelOptionSchema>;

export const CodexSetupStateSchema = z.enum([
  'not-configured',
  'configured',
  'update-needed',
  'conflict',
  'unavailable',
]);
export type CodexSetupState = z.infer<typeof CodexSetupStateSchema>;

/**
 * First-party Settings status for the Gezel-owned Codex profile and its
 * authenticated loopback inference bridge. Secrets are intentionally absent.
 */
export const CodexSetupStatusResponseSchema = z.object({
  state: CodexSetupStateSchema,
  models: z.array(CodexSetupModelOptionSchema),
  configuredModel: z.string().optional(),
  recommendedModel: z.string().optional(),
  reasons: z.array(z.string()),
  message: z.string().optional(),
  codexInstalled: z.boolean(),
  codexVersion: z.string().optional(),
  codexPath: z.string().optional(),
  endpointsEnabled: z.boolean(),
  profileName: z.string().min(1),
  profilePath: z.string().min(1),
  launchCommand: z.string().min(1),
  bridge: z.object({
    baseUrl: z.string().url(),
    listening: z.boolean(),
    port: z.number().int().nonnegative(),
  }),
  canConfigure: z.boolean(),
  /** Whether Gezel-owned credential/state material exists and can be safely removed. */
  canRemove: z.boolean(),
});
export type CodexSetupStatusResponse = z.infer<typeof CodexSetupStatusResponseSchema>;

export const ConfigureCodexRequestSchema = z.object({
  model: z.string().min(1),
});
export type ConfigureCodexRequest = z.infer<typeof ConfigureCodexRequestSchema>;
