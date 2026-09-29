import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFirstPartyAppTokens } from '../../grants/first-party-apps.js';
import { createGrantManager } from '../../grants/manager.js';
import type { ServiceContext } from '../context.js';
import { type TokenStore, createTokenStore } from '../token-store.js';
import { v1AppsRoutes } from './v1-apps.js';

const OFFICE_ORIGIN = 'https://localhost:45001';
const KEY = 'a-correct-enrollment-key-of-some-length';

let home: string;
let app: Hono;
let tokenStore: TokenStore;
let openaiEnabled: boolean;

async function build(overrides: Partial<ServiceContext> = {}): Promise<void> {
  const grants = await createGrantManager({ home, tokenStore });
  const context = {
    tokenStore,
    grants,
    firstPartyApps: createFirstPartyAppTokens(tokenStore),
    officeHostOrigin: () => OFFICE_ORIGIN,
    verifyOfficeEnrollmentKey: async (key: string) => key === KEY,
    store: { readConfig: async () => ({ openaiEndpoints: { enabled: openaiEnabled } }) },
    ...overrides,
  } as unknown as ServiceContext;
  app = new Hono().route('/v1/apps', v1AppsRoutes(context));
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-v1-first-party-'));
  openaiEnabled = true;
  tokenStore = await createTokenStore({
    home,
    rootToken: 'ROOT',
    ephemeralTokens: [{ appId: 'desktop-client', appName: 'Gezel', scopes: ['ui'], token: 'UI' }],
  });
  await build();
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true }).catch(() => {});
});

function enroll(
  key: string,
  headers: Record<string, string> = { Origin: OFFICE_ORIGIN, 'Sec-Fetch-Site': 'same-origin' },
): Promise<Response> {
  return Promise.resolve(
    app.request('http://localhost/v1/apps/office/enroll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ key }),
    }),
  );
}

function localConnect(appId: string, bearer = 'UI'): Promise<Response> {
  return Promise.resolve(
    app.request('http://localhost/v1/apps/local-connect', {
      method: 'POST',
      headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId }),
    }),
  );
}

describe('Office pane enrollment', () => {
  it('trades the manifest key for the shared office grant, without a code', async () => {
    const res = await enroll(KEY);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { appId: string; scopes: string[]; token: string };
    expect(body).toMatchObject({ appId: 'office', scopes: ['product'] });
    expect(tokenStore.lookup(body.token)).toMatchObject({ appId: 'office', scopes: ['product'] });

    // Excel's pane keeps its own storage: it enrolls too and gets the same grant.
    const again = (await (await enroll(KEY)).json()) as { token: string };
    expect(again.token).toBe(body.token);
  });

  it('refuses a wrong key and issues nothing', async () => {
    const res = await enroll('not-the-enrollment-key-at-all');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'enrollment_key_invalid' });
    expect(tokenStore.list().some((r) => r.appId === 'office')).toBe(false);
  });

  it('refuses browser requests from any other origin, even with the key', async () => {
    const res = await enroll(KEY, {
      Origin: 'https://example.com',
      'Sec-Fetch-Site': 'cross-site',
    });
    expect(res.status).toBe(403);
    expect(tokenStore.list().some((r) => r.appId === 'office')).toBe(false);
  });

  it('only takes JSON, and slows down guessing', async () => {
    const form = await app.request('http://localhost/v1/apps/office/enroll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: OFFICE_ORIGIN },
      body: `key=${KEY}`,
    });
    expect(form.status).toBe(415);
    for (let i = 0; i < 10; i += 1) {
      expect((await enroll(`wrong-key-number-${i}-padding`)).status).toBe(403);
    }
    expect((await enroll(KEY)).status).toBe(429);
  });

  it('does not exist where Office cannot be set up', async () => {
    await build({ verifyOfficeEnrollmentKey: undefined } as Partial<ServiceContext>);
    expect((await enroll(KEY)).status).toBe(404);
  });
});

describe('local add-in connection', () => {
  it('trades the owner credential for a narrower VS Code grant, stable across calls', async () => {
    const res = await localConnect('vscode');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { appId: string; scopes: string[]; token: string };
    expect(body).toMatchObject({ appId: 'vscode', scopes: ['product', 'openai'] });
    expect(tokenStore.lookup(body.token)).toMatchObject({ appId: 'vscode' });
    const again = (await (await localConnect('vscode')).json()) as { token: string };
    expect(again.token).toBe(body.token);
  });

  it('is only for the owner, and only for Gezel add-ins', async () => {
    const office = (await (await enroll(KEY)).json()) as { token: string };
    expect((await localConnect('vscode', office.token)).status).toBe(403);
    expect((await localConnect('vscode', 'nope')).status).toBe(401);
    const other = await localConnect('some-third-party-app');
    expect(other.status).toBe(400);
    expect(tokenStore.list().some((r) => r.appId === 'some-third-party-app')).toBe(false);
  });

  it('respects the OpenAI endpoints switch for the add-in that uses them', async () => {
    openaiEnabled = false;
    expect((await localConnect('vscode')).status).toBe(403);
    expect((await localConnect('libreoffice')).status).toBe(200);
  });
});
