import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type TokenStore, createTokenStore } from '../http/token-store.js';
import { createFirstPartyAppTokens, isFirstPartyLocalAppId } from './first-party-apps.js';

let home: string;
let tokenStore: TokenStore;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-first-party-apps-'));
  tokenStore = await createTokenStore({ home, rootToken: 'ROOT' });
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const record = (appId: string) => tokenStore.list().find((r) => r.appId === appId);

describe('first-party app tokens', () => {
  it('issues each add-in its fixed scopes under its Connected Apps name', async () => {
    const apps = createFirstPartyAppTokens(tokenStore);
    const token = await apps.connect('vscode');
    expect(record('vscode')).toMatchObject({
      appName: 'Visual Studio Code',
      scopes: ['product', 'openai'],
      token,
    });
    await apps.connect('office');
    expect(record('office')).toMatchObject({ appName: 'Microsoft Office', scopes: ['product'] });
  });

  it('hands every Office host the same token instead of revoking the last one', async () => {
    const apps = createFirstPartyAppTokens(tokenStore);
    const [word, excel, powerpoint] = await Promise.all([
      apps.connect('office'),
      apps.connect('office'),
      apps.connect('office'),
    ]);
    expect(excel).toBe(word);
    expect(powerpoint).toBe(word);
    expect(await apps.connect('office')).toBe(word);
    expect(tokenStore.lookup(word)?.appId).toBe('office');
  });

  it('replaces a token for the same app id with the wrong scopes', async () => {
    const squatted = await tokenStore.issue({
      appId: 'office',
      appName: 'Not Office',
      scopes: ['openai'],
    });
    const token = await createFirstPartyAppTokens(tokenStore).connect('office');
    expect(token).not.toBe(squatted.token);
    expect(tokenStore.lookup(squatted.token)).toBeNull();
    expect(record('office')).toMatchObject({ appName: 'Microsoft Office', scopes: ['product'] });
  });

  it('revokes on disconnect, and a later connect mints a new token', async () => {
    const apps = createFirstPartyAppTokens(tokenStore);
    const first = await apps.connect('libreoffice');
    await apps.disconnect('libreoffice');
    expect(tokenStore.lookup(first)).toBeNull();
    await apps.disconnect('libreoffice');
    const second = await apps.connect('libreoffice');
    expect(second).not.toBe(first);
  });

  it('knows only its own add-ins', () => {
    expect(isFirstPartyLocalAppId('office')).toBe(true);
    expect(isFirstPartyLocalAppId('vscode')).toBe(true);
    expect(isFirstPartyLocalAppId('gezel-cli.1234')).toBe(false);
    expect(isFirstPartyLocalAppId('toString')).toBe(false);
  });
});
