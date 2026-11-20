/**
 * Gezel's own sign-in apps: what a person connects through when they have not
 * registered a developer app of their own. Both are read-only, and each may
 * ask only for the scopes listed here. A connector type that asks for anything
 * more needs the person's own app. The lists live in code, not in the catalog,
 * so a catalog entry cannot widen what Gezel's verified apps request, and
 * asking a Google-verified app for an unverified scope would put it back
 * behind Google's "unverified app" warning for everyone.
 *
 * Microsoft's client ID is public and lives here. Google forbids committing
 * client credentials to a public repository, so Google's comes from
 * `builtin-oauth-clients.json`, which only the desktop release workflows write
 * into the service build (`packages/service/tsup.config.ts`, from CI secrets).
 * It is never in the source or on npm; a build without it connects Google
 * through the person's own app.
 *
 * The registrations themselves are recorded in `assets/app-registrations/`.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createLogger } from '@bendyline/gezel';

const log = createLogger('connectors');

export interface BuiltinOAuthClient {
  /** The connector manifests' `clientIdEnv` name this app serves. */
  key: string;
  clientId: string;
  /** Google's desktop clients need theirs at the token endpoint; Microsoft's public client has none. */
  clientSecret?: string;
  /** Every connector scope this app may request. Gezel adds the sign-in scopes itself. */
  scopes: readonly string[];
}

const GRAPH = 'https://graph.microsoft.com/';
const GOOGLE = 'https://www.googleapis.com/auth/';

/** "Gezel (read-only)" in Microsoft Entra ID: its declared delegated permissions. */
const MICROSOFT_READ_ONLY: BuiltinOAuthClient = {
  key: 'GEZEL_MICROSOFT_CLIENT_ID',
  clientId: 'fd484001-ce41-44ee-8ecb-dfb3b639cee5',
  scopes: [
    'offline_access',
    `${GRAPH}User.Read`,
    `${GRAPH}Mail.Read`,
    `${GRAPH}Calendars.Read`,
    `${GRAPH}Files.Read`,
    `${GRAPH}Sites.Read.All`,
  ],
};

/**
 * The scopes each app in the release file may request, by key. A key with no
 * entry here is ignored, so the file can supply credentials but never decide
 * what they are used for.
 */
const RELEASE_FILE_SCOPES: Record<string, readonly string[]> = {
  // "Gezel (read-only)" on the Google Auth Platform: what its verification covers.
  GEZEL_GOOGLE_CLIENT_ID: [
    `${GOOGLE}calendar.calendarlist.readonly`,
    `${GOOGLE}calendar.events.readonly`,
  ],
};

export const BUILTIN_OAUTH_CLIENTS_FILE = 'builtin-oauth-clients.json';

/**
 * Read the release file's clients. Returns none for a missing file; a file
 * that is present but malformed is logged and ignored rather than failing
 * every connection.
 */
export function readReleaseOAuthClients(path: string): BuiltinOAuthClient[] {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    log.warn(`${path} is not JSON; Gezel's own Google app is unavailable in this build`);
    return [];
  }
  if (!parsed || typeof parsed !== 'object') return [];
  const out: BuiltinOAuthClient[] = [];
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const scopes = RELEASE_FILE_SCOPES[key];
    const entry = value as { clientId?: unknown; clientSecret?: unknown } | null;
    const clientId = typeof entry?.clientId === 'string' ? entry.clientId.trim() : '';
    if (!scopes || !clientId) continue;
    const clientSecret = typeof entry?.clientSecret === 'string' ? entry.clientSecret.trim() : '';
    out.push({ key, clientId, ...(clientSecret ? { clientSecret } : {}), scopes });
  }
  return out;
}

/**
 * Where a build put the release file: beside the bundle's shared chunks
 * (`dist/`), one level up from an entry under `dist/bin/`.
 */
function releaseFileCandidates(): string[] {
  return [`./${BUILTIN_OAUTH_CLIENTS_FILE}`, `../${BUILTIN_OAUTH_CLIENTS_FILE}`].map((rel) =>
    fileURLToPath(new URL(rel, import.meta.url)),
  );
}

let cached: Map<string, BuiltinOAuthClient> | null = null;

function builtinClients(): Map<string, BuiltinOAuthClient> {
  if (cached) return cached;
  const clients = new Map<string, BuiltinOAuthClient>([
    [MICROSOFT_READ_ONLY.key, MICROSOFT_READ_ONLY],
  ]);
  for (const path of releaseFileCandidates()) {
    const found = readReleaseOAuthClients(path);
    for (const client of found) clients.set(client.key, client);
    if (found.length > 0) break;
  }
  cached = clients;
  return clients;
}

/** Whether Gezel has an app of its own for this key, whatever it may request. */
export function hasBuiltinOAuthClient(key: string | undefined): boolean {
  return key !== undefined && builtinClients().has(key);
}

/**
 * Gezel's own app for this key, when it may request every one of the
 * connector's scopes; otherwise null, and the connection needs the person's
 * own app.
 */
export function builtinOAuthClientFor(
  key: string | undefined,
  connectorScopes: string[],
): BuiltinOAuthClient | null {
  const client = key === undefined ? undefined : builtinClients().get(key);
  if (!client) return null;
  return connectorScopes.every((scope) => client.scopes.includes(scope)) ? client : null;
}
