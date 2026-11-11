import {
  type Account,
  type AccountSession,
  OLLAMA_EMULATION_PORT,
  containerPublicBase,
  ollamaEmulationAddresses,
} from '@bendyline/gezel';
import { GezelApiError, type GezelClient, apiErrorMessage } from '@bendyline/gezel-client';
import type { Command } from 'commander';
import { CliError } from './connection.js';
import { enabledValue } from './settings-command.js';

/**
 * `gezel account …` — accounts that sign in on network-facing surfaces
 * (ADR 0029): a Gezel container's web UI, or `gezel start --web --accounts`.
 * Runs with the owner's own credential, which is how a container's shell
 * (`docker exec <container> gezel account …`) adds people and resets
 * passwords when nobody can sign in.
 */

type AccountClient = Pick<
  GezelClient['accounts'],
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

type IntegrationClient = Pick<
  GezelClient,
  | 'createAppToken'
  | 'revokeAppToken'
  | 'getBaseUrl'
  | 'getFetch'
  | 'authHeader'
  | 'getConfig'
  | 'updateConfig'
>;

/** What the address commands read from the computer the command runs on. */
export interface IntegrationHost {
  env: NodeJS.ProcessEnv;
  /** Whether Gezel itself answers on the Ollama port right now. */
  ollamaAnswering: () => Promise<boolean>;
}

const THIS_COMPUTER: IntegrationHost = {
  env: process.env,
  async ollamaAnswering() {
    try {
      const response = await fetch(`${ollamaEmulationAddresses().ollama}/api/version`, {
        signal: AbortSignal.timeout(1_000),
      });
      // Real Ollama answers the same path; only Gezel's listener sets the marker.
      return response.ok && response.headers.get('x-gezel-ollama-emulation') === '1';
    } catch {
      return false;
    }
  },
};

/** The OpenAI-style address that takes an app key. */
export interface KeyedAddress {
  baseUrl: string;
  /** Served with Gezel's own certificate, which other programs do not trust unasked. */
  ownCertificate: boolean;
  /** A container's address is already plain HTTP on a fixed port. */
  container: boolean;
}

/**
 * Where a program with a key finds the models. Inside a container the
 * command line talks to the container's own loopback, which the host never
 * reaches, so the address is the one the container publishes.
 */
export function keyedAddress(
  client: Pick<GezelClient, 'getBaseUrl'>,
  env: NodeJS.ProcessEnv,
): KeyedAddress {
  if (env.GEZEL_CONTAINER === '1') {
    return { baseUrl: `${containerPublicBase(env)}/v1`, ownCertificate: false, container: true };
  }
  const base = client.getBaseUrl();
  return { baseUrl: `${base}/v1`, ownCertificate: base.startsWith('https://'), container: false };
}

const OWN_CERTIFICATE_NOTE =
  "It is served with Gezel's own certificate, which a program has to trust or skip checking.";

const OLLAMA_SWITCH = 'gezel integrations ollama on';

/**
 * Every address another program can use, for `gezel integrations address`.
 * `answering` is null when the service is on another computer and the port
 * cannot be checked from here.
 */
export function describeAppAddresses(input: {
  keyed: KeyedAddress;
  appsAllowed: boolean;
  emulation: { on: boolean; answering: boolean | null };
}): string[] {
  const { keyed, emulation } = input;
  const lines: string[] = [];
  if (!input.appsAllowed) {
    lines.push(
      'Apps are not allowed to connect to this Gezel ("Allow apps to connect" is off in Settings → Integrations). These addresses answer once it is on.',
      '',
    );
  }
  lines.push('With an app key ("gezel integrations token create <app>"):', `  ${keyed.baseUrl}`);
  if (keyed.ownCertificate) lines.push(`  ${OWN_CERTIFICATE_NOTE}`);
  if (keyed.container) return lines;

  const plain = ollamaEmulationAddresses();
  lines.push('');
  if (!emulation.on) {
    lines.push(
      `Without a key, over plain HTTP on a fixed port: off. "${OLLAMA_SWITCH}" turns it on:`,
      `  ${plain.openai}`,
    );
  } else if (emulation.answering === false) {
    lines.push(
      `Ollama emulation is on, but Gezel is not answering on port ${OLLAMA_EMULATION_PORT}. Another program may hold the port (Ollama itself, or another person's Gezel); the service log says which.`,
    );
  } else {
    lines.push(
      'Without a key, over plain HTTP on a fixed port (Ollama emulation is on):',
      `  ${plain.openai}   OpenAI-style`,
      `  ${plain.ollama}      Ollama`,
    );
  }
  return lines;
}

function isThisComputer(baseUrl: string): boolean {
  try {
    return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
}

/** The Integrations roster, as `GET /v1/apps/` answers the person's own client. */
interface AppRoster {
  apps: Array<{ appId: string; appName?: string; scopes: string[]; lastUsedAt?: string }>;
  grants: Array<{
    id: string;
    appId: string;
    appName?: string;
    scopes: string[];
    status: string;
    createdAt: string;
    kind?: string;
    verificationRequired?: boolean;
  }>;
}

const APP_ERRORS: Record<string, string> = {
  verification_code_required: 'This request needs the code the app is showing. Add --code <code>.',
  verification_code_invalid: 'That code does not match the one the app is showing.',
  verification_attempts_exceeded:
    'Too many wrong codes. Ask the app to connect again, then approve the new request.',
  grant_expired: 'That request ran out. Ask the app to connect again.',
  grant_not_found: 'That request is gone. Ask the app to connect again.',
};

/**
 * `/v1/apps/*` is the public app surface, which the typed client leaves
 * unwrapped on purpose; the desktop's Integrations panel reaches it the same
 * way, with the person's own credential.
 */
async function appsRequest<T>(
  client: IntegrationClient,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await client.getFetch()(`${client.getBaseUrl()}/v1/apps${path}`, {
    method,
    headers: {
      ...client.authHeader(),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = (await response.json().catch(() => ({}))) as { error?: unknown };
  if (!response.ok) {
    const code = typeof data.error === 'string' ? data.error : '';
    throw new CliError(
      APP_ERRORS[code] ?? `Gezel refused (${response.status}${code ? `: ${code}` : ''}).`,
    );
  }
  return data as T;
}

/**
 * The roster lives at `/v1/apps` exactly. With a trailing slash the request
 * falls through to the web interface, which answers 200 with a page.
 */
async function appRoster(client: IntegrationClient): Promise<AppRoster> {
  const roster = await appsRequest<Partial<AppRoster>>(client, 'GET', '');
  if (!Array.isArray(roster.apps) || !Array.isArray(roster.grants)) {
    throw new CliError('This Gezel service did not answer with its connected apps.');
  }
  return roster as AppRoster;
}

/** Requests from apps waiting on the person; devices pair through their own screen. */
function waitingRequests(roster: AppRoster): AppRoster['grants'] {
  return roster.grants.filter((grant) => grant.status === 'pending' && grant.kind !== 'device');
}

async function waitingRequestFor(
  client: IntegrationClient,
  appId: string,
): Promise<AppRoster['grants'][number]> {
  const waiting = waitingRequests(await appRoster(client));
  const grant = waiting.find((candidate) => candidate.appId === appId);
  if (grant) return grant;
  throw new CliError(
    waiting.length > 0
      ? `${appId} is not waiting for approval. Waiting now: ${waiting.map((g) => g.appId).join(', ')}.`
      : `No app is waiting for approval. A request lasts ten minutes; ask ${appId} to connect again.`,
  );
}

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
  host: IntegrationHost = THIS_COMPUTER,
): void {
  const integrations = program
    .command('integrations')
    .description('Connect other apps to this Gezel');

  // A key was no use without knowing where to send it: `token create` said
  // "the base URL ending in /v1" and nothing printed one (2026-11-10).
  integrations
    .command('address')
    .description("Show where other programs reach this Gezel's models")
    .option('--json', 'Output as JSON')
    .action(async (options: { json?: boolean }) => {
      const client = await connect();
      const endpoints = (await client.getConfig()).openaiEndpoints ?? {};
      const keyed = keyedAddress(client, host.env);
      const on = endpoints.emulateOllama === true;
      const answering =
        on && !keyed.container && isThisComputer(client.getBaseUrl())
          ? await host.ollamaAnswering()
          : null;
      if (options.json) {
        return output(
          JSON.stringify({
            baseUrl: keyed.baseUrl,
            needsKey: true,
            ownCertificate: keyed.ownCertificate,
            appsAllowed: endpoints.enabled !== false,
            ...(keyed.container
              ? {}
              : { ollamaEmulation: { on, answering, ...ollamaEmulationAddresses() } }),
          }),
        );
      }
      output(
        describeAppAddresses({
          keyed,
          appsAllowed: endpoints.enabled !== false,
          emulation: { on, answering },
        }).join('\n'),
      );
    });

  // The terminal's switch for Settings → Integrations → "Emulate Ollama":
  // one fixed plain-HTTP port, no key. Off unless a person turns it on.
  integrations
    .command('ollama [state]')
    .description(
      `Show or set on/off for a plain-HTTP port programs on this computer can use without a key (Ollama emulation, port ${OLLAMA_EMULATION_PORT})`,
    )
    .option('--json', 'Output as JSON')
    .action(async (state: string | undefined, options: { json?: boolean }) => {
      const wanted = enabledValue(state);
      const client = await connect();
      const endpoints = (await client.getConfig()).openaiEndpoints ?? {};
      let on = endpoints.emulateOllama === true;
      if (wanted !== undefined) {
        // The service replaces the whole object, so the other switches ride along.
        const { emulateOllama: _previous, ...rest } = endpoints;
        const updated = await plainly(() =>
          client.updateConfig({
            openaiEndpoints: wanted ? { ...rest, emulateOllama: true } : rest,
          }),
        );
        on = updated.openaiEndpoints?.emulateOllama === true;
        if (wanted && !on) {
          throw new CliError('This build of Gezel does not offer the plain-HTTP port.');
        }
      }
      const plain = ollamaEmulationAddresses();
      if (options.json) {
        return output(JSON.stringify({ emulateOllama: on, ...(on ? plain : {}) }));
      }
      const lines = [`Ollama emulation: ${on ? 'on' : 'off'}`];
      if (on && endpoints.enabled === false) {
        lines.push(
          'Apps are not allowed to connect to this Gezel, so the port stays closed. Turn on "Allow apps to connect" in Settings → Integrations.',
        );
      } else if (on && host.env.GEZEL_CONTAINER === '1') {
        lines.push(
          `In a container this port answers only inside the container. From outside, use ${keyedAddress(client, host.env).baseUrl} with an app key.`,
        );
      } else if (on) {
        lines.push(
          'Programs on this computer can use your models without a key:',
          `  ${plain.openai}   OpenAI-style`,
          `  ${plain.ollama}      Ollama`,
          ...(wanted ? ['It stays on until you run "gezel integrations ollama off".'] : []),
        );
      }
      output(lines.join('\n'));
    });

  // An app that asks to connect waits for the person. The desktop shows a
  // prompt; a server or a terminal-only install had nowhere to answer it, so
  // the app's connect call sat until the request ran out (2026-11-10).
  integrations
    .command('list')
    .description('Show the apps connected to this Gezel and the ones waiting for your approval')
    .option('--json', 'Output as JSON')
    .action(async (options: { json?: boolean }) => {
      const roster = await appRoster(await connect());
      const waiting = waitingRequests(roster);
      const label = (app: { appId: string; appName?: string; scopes: string[] }) =>
        `${app.appId}${app.appName && app.appName !== app.appId ? `  ${app.appName}` : ''}  (${app.scopes.join(', ')})`;
      const lines: string[] = [];
      if (waiting.length > 0) {
        lines.push('Waiting for your approval:');
        for (const grant of waiting) {
          lines.push(
            `  ${label(grant)}${grant.verificationRequired ? '  needs the code it shows' : ''}`,
          );
        }
        lines.push('Answer with "gezel integrations approve <appId>" or "deny <appId>".', '');
      }
      // Each chat and each coding-agent connection holds a key of its own for
      // Gezel's tool server. Integrations in the app leaves those out too.
      const connected = roster.apps.filter(
        (app) => !app.appId.startsWith('session:') && !app.appId.startsWith('harness:'),
      );
      if (options.json) return output(JSON.stringify({ waiting, connected }));
      lines.push(connected.length > 0 ? 'Connected:' : 'No apps are connected.');
      for (const app of connected) lines.push(`  ${label(app)}`);
      output(lines.join('\n'));
    });

  integrations
    .command('approve <appId>')
    .description('Let an app that asked to connect use this Gezel')
    .option('--code <code>', 'The code the app shows, when it asks for more than model access')
    .action(async (appId: string, options: { code?: string }) => {
      const client = await connect();
      const grant = await waitingRequestFor(client, appId);
      await appsRequest(
        client,
        'POST',
        `/grant/${encodeURIComponent(grant.id)}/approve`,
        options.code ? { verificationCode: options.code } : {},
      );
      output(
        `${appId} is connected (${grant.scopes.join(', ')}). Revoke it with "gezel integrations token revoke ${appId}".`,
      );
    });

  integrations
    .command('deny <appId>')
    .description('Turn down an app that asked to connect')
    .action(async (appId: string) => {
      const client = await connect();
      const grant = await waitingRequestFor(client, appId);
      await appsRequest(client, 'POST', `/grant/${encodeURIComponent(grant.id)}/deny`);
      output(`${appId} was turned down.`);
    });

  const token = integrations.command('token').description('Make or revoke an app key');

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
      const where = keyedAddress(client, host.env);
      if (options.json) return output(JSON.stringify({ ...created, baseUrl: where.baseUrl }));
      output(
        [
          `Key for ${created.appId} (${created.scopes.join(', ')}):`,
          `  ${created.token}`,
          '',
          'Use it as the API key, with this base URL:',
          `  ${where.baseUrl}`,
          ...(where.ownCertificate
            ? [
                `${OWN_CERTIFICATE_NOTE} For plain HTTP on a fixed port, see "gezel integrations address".`,
              ]
            : []),
          'The key is shown once. Revoke it with "gezel integrations token revoke".',
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
