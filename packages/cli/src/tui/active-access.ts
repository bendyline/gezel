import {
  type GezelSummary,
  type Project,
  type ProviderName,
  normalizeCodexPermissionMode,
  projectWorkspaceWritable,
  resolveSandboxCopilot,
} from '@bendyline/gezel';
import type { ConfigResponse } from '@bendyline/gezel-client/node';

export type ActiveAccessMode = 'read-only' | 'editable' | 'reviewed edits' | 'full access';

type AccessProject = Pick<Project, 'workingDir' | 'allowGezelWrites' | 'codexPermissionMode'>;
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
  const { provider, project, gezel, config } = opts;

  if (provider === 'codex-cli') {
    const mode = normalizeCodexPermissionMode(
      project?.codexPermissionMode ??
        gezel?.codexPermissionMode ??
        gezel?.claudePermissionMode ??
        config?.codexCli?.defaultPermissionMode,
    );
    switch (mode) {
      case 'plan':
        return 'read-only';
      case 'edit':
        return 'editable';
      case 'reviewed':
        return 'reviewed edits';
      case 'full':
        return 'full access';
    }
  }

  if (provider === 'anthropic-cli') {
    const mode =
      gezel?.claudePermissionMode ?? config?.anthropicCli?.defaultPermissionMode ?? 'acceptEdits';
    if (mode === 'plan') return 'read-only';
    if (mode === 'bypassPermissions') return 'full access';
    return 'editable';
  }

  if (
    provider === 'copilot' &&
    !resolveSandboxCopilot(config?.sandboxCopilot, gezel?.sandboxCopilot)
  ) {
    return 'editable';
  }

  return projectWorkspaceWritable(project) ? 'editable' : 'read-only';
}
