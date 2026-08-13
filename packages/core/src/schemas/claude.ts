import { z } from 'zod';

/** Permission modes accepted by the Claude CLI `--permission-mode` flag. */
export const ClaudePermissionModeSchema = z.enum([
  'default',
  'acceptEdits',
  'plan',
  'bypassPermissions',
]);
export type ClaudePermissionMode = z.infer<typeof ClaudePermissionModeSchema>;
