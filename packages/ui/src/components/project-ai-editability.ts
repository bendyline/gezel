import {
  type CodexPermissionMode,
  type GezelConfig,
  type GezelSummary,
  type Project,
  type ProviderName,
  normalizeCodexPermissionMode,
  resolveSandboxCopilot,
} from '@bendyline/gezel';

type ClaudePermissionMode = NonNullable<GezelSummary['claudePermissionMode']>;

/** Config fields that determine whether a provider can bypass the project write switch. */
export type AiProviderEditabilityConfig = Pick<
  GezelConfig,
  'provider' | 'sandboxCopilot' | 'anthropicCli' | 'codexCli'
>;

function claudePermissionMode(
  gezel: GezelSummary | undefined,
  config: AiProviderEditabilityConfig | null | undefined,
): ClaudePermissionMode {
  return (
    gezel?.claudePermissionMode ?? config?.anthropicCli?.defaultPermissionMode ?? 'acceptEdits'
  );
}

function codexPermissionMode(
  projectMode: CodexPermissionMode | undefined,
  gezel: GezelSummary | undefined,
  config: AiProviderEditabilityConfig | null | undefined,
): CodexPermissionMode {
  return normalizeCodexPermissionMode(
    projectMode ??
      gezel?.codexPermissionMode ??
      // Compatibility for gezels written before the Codex-specific field.
      gezel?.claudePermissionMode ??
      config?.codexCli?.defaultPermissionMode,
  );
}

/**
 * Whether this effective provider has a direct file-editing path outside
 * Gezel's project-scoped MCP write gate.
 */
function providerCanEditOutsideProjectGate(
  provider: ProviderName,
  gezel: GezelSummary | undefined,
  config: AiProviderEditabilityConfig | null | undefined,
  projectCodexMode?: CodexPermissionMode,
): boolean {
  if (provider === 'codex-cli') {
    return codexPermissionMode(projectCodexMode, gezel, config) !== 'plan';
  }
  if (provider === 'anthropic-cli') {
    return claudePermissionMode(gezel, config) !== 'plan';
  }
  if (provider === 'copilot') {
    return !resolveSandboxCopilot(config?.sandboxCopilot, gezel?.sandboxCopilot);
  }
  return false;
}

/**
 * Project-level indicator for providers whose own harness can edit the
 * workspace without passing through `project.allowGezelWrites`.
 *
 * The install default counts because every gezel without an override inherits
 * it. Explicitly assigned global gezels and project-local gezels are checked
 * as well, including their per-gezel Copilot/CLI permission overrides.
 */
export function projectEditableViaAiProvider(
  project: Pick<Project, 'gezelIds' | 'voormanGezelId' | 'codexPermissionMode'>,
  globalGezels: readonly GezelSummary[],
  projectLocalGezels: readonly GezelSummary[],
  config: AiProviderEditabilityConfig | null | undefined,
): boolean {
  const defaultProvider = config?.provider ?? 'copilot';
  if (
    providerCanEditOutsideProjectGate(
      defaultProvider,
      undefined,
      config,
      project.codexPermissionMode,
    )
  )
    return true;

  const projectGezelIds = new Set(project.gezelIds ?? []);
  if (project.voormanGezelId) projectGezelIds.add(project.voormanGezelId);
  const projectGezels = [
    ...globalGezels.filter((gezel) => projectGezelIds.has(gezel.id)),
    ...projectLocalGezels,
  ];

  return projectGezels.some((gezel) => {
    if (gezel.fixedFunction) return false;
    const provider = gezel.provider ?? defaultProvider;
    return providerCanEditOutsideProjectGate(provider, gezel, config, project.codexPermissionMode);
  });
}

/** Whether this project can start at least one ordinary Codex-backed gezel. */
export function projectUsesCodex(
  project: Pick<Project, 'gezelIds' | 'voormanGezelId'>,
  globalGezels: readonly GezelSummary[],
  projectLocalGezels: readonly GezelSummary[],
  config: AiProviderEditabilityConfig | null | undefined,
): boolean {
  const defaultProvider = config?.provider ?? 'copilot';
  if (defaultProvider === 'codex-cli') return true;

  const projectGezelIds = new Set(project.gezelIds ?? []);
  if (project.voormanGezelId) projectGezelIds.add(project.voormanGezelId);
  return [...globalGezels.filter((gezel) => projectGezelIds.has(gezel.id)), ...projectLocalGezels]
    .filter((gezel) => !gezel.fixedFunction)
    .some((gezel) => (gezel.provider ?? defaultProvider) === 'codex-cli');
}
