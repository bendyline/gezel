import {
  type ClaudePermissionMode,
  type GezelConfig,
  type GezelSummary,
  type Project,
  projectManagedWorkspaceWritable,
  providerNativeWorkspaceAccess,
} from '@bendyline/gezel';

/** Config fields that determine managed and provider-native workspace access. */
export type AiProviderEditabilityConfig = Pick<
  GezelConfig,
  'provider' | 'sandboxCopilot' | 'anthropicCli' | 'codexCli'
>;

type ProjectProviderFields = Pick<
  Project,
  'gezelIds' | 'voormanGezelId' | 'codexPermissionMode' | 'claudePermissionMode'
>;

function projectProviderCandidates(
  project: Pick<Project, 'gezelIds' | 'voormanGezelId'>,
  globalGezels: readonly GezelSummary[],
  projectLocalGezels: readonly GezelSummary[],
  config: AiProviderEditabilityConfig | null | undefined,
): Array<{ provider: GezelSummary['provider']; gezel?: GezelSummary }> {
  const defaultProvider = config?.provider ?? 'copilot';
  const projectGezelIds = new Set(project.gezelIds ?? []);
  if (project.voormanGezelId) projectGezelIds.add(project.voormanGezelId);
  const projectGezels = [
    ...globalGezels.filter((gezel) => projectGezelIds.has(gezel.id)),
    ...projectLocalGezels,
  ].filter((gezel) => !gezel.fixedFunction);
  return [
    { provider: defaultProvider },
    ...projectGezels.map((gezel) => ({ provider: gezel.provider ?? defaultProvider, gezel })),
  ];
}

function projectProviderAccessSummary(
  project: ProjectProviderFields,
  globalGezels: readonly GezelSummary[],
  projectLocalGezels: readonly GezelSummary[],
  config: AiProviderEditabilityConfig | null | undefined,
): { nativeWritable: boolean; managedSurfaceAvailable: boolean } {
  const candidates = projectProviderCandidates(project, globalGezels, projectLocalGezels, config);
  let nativeWritable = false;
  let managedSurfaceAvailable = false;
  for (const candidate of candidates) {
    const nativeAccess = providerNativeWorkspaceAccess({
      provider: candidate.provider,
      projectCodexMode: project.codexPermissionMode,
      projectClaudeMode: project.claudePermissionMode,
      gezel: candidate.gezel,
      config,
    });
    if (nativeAccess === 'none') managedSurfaceAvailable = true;
    if (nativeAccess === 'edit' || nativeAccess === 'reviewed' || nativeAccess === 'full') {
      nativeWritable = true;
    }
  }
  return { nativeWritable, managedSurfaceAvailable };
}

/**
 * Project-level indicator for providers whose own harness can edit the
 * workspace without passing through Gezel's managed workspace-write policy.
 *
 * The install default counts because every gezel without an override inherits
 * it. Explicitly assigned global gezels and project-local gezels are checked
 * as well, including their per-gezel Copilot/CLI permission overrides.
 */
export function projectNativeWorkspaceWritable(
  project: ProjectProviderFields,
  globalGezels: readonly GezelSummary[],
  projectLocalGezels: readonly GezelSummary[],
  config: AiProviderEditabilityConfig | null | undefined,
): boolean {
  return projectProviderAccessSummary(project, globalGezels, projectLocalGezels, config)
    .nativeWritable;
}

/** @deprecated Use `projectNativeWorkspaceWritable`. */
export const projectEditableViaAiProvider = projectNativeWorkspaceWritable;

export interface ResolvedProjectWorkspaceAccess {
  managedWritable: boolean;
  nativeWritable: boolean;
  effectiveWritable: boolean;
}

/** Resolve the project-wide editability summary consumed by shared project chrome. */
export function resolveProjectWorkspaceAccess(
  project: Pick<
    Project,
    | 'workingDir'
    | 'managedWorkspaceWritePolicy'
    | 'allowGezelWrites'
    | 'gezelIds'
    | 'voormanGezelId'
    | 'codexPermissionMode'
    | 'claudePermissionMode'
  >,
  globalGezels: readonly GezelSummary[],
  projectLocalGezels: readonly GezelSummary[],
  config: AiProviderEditabilityConfig | null | undefined,
): ResolvedProjectWorkspaceAccess {
  const managedWritable = projectManagedWorkspaceWritable(project);
  const { nativeWritable, managedSurfaceAvailable } = projectProviderAccessSummary(
    project,
    globalGezels,
    projectLocalGezels,
    config,
  );
  return {
    managedWritable,
    nativeWritable,
    effectiveWritable: nativeWritable || (managedWritable && managedSurfaceAvailable),
  };
}

/** Whether this project can start at least one ordinary Codex-backed gezel. */
export function projectUsesCodex(
  project: Pick<Project, 'gezelIds' | 'voormanGezelId'>,
  globalGezels: readonly GezelSummary[],
  projectLocalGezels: readonly GezelSummary[],
  config: AiProviderEditabilityConfig | null | undefined,
): boolean {
  return projectProviderCandidates(project, globalGezels, projectLocalGezels, config).some(
    (candidate) => candidate.provider === 'codex-cli',
  );
}

/** Whether this project can start at least one ordinary Claude CLI-backed gezel. */
export function projectUsesClaude(
  project: Pick<Project, 'gezelIds' | 'voormanGezelId'>,
  globalGezels: readonly GezelSummary[],
  projectLocalGezels: readonly GezelSummary[],
  config: AiProviderEditabilityConfig | null | undefined,
): boolean {
  return projectProviderCandidates(project, globalGezels, projectLocalGezels, config).some(
    (candidate) => candidate.provider === 'anthropic-cli',
  );
}

export type ProjectClaudePermissionMode = ClaudePermissionMode | 'mixed';

/** Resolve the Claude posture represented by the project control. */
export function resolveProjectClaudePermissionMode(
  project: Pick<Project, 'gezelIds' | 'voormanGezelId' | 'claudePermissionMode'>,
  globalGezels: readonly GezelSummary[],
  projectLocalGezels: readonly GezelSummary[],
  config: AiProviderEditabilityConfig | null | undefined,
): ProjectClaudePermissionMode {
  if (project.claudePermissionMode) return project.claudePermissionMode;
  const modes = new Set(
    projectProviderCandidates(project, globalGezels, projectLocalGezels, config)
      .filter((candidate) => candidate.provider === 'anthropic-cli')
      .map(
        (candidate) =>
          candidate.gezel?.claudePermissionMode ??
          config?.anthropicCli?.defaultPermissionMode ??
          'acceptEdits',
      ),
  );
  if (modes.size > 1) return 'mixed';
  return modes.values().next().value ?? 'acceptEdits';
}
