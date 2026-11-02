import { readFile } from 'node:fs/promises';
import type { AccountManager } from './manager.js';

/**
 * Create the owner from a deployer-supplied name and password file — a
 * Docker or Kubernetes secret — so an automated deploy needs no setup link.
 * Only a file: a password in an environment variable shows up in
 * `docker inspect` and in every child process. Runs once, while the
 * accounts store is empty; afterwards the variables are ignored.
 */
export async function seedOwnerFromEnvironment(
  accounts: AccountManager,
  env: NodeJS.ProcessEnv = process.env,
  read: (path: string) => Promise<string> = (path) => readFile(path, 'utf8'),
): Promise<'created' | 'exists' | 'not-configured'> {
  const name = env.GEZEL_OWNER_NAME?.trim();
  const file = env.GEZEL_OWNER_PASSWORD_FILE?.trim();
  if (!name || !file) return 'not-configured';
  if (accounts.hasAccounts()) return 'exists';
  // Secret files usually end in a newline the person never meant to type.
  const password = (await read(file)).replace(/\r?\n$/, '');
  return (await accounts.seedOwner(name, password)) ? 'created' : 'exists';
}
