/**
 * Against real loopback HTTPS on a self-signed certificate — the case where a
 * plain `new GezelClient({ baseUrl, token })` fails with
 * DEPTH_ZERO_SELF_SIGNED_CERT — and across the restarts that move the port and
 * rotate the token, which a copied configuration cannot survive.
 */
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { type IncomingMessage, createServer as createHttpServer } from 'node:http';
import { type Server, createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gezelPaths } from '@bendyline/gezel/paths';
import { afterEach, describe, expect, it } from 'vitest';
import { DaemonNotRunningError } from './discover-or-spawn.js';
import { connectToLocalGezel } from './local-gezel.js';

const fixture = (name: string) =>
  readFile(new URL(`./test-fixtures/tls/${name}.pem`, import.meta.url), 'utf8');

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function listen(server: Server | ReturnType<typeof createHttpServer>): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return (server.address() as AddressInfo).port;
}

/** A stand-in service that accepts one token at a time. */
async function fakeService(cert: string, key: string, token: { current: string }) {
  const server = createServer({ cert, key }, (req, res) => {
    if (req.headers.authorization !== `Bearer ${token.current}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      req.url === '/api/health'
        ? JSON.stringify({ ok: true, version: 'test', startedAt: new Date(0).toISOString() })
        : JSON.stringify({ gezels: [{ id: 'mira', name: 'Mira' }] }),
    );
  });
  const port = await listen(server);
  return { server, port };
}

async function writeRuntime(home: string, runtime: { port: number; token: string; cert: string }) {
  const paths = gezelPaths(home).runtime;
  await mkdir(paths.dir, { recursive: true });
  await Promise.all([
    writeFile(paths.port, String(runtime.port)),
    writeFile(paths.token, runtime.token),
    writeFile(paths.pid, String(process.pid)),
    writeFile(paths.cert, runtime.cert),
  ]);
}

async function tempHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'gezel-local-client-'));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  return home;
}

describe('connectToLocalGezel', () => {
  it('reaches a self-signed service with no port, token, or certificate from the caller', async () => {
    const [cert, key] = await Promise.all([fixture('server'), fixture('server-key')]);
    const home = await tempHome();
    const token = { current: 'launch-1' };
    const { port } = await fakeService(cert, key, token);
    await writeRuntime(home, { port, token: token.current, cert });

    // The failure the README quick start produced: Node's own fetch refuses it.
    await expect(fetch(`https://127.0.0.1:${port}/api/health`)).rejects.toThrow(/fetch failed/);

    const local = await connectToLocalGezel({ home });
    cleanups.push(() => local.close());
    await expect(local.client.listGezels()).resolves.toMatchObject({
      gezels: [{ id: 'mira' }],
    });
  });

  it('follows the service to its next launch: new port, new token', async () => {
    const [cert, key] = await Promise.all([fixture('server'), fixture('server-key')]);
    const home = await tempHome();
    const first = await fakeService(cert, key, { current: 'launch-1' });
    await writeRuntime(home, { port: first.port, token: 'launch-1', cert });
    const local = await connectToLocalGezel({ home });
    cleanups.push(() => local.close());

    const closed = new Promise<void>((resolve) => first.server.close(() => resolve()));
    first.server.closeAllConnections();
    await closed;
    const second = await fakeService(cert, key, { current: 'launch-2' });
    await writeRuntime(home, { port: second.port, token: 'launch-2', cert });

    await expect(local.client.listGezels()).resolves.toMatchObject({ gezels: [{ id: 'mira' }] });
  });

  it('picks up a rotated token when the service rejects the old one', async () => {
    const [cert, key] = await Promise.all([fixture('server'), fixture('server-key')]);
    const home = await tempHome();
    const token = { current: 'launch-1' };
    const { port } = await fakeService(cert, key, token);
    await writeRuntime(home, { port, token: token.current, cert });
    const local = await connectToLocalGezel({ home });
    cleanups.push(() => local.close());

    token.current = 'launch-2';
    await writeRuntime(home, { port, token: token.current, cert });

    await expect(local.client.listGezels()).resolves.toMatchObject({ gezels: [{ id: 'mira' }] });
  });

  it('never sends the token anywhere but the service', async () => {
    const [cert, key] = await Promise.all([fixture('server'), fixture('server-key')]);
    const home = await tempHome();
    const { port } = await fakeService(cert, key, { current: 'launch-1' });
    await writeRuntime(home, { port, token: 'launch-1', cert });
    const local = await connectToLocalGezel({ home });
    cleanups.push(() => local.close());

    let seen: IncomingMessage['headers'] | undefined;
    const elsewhere = createHttpServer((req, res) => {
      seen = req.headers;
      res.end('ok');
    });
    const otherPort = await listen(elsewhere);
    await (await local.fetch(`http://127.0.0.1:${otherPort}/`)).text();

    expect(seen?.authorization).toBeUndefined();
  });

  it('says how to start Gezel when it is not running', async () => {
    const home = await tempHome();
    await expect(connectToLocalGezel({ home })).rejects.toBeInstanceOf(DaemonNotRunningError);
    await expect(connectToLocalGezel({ home })).rejects.toThrow(
      /Start it from the Gezel app, or run `gezel start`/,
    );
  });
});
