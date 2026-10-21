import { errorToResponse } from '@bendyline/gezel/runtime';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { classifyMalformedJsonBody } from './json-body.js';

function app(): Hono {
  const a = new Hono();
  a.use('*', classifyMalformedJsonBody());
  a.onError((err, c) => {
    const reply = errorToResponse(err, { exposeUnknown: false });
    return c.json(reply.body, reply.status as 400);
  });
  a.put('/strict', async (c) => c.json({ got: await c.req.json() }));
  a.put('/lenient', async (c) => c.json({ got: await c.req.json().catch(() => ({})) }));
  a.get('/corrupt-file', () => {
    JSON.parse('{ not json');
    return new Response('unreachable');
  });
  return a;
}

const put = (path: string, body: string) =>
  app().request(path, { method: 'PUT', body, headers: { 'content-type': 'application/json' } });

describe('classifyMalformedJsonBody', () => {
  it('answers a malformed body with 400, not 500', async () => {
    const res = await put('/strict', '{"provider": ');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'The request body is not valid JSON.' });
  });

  it('leaves valid bodies and routes that tolerate a missing body alone', async () => {
    expect(await (await put('/strict', '{"a":1}')).json()).toEqual({ got: { a: 1 } });
    const lenient = await put('/lenient', 'nope');
    expect(lenient.status).toBe(200);
    expect(await lenient.json()).toEqual({ got: {} });
  });

  it('keeps a server-side parse failure a server error', async () => {
    const res = await app().request('/corrupt-file');
    expect(res.status).toBe(500);
  });
});
