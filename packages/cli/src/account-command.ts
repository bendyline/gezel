import type { Account, AccountSession } from '@bendyline/gezel';
import { GezelApiError, type GezelClient, apiErrorMessage } from '@bendyline/gezel-client';
import type { Command } from 'commander';
import { CliError } from './connection.js';

/**
 * `gezel account …` — accounts that sign in on network-facing surfaces
 * (ADR 0029): a Gezel container's web UI, or `gezel start --web --accounts`.
 * Runs with the owner's own credential, which is how a container's shell
 * (`docker exec <container> gezel account …`) adds people and resets
 * passwords when nobody can sign in.
 */

type AccountClient = Pick<
  GezelClient,
  | 'listAccounts'
  | 'createAccount'
  | 'updateAccount'
  | 'setAccountPassword'
  | 'removeAccount'
  | 'listAccountSessions'
  | 'signOutAccountEverywhere'
  | 'createSetupLink'
>;

interface PasswordInput extends AsyncIterable<string | Buffer> {
  isTTY?: boolean;
  setRawMode?: (raw: boolean) => unknown;
  on?: (event: 'data', listener: (chunk: Buffer | string) => void) => unknown;
  off?: (event: 'data', listener: (chunk: Buffer | string) => void) => unknown;
  resume?: () => unknown;
  pause?: () => unknown;
}

interface PasswordOptions {
  passwordStdin?: boolean;
}

/** Read a password from piped stdin, or ask for it twice without echoing it. */
export async function readNewPassword(
  options: PasswordOptions,
  input: PasswordInput = process.stdin,
  write: (text: string) => void = (text) => process.stderr.write(text),
): Promise<string> {
  if (options.passwordStdin) {
    if (input.isTTY) throw new CliError('--password-stdin needs piped input.');
    const chunks: Buffer[] = [];
    for await (const chunk of input) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      if (chunks.reduce((n, c) => n + c.length, 0) > 4096) {
        throw new CliError('The password is too long.');
      }
    }
    return Buffer.concat(chunks)
      .toString('utf8')
      .replace(/\r?\n$/, '');
  }
  if (!input.isTTY || !input.setRawMode) {
    throw new CliError('No terminal to type a password into. Pipe it in with --password-stdin.');
  }
  const first = await promptHidden('New password: ', input, write);
  const second = await promptHidden('Type it again: ', input, write);
  if (first !== second) throw new CliError('The two passwords did not match.');
  return first;
}

function promptHidden(
  prompt: string,
  input: PasswordInput,
  write: (text: string) => void,
): Promise<string> {
  write(prompt);
  return new Promise((resolve, reject) => {
    let value = '';
    const done = (error?: Error) => {
      input.off?.('data', onData);
      input.setRawMode?.(false);
      input.pause?.();
      write('\n');
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: Buffer | string) => {
      for (const ch of chunk.toString('utf8')) {
        if (ch === '\r' || ch === '\n') return done();
        if (ch === '\u0003') return done(new CliError('Canceled.'));
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else if (ch >= ' ') value += ch;
      }
    };
    input.setRawMode?.(true);
    input.resume?.();
    input.on?.('data', onData);
  });
}

async function findAccount(client: AccountClient, name: string): Promise<Account> {
  const key = name.trim().toLowerCase();
  const { accounts } = await client.listAccounts();
  const match = accounts.find((a) => a.name.toLowerCase() === key || a.id === name);
  if (!match) throw new CliError(`There is no account called "${name}". See "gezel account list".`);
  return match;
}

/** Turn the daemon's plain refusal into a CLI message; anything else propagates. */
async function plainly<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof GezelApiError && error.status < 500 && error.status > 0) {
      const details = error.details as { error?: unknown } | undefined;
      if (error.status === 404 && details?.error === 'accounts_unavailable') {
        throw new CliError('This Gezel service has no accounts.');
      }
      throw new CliError(apiErrorMessage(error));
    }
    throw error;
  }
}

function describeAccount(account: Account): string {
  const state = account.disabledAt ? 'disabled' : account.role;
  const seen = account.lastSignInAt
    ? `last signed in ${account.lastSignInAt.slice(0, 10)}`
    : 'never signed in';
  return `${account.name}\t${state}\t${seen}`;
}

function describeSession(session: AccountSession): string {
  return [
    session.label ?? 'unknown',
    session.address ?? '',
    `last seen ${session.lastSeenAt.slice(0, 16).replace('T', ' ')}`,
  ]
    .filter(Boolean)
    .join('\t');
}

export function registerAccountCommands(
  program: Command,
  connect: () => Promise<AccountClient>,
  output: (value: string) => void = console.log,
  input: PasswordInput = process.stdin,
): void {
  const account = program
    .command('account')
    .description('Manage the accounts that sign in to this Gezel from a browser');

  account
    .command('list')
    .description('List accounts')
    .option('--json', 'Output as JSON')
    .action(async (options: { json?: boolean }) => {
      const { accounts } = await plainly(async () => (await connect()).listAccounts());
      if (options.json) return output(JSON.stringify({ accounts }));
      output(accounts.length ? accounts.map(describeAccount).join('\n') : 'No accounts yet.');
    });

  account
    .command('create <name>')
    .description('Add an account. Everyone you add can do everything you can.')
    .option('--password-stdin', 'Read the password from piped stdin')
    .option('--json', 'Output as JSON')
    .action(async (name: string, options: PasswordOptions & { json?: boolean }) => {
      const client = await connect();
      const password = await readNewPassword(options, input);
      const created = await plainly(() => client.createAccount(name, password));
      output(options.json ? JSON.stringify(created) : `${created.account.name} can now sign in.`);
    });

  account
    .command('reset-password <name>')
    .description("Set someone's password and sign them out everywhere")
    .option('--password-stdin', 'Read the password from piped stdin')
    .action(async (name: string, options: PasswordOptions) => {
      const client = await connect();
      const target = await findAccount(client, name);
      const password = await readNewPassword(options, input);
      await plainly(() => client.setAccountPassword(target.id, password));
      output(`${target.name}'s password was changed. They are signed out everywhere.`);
    });

  for (const [verb, disabled, done] of [
    ['disable', true, 'can no longer sign in'],
    ['enable', false, 'can sign in again'],
  ] as const) {
    account
      .command(`${verb} <name>`)
      .description(disabled ? 'Stop an account signing in' : 'Let a disabled account sign in again')
      .action(async (name: string) => {
        const client = await connect();
        const target = await findAccount(client, name);
        await plainly(() => client.updateAccount(target.id, { disabled }));
        output(`${target.name} ${done}.`);
      });
  }

  account
    .command('remove <name>')
    .description('Remove an account and sign it out everywhere')
    .option('--yes', 'Do not ask for confirmation')
    .action(async (name: string, options: { yes?: boolean }) => {
      if (!options.yes)
        throw new CliError('Removing an account cannot be undone. Add --yes to go ahead.');
      const client = await connect();
      const target = await findAccount(client, name);
      await plainly(() => client.removeAccount(target.id));
      output(`${target.name} was removed.`);
    });

  account
    .command('sessions <name>')
    .description('List where an account is signed in')
    .option('--json', 'Output as JSON')
    .action(async (name: string, options: { json?: boolean }) => {
      const client = await connect();
      const target = await findAccount(client, name);
      const { sessions } = await plainly(() => client.listAccountSessions(target.id));
      if (options.json) return output(JSON.stringify({ sessions }));
      output(
        sessions.length
          ? sessions.map(describeSession).join('\n')
          : `${target.name} is not signed in anywhere.`,
      );
    });

  account
    .command('sign-out-all <name>')
    .description('Sign an account out of every browser')
    .action(async (name: string) => {
      const client = await connect();
      const target = await findAccount(client, name);
      const { signedOut } = await plainly(() => client.signOutAccountEverywhere(target.id));
      output(
        `Signed ${target.name} out of ${signedOut} ${signedOut === 1 ? 'browser' : 'browsers'}.`,
      );
    });

  account
    .command('setup-link')
    .description('Print a new link to create the first account (only while there is none)')
    .action(async () => {
      const { code, url } = await plainly(async () => (await connect()).createSetupLink());
      if (!code)
        throw new CliError('This Gezel already has an account. Use "gezel account create".');
      output(url ? `Open this link to create the first account:\n  ${url}` : `Setup code: ${code}`);
    });
}

type IntegrationClient = Pick<GezelClient, 'createAppToken' | 'revokeAppToken'>;

/**
 * `gezel integrations token …` — a key for an app that talks to this
 * Gezel's OpenAI-compatible endpoints, made without the approval prompt,
 * because the person typing the command is the one approving. The key shows
 * in Settings → Integrations like any other and is revoked there or here.
 */
export function registerIntegrationCommands(
  program: Command,
  connect: () => Promise<IntegrationClient>,
  output: (value: string) => void = console.log,
): void {
  const token = program
    .command('integrations')
    .description('Connect other apps to this Gezel')
    .command('token')
    .description('Make or revoke an app key');

  token
    .command('create <appId>')
    .description('Make a key for an app (OpenAI-compatible access by default)')
    .option('--name <name>', 'The name Integrations shows for the app')
    .option(
      '--scope <scope...>',
      'What the key may do: openai, knowledge, images, product or cli (default: openai)',
    )
    .option('--json', 'Output as JSON')
    .action(async (appId: string, options: { name?: string; scope?: string[]; json?: boolean }) => {
      const client = await connect();
      const created = await plainly(() =>
        client.createAppToken(appId, {
          ...(options.name ? { appName: options.name } : {}),
          ...(options.scope?.length ? { scopes: options.scope } : {}),
        }),
      );
      if (options.json) return output(JSON.stringify(created));
      output(
        [
          `Key for ${created.appId} (${created.scopes.join(', ')}):`,
          `  ${created.token}`,
          '',
          'Use it as the API key, with the base URL ending in /v1.',
          'It is shown once. Revoke it with "gezel integrations token revoke".',
        ].join('\n'),
      );
    });

  token
    .command('revoke <appId>')
    .description("Revoke an app's key")
    .action(async (appId: string) => {
      const { revoked } = await plainly(async () => (await connect()).revokeAppToken(appId));
      output(revoked ? `${appId} can no longer connect.` : `${appId} had no key.`);
    });
}
