import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { type RequestListener, createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectGezel } from './detect.js';

const fixture = (name: string) =>
  readFile(new URL(`../../client/src/test-fixtures/tls/${name}.pem`, import.meta.url), 'utf8');

describe.each(['http', 'https'] as const)('%s health discovery', (scheme) => {
  it.each(['headers', 'body'] as const)(
    'times out a real stalled %s response and closes its sockets',
    async (phase) => {
      const home = await mkdtemp(join(tmpdir(), 'gezel-hanging-health-'));
      let accepted!: () => void;
      const requestAccepted = new Promise<void>((resolve) => {
        accepted = resolve;
      });
      const listener: RequestListener = (_request, response) => {
        if (phase === 'body') {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.write('{"version":');
        }
        accepted();
        // Intentionally leave this response open until discovery aborts it.
      };
      const cert = scheme === 'https' ? await fixture('server') : null;
      const server = cert
        ? createHttpsServer({ cert, key: await fixture('server-key') }, listener)
        : createHttpServer(listener);
      const sockets = new Set<Socket>();
      server.on('connection', (socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
      });
      try {
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        await mkdir(join(home, 'runtime'));
        await writeFile(
          join(home, 'runtime', 'port'),
          String((server.address() as AddressInfo).port),
        );
        if (cert) await writeFile(join(home, 'runtime', 'cert.pem'), cert);
        const pending = detectGezel({ home, timeoutMs: 300 });
        await Promise.race([
          requestAccepted,
          pending.then(() => {
            throw new Error('Discovery ended before reaching the test listener');
          }),
        ]);
        expect(await pending).toMatchObject({ installed: true, running: false });
        await Promise.all([...sockets].map((socket) => once(socket, 'close')));
        expect(sockets.size).toBe(0);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(home, { recursive: true, force: true });
      }
    },
  );
});
