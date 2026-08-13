import {
  type GezelSummary,
  type Project,
  type ProviderName,
  resolveGezelWorkspaceAccess,
} from '@bendyline/gezel';
import type { ConfigResponse } from '@bendyline/gezel-client/node';

export type ActiveAccessMode = 'read-only' | 'editable' | 'reviewed edits' | 'full access';

type AccessProject = Pick<
  Project,
  | 'workingDir'
  | 'managedWorkspaceWritePolicy'
  | 'allowGezelWrites'
  | 'codexPermissionMode'
  | 'claudePermissionMode'
>;
type AccessConfig = Pick<ConfigResponse, 'sandboxCopilot' | 'anthropicCli' | 'codexCli'>;

/**
 * Compact, effective workspace-access label for the TUI status row.
 * Provider-native file access wins over the ordinary project MCP write gate,
 * matching the desktop project's editability calculation.
 */
export function activeAccessMode(opts: {
  provider: ProviderName | undefined;
  project: AccessProject | null | undefined;
  gezel: GezelSummary | undefined;
  config: AccessConfig | null | undefined;
}): ActiveAccessMode {
  const access = resolveGezelWorkspaceAccess(opts);
  if (access.nativeAccess === 'reviewed') return 'reviewed edits';
  if (access.nativeAccess === 'full') return 'full access';
  return access.effectiveWritable ? 'editable' : 'read-only';
}
