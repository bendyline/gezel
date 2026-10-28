const assert = require('node:assert/strict');
const net = require('node:net');
const { gzipSync } = require('node:zlib');
const { fetch, Agent } = require(process.argv[2]);

async function main() {
  let requests = 0;
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.once('data', () => {
      if (++requests === 1) {
        socket.end(
          'HTTP/1.1 200 OK\r\nContent-Encoding: gzip, gzip, gzip, gzip, gzip, gzip\r\nContent-Length: 100\r\nConnection: close\r\n\r\n',
        );
      } else {
        const body = gzipSync('still-alive');
        socket.end(
          Buffer.concat([
            Buffer.from(
              `HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`,
            ),
            body,
          ]),
        );
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const agent = new Agent({ headersTimeout: 0, bodyTimeout: 0 });
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    await assert.rejects(fetch(url, { dispatcher: agent, signal: AbortSignal.timeout(5_000) }));
    // Let the orphaned stream error surface; catching fetch alone did not prevent the crash.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const response = await fetch(url, { dispatcher: agent, signal: AbortSignal.timeout(5_000) });
    assert.equal(await response.text(), 'still-alive');
    console.log('malformed-response-rejected; healthy-gzip-ok');
  } finally {
    await agent.destroy();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
