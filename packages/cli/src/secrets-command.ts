import type { UpdateConfigRequest } from '@bendyline/gezel';
import { GezelApiError, type GezelClient } from '@bendyline/gezel-client';
import type { Command } from 'commander';
import { CliError } from './connection.js';

// Deliberately limited to the public credential settings. Device identity and
// toolset secrets have different authority and must not pass through config.
const credentialFlags = {
  githubToken: 'hasGithubToken',
  openaiApiKey: 'hasOpenaiApiKey',
  openaiOrganization: 'hasOpenaiOrganization',
  anthropicApiKey: 'hasAnthropicApiKey',
  googleAiApiKey: 'hasGoogleAiApiKey',
  webhookBearerToken: 'hasWebhookBearerToken',
  webhookBasicAuth: 'hasWebhookBasicAuth',
  braveSearchApiKey: 'hasBraveSearchApiKey',
  tavilyApiKey: 'hasTavilyApiKey',
} as const;
type CredentialName = keyof typeof credentialFlags;
type SecretClient = Pick<GezelClient, 'getConfig' | 'updateConfig'>;
interface SecretOptions {
  env?: string;
  stdin?: boolean;
  useForSearch?: boolean;
  json?: boolean;
}

function credentialName(name: string): CredentialName {
  if (!Object.hasOwn(credentialFlags, name)) {
    throw new CliError(`Unknown credential. Run "gezel secret list" for supported names.`);
  }
  return name as CredentialName;
}

export async function readSecretInput(
  options: SecretOptions,
  env: NodeJS.ProcessEnv = process.env,
  input: AsyncIterable<string | Buffer> & { isTTY?: boolean } = process.stdin,
): Promise<string> {
  if (Number(options.env !== undefined) + Number(options.stdin === true) !== 1) {
    throw new CliError('Choose exactly one secret input: --env <VARIABLE> or --stdin.');
  }
  let value: string;
  if (options.env !== undefined) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(options.env)) {
      throw new CliError('Use an environment variable name with --env, not its value.');
    }
    value = env[options.env] ?? '';
  } else {
    if (input.isTTY) {
      throw new CliError('--stdin requires piped input. Use --env for an existing shell variable.');
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of input) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > 65_536) throw new CliError('Secret input exceeds 64 KiB.');
      chunks.push(bytes);
    }
    value = Buffer.concat(chunks).toString('utf8');
  }
  // Shell pipes normally append a newline; keep meaningful internal spaces.
  value = value.replace(/[\r\n]+$/, '');
  if (!value.trim())
    throw new CliError('Secret input is empty; use "gezel secret remove" to clear it.');
  if (Buffer.byteLength(value) > 65_536) throw new CliError('Secret input exceeds 64 KiB.');
  if (/[\r\n\0]/.test(value))
    throw new CliError('Secret input must be a single line without NUL bytes.');
  return value;
}

async function writeCredential(client: SecretClient, patch: UpdateConfigRequest): Promise<void> {
  try {
    await client.updateConfig(patch);
  } catch (error) {
    // A server/proxy validation error can echo request bodies. Never forward it
    // into terminal output when handling write-only credentials.
    const status = error instanceof GezelApiError ? ` (HTTP ${error.status})` : '';
    throw new CliError(
      `Could not update the credential${status}. Check the service connection and permissions.`,
    );
  }
}

export function registerSecretCommands(
  program: Command,
  connect: () => Promise<SecretClient>,
  output: (value: string) => void = console.log,
): void {
  const secret = program.command('secret').description('Manage write-only provider credentials');
  secret
    .command('list')
    .description('Show supported names and whether each is configured')
    .option('--json', 'Output names and configured flags as JSON')
    .action(async (options: SecretOptions) => {
      const config = await (await connect()).getConfig();
      const credentials = Object.entries(credentialFlags).map(([name, flag]) => ({
        name,
        configured: config[flag] === true,
      }));
      output(
        options.json
          ? JSON.stringify({ credentials })
          : credentials
              .map((c) => `${c.name}\t${c.configured ? 'configured' : 'not configured'}`)
              .join('\n'),
      );
    });
  secret
    .command('set <name>')
    .description('Save a provider credential in the service credential store')
    .option('--env <VARIABLE>', 'Read the value from this environment variable')
    .option('--stdin', 'Read the value from piped stdin')
    .option('--use-for-search', 'Also select this Brave credential as the web search provider')
    .option('--json', 'Output status as JSON without the value')
    .action(async (name: string, options: SecretOptions) => {
      const key = credentialName(name);
      // The service has no Tavily search backend yet: selecting it switched
      // search to a provider that always answers "not yet implemented". The
      // key itself can still be saved for when it lands.
      if (options.useForSearch && key === 'tavilyApiKey')
        throw new CliError(
          'Tavily search is not available yet. Save the key without --use-for-search, and use braveSearchApiKey (or the built-in Wikipedia search) for now.',
        );
      const provider = key === 'braveSearchApiKey' ? 'brave' : undefined;
      if (options.useForSearch && !provider)
        throw new CliError('--use-for-search requires braveSearchApiKey.');
      const value = await readSecretInput(options);
      const client = await connect();
      const patch: UpdateConfigRequest = { [key]: value };
      if (options.useForSearch) {
        const config = await client.getConfig();
        patch.webSearch = { ...config.webSearch, provider };
      }
      await writeCredential(client, patch);
      output(
        options.json
          ? JSON.stringify({
              name: key,
              configured: true,
              ...(options.useForSearch ? { searchProvider: provider } : {}),
            })
          : `${key}: configured${options.useForSearch ? `; web search: ${provider}` : ''}`,
      );
    });
  secret
    .command('remove <name>')
    .description('Remove a provider credential')
    .option('--json', 'Output status as JSON without the value')
    .action(async (name: string, options: SecretOptions) => {
      const key = credentialName(name);
      await writeCredential(await connect(), { [key]: '' });
      output(options.json ? JSON.stringify({ name: key, configured: false }) : `${key}: removed`);
    });
}
