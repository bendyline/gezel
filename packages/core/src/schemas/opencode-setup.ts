import { z } from 'zod';
import {
  LocalHarnessBridgeSchema,
  LocalHarnessModelOptionSchema,
  LocalHarnessSetupStateSchema,
} from './local-harness.js';

/** A gezel or raw local model that can safely sit behind OpenCode's tool loop. */
export const OpenCodeSetupModelOptionSchema = LocalHarnessModelOptionSchema;
export type OpenCodeSetupModelOption = z.infer<typeof OpenCodeSetupModelOptionSchema>;

export const OpenCodeSetupStateSchema = LocalHarnessSetupStateSchema;
export type OpenCodeSetupState = z.infer<typeof OpenCodeSetupStateSchema>;

/**
 * First-party Settings status for the Gezel-owned OpenCode config file and its
 * authenticated loopback inference bridge. Secrets are intentionally absent —
 * the managed config references the credential by path, never by value.
 */
export const OpenCodeSetupStatusResponseSchema = z.object({
  state: OpenCodeSetupStateSchema,
  models: z.array(OpenCodeSetupModelOptionSchema),
  configuredModel: z.string().optional(),
  recommendedModel: z.string().optional(),
  reasons: z.array(z.string()),
  message: z.string().optional(),
  opencodeInstalled: z.boolean(),
  opencodeVersion: z.string().optional(),
  opencodePath: z.string().optional(),
  endpointsEnabled: z.boolean(),
  /** Provider key written into the managed config; also the `<provider>/<model>` prefix. */
  providerId: z.string().min(1),
  /** The Gezel-owned config file. Never the user's own `opencode.json`. */
  configPath: z.string().min(1),
  launchCommand: z.string().min(1),
  bridge: LocalHarnessBridgeSchema,
  canConfigure: z.boolean(),
  /** Whether Gezel-owned credential/state material exists and can be safely removed. */
  canRemove: z.boolean(),
  /**
   * Whether a `conflict` can be resolved by backing the foreign config up and
   * republishing a managed one. False for a credential conflict, which belongs
   * to another app and is only the user's to revoke.
   */
  canRepair: z.boolean(),
  /**
   * Where a conflicting config was preserved. Present only on the response of
   * the repairing request that moved it.
   */
  configBackupPath: z.string().min(1).optional(),
});
export type OpenCodeSetupStatusResponse = z.infer<typeof OpenCodeSetupStatusResponseSchema>;

export const ConfigureOpenCodeRequestSchema = z.object({
  model: z.string().min(1),
  /**
   * Copy a conflicting managed config to a `.backup` sibling and replace it.
   * Rejected unless the status reports `canRepair`.
   */
  backupConflictingConfig: z.boolean().optional(),
});
export type ConfigureOpenCodeRequest = z.infer<typeof ConfigureOpenCodeRequestSchema>;
