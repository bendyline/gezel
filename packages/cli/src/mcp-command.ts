import {
  HARNESS_AGENT_FILE,
  HARNESS_CLIENT_IDS,
  type HarnessClientId,
  HarnessClientIdSchema,
  type HarnessToolsClientStatus,
  harnessAgentFileLine,
  harnessPromptInvocation,
} from '@bendyline/gezel';
import { GezelApiError, type GezelClient, apiErrorMessage } from '@bendyline/gezel-client';
import type { Command } from 'commander';
import { CliError } from './connection.js';

type HarnessToolsClient = Pick<
  GezelClient,
  'getHarnessTools' | 'configureHarnessTools' | 'removeHarnessTools'
>;

interface McpOptions {
  project?: string;
  profile?: string;
  replace?: boolean;
  json?: boolean;
}

const STATE_WORDS: Record<HarnessToolsClientStatus['state'], string> = {
  configured: 'set up',
  'not-configured': 'not set up',
  'update-needed': 'needs repair',
  conflict: 'needs attention',
  unavailable: 'unavailable',
};

function clientId(name: string): HarnessClientId {
  const parsed = HarnessClientIdSchema.safeParse(name);
  if (!parsed.success) {
    throw new CliError(`Unknown app "${name}". Choose one of: ${HARNESS_CLIENT_IDS.join(', ')}.`);
  }
  return parsed.data;
}

function describe(status: HarnessToolsClientStatus): string {
  const lines = [`${status.label}: ${STATE_WORDS[status.state]}`];
  if (status.configPath) lines.push(`  settings: ${status.configPath}`);
  for (const reason of status.reasons) lines.push(`  ${reason}`);
  if (status.state !== 'configured' && status.manualCommand) {
    lines.push(`  to set it up yourself: ${status.manualCommand}`);
  }
  return lines.join('\n');
}

async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof GezelApiError) throw new CliError(apiErrorMessage(error));
    throw error;
  }
}

/**
 * `gezel mcp …`: give Claude Code, Codex, Cursor, Claude Desktop or VS Code
 * Gezel's tools — search over the folder you work in, your shared library,
 * memories and knowledge, Office documents, and images. The same setup
 * Settings → Integrations does.
 */
export function registerMcpCommands(
  program: Command,
  connect: () => Promise<HarnessToolsClient>,
  output: (value: string) => void = console.log,
): void {
  const mcp = program
    .command('mcp')
    .description(
      "Give other AI apps Gezel's tools (Claude Code, Codex, Cursor, Claude Desktop, VS Code)",
    );

  mcp
    .command('status')
    .description("Show which apps have Gezel's tools and what they may do")
    .option('--json', 'Output the full status as JSON')
    .action(async (options: McpOptions) => {
      const status = await call(async () => (await connect()).getHarnessTools());
      if (options.json) {
        output(JSON.stringify(status));
        return;
      }
      const { config } = status;
      const lines = [
        `Gezel's tools in other apps: ${config.enabled ? 'on' : 'off'} (memories: ${config.memory}, images: ${config.images}, new folders: ${config.newFolders})`,
        ...(status.unavailableReason ? [status.unavailableReason] : []),
        '',
        ...status.clients.map(describe),
      ];
      if (status.connections.length > 0) {
        lines.push('', 'In use now:');
        for (const c of status.connections) {
          lines.push(
            `  ${c.label}: ${c.projectName ?? 'no project'}${c.folder ? ` (${c.folder})` : ''}`,
          );
        }
      }
      output(lines.join('\n'));
    });

  mcp
    .command('install <app>')
    .description(`Set up Gezel's tools in one app: ${HARNESS_CLIENT_IDS.join(', ')}`)
    .option('--project <id>', 'Claude Desktop: the Gezel project it works in')
    .option('--profile <id>', 'VS Code: the profile to set up')
    .option('--replace', 'Replace a "gezel" entry Gezel did not write (it is kept as a backup)')
    .option('--json', 'Output the app status as JSON')
    .action(async (app: string, options: McpOptions) => {
      const client = clientId(app);
      const status = await call(async () =>
        (await connect()).configureHarnessTools(client, {
          ...(options.project ? { projectId: options.project } : {}),
          ...(options.profile ? { profileId: options.profile } : {}),
          ...(options.replace ? { replaceExisting: true } : {}),
        }),
      );
      if (options.json) {
        output(JSON.stringify(status));
        return;
      }
      const lines = [describe(status)];
      const line = harnessAgentFileLine(client);
      if (status.state === 'configured' && line) {
        lines.push(
          '',
          `${status.label} reaches for its own search first. So it uses Gezel's, add this line to the ${HARNESS_AGENT_FILE[client]} file in a folder you work in:`,
          '',
          `  ${line}`,
        );
      }
      const triage = harnessPromptInvocation(client, 'triage_issues');
      if (status.state === 'configured' && triage) {
        lines.push(
          '',
          `To have ${status.label} check the suspected problems Gezel's night shift found, run ${triage} in a folder Gezel knows.`,
        );
      }
      output(lines.join('\n'));
    });

  mcp
    .command('remove <app>')
    .description("Take Gezel's tools out of one app")
    .option('--json', 'Output the app status as JSON')
    .action(async (app: string, options: McpOptions) => {
      const status = await call(async () => (await connect()).removeHarnessTools(clientId(app)));
      output(options.json ? JSON.stringify(status) : describe(status));
    });
}
