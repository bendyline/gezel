/**
 * Export one connection's saved credential, with what is needed to make the
 * same connection again, for a CI secret the live connector checks use.
 *
 *   pnpm --silent --filter @bendyline/gezel-service run connectors:export-credential -- \
 *     --home ~/.gezel-dev --project connhome [--binding mail-gmail:adb4b048] \
 *     | gh secret set GEZEL_LIVE_GMAIL --env connector-live
 *
 * The bundle goes to stdout only when stdout is a pipe, or to a 0600 file
 * with `--out`; it never reaches a terminal. It is JSON:
 * `{ v, type, version, sourceId, config, displayName?, credential }`, where
 * `credential` is the blob the connection stored (for OAuth: the refresh
 * token and the client it was issued to).
 *
 * Read-only: the home's secret store is opened in place, never migrated, and
 * the token is not refreshed. Export only connections to test accounts.
 */

import { writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { setLogOutput } from '@bendyline/gezel';

// The bundle is the only thing stdout may carry.
setLogOutput('stderr');

const { readFile } = await import('node:fs/promises');
const { deviceIdentityScope } = await import('@bendyline/gezel-inference/internal/secrets/types');
const { FileSecretStore } = await import('../src/secrets/file-store.js');
const { KeyringSecretStore } = await import('../src/secrets/keyring-store.js');
const { connectorSecretKey } = await import('../src/connectors/registry.js');

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function fail(message: string): never {
  process.stderr.write(`export-connector-credential: ${message}\n`);
  process.exit(1);
}

function expandHome(path: string): string {
  return path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path;
}

interface Binding {
  id: string;
  type: string;
  version?: string;
  sourceId?: string;
  displayName?: string;
  config?: Record<string, unknown>;
  /** The account the sign-in reached (Google, Microsoft), when recorded. */
  account?: string;
}

const home = resolve(
  expandHome(arg('home') ?? process.env.GEZEL_HOME ?? join(homedir(), '.gezel')),
);
const projectArg = arg('project') ?? fail('name the project with --project <id or name>');
const out = arg('out');
if (!out && process.stdout.isTTY) {
  fail(
    'refusing to print a credential to a terminal. Pipe it (for example into `gh secret set NAME --env connector-live`) or pass --out <file>.',
  );
}

async function readProject(dir: string): Promise<{ name?: string; connectors?: Binding[] } | null> {
  try {
    return JSON.parse(await readFile(join(dir, 'project.json'), 'utf8'));
  } catch {
    return null;
  }
}

const projectsDir = join(home, 'projects');
let project = await readProject(join(projectsDir, projectArg));
if (!project) {
  const { readdir } = await import('node:fs/promises');
  for (const id of await readdir(projectsDir).catch(() => [] as string[])) {
    const candidate = await readProject(join(projectsDir, id));
    if (candidate?.name === projectArg) {
      project = candidate;
      break;
    }
  }
}
if (!project) fail(`no project ${projectArg} in ${home}`);

const bindings = project.connectors ?? [];
const wanted = arg('binding');
const binding = wanted
  ? bindings.find((b) => b.id === wanted)
  : bindings.length === 1
    ? bindings[0]
    : undefined;
if (!binding) {
  const list = bindings.map((b) => `  ${b.id}  (${b.type})`).join('\n') || '  (none)';
  fail(
    `${wanted ? `no connection ${wanted}` : 'name one connection with --binding'} in ${projectArg}:\n${list}`,
  );
}

const backend = (await readFile(join(home, 'secrets.backend'), 'utf8').catch(() => '')).trim();
const secrets =
  backend === 'keyring'
    ? new KeyringSecretStore({ identityScope: deviceIdentityScope(home) })
    : backend === 'file'
      ? new FileSecretStore(home)
      : fail(`${home} has no secret store (secrets.backend is missing)`);
const credential = await secrets.get(connectorSecretKey(binding.type, binding.id));
if (!credential) fail(`no saved credential for ${binding.id}`);

let parsed: Record<string, unknown> | null = null;
try {
  parsed = JSON.parse(credential) as Record<string, unknown>;
} catch {
  /* an API key or app password, stored bare */
}
if (parsed && 'accessToken' in parsed && !parsed.refreshToken) {
  fail(
    `${binding.id} has no refresh token; it would stop working within the hour. Reconnect it first.`,
  );
}

const bundle = `${JSON.stringify({
  v: 1,
  type: binding.type,
  ...(binding.version ? { version: binding.version } : {}),
  sourceId: binding.sourceId ?? 'bundled',
  config: binding.config ?? {},
  ...(binding.displayName ? { displayName: binding.displayName } : {}),
  credential,
})}\n`;

if (out) {
  await writeFile(out, bundle, { mode: 0o600, flag: 'wx' }).catch((err: NodeJS.ErrnoException) =>
    fail(err.code === 'EEXIST' ? `${out} already exists` : String(err)),
  );
} else {
  process.stdout.write(bundle);
}
// The address is what was typed; the account is who actually signed in. A
// connection made before the sign-in check may hold another account entirely.
const signedIn = binding.account
  ? `signed in as ${binding.account}`
  : 'the account it signed in with was not recorded; reconnect it to be sure which one this is';
process.stderr.write(
  `exported ${binding.id} (${binding.type}${binding.config?.address ? `, ${String(binding.config.address)}` : ''}; ${signedIn})${out ? ` to ${out}` : ''}. Reconnecting it in Gezel later issues a new token; this one stays valid.\n`,
);
