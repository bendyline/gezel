import * as GezelCore from '@bendyline/gezel';
import type { GezelSummary, Project, ProviderName } from '@bendyline/gezel';
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
  // Use a namespace lookup so a skewed npm graph can still start and take the
  // compatibility path. A static named ESM import aborts module loading before
  // any useful recovery message or fallback can run.
  const resolveAccess = Reflect.get(GezelCore, 'resolveGezelWorkspaceAccess') as
    | ((input: typeof opts) => {
        nativeAccess: 'none' | 'read-only' | 'edit' | 'reviewed' | 'full';
        effectiveWritable: boolean;
      })
    | undefined;
  if (resolveAccess) {
    const access = resolveAccess(opts);
    if (access.nativeAccess === 'reviewed') return 'reviewed edits';
    if (access.nativeAccess === 'full') return 'full access';
    return access.effectiveWritable ? 'editable' : 'read-only';
  }

  // @bendyline/gezel-cli@1.0.1 was accidentally published against core
  // 1.0.0, before the shared resolver existed. Keep the earlier calculation
  // as a narrow compatibility path; current aligned releases use the shared
  // resolver above.
  const { provider, project, gezel, config } = opts;
  if (provider === 'codex-cli') {
    const mode = GezelCore.normalizeCodexPermissionMode(
      project?.codexPermissionMode ??
        gezel?.codexPermissionMode ??
        gezel?.claudePermissionMode ??
        config?.codexCli?.defaultPermissionMode,
    );
    if (mode === 'plan') return 'read-only';
    if (mode === 'reviewed') return 'reviewed edits';
    if (mode === 'full') return 'full access';
    return 'editable';
  }
  if (provider === 'anthropic-cli') {
    const mode =
      project?.claudePermissionMode ??
      gezel?.claudePermissionMode ??
      config?.anthropicCli?.defaultPermissionMode ??
      'acceptEdits';
    if (mode === 'plan') return 'read-only';
    if (mode === 'bypassPermissions') return 'full access';
    return 'editable';
  }
  if (
    provider === 'copilot' &&
    !GezelCore.resolveSandboxCopilot(config?.sandboxCopilot, gezel?.sandboxCopilot)
  ) {
    return 'editable';
  }
  return GezelCore.projectWorkspaceWritable(project) ? 'editable' : 'read-only';
}
