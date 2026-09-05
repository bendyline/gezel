import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { createTrustingFetch } from './node-tls.js';

const fixture = (name: string) =>
  readFile(new URL(`./test-fixtures/tls/${name}.pem`, import.meta.url), 'utf8');

describe('Node TLS transport', () => {
  it('accepts the pinned daemon, rejects a different trust anchor, and releases connections', async () => {
    const [cert, key, untrusted] = await Promise.all([
      fixture('server'),
      fixture('server-key'),
      fixture('untrusted'),
    ]);
    const server = createServer({ cert, key }, (_req, response) => response.end('trusted daemon'));
    const trusted = createTrustingFetch({ cert });
    const rejected = createTrustingFetch({ cert: untrusted });
    try {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const url = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
      expect(await (await trusted(url)).text()).toBe('trusted daemon');
      await expect(rejected(url)).rejects.toThrow(/fetch failed/);
      await trusted.close();
      await expect(trusted(url)).rejects.toThrow();
    } finally {
      await Promise.all([trusted.destroy(), rejected.destroy()]);
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
