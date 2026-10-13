import { createServer } from 'node:net';

/**
 * Pick a free TCP port on 127.0.0.1 for a native engine child
 * process. Binds to port 0, reads the OS-assigned port, then closes.
 *
 * There's an inherent race — another process could grab the port
 * between close() and the engine's listen() — but the window is
 * microseconds on a loopback binding and the supervisor's health
 * check catches anything weird. Good enough for a single-user
 * desktop app.
 */
export async function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen({ port: 0, host: '127.0.0.1' }, () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        const port = addr.port;
        server.close(() => resolve(port));
      } else {
        server.close();
        reject(new Error('could not determine bound port'));
      }
    });
  });
}
