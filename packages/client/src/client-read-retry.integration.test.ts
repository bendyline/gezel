/**
 * Run the built Node client against real pinned TLS sockets. Both an early
 * reset and a truncated artifact body must recover without replaying writes.
 * The fixture is isolated from the development daemon and never calls a model.
 */
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { expect, it } from 'vitest';

it('recovers artifact reads before headers and during the body in the built client', async () => {
  const { GezelClient, createTrustingFetch } = await import('../dist/node.js');
  const fixture = (name: string) =>
    readFile(new URL(`./test-fixtures/tls/${name}.pem`, import.meta.url), 'utf8');
  const [cert, key] = await Promise.all([fixture('server'), fixture('server-key')]);
  const counts = new Map<string, number>();
  const requests: Array<{ method?: string; url: string; authorization?: string }> = [];
  const artifact = {
    path: 'video-000006/item-5/judge/input.json',
    content: '{"binding":"retained"}',
  };
  const server = createServer({ cert, key }, (req, res) => {
    const url = new URL(req.url!, 'https://fixture');
    const testCase = url.searchParams.get('path') ?? url.pathname;
    const count = (counts.get(testCase) ?? 0) + 1;
    counts.set(testCase, count);
    requests.push({ method: req.method, url: req.url!, authorization: req.headers.authorization });
    if (
      req.method === 'PUT' ||
      testCase === 'persistent' ||
      (testCase === artifact.path && count === 1)
    ) {
      req.socket.destroy();
      return;
    }
    if (testCase === 'body-reset' && count === 1) {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': '4096' });
      res.write('{"path":"partial",');
      setTimeout(() => req.socket.destroy(), 20);
      return;
    }
    if (testCase === 'quota') {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end('{"error":"quota"}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(artifact));
  });
  const transport = createTrustingFetch({ cert, httpVersion: '1.1' });
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const client = new GezelClient({
      baseUrl: `https://127.0.0.1:${(server.address() as AddressInfo).port}`,
      token: 'fixture-owner',
      fetch: transport,
    });
    expect(await client.readProjectArtifact('qualla-internal', artifact.path)).toEqual(artifact);
    expect(await client.readProjectArtifact('qualla-internal', 'body-reset')).toEqual(artifact);
    await expect(client.readProjectArtifact('qualla-internal', 'persistent')).rejects.toMatchObject(
      {
        status: 0,
        details: { readRetryExhausted: true, attempts: 4 },
      },
    );
    await expect(client.readProjectArtifact('qualla-internal', 'quota')).rejects.toMatchObject({
      status: 429,
    });
    await expect(client.updateConfig({})).rejects.toThrow();
    expect(counts.get(artifact.path)).toBe(2);
    expect(counts.get('body-reset')).toBe(2);
    expect(counts.get('persistent')).toBe(4);
    expect(counts.get('quota')).toBe(1);
    expect(counts.get('/api/config')).toBe(1);
    expect(requests.filter((r) => r.method !== 'GET')).toEqual([
      { method: 'PUT', url: '/api/config', authorization: 'Bearer fixture-owner' },
    ]);
    expect(requests.every((r) => r.authorization === 'Bearer fixture-owner')).toBe(true);
  } finally {
    await transport.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}, 10_000);
