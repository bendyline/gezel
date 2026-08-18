import { z } from 'zod';
import { LocalHarnessStatusBaseSchema } from './local-harness.js';

/** A VS Code profile whose built-in custom-endpoint file Gezel can manage. */
export const VSCodeSetupProfileOptionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  product: z.enum(['code', 'code-insiders']),
  configPath: z.string().min(1),
});
export type VSCodeSetupProfileOption = z.infer<typeof VSCodeSetupProfileOptionSchema>;

/**
 * Status for the extension-free VS Code integration. The credential is
 * intentionally never returned: it lives only in the selected profile's
 * `chatLanguageModels.json`, where VS Code's built-in provider reads it.
 */
export const VSCodeSetupStatusResponseSchema = LocalHarnessStatusBaseSchema.extend({
  vscodeInstalled: z.boolean(),
  vscodeVersion: z.string().optional(),
  vscodePath: z.string().optional(),
  providerId: z.string().min(1),
  profiles: z.array(VSCodeSetupProfileOptionSchema).min(1),
  configuredProfileId: z.string().min(1).optional(),
  configPath: z.string().min(1),
  configBackupPath: z.string().min(1).optional(),
});
export type VSCodeSetupStatusResponse = z.infer<typeof VSCodeSetupStatusResponseSchema>;

export const ConfigureVSCodeRequestSchema = z.object({
  profileId: z.string().min(1),
  /** Back up the profile file before replacing a conflicting Gezel entry. */
  backupConflictingConfig: z.boolean().optional(),
});
export type ConfigureVSCodeRequest = z.infer<typeof ConfigureVSCodeRequestSchema>;
