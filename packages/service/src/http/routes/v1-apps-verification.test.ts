import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGrantManager } from '../../grants/manager.js';
import type { ServiceContext } from '../context.js';
import { createTokenStore } from '../token-store.js';
import { v1AppsRoutes } from './v1-apps.js';

let home: string;
let app: Hono;
let context: ServiceContext;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-v1-app-code-'));
  const tokenStore = await createTokenStore({
    home,
    rootToken: 'ROOT',
    ephemeralTokens: [
      {
        appId: 'desktop-client',
        appName: 'Gezel Desktop',
        scopes: ['ui'],
        token: 'UI',
      },
    ],
  });
  const grants = await createGrantManager({ home, tokenStore });
  context = {
    tokenStore,
    grants,
    store: { readConfig: async () => ({}) },
  } as unknown as ServiceContext;
  app = new Hono().route('/v1/apps', v1AppsRoutes(context));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true }).catch(() => {});
});

function request(method: string, path: string, body?: unknown): Promise<Response> {
  return Promise.resolve(
    app.request(`http://localhost${path}`, {
      method,
      headers: {
        Authorization: 'Bearer UI',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    }),
  );
}

async function register(
  appId: string,
  options: { scopes?: string[]; requireVerificationCode?: boolean } = {},
): Promise<{
  grantRequestId: string;
  verificationCode: string;
}> {
  const response = await app.request('http://localhost/v1/apps/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      appId,
      appName: appId === 'vscode' ? 'Visual Studio Code' : 'Gezel CLI',
      scopes: options.scopes ?? ['cli'],
      ...(options.requireVerificationCode ? { requireVerificationCode: true } : {}),
    }),
  });
  expect(response.status).toBe(201);
  return response.json() as Promise<{ grantRequestId: string; verificationCode: string }>;
}

describe('v1 app verification approval', () => {
  it('accepts product + openai as a code-protected external app grant', async () => {
    const registered = await register('vscode', {
      scopes: ['product', 'openai'],
    });
    expect(registered.verificationCode).toMatch(
      /^[2-9A-HJ-KM-NP-TV-Z]{3}-[2-9A-HJ-KM-NP-TV-Z]{3}$/,
    );
  });

  it('supports requester-code opt-in for an inference-only client', async () => {
    const registered = await register('vscode', {
      scopes: ['openai'],
      requireVerificationCode: true,
    });
    expect(registered.verificationCode).toMatch(
      /^[2-9A-HJ-KM-NP-TV-Z]{3}-[2-9A-HJ-KM-NP-TV-Z]{3}$/,
    );
  });

  it('requires the requester code and issues the token only after a match', async () => {
    const registered = await register('gezel-cli.route');

    expect(
      (await request('POST', `/v1/apps/grant/${registered.grantRequestId}/approve`)).status,
    ).toBe(400);
    expect(
      (
        await request('POST', `/v1/apps/grant/${registered.grantRequestId}/approve`, {
          verificationCode: 'ZZZ-ZZZ',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request('POST', `/v1/apps/grant/${registered.grantRequestId}/approve`, {
          verificationCode: registered.verificationCode,
        })
      ).status,
    ).toBe(200);

    const poll = await app.request(`http://localhost/v1/apps/grant/${registered.grantRequestId}`);
    await expect(poll.json()).resolves.toMatchObject({
      status: 'approved',
      token: expect.any(String),
    });
  });

  it('enforces the deadline at the approval boundary', async () => {
    const registered = await register('gezel-cli.route-expired');
    context.grants.get(registered.grantRequestId)!.expiresAt = Date.now() - 1;

    const response = await request('POST', `/v1/apps/grant/${registered.grantRequestId}/approve`, {
      verificationCode: registered.verificationCode,
    });
    expect(response.status).toBe(410);
    await expect(response.json()).resolves.toEqual({ error: 'grant_expired' });
  });
});
