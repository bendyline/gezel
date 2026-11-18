import http from 'node:http';
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { FilterProxy } from './filter-proxy.js';

/** Send a raw CONNECT through the proxy; resolve with the status line. */
function connectThrough(proxyPort: number, target: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = net.connect(proxyPort, '127.0.0.1', () => {
      s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    });
    s.once('data', (d) => {
      resolve(d.toString('latin1').split('\r\n')[0] ?? '');
      s.destroy();
    });
    s.on('error', reject);
  });
}

function plainThrough(proxyPort: number, url: string, method = 'GET'): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: proxyPort,
        method,
        path: url,
        headers: { host: new URL(url).host },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('FilterProxy', () => {
  const opened: FilterProxy[] = [];
  const servers: http.Server[] = [];
  afterEach(async () => {
    for (const p of opened.splice(0)) await p.close();
    for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
  });

  async function proxy(opts: Parameters<typeof FilterProxy.start>[0]) {
    const p = await FilterProxy.start(opts);
    opened.push(p);
    return p;
  }

  it('refuses loopback, private, link-local and metadata targets', async () => {
    const p = await proxy({
      resolve: async (host) =>
        ({
          'lan.test': ['192.168.1.20'],
          'meta.test': ['169.254.169.254'],
          'rebind.test': ['93.184.216.34', '127.0.0.1'],
        })[host] ?? [],
    });
    p.beginPage('page.test');
    expect(await connectThrough(p.port, '127.0.0.1:443')).toMatch(/403/);
    expect(await connectThrough(p.port, 'localhost:443')).toMatch(/403/);
    expect(await connectThrough(p.port, '[::1]:443')).toMatch(/403/);
    expect(await connectThrough(p.port, 'lan.test:443')).toMatch(/403/);
    expect(await connectThrough(p.port, 'meta.test:443')).toMatch(/403/);
    // One private answer among public ones refuses the host.
    expect(await connectThrough(p.port, 'rebind.test:443')).toMatch(/403/);
    expect(await connectThrough(p.port, 'unknown.test:443')).toMatch(/403/);
    const stats = p.endPage();
    expect(stats.refused.loopback).toBeGreaterThanOrEqual(3);
    expect(stats.refused.metadata).toBe(1);
  });

  it('refuses everything between pages, and other ports', async () => {
    const p = await proxy({ resolve: async () => ['93.184.216.34'] });
    expect(await connectThrough(p.port, 'public.test:443')).toMatch(/403/);
    p.beginPage('public.test');
    expect(await connectThrough(p.port, 'public.test:22')).toMatch(/403/);
    p.endPage();
  });

  it('reaches a private host the person typed only while its own page is captured', async () => {
    const target = http.createServer((_req, res) => res.end('intranet'));
    servers.push(target);
    await new Promise<void>((r) => target.listen(0, '127.0.0.1', () => r()));
    const port = (target.address() as net.AddressInfo).port;
    const p = await proxy({
      privateHosts: ['wiki.corp'],
      extraPorts: [port],
      // The test fixture listens on loopback; production passes no such seam.
      allowLoopbackPorts: [port],
      resolve: async (host) => (host === 'wiki.corp' ? ['10.0.0.5'] : []),
    });
    p.beginPage('news.test');
    expect(await connectThrough(p.port, `wiki.corp:${port}`)).toMatch(/403/);
    p.endPage();
    p.beginPage('wiki.corp');
    // Allowed now. The connect goes to 10.0.0.5, which may not answer here,
    // so wait briefly for whatever comes back rather than for a reply.
    const reply = await new Promise<string>((resolve) => {
      const s = net.connect(p.port, '127.0.0.1', () =>
        s.write(`CONNECT wiki.corp:${port} HTTP/1.1\r\n\r\n`),
      );
      const done = (v: string) => {
        s.destroy();
        resolve(v);
      };
      s.once('data', (d) => done(d.toString('latin1').split('\r\n')[0] ?? ''));
      s.on('error', () => done('error'));
      setTimeout(() => done('pending'), 400);
    });
    expect(reply).not.toMatch(/403/);
    const stats = p.endPage();
    expect(stats.refused.private ?? 0).toBe(0);
    expect(stats.connections).toBe(1);
  });

  it('tunnels to an allowed target and counts the bytes', async () => {
    const target = net.createServer((s) => s.end('hello through the tunnel'));
    await new Promise<void>((r) => target.listen(0, '127.0.0.1', () => r()));
    const port = (target.address() as net.AddressInfo).port;
    const p = await proxy({
      extraPorts: [port],
      allowLoopbackPorts: [port],
      resolve: async () => ['127.0.0.1'],
    });
    p.beginPage('fixture.test');
    const body = await new Promise<string>((resolve, reject) => {
      const s = net.connect(p.port, '127.0.0.1', () =>
        s.write(`CONNECT fixture.test:${port} HTTP/1.1\r\n\r\n`),
      );
      let buf = '';
      s.on('data', (d) => {
        buf += d.toString('latin1');
      });
      s.on('end', () => resolve(buf));
      s.on('error', reject);
    });
    expect(body).toMatch(/200 Connection Established/);
    expect(body).toContain('hello through the tunnel');
    expect(p.endPage().bytes).toBeGreaterThan(0);
    await new Promise<void>((r) => target.close(() => r()));
  });

  it('refuses plain-HTTP POST unless script posts are allowed', async () => {
    const p = await proxy({ resolve: async () => ['93.184.216.34'] });
    p.beginPage('public.test');
    expect(await plainThrough(p.port, 'http://public.test/form', 'POST')).toBe(403);
    expect(await plainThrough(p.port, 'http://127.0.0.1/admin')).toBe(403);
    p.endPage();
  });
});
