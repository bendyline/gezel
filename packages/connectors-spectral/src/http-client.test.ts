import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, expect, it } from 'vitest';

const { createClient } = require('@prismatic-io/spectral/dist/clients/http');
let server: ReturnType<typeof createServer>;
let baseUrl: string;
let requests: { url: string; authorization: string | undefined }[];

beforeEach(async () => {
  requests = [];
  server = createServer((req, res) => {
    requests.push({ url: req.url ?? '', authorization: req.headers.authorization });
    if (req.url === '/redirect') {
      res.writeHead(302, { Location: '/records?offset=next' }).end();
      return;
    }
    res
      .writeHead(200, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ records: [{ id: 'one' }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

it('the real Spectral/Axios client preserves JSON, query parameters and auth across a same-origin redirect', async () => {
  const client = createClient({
    baseUrl,
    headers: { Authorization: 'Bearer test-fixture' },
    timeout: 2000,
  });
  const response = await client.get('/redirect', { proxy: false });
  expect(response.data).toEqual({ records: [{ id: 'one' }] });
  expect(requests).toEqual([
    { url: '/redirect', authorization: 'Bearer test-fixture' },
    { url: '/records?offset=next', authorization: 'Bearer test-fixture' },
  ]);
});

it('honors disabled redirects without sending the second request', async () => {
  const client = createClient({ baseUrl, timeout: 2000 });
  await expect(client.get('/redirect', { proxy: false, maxRedirects: 0 })).rejects.toMatchObject({
    response: { status: 302 },
  });
  expect(requests.map(({ url }) => url)).toEqual(['/redirect']);
});

it('honors an explicit HTTP proxy without resolving the remote fixture host', async () => {
  const client = createClient({ baseUrl: 'http://connector.invalid', timeout: 2000 });
  const response = await client.get('/records', {
    params: { offset: 'next' },
    proxy: { protocol: 'http', host: '127.0.0.1', port: (server.address() as AddressInfo).port },
  });
  expect(response.data.records).toEqual([{ id: 'one' }]);
  expect(requests[0]?.url).toBe('http://connector.invalid/records?offset=next');
});
