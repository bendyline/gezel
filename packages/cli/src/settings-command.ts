/** Explicit CLI settings needed by unattended project workflows. */
import {
  type SecurityCapabilities,
  type SecurityLevel,
  type SecurityPolicy,
  type SecurityPresetLevel,
  classifySecurityLevel,
  resolveSecurityPolicy,
  securityCapabilitiesOf,
  securityPolicyForLevel,
} from '@bendyline/gezel';
import type { GezelClient } from '@bendyline/gezel-client';
import type { Command } from 'commander';
import { CliError } from './connection.js';

/** The names Settings → Security & compliance shows for each level. */
export const SECURITY_LEVEL_LABELS: Record<SecurityLevel, string> = {
  'super-lockdown': 'Super Lockdown',
  lockdown: 'Lockdown',
  free: 'Unrestricted',
  custom: 'Custom',
};

/**
 * The stored policy with one capability switched, labelled with the preset
 * it now matches — switching on the last capability Lockdown lacks IS
 * Unrestricted, and the person should be told so rather than see "Custom".
 */
export function policyWithCapability(
  config: Parameters<typeof resolveSecurityPolicy>[0],
  key: keyof SecurityCapabilities,
  enabled: boolean,
): SecurityPolicy {
  const caps = { ...securityCapabilitiesOf(resolveSecurityPolicy(config)), [key]: enabled };
  return { level: classifySecurityLevel(caps), ...caps };
}

/** The stored policy with External services switched. */
export function policyWithExternalServices(
  config: Parameters<typeof resolveSecurityPolicy>[0],
  enabled: boolean,
): SecurityPolicy {
  return policyWithCapability(config, 'allowExternalServices', enabled);
}

/** The switches `gezel security` exposes, by subcommand. */
const SECURITY_SWITCHES: ReadonlyArray<{
  command: string;
  key: keyof SecurityCapabilities;
  label: string;
  description: string;
}> = [
  {
    command: 'external-services',
    key: 'allowExternalServices',
    label: 'External services',
    description: 'Show or set on/off for model-initiated external services, including web search',
  },
  {
    command: 'run-package-scripts',
    key: 'allowPackageScriptExecution',
    label: 'Run package scripts',
    description:
      'Show or set on/off for Gezel running package scripts and installed package binaries (outside the sandbox, with network access)',
  },
  {
    command: 'edit-package-scripts',
    key: 'allowPackageScriptEdits',
    label: 'Edit package scripts',
    description: 'Show or set on/off for Gezel adding or changing the scripts in package.json',
  },
];

/** What each capability lets happen, in the words `gezel security level` prints. */
const CAPABILITY_LABELS: ReadonlyArray<[keyof SecurityCapabilities, string]> = [
  ['allowExternalChat', 'Cloud models'],
  ['allowFileEdits', 'File edits and the model’s Git tools'],
  ['allowScriptExecution', 'Sandboxed scripts'],
  ['allowAppNetwork', 'Update checks and the connector syncs you start'],
  ['allowExternalServices', 'Web search, mail and other outside services'],
  ['allowPackageScriptExecution', 'Run package scripts'],
  ['allowPackageScriptEdits', 'Edit package scripts'],
];

/** Accepted names for each preset; `unrestricted` is the name Settings shows for `free`. */
const LEVEL_ALIASES: Readonly<Record<string, SecurityPresetLevel>> = {
  'super-lockdown': 'super-lockdown',
  superlockdown: 'super-lockdown',
  lockdown: 'lockdown',
  free: 'free',
  unrestricted: 'free',
};

/** Parse a preset name, or explain the choices. */
export function parseSecurityLevel(input: string): SecurityPresetLevel {
  const level = LEVEL_ALIASES[input.trim().toLowerCase()];
  if (!level) {
    throw new CliError(
      `Unknown security level "${input}". Choose super-lockdown, lockdown, or free (shown as Unrestricted in Settings).`,
    );
  }
  return level;
}

/** The level and every capability it allows, one per line. */
export function describeSecurityLevel(policy: SecurityPolicy): string[] {
  const caps = securityCapabilitiesOf(resolveSecurityPolicy({ securityPolicy: policy }));
  const level = classifySecurityLevel(caps);
  const width = Math.max(...CAPABILITY_LABELS.map(([, label]) => label.length));
  return [
    `Security level: ${SECURITY_LEVEL_LABELS[level]}${level === 'custom' ? '' : ` (${level})`}`,
    ...CAPABILITY_LABELS.map(
      ([key, label]) => `  ${label.padEnd(width)}  ${caps[key] ? 'on' : 'off'}`,
    ),
  ];
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
  const security = program
    .command('security')
    .description('Inspect or explicitly change security settings');
  security
    .command('level [action] [level]')
    .description(
      'Show the security level, or set a preset: `level set super-lockdown|lockdown|free`',
    )
    .option('--json', 'Output the level and its capabilities as JSON')
    .action(
      async (
        action: string | undefined,
        requested: string | undefined,
        options: { json?: boolean },
      ) => {
        if (action !== undefined && action !== 'show' && action !== 'set') {
          throw new CliError('Use `gezel security level`, `level show`, or `level set <level>`.');
        }
        if (action === 'set' && requested === undefined) {
          throw new CliError('Name a level: super-lockdown, lockdown, or free.');
        }
        if (action !== 'set' && requested !== undefined) {
          throw new CliError('To change the level, use `gezel security level set <level>`.');
        }
        const next = action === 'set' ? parseSecurityLevel(requested!) : undefined;
        const client = await connect();
        const policy: SecurityPolicy = next
          ? securityPolicyForLevel(next)
          : {
              level: 'custom',
              ...securityCapabilitiesOf(resolveSecurityPolicy(await client.getConfig())),
            };
        if (next) await client.updateConfig({ securityPolicy: policy });
        if (options.json) {
          const caps = securityCapabilitiesOf(resolveSecurityPolicy({ securityPolicy: policy }));
          console.log(JSON.stringify({ level: classifySecurityLevel(caps), ...caps }));
          return;
        }
        for (const line of describeSecurityLevel(policy)) console.log(line);
      },
    );
  for (const setting of SECURITY_SWITCHES) {
    security
      .command(`${setting.command} [state]`)
      .description(setting.description)
      .option('--json', 'Output the setting as JSON')
      .action(async (state: string | undefined, options: { json?: boolean }) => {
        const enabled = enabledValue(state);
        const client = await connect();
        const config = await client.getConfig();
        const policy = resolveSecurityPolicy(config);
        if (enabled !== undefined) {
          await client.updateConfig({
            securityPolicy: policyWithCapability(config, setting.key, enabled),
          });
        }
        const value = enabled ?? policy[setting.key];
        console.log(
          options.json
            ? JSON.stringify({ [setting.key]: value })
            : `${setting.label}: ${value ? 'on' : 'off'}`,
        );
      });
  }
}

/**
 * `gezel growth [on|off]`: gezel growth (XP, and the level-ups it offers) for
 * the whole home. A home that runs bulk workflows can switch it off; nothing
 * then computes XP. Switching it back on recomputes XP from the full record
 * at the next refresh, so nothing earned meanwhile is lost.
 */
export function registerGrowthCommand(
  program: Command,
  connect: () => Promise<Pick<GezelClient, 'getConfig' | 'updateConfig'>>,
): void {
  program
    .command('growth [state]')
    .description('Show or set on/off for crew growth: XP and the level-ups it offers')
    .option('--json', 'Output the setting as JSON')
    .action(async (state: string | undefined, options: { json?: boolean }) => {
      const enabled = enabledValue(state);
      const client = await connect();
      const config =
        enabled === undefined
          ? await client.getConfig()
          : await client.updateConfig({ growth: { enabled } });
      const value = config.growth?.enabled !== false;
      console.log(
        options.json
          ? JSON.stringify({ growthEnabled: value })
          : `Growth (XP and level-ups): ${value ? 'on' : 'off'}`,
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
