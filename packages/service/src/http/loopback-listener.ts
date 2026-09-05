import { createSecureServer } from 'node:http2';
import type { Socket } from 'node:net';
import { type ServerType, serve } from '@hono/node-server';
import type { LoopbackCert } from './cert.js';

const connections = new WeakMap<ServerType, Set<Socket>>();

/** Both daemon roles use the same loopback-only, pinned TLS transport. */
export function listenLoopback(
  fetch: Parameters<typeof serve>[0]['fetch'],
  cert: LoopbackCert | null,
  port: number,
): Promise<{ server: ServerType; port: number }> {
  return new Promise((resolve, reject) => {
    const server = serve(
      {
        fetch,
        port,
        hostname: '127.0.0.1',
        ...(cert
          ? {
              createServer: createSecureServer,
              serverOptions: {
                key: cert.keyPem,
                cert: cert.certPem,
                allowHTTP1: true,
                minVersion: 'TLSv1.3',
                ALPNProtocols: ['h2', 'http/1.1'],
              },
            }
          : {}),
      },
      (info) => resolve({ server, port: info.port }),
    );
    const sockets = new Set<Socket>();
    connections.set(server, sockets);
    server.on('connection', (socket: Socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
    server.once('error', reject);
  });
}

export async function closeLoopbackListener(server: ServerType): Promise<void> {
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  for (const socket of connections.get(server) ?? []) socket.destroy();
  await closed;
  connections.delete(server);
}
