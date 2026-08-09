import { z } from 'zod';

/** User-facing Codex execution postures, ordered from least to most authority. */
export const CodexPermissionModeSchema = z.enum(['plan', 'edit', 'reviewed', 'full']);
export type CodexPermissionMode = z.infer<typeof CodexPermissionModeSchema>;

/**
 * Values written by Gezel before the Codex-specific four-mode control landed.
 * Keep accepting them at read/API boundaries so existing config and gezel files
 * upgrade without a migration pass.
 */
export const LegacyCodexPermissionModeSchema = z.enum([
  'default',
  'acceptEdits',
  'bypassPermissions',
]);
export type LegacyCodexPermissionMode = z.infer<typeof LegacyCodexPermissionModeSchema>;

export const CodexPermissionModeCompatSchema = z.union([
  CodexPermissionModeSchema,
  LegacyCodexPermissionModeSchema,
]);
export type CodexPermissionModeCompat = z.infer<typeof CodexPermissionModeCompatSchema>;

/** Translate persisted legacy names onto the current four-state vocabulary. */
export function normalizeCodexPermissionMode(
  mode: CodexPermissionModeCompat | undefined,
): CodexPermissionMode {
  switch (mode) {
    case 'plan':
      return 'plan';
    case 'reviewed':
      return 'reviewed';
    case 'full':
    case 'bypassPermissions':
      return 'full';
    case 'edit':
    case 'default':
    case 'acceptEdits':
    case undefined:
      return 'edit';
  }
}
