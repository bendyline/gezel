/**
 * Real loopback TLS verifies pinning and protocol selection independently of
 * mocked dispatcher options. The HTTP/1.1 workload holds SSE open while batches
 * of uploads wait for each other, catching transport pools that serialize work.
 */
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { type Http2ServerResponse, createSecureServer } from 'node:http2';
import { createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { createTrustingFetch } from './node-tls.js';

const fixture = (name: string) =>
  readFile(new URL(`./test-fixtures/tls/${name}.pem`, import.meta.url), 'utf8');

describe('Node TLS transport', () => {
  it.each(['auto', '1.1'] as const)(
    'accepts only the pinned daemon and releases %s connections',
    async (httpVersion) => {
      const [cert, key, untrusted] = await Promise.all([
        fixture('server'),
        fixture('server-key'),
        fixture('untrusted'),
      ]);
      const server = createServer({ cert, key }, (_req, response) =>
        response.end('trusted daemon'),
      );
      const trusted = createTrustingFetch({ cert, httpVersion });
      const rejected = createTrustingFetch({ cert: untrusted, httpVersion });
      try {
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        const url = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
        expect(await (await trusted(url)).text()).toBe('trusted daemon');
        await expect(rejected(url)).rejects.toThrow(/fetch failed/);
        await expect(trusted(url.replace('127.0.0.1', 'localhost'))).rejects.toMatchObject({
          cause: { code: 'ERR_TLS_CERT_ALTNAME_INVALID' },
        });
        await trusted.close();
        await expect(trusted(url)).rejects.toThrow();
      } finally {
        await Promise.all([trusted.destroy(), rejected.destroy()]);
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    },
  );

  it('keeps parallel uploads and polling moving while HTTP/1.1 SSE stays open', async () => {
    const [cert, key] = await Promise.all([fixture('server'), fixture('server-key')]);
    const versions = new Set<string>();
    const waiting: Array<{ response: ServerResponse | Http2ServerResponse; bytes: number }> = [];
    let eventResponse: ServerResponse | Http2ServerResponse | undefined;
    let eventsClosed = false;
    const server = createSecureServer({ cert, key, allowHTTP1: true }, (req, response) => {
      versions.add(req.httpVersion);
      if (req.url === '/events') {
        eventResponse = response;
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write('data: ready\n\n');
        response.on('close', () => {
          eventsClosed = true;
        });
      } else if (req.url === '/upload') {
        let bytes = 0;
        req.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
        });
        req.on('end', () => {
          waiting.push({ response, bytes });
          if (waiting.length === 5) {
            for (const pending of waiting.splice(0)) pending.response.end(String(pending.bytes));
          }
        });
      } else {
        response.end('ready');
      }
    });
    const transport = createTrustingFetch({ cert, httpVersion: '1.1' });
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 10_000);
    try {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const url = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const stream = await transport(`${url}/events`, { signal: controller.signal });
      const reader = stream.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain('data: ready');
      const payload = Buffer.alloc(2 * 1024 * 1024, 7);
      for (let batch = 0; batch < 3; batch++) {
        const [uploads, polls] = await Promise.all([
          Promise.all(
            Array.from({ length: 5 }, async () => {
              const response = await transport(`${url}/upload`, {
                method: 'POST',
                body: payload,
                signal: controller.signal,
              });
              return Number(await response.text());
            }),
          ),
          Promise.all(
            Array.from({ length: 5 }, async () =>
              (await transport(`${url}/metadata`, { signal: controller.signal })).text(),
            ),
          ),
        ]);
        expect(uploads).toEqual(Array(5).fill(payload.length));
        expect(polls).toEqual(Array(5).fill('ready'));
        expect(eventsClosed).toBe(false);
      }
      expect(versions).toEqual(new Set(['1.1']));
      eventResponse!.end();
      expect((await reader.read()).done).toBe(true);
      await transport.close();
    } finally {
      clearTimeout(deadline);
      controller.abort();
      eventResponse?.end();
      await transport.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }, 15_000);
});
