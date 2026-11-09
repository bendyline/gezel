import { connect } from 'node:http2';
import { describe, expect, it } from 'vitest';
import { generateLoopbackCert } from './cert.js';
import { closeLoopbackListener, listenLoopback } from './loopback-listener.js';

const BIG_BODY = 'x'.repeat(4 * 1024 * 1024);

describe('listenLoopback', () => {
  // A renderer busy parsing a large response stops reading it, and Node counts
  // the unread bytes against the connection. Past its 10 MB default every new
  // request on that connection was refused with ENHANCE_YOUR_CALM: the toolset
  // catalog alone is 19 MB.
  it('keeps answering while large responses wait for a slow reader', async () => {
    const cert = await generateLoopbackCert();
    const { server, port } = await listenLoopback(
      (req) => new Response(new URL(req.url).pathname === '/big' ? BIG_BODY : 'ok'),
      cert,
      0,
    );
    const client = connect(`https://127.0.0.1:${port}`, { rejectUnauthorized: false });
    client.on('error', () => {});
    try {
      for (let i = 0; i < 4; i++) {
        const stream = client.request({ ':path': '/big' });
        stream.on('error', () => {});
        stream.pause();
        stream.end();
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
      const outcomes = await Promise.all(
        Array.from(
          { length: 10 },
          () =>
            new Promise<string>((resolve) => {
              const stream = client.request({ ':path': '/small' });
              let body = '';
              stream.setEncoding('utf8');
              stream.on('data', (chunk: string) => {
                body += chunk;
              });
              stream.on('end', () => resolve(body));
              stream.on('close', () => resolve(body || `reset ${stream.rstCode}`));
              stream.on('error', () => {});
              stream.end();
            }),
        ),
      );
      expect(outcomes).toEqual(Array(10).fill('ok'));
    } finally {
      client.destroy();
      await closeLoopbackListener(server);
    }
  }, 30_000);
});
