/** Explicit CLI settings needed by unattended project workflows. */
import { resolveSecurityPolicy } from '@bendyline/gezel';
import type { GezelClient } from '@bendyline/gezel-client';
import type { Command } from 'commander';
import { CliError } from './connection.js';

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
      const policy = resolveSecurityPolicy(await client.getConfig());
      if (enabled !== undefined) {
        await client.updateConfig({
          securityPolicy: { ...policy, level: 'custom', allowExternalServices: enabled },
        });
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
