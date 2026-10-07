/** Explicit CLI settings needed by unattended project workflows. */
import {
  type SecurityLevel,
  type SecurityPolicy,
  classifySecurityLevel,
  resolveSecurityPolicy,
} from '@bendyline/gezel';
import type { GezelClient } from '@bendyline/gezel-client';
import type { Command } from 'commander';
import { CliError } from './connection.js';

/** The names Settings → Security & Compliance shows for each level. */
export const SECURITY_LEVEL_LABELS: Record<SecurityLevel, string> = {
  'super-lockdown': 'Super Lockdown',
  lockdown: 'Lockdown',
  free: 'Unrestricted',
  custom: 'Custom',
};

/**
 * The stored policy with External services switched, labelled with the
 * preset it now matches — Lockdown plus External services IS Unrestricted,
 * and the person should be told so rather than see "Custom".
 */
export function policyWithExternalServices(
  config: Parameters<typeof resolveSecurityPolicy>[0],
  enabled: boolean,
): SecurityPolicy {
  const current = resolveSecurityPolicy(config);
  const caps = {
    allowFileEdits: current.allowFileEdits,
    allowExternalChat: current.allowExternalChat,
    allowExternalServices: enabled,
    allowScriptExecution: current.allowScriptExecution,
    allowAppNetwork: current.allowAppNetwork,
  };
  return { level: classifySecurityLevel(caps), ...caps };
}

function enabledValue(state: string | undefined): boolean | undefined {
  if (state === undefined) return undefined;
  if (state === 'on') return true;
  if (state === 'off') return false;
  throw new CliError('Use on or off.');
}

export function registerSecurityCommands(
  program: Command,
  connect: () => Promise<Pick<GezelClient, 'getConfig' | 'updateConfig'>>,
): void {
  program
    .command('security')
    .description('Inspect or explicitly change security settings')
    .command('external-services [state]')
    .description('Show or set on/off for model-initiated external services, including web search')
    .option('--json', 'Output the setting as JSON')
    .action(async (state: string | undefined, options: { json?: boolean }) => {
      const enabled = enabledValue(state);
      const client = await connect();
      const config = await client.getConfig();
      const policy = resolveSecurityPolicy(config);
      if (enabled !== undefined) {
        await client.updateConfig({ securityPolicy: policyWithExternalServices(config, enabled) });
      }
      const result = { allowExternalServices: enabled ?? policy.allowExternalServices };
      console.log(
        options.json
          ? JSON.stringify(result)
          : `External services: ${result.allowExternalServices ? 'on' : 'off'}`,
      );
    });
}

export function registerProjectSettingsCommands(
  env: Command,
  connect: () => Promise<GezelClient>,
  projectFor: (client: GezelClient) => Promise<string>,
): void {
  env
    .command('indexing [state]')
    .description('Show or set on/off for background workspace indexing in the current project')
    .option('--json', 'Output the project setting as JSON')
    .action(async (state: string | undefined, options: { json?: boolean }) => {
      const enabled = enabledValue(state);
      const client = await connect();
      const projectId = await projectFor(client);
      const project =
        enabled === undefined
          ? await client.getProject(projectId)
          : await client.updateProject(projectId, { indexingEnabled: enabled });
      const result = { projectId, indexingEnabled: project.indexingEnabled !== false };
      console.log(
        options.json
          ? JSON.stringify(result)
          : `${projectId}: workspace indexing ${result.indexingEnabled ? 'on' : 'off'}`,
      );
    });
}
