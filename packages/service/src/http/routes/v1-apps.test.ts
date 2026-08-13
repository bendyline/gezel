import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTrustingFetch } from '@bendyline/gezel-client/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningService, startService } from '../../service.js';
import { v1AppsRoutes } from './v1-apps.js';

let svc: RunningService;
let baseUrl: string;
let rootToken: string;
let uiToken: string;
let home: string;
let httpFetch: typeof fetch;

const priorMockFlag = process.env.GEZEL_MOCK_PROVIDER;

beforeAll(async () => {
  process.env.GEZEL_MOCK_PROVIDER = '1';
  home = await mkdtemp(join(tmpdir(), 'gezel-v1-apps-'));
  svc = await startService({ home });
  const scheme = svc.cert ? 'https' : 'http';
  baseUrl = `${scheme}://127.0.0.1:${svc.port}`;
  rootToken = svc.context.token;
  uiToken = svc.clientToken;
  httpFetch = svc.cert ? createTrustingFetch({ cert: svc.cert.certPem }) : fetch;
}, 30_000);

afterAll(async () => {
  await svc.stop();
  await rm(home, { recursive: true, force: true }).catch(() => {});
  if (priorMockFlag === undefined) delete process.env.GEZEL_MOCK_PROVIDER;
  else process.env.GEZEL_MOCK_PROVIDER = priorMockFlag;
}, 30_000);

function v1(
  method: string,
  path: string,
  opts: { body?: unknown; token?: string } = {},
): Promise<Response> {
  return httpFetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
}

describe('POST /v1/apps/register', () => {
  it('keeps health, UI, and administrative routes off the optional LAN listener', async () => {
    const status = await svc.context.remoteServing.reconfigure({
      enabled: true,
      bindAddress: '127.0.0.1',
      port: 0,
    });
    try {
      const remoteBase = `https://127.0.0.1:${status.port}`;
      expect((await httpFetch(`${remoteBase}/v1/identity`)).status).toBe(200);
      expect((await httpFetch(`${remoteBase}/api/health`)).status).toBe(404);
      expect(
        (
          await httpFetch(`${remoteBase}/v1/apps`, {
            headers: { Authorization: `Bearer ${rootToken}` },
          })
        ).status,
      ).toBe(404);
      expect((await httpFetch(`${remoteBase}/`)).status).toBe(404);
    } finally {
      await svc.context.remoteServing.reconfigure({ enabled: false });
    }
  });

  it('opens a pending grant and returns its id without authentication', async () => {
    const res = await v1('POST', '/v1/apps/register', {
      body: { appId: 'pending-app', appName: 'Pending App', scopes: ['openai'] },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      grantRequestId: string;
      status: string;
      token?: string;
      verificationCode?: string;
    };
    expect(typeof body.grantRequestId).toBe('string');
    expect(body.status).toBe('pending');
    expect(body.token).toBeUndefined();
    expect(body.verificationCode).toBeUndefined();
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("img-src 'self' data: blob:");
    expect(csp).not.toContain('https:');
    expect(csp).not.toContain('webrtc');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('x-dns-prefetch-control')).toBe('off');
  });

  it('rejects an appId that already has an issued token with 409', async () => {
    // Approve a grant for this appId first.
    const first = await v1('POST', '/v1/apps/register', {
      body: { appId: 'duplicate-app', appName: 'Dup', scopes: ['openai'] },
    });
    const { grantRequestId } = (await first.json()) as { grantRequestId: string };
    const approveRes = await v1('POST', `/v1/apps/grant/${grantRequestId}/approve`, {
      token: rootToken,
    });
    expect(approveRes.status).toBe(200);

    const second = await v1('POST', '/v1/apps/register', {
      body: { appId: 'duplicate-app', appName: 'Dup Two', scopes: ['openai'] },
    });
    expect(second.status).toBe(409);
    const body = (await second.json()) as { error: string };
    expect(body.error).toBe('already_connected');
  });

  it('422 on malformed body (missing scopes)', async () => {
    const res = await v1('POST', '/v1/apps/register', {
      body: { appId: 'no-scopes', appName: 'No Scopes' },
    });
    expect(res.status).toBe(422);
  });

  it('rejects oversized unauthenticated registration bodies before parsing', async () => {
    const res = await v1('POST', '/v1/apps/register', {
      body: { appId: 'oversized', appName: 'x'.repeat(20_000), scopes: ['openai'] },
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'request_too_large' });
  });

  it('rejects browser-originated and form-shaped drive-by registrations', async () => {
    const browser = await httpFetch(`${baseUrl}/v1/apps/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://attacker.example',
        'Sec-Fetch-Site': 'cross-site',
      },
      body: JSON.stringify({ appId: 'drive-by', appName: 'Drive By', scopes: ['openai'] }),
    });
    expect(browser.status).toBe(403);
    expect(await browser.json()).toEqual({ error: 'browser_registration_not_allowed' });

    const form = await httpFetch(`${baseUrl}/v1/apps/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ appId: 'form-post', appName: 'Form Post', scopes: ['openai'] }),
    });
    expect(form.status).toBe(415);
    expect(await form.json()).toEqual({ error: 'content_type_must_be_application_json' });
  });

  it('rejects a reserved scope (root) with 400 invalid_scope', async () => {
    const res = await v1('POST', '/v1/apps/register', {
      body: { appId: 'wants-root', appName: 'Wants Root', scopes: ['root'] },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; hint: string };
    expect(body.error).toBe('invalid_scope');
    expect(body.hint).toContain('root');
  });

  it('rejects the Settings-managed Codex app id before creating a grant', async () => {
    // Use an isolated route instance so this negative case does not consume
    // the shared listener's intentionally small registration-rate budget.
    const res = await v1AppsRoutes(svc.context).request('/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        appId: 'gezel.codex.local-model-bridge',
        appName: 'Codex Impostor',
        scopes: ['openai'],
      }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'reserved_app_id' });
    expect(
      svc.context.grants.list().some((grant) => grant.appId === 'gezel.codex.local-model-bridge'),
    ).toBe(false);
  });

  it('rejects an unknown scope with 400 invalid_scope', async () => {
    const res = await v1('POST', '/v1/apps/register', {
      body: { appId: 'wants-bogus', appName: 'Bogus', scopes: ['openai', 'workspace:write'] },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; hint: string };
    expect(body.error).toBe('invalid_scope');
    expect(body.hint).toContain('workspace:write');
  });

  it('accepts the user-approved CLI control scope', async () => {
    const res = await v1('POST', '/v1/apps/register', {
      body: { appId: 'gezel-cli', appName: 'Gezel CLI', scopes: ['cli'] },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      grantRequestId: string;
      status: string;
      verificationRequired?: boolean;
      verificationCode?: string;
    };
    expect(body.status).toBe('pending');
    expect(body.grantRequestId).toBeTruthy();
    expect(body.verificationRequired).toBe(true);
    expect(body.verificationCode).toMatch(/^[2-9A-HJ-KM-NP-TV-Z]{3}-[2-9A-HJ-KM-NP-TV-Z]{3}$/);

    expect(
      (
        await v1('POST', `/v1/apps/grant/${body.grantRequestId}/approve`, {
          token: uiToken,
          body: { verificationCode: body.verificationCode },
        })
      ).status,
    ).toBe(200);
    const approved = await v1('GET', `/v1/apps/grant/${body.grantRequestId}`);
    const grant = (await approved.json()) as { status: string; token: string };
    expect(grant.status).toBe('approved');

    // The approved CLI may use the product API but is not a first-party
    // desktop credential and cannot administer other app grants.
    expect((await v1('GET', '/api/config', { token: grant.token })).status).toBe(200);
    expect((await v1('GET', '/v1/apps', { token: grant.token })).status).toBe(403);
  });

  it('never exposes the CLI verification code in polling or the desktop grant list', async () => {
    const res = await v1('POST', '/v1/apps/register', {
      body: { appId: 'gezel-cli.hidden-code', appName: 'Gezel CLI', scopes: ['cli'] },
    });
    const registered = (await res.json()) as {
      grantRequestId: string;
      verificationCode: string;
    };

    const poll = await v1('GET', `/v1/apps/grant/${registered.grantRequestId}`);
    expect(JSON.stringify(await poll.json())).not.toContain(registered.verificationCode);

    const list = await v1('GET', '/v1/apps', { token: uiToken });
    const body = (await list.json()) as {
      grants: Array<Record<string, unknown>>;
    };
    const listed = body.grants.find((grant) => grant.id === registered.grantRequestId);
    expect(listed).toMatchObject({ verificationRequired: true });
    expect(listed).not.toHaveProperty('verificationCode');
    expect(listed).not.toHaveProperty('verificationCodeHash');
    expect(listed).not.toHaveProperty('verificationCodeSalt');
  });
});

describe('GET /v1/apps/grant/:id', () => {
  it('returns 404 for an unknown grant id', async () => {
    const res = await v1('GET', '/v1/apps/grant/00000000-0000-0000-0000-000000000000');
    expect(res.status).toBe(404);
  });

  it('returns the current pending state on a one-shot poll', async () => {
    const reg = await v1('POST', '/v1/apps/register', {
      body: { appId: 'poll-app', appName: 'Polling App', scopes: ['openai'] },
    });
    const { grantRequestId } = (await reg.json()) as { grantRequestId: string };
    const res = await v1('GET', `/v1/apps/grant/${grantRequestId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; appId: string; token?: string };
    expect(body.status).toBe('pending');
    expect(body.appId).toBe('poll-app');
    expect(body.token).toBeUndefined();
  });

  it('exposes an approved token exactly once', async () => {
    const reg = await v1('POST', '/v1/apps/register', {
      body: { appId: 'approve-app', appName: 'Approve App', scopes: ['openai'] },
    });
    const { grantRequestId } = (await reg.json()) as { grantRequestId: string };
    await v1('POST', `/v1/apps/grant/${grantRequestId}/approve`, { token: rootToken });
    const res = await v1('GET', `/v1/apps/grant/${grantRequestId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; token?: string };
    expect(body.status).toBe('approved');
    expect(body.token).toBeTruthy();

    const second = await v1('GET', `/v1/apps/grant/${grantRequestId}`);
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { status: string; token?: string };
    expect(secondBody).toMatchObject({ status: 'approved' });
    expect(secondBody).not.toHaveProperty('token');

    // The issued token authorizes /api/health -> won't help; need a
    // /v1/ scope to test. We at least confirm it's listed via the root
    // app-listing endpoint.
    const listRes = await v1('GET', '/v1/apps', { token: rootToken });
    const list = (await listRes.json()) as { apps: Array<{ appId: string }> };
    expect(list.apps.map((a) => a.appId)).toContain('approve-app');
  });

  it('returns denied on a denied grant with no token', async () => {
    const reg = await v1('POST', '/v1/apps/register', {
      body: { appId: 'deny-app', appName: 'Deny App', scopes: ['openai'] },
    });
    const { grantRequestId } = (await reg.json()) as { grantRequestId: string };
    await v1('POST', `/v1/apps/grant/${grantRequestId}/deny`, { token: rootToken });
    const res = await v1('GET', `/v1/apps/grant/${grantRequestId}`);
    const body = (await res.json()) as { status: string; token?: string };
    expect(body.status).toBe('denied');
    expect(body.token).toBeUndefined();
  });
});

describe('POST /v1/apps/grant/:id/{approve,deny}', () => {
  it('requires a first-party root/ui scope', async () => {
    const reg = await v1('POST', '/v1/apps/register', {
      body: { appId: 'auth-needed', appName: 'Auth Needed', scopes: ['openai'] },
    });
    const { grantRequestId } = (await reg.json()) as { grantRequestId: string };
    const res = await v1('POST', `/v1/apps/grant/${grantRequestId}/approve`);
    expect(res.status).toBe(401);

    const appToken = await svc.context.tokenStore.issue({
      appId: 'not-an-admin',
      appName: 'Not an admin',
      scopes: ['openai'],
    });
    const appAttempt = await v1('POST', `/v1/apps/grant/${grantRequestId}/approve`, {
      token: appToken.token,
    });
    expect(appAttempt.status).toBe(403);
  });

  it('returns 404 for an unknown grant', async () => {
    const res = await v1('POST', '/v1/apps/grant/00000000-0000-0000-0000-000000000000/approve', {
      token: rootToken,
    });
    expect(res.status).toBe(404);
  });

  it('approve on an already-decided grant returns 409', async () => {
    const reg = await v1('POST', '/v1/apps/register', {
      body: { appId: 'double-approve', appName: 'Double', scopes: ['openai'] },
    });
    const { grantRequestId } = (await reg.json()) as { grantRequestId: string };
    await v1('POST', `/v1/apps/grant/${grantRequestId}/approve`, { token: rootToken });
    const second = await v1('POST', `/v1/apps/grant/${grantRequestId}/approve`, {
      token: rootToken,
    });
    expect(second.status).toBe(409);
  });

  it('requires the code for CLI approval and expires after five incorrect attempts', async () => {
    const reg = await v1('POST', '/v1/apps/register', {
      body: { appId: 'gezel-cli.bad-codes', appName: 'Gezel CLI', scopes: ['cli'] },
    });
    const { grantRequestId } = (await reg.json()) as { grantRequestId: string };

    const missing = await v1('POST', `/v1/apps/grant/${grantRequestId}/approve`, {
      token: uiToken,
    });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ error: 'verification_code_required' });

    for (let attemptsRemaining = 4; attemptsRemaining > 0; attemptsRemaining -= 1) {
      const invalid = await v1('POST', `/v1/apps/grant/${grantRequestId}/approve`, {
        token: uiToken,
        body: { verificationCode: 'ZZZ-ZZZ' },
      });
      expect(invalid.status).toBe(403);
      expect(await invalid.json()).toEqual({
        error: 'verification_code_invalid',
        attemptsRemaining,
      });
    }

    const exhausted = await v1('POST', `/v1/apps/grant/${grantRequestId}/approve`, {
      token: uiToken,
      body: { verificationCode: 'ZZZ-ZZZ' },
    });
    expect(exhausted.status).toBe(429);
    expect(await exhausted.json()).toEqual({ error: 'verification_attempts_exceeded' });

    const poll = await v1('GET', `/v1/apps/grant/${grantRequestId}`);
    expect(await poll.json()).toMatchObject({ status: 'expired' });
  });

  it('rejects a correct code after the ten-minute grant deadline', async () => {
    const reg = await v1('POST', '/v1/apps/register', {
      body: { appId: 'gezel-cli.stale-code', appName: 'Gezel CLI', scopes: ['cli'] },
    });
    const registered = (await reg.json()) as {
      grantRequestId: string;
      verificationCode: string;
    };
    svc.context.grants.get(registered.grantRequestId)!.expiresAt = Date.now() - 1;

    const expired = await v1('POST', `/v1/apps/grant/${registered.grantRequestId}/approve`, {
      token: uiToken,
      body: { verificationCode: registered.verificationCode },
    });
    expect(expired.status).toBe(410);
    expect(await expired.json()).toEqual({ error: 'grant_expired' });
  });
});

describe('GET /v1/apps', () => {
  it('requires authentication', async () => {
    const res = await v1('GET', '/v1/apps');
    expect(res.status).toBe(401);
  });

  it('lets the first-party UI approve and list connected apps without root scope', async () => {
    const reg = await v1('POST', '/v1/apps/register', {
      body: { appId: 'listed-app', appName: 'Listed', scopes: ['openai'] },
    });
    const { grantRequestId } = (await reg.json()) as { grantRequestId: string };
    await v1('POST', `/v1/apps/grant/${grantRequestId}/approve`, { token: uiToken });

    const res = await v1('GET', '/v1/apps', { token: uiToken });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      apps: Array<{ appId: string; scopes: string[] }>;
      grants: Array<{ appId: string; status: string }>;
    };
    const listed = body.apps.find((a) => a.appId === 'listed-app');
    expect(listed).toBeTruthy();
    expect(listed?.scopes).toEqual(['openai']);
    expect(body.grants.find((g) => g.appId === 'listed-app')?.status).toBe('approved');
  });
});

describe('DELETE /v1/apps/:appId/token', () => {
  it('lets an app self-revoke with its own token', async () => {
    const reg = await v1('POST', '/v1/apps/register', {
      body: { appId: 'self-revoke', appName: 'Self', scopes: ['openai'] },
    });
    const { grantRequestId } = (await reg.json()) as { grantRequestId: string };
    await v1('POST', `/v1/apps/grant/${grantRequestId}/approve`, {
      token: rootToken,
    });
    const poll = await v1('GET', `/v1/apps/grant/${grantRequestId}`);
    const approved = (await poll.json()) as { token: string };

    const revoke = await v1('DELETE', '/v1/apps/self-revoke/token', {
      token: approved.token,
    });
    expect(revoke.status).toBe(200);

    // The token is gone — second attempt with the now-revoked token is 401.
    const after = await v1('DELETE', '/v1/apps/self-revoke/token', {
      token: approved.token,
    });
    expect(after.status).toBe(401);
  });

  it('refuses cross-app revocation without root scope', async () => {
    const a = await v1('POST', '/v1/apps/register', {
      body: { appId: 'app-a', appName: 'A', scopes: ['openai'] },
    });
    const ga = (await a.json()) as { grantRequestId: string };
    await v1('POST', `/v1/apps/grant/${ga.grantRequestId}/approve`, {
      token: rootToken,
    });
    const aPoll = await v1('GET', `/v1/apps/grant/${ga.grantRequestId}`);
    const aToken = ((await aPoll.json()) as { token: string }).token;

    const b = await v1('POST', '/v1/apps/register', {
      body: { appId: 'app-b', appName: 'B', scopes: ['openai'] },
    });
    const gb = (await b.json()) as { grantRequestId: string };
    await v1('POST', `/v1/apps/grant/${gb.grantRequestId}/approve`, { token: rootToken });

    // A tries to revoke B — should 403.
    const cross = await v1('DELETE', '/v1/apps/app-b/token', { token: aToken });
    expect(cross.status).toBe(403);
  });

  it('a first-party UI token can revoke any app', async () => {
    const reg = await v1('POST', '/v1/apps/register', {
      body: { appId: 'admin-revoke', appName: 'Admin', scopes: ['openai'] },
    });
    const { grantRequestId } = (await reg.json()) as { grantRequestId: string };
    await v1('POST', `/v1/apps/grant/${grantRequestId}/approve`, { token: rootToken });

    const revoke = await v1('DELETE', '/v1/apps/admin-revoke/token', { token: uiToken });
    expect(revoke.status).toBe(200);

    // Now the app no longer appears in the list.
    const list = await v1('GET', '/v1/apps', { token: uiToken });
    const body = (await list.json()) as { apps: Array<{ appId: string }> };
    expect(body.apps.map((a) => a.appId)).not.toContain('admin-revoke');
  });
});
