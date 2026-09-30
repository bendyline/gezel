import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { v1Cors } from './cors.js';

const OFFICE_ORIGIN = 'https://localhost:31234';
const SITE = 'https://tracker.example';

function app(officeOrigin: string | null = OFFICE_ORIGIN): Hono {
  const a = new Hono();
  a.use('/v1/*', v1Cors({ officeHostOrigin: () => officeOrigin }));
  a.get('/v1/*', (c) => c.json({ deviceId: 'd-1' }));
  return a;
}

async function allowOrigin(
  url: string,
  origin: string,
  method: 'GET' | 'OPTIONS' = 'GET',
  target = app(),
): Promise<string | null> {
  const res = await target.request(url, {
    method,
    headers: {
      origin,
      ...(method === 'OPTIONS' ? { 'access-control-request-method': 'GET' } : {}),
    },
  });
  return res.headers.get('access-control-allow-origin');
}

describe('v1Cors', () => {
  it('lets a browser app read the authenticated surface on the main listener', async () => {
    expect(await allowOrigin('https://127.0.0.1:6228/v1/models', SITE)).toBe(SITE);
    expect(await allowOrigin('https://127.0.0.1:6228/v1/models', SITE, 'OPTIONS')).toBe(SITE);
  });

  it('never lets a page read an unauthenticated endpoint, on any listener', async () => {
    // `/v1/identity` carries a device id that survives cookie clearing.
    for (const path of [
      '/v1/identity',
      '/v1/identity/',
      '/v1/openapi.json',
      '/v1/apps',
      '/v1/apps/register',
    ]) {
      for (const host of ['https://127.0.0.1:6228', OFFICE_ORIGIN]) {
        expect(await allowOrigin(`${host}${path}`, SITE), `${host}${path}`).toBeNull();
        expect(await allowOrigin(`${host}${path}`, SITE, 'OPTIONS'), `${host}${path}`).toBeNull();
      }
    }
    expect(await allowOrigin('https://127.0.0.1:6228/v1/identityx', SITE)).toBe(SITE);
  });

  it('answers only the task pane on the Office listener, whose certificate every browser trusts', async () => {
    const office = `${OFFICE_ORIGIN}/v1/models`;
    expect(await allowOrigin(office, SITE)).toBeNull();
    expect(await allowOrigin(office, SITE, 'OPTIONS')).toBeNull();
    expect(await allowOrigin(office, 'http://localhost:5173')).toBeNull();
    expect(await allowOrigin(office, OFFICE_ORIGIN)).toBe(OFFICE_ORIGIN);
    // The listener is told apart by the Host header, as the host guard reads it.
    const res = await app().request('https://127.0.0.1:6228/v1/models', {
      headers: { origin: SITE, host: 'localhost:31234' },
    });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('treats every listener as the main one while Office is not set up', async () => {
    expect(await allowOrigin(`${OFFICE_ORIGIN}/v1/models`, SITE, 'GET', app(null))).toBe(SITE);
  });
});
