import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTrustingFetch } from '@bendyline/gezel-client/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { oauthClientSecretKey } from '../../connectors/oauth.js';
import { type RunningService, startService } from '../../service.js';

/**
 * The bring-your-own OAuth app registry over real HTTP: set/list/clear, the
 * write-only secret contract, and key hygiene.
 */

let svc: RunningService;
let baseUrl: string;
let token: string;
let home: string;
let httpFetch: typeof fetch;

const priorMockFlag = process.env.GEZEL_MOCK_PROVIDER;

beforeAll(async () => {
  process.env.GEZEL_MOCK_PROVIDER = '1';
  home = await mkdtemp(join(tmpdir(), 'gezel-oauth-clients-'));
  svc = await startService({ home });
  const scheme = svc.cert ? 'https' : 'http';
  baseUrl = `${scheme}://127.0.0.1:${svc.port}`;
  token = svc.context.token;
  httpFetch = svc.cert ? createTrustingFetch({ cert: svc.cert.certPem }) : fetch;
}, 60_000);

afterAll(async () => {
  await svc.stop();
  await rm(home, { recursive: true, force: true }).catch(() => {});
  if (priorMockFlag === undefined) delete process.env.GEZEL_MOCK_PROVIDER;
  else process.env.GEZEL_MOCK_PROVIDER = priorMockFlag;
}, 30_000);

function call(method: string, path: string, body?: unknown, auth = true) {
  return httpFetch(`${baseUrl}/api/oauth-clients${path}`, {
    method,
    headers: {
      ...(auth ? { Authorization: `Bearer ${token}` } : {}),
      'Content-Type': 'application/json',
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

describe('/api/oauth-clients', () => {
  it('rejects unauthenticated callers', async () => {
    expect((await call('GET', '', undefined, false)).status).toBe(401);
    expect((await call('PUT', '/GEZEL_X_CLIENT_ID', { clientId: 'x' }, false)).status).toBe(401);
  });

  it('registers a client, lists it without the secret, and clears it', async () => {
    const put = await call('PUT', '/GEZEL_X_CLIENT_ID', {
      clientId: '  my-public-id  ',
      clientSecret: 'shh-secret',
    });
    expect(put.status).toBe(200);

    const list = await call('GET', '');
    expect(list.status).toBe(200);
    const body = (await list.json()) as {
      clients: Array<{ key: string; clientId: string; hasSecret: boolean }>;
    };
    expect(body.clients).toEqual([
      { key: 'GEZEL_X_CLIENT_ID', clientId: 'my-public-id', hasSecret: true },
    ]);
    // The secret never appears in any response body.
    expect(JSON.stringify(body)).not.toContain('shh-secret');
    // It landed in the SecretStore under the shared oauth-client namespace.
    expect(await svc.context.secrets.get(oauthClientSecretKey('GEZEL_X_CLIENT_ID'))).toBe(
      'shh-secret',
    );

    // Explicit null clears just the secret; the client id stays.
    const clear = await call('PUT', '/GEZEL_X_CLIENT_ID', {
      clientId: 'my-public-id',
      clientSecret: null,
    });
    expect(clear.status).toBe(200);
    const after = (await (await call('GET', '')).json()) as {
      clients: Array<{ hasSecret: boolean }>;
    };
    expect(after.clients[0]?.hasSecret).toBe(false);

    const del = await call('DELETE', '/GEZEL_X_CLIENT_ID');
    expect(del.status).toBe(200);
    const empty = (await (await call('GET', '')).json()) as { clients: unknown[] };
    expect(empty.clients).toEqual([]);
  });

  it('a PKCE public client registers with no secret at all', async () => {
    await call('PUT', '/GEZEL_X_CLIENT_ID', { clientId: 'pkce-only' });
    const body = (await (await call('GET', '')).json()) as {
      clients: Array<{ clientId: string; hasSecret: boolean }>;
    };
    expect(body.clients[0]).toMatchObject({ clientId: 'pkce-only', hasSecret: false });
    await call('DELETE', '/GEZEL_X_CLIENT_ID');
  });

  it('rejects keys that are not GEZEL_* env names', async () => {
    const res = await call('PUT', '/PATH', { clientId: 'x' });
    expect(res.status).toBe(422);
  });
});
