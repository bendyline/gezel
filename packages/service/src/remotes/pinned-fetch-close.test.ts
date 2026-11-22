import { type Server, createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import {
  closePairedRemoteFetches,
  createPinnedFetch,
  getPairedRemoteFetch,
} from '@bendyline/gezel-inference/internal/remotes/pinned-fetch';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type LoopbackCert, generateLoopbackCert } from '../http/cert.js';
import type { PairedRemote, RemotesRegistry } from './registry.js';

// A status feed the UI holds open: headers and one event, then nothing until
// the client hangs up. Quitting with Settings → About open left one of these
// running through the machine-engine bridge, and the bridge's close waited on it.
let cert: LoopbackCert;
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  cert = await generateLoopbackCert();
  server = createServer({ key: cert.keyPem, cert: cert.certPem }, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: ready\n\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 30_000);

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function openStream(fetchImpl: typeof fetch) {
  const response = await fetchImpl(`${baseUrl}/events`);
  const reader = response.body!.getReader();
  await reader.read();
  return reader;
}

function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  return Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
  ]);
}

describe('closing a pinned fetch with a stream still open', () => {
  it('waits for the stream when no grace is given', async () => {
    const pinned = createPinnedFetch(cert.certPem);
    const reader = await openStream(pinned);
    const closing = pinned.close();
    expect(await settlesWithin(closing, 300)).toBe(false);
    await pinned.close({ graceMs: 0 });
    expect(await settlesWithin(closing, 2_000)).toBe(true);
    await expect(reader.read()).rejects.toThrow();
  });

  it('aborts the stream once the grace runs out', async () => {
    const pinned = createPinnedFetch(cert.certPem);
    const reader = await openStream(pinned);
    const startedAt = Date.now();
    await pinned.close({ graceMs: 50 });
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    await expect(reader.read()).rejects.toThrow();
  });

  it('lets a paired server go without waiting on its streams', async () => {
    const remote = {
      remoteId: 'machine',
      baseUrl,
      tlsCertPem: cert.certPem,
      pinnedIdentityFingerprint: 'ab'.repeat(32),
    } as PairedRemote;
    const registry = {} as RemotesRegistry;
    const shared = getPairedRemoteFetch(remote, registry);
    const reader = await openStream(shared);

    const closing = closePairedRemoteFetches(registry, remote.remoteId, { graceMs: 50 });
    expect(await settlesWithin(closing, 2_000)).toBe(true);
    await expect(reader.read()).rejects.toThrow();
    expect(getPairedRemoteFetch(remote, registry)).not.toBe(shared);
    await closePairedRemoteFetches(registry);
  });
});
