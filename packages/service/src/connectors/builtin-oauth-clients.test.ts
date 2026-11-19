import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  builtinOAuthClientFor,
  hasBuiltinOAuthClient,
  readReleaseOAuthClients,
} from './builtin-oauth-clients.js';

const GRAPH = 'https://graph.microsoft.com/';
const GOOGLE = 'https://www.googleapis.com/auth/';
const MICROSOFT = 'GEZEL_MICROSOFT_CLIENT_ID';

describe("Gezel's own Microsoft app", () => {
  it('connects the read-only types: calendar, OneDrive, SharePoint', () => {
    for (const scope of ['Calendars.Read', 'Files.Read', 'Sites.Read.All', 'Mail.Read']) {
      const client = builtinOAuthClientFor(MICROSOFT, ['offline_access', `${GRAPH}${scope}`]);
      expect(client?.clientId).toBe('fd484001-ce41-44ee-8ecb-dfb3b639cee5');
      expect(client?.clientSecret).toBeUndefined();
    }
  });

  it('refuses anything that could change or send', () => {
    expect(
      builtinOAuthClientFor(MICROSOFT, [
        'offline_access',
        `${GRAPH}Mail.Read`,
        `${GRAPH}Mail.ReadWrite`,
        `${GRAPH}Mail.Send`,
      ]),
    ).toBeNull();
    // It still exists, so the error can say why it was not used.
    expect(hasBuiltinOAuthClient(MICROSOFT)).toBe(true);
  });
});

describe("Gezel's own Google app", () => {
  it('is absent from a build without the release file', () => {
    expect(hasBuiltinOAuthClient('GEZEL_GOOGLE_CLIENT_ID')).toBe(false);
    expect(
      builtinOAuthClientFor('GEZEL_GOOGLE_CLIENT_ID', [`${GOOGLE}calendar.events.readonly`]),
    ).toBeNull();
  });

  it('has no app for providers Gezel never registered', () => {
    expect(hasBuiltinOAuthClient('GEZEL_X_CLIENT_ID')).toBe(false);
    expect(hasBuiltinOAuthClient(undefined)).toBe(false);
  });
});

describe('the release file', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gezel-builtin-oauth-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('supplies credentials but never decides what they may ask for', async () => {
    const path = join(dir, 'clients.json');
    await writeFile(
      path,
      JSON.stringify({
        GEZEL_GOOGLE_CLIENT_ID: {
          clientId: ' google-id.apps.googleusercontent.com ',
          clientSecret: 'GOCSPX-x',
          scopes: [`${GOOGLE}gmail.readonly`],
        },
        // No scope list in code: ignored, whatever it says.
        GEZEL_X_CLIENT_ID: { clientId: 'x-id', clientSecret: 'x-secret' },
      }),
    );
    expect(readReleaseOAuthClients(path)).toEqual([
      {
        key: 'GEZEL_GOOGLE_CLIENT_ID',
        clientId: 'google-id.apps.googleusercontent.com',
        clientSecret: 'GOCSPX-x',
        scopes: [`${GOOGLE}calendar.calendarlist.readonly`, `${GOOGLE}calendar.events.readonly`],
      },
    ]);
  });

  it('reads as empty when missing, malformed, or without a client ID', async () => {
    expect(readReleaseOAuthClients(join(dir, 'absent.json'))).toEqual([]);
    const broken = join(dir, 'broken.json');
    await writeFile(broken, '{ not json');
    expect(readReleaseOAuthClients(broken)).toEqual([]);
    const blank = join(dir, 'blank.json');
    await writeFile(blank, JSON.stringify({ GEZEL_GOOGLE_CLIENT_ID: { clientSecret: 's' } }));
    expect(readReleaseOAuthClients(blank)).toEqual([]);
  });
});
