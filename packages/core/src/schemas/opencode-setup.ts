import { z } from 'zod';
import {
  LocalHarnessModelOptionSchema,
  LocalHarnessSetupStateSchema,
  LocalHarnessStatusBaseSchema,
} from './local-harness.js';

/** A gezel or raw local model that can safely sit behind OpenCode's tool loop. */
export const OpenCodeSetupModelOptionSchema = LocalHarnessModelOptionSchema;
export type OpenCodeSetupModelOption = z.infer<typeof OpenCodeSetupModelOptionSchema>;

export const OpenCodeSetupStateSchema = LocalHarnessSetupStateSchema;
export type OpenCodeSetupState = z.infer<typeof OpenCodeSetupStateSchema>;

export const OpenCodeSetupPluginStateSchema = z.enum([
  'not-installed',
  'installed',
  /** Installed and Gezel-owned, but its contents no longer match this install. */
  'stale',
  /** A file of the same name exists that this Gezel install did not write. */
  'conflict',
  /** OpenCode is not installed here, so there is nowhere to put the plugin. */
  'unsupported',
]);
export type OpenCodeSetupPluginState = z.infer<typeof OpenCodeSetupPluginStateSchema>;

/**
 * The optional plugin Gezel writes into OpenCode's own config directory so a
 * bare `opencode` offers the crew without the launch command. It is the one
 * artifact Gezel places outside its own home, so it carries an ownership
 * marker and is never overwritten or deleted unless this install wrote it.
 */
export const OpenCodeSetupPluginSchema = z.object({
  state: OpenCodeSetupPluginStateSchema,
  /** Absent only when OpenCode's config directory could not be resolved. */
  path: z.string().min(1).optional(),
  canInstall: z.boolean(),
  canRemove: z.boolean(),
  /** Whether a foreign file may be backed up and replaced. */
  canReplace: z.boolean(),
  message: z.string().optional(),
});
export type OpenCodeSetupPlugin = z.infer<typeof OpenCodeSetupPluginSchema>;

/**
 * First-party Settings status for the Gezel-owned OpenCode config file and its
 * authenticated loopback inference bridge. Secrets are intentionally absent —
 * the managed config references the credential by path, never by value.
 */
export const OpenCodeSetupStatusResponseSchema = LocalHarnessStatusBaseSchema.extend({
  opencodeInstalled: z.boolean(),
  opencodeVersion: z.string().optional(),
  opencodePath: z.string().optional(),
  /** Provider key written into the managed config; also the `<provider>/<model>` prefix. */
  providerId: z.string().min(1),
  /** The Gezel-owned config file. Never the user's own `opencode.json`. */
  configPath: z.string().min(1),
  plugin: OpenCodeSetupPluginSchema,
  /**
   * Where a conflicting config was preserved. Present only on the response of
   * the repairing request that moved it.
   */
  configBackupPath: z.string().min(1).optional(),
  /**
   * Where a conflicting plugin file was preserved. Present only on the
   * response of the replacing request that moved it.
   */
  pluginBackupPath: z.string().min(1).optional(),
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

export const InstallOpenCodePluginRequestSchema = z.object({
  /**
   * Copy a conflicting plugin file to a `.backup` sibling and replace it.
   * Rejected unless the status reports `plugin.canReplace`.
   */
  backupConflictingPlugin: z.boolean().optional(),
});
export type InstallOpenCodePluginRequest = z.infer<typeof InstallOpenCodePluginRequestSchema>;
