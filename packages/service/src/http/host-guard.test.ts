import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { hostGuard } from './host-guard.js';

function guardedApp(allowLanIpHosts: () => boolean) {
  const app = new Hono();
  app.use('*', hostGuard({ allowLanIpHosts }));
  app.get('/', (c) => c.text('ok'));
  return app;
}

describe('hostGuard', () => {
  it('allows loopback hosts and rejects LAN IPs while remote serving is stopped', async () => {
    const app = guardedApp(() => false);
    expect((await app.request('/', { headers: { host: '127.0.0.1:6228' } })).status).toBe(200);
    expect((await app.request('/', { headers: { host: '192.168.1.20:6229' } })).status).toBe(403);
  });

  it('allows literal LAN IP hosts only while the remote listener is active', async () => {
    let listening = true;
    const app = guardedApp(() => listening);
    expect((await app.request('/', { headers: { host: '192.168.1.20:6229' } })).status).toBe(200);
    listening = false;
    expect((await app.request('/', { headers: { host: '192.168.1.20:6229' } })).status).toBe(403);
  });

  it('continues to reject domain names when remote serving is active', async () => {
    const app = guardedApp(() => true);
    expect((await app.request('/', { headers: { host: 'attacker.example:6229' } })).status).toBe(
      403,
    );
  });

  it('validates the request URL authority when HTTP/2 supplies no Host header', async () => {
    const app = guardedApp(() => false);
    expect((await app.request('http://localhost/')).status).toBe(200);
    expect((await app.request('http://attacker.example/')).status).toBe(403);
  });

  it('does not let a benign URL override an explicit hostile Host header', async () => {
    const app = guardedApp(() => false);
    const response = await app.request('http://localhost/', {
      headers: { host: 'attacker.example' },
    });
    expect(response.status).toBe(403);
  });
});
