import type { ConnectorTestExchange } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { checkFakeFidelity } from './fidelity.js';

const recorded: ConnectorTestExchange[] = [
  {
    kind: 'http',
    request: { method: 'GET', url: 'https://api.example/items' },
    response: {
      status: 200,
      body: {
        items: [{ id: 'p-0123456789', title: 'p-abcdef0123', likes: 3 }],
        nextPageToken: 'p-9999999999',
      },
    },
  },
  {
    kind: 'http',
    request: { method: 'GET', url: 'https://api.example/gone' },
    response: { status: 404, body: { error: { code: 404 } } },
  },
];

const fakeAnswering =
  (items: unknown, gone = 404): typeof fetch =>
  async (input) =>
    String(input).endsWith('/gone')
      ? new Response(JSON.stringify({ error: { code: 404 } }), { status: gone })
      : new Response(JSON.stringify(items), { headers: { 'content-type': 'application/json' } });

describe('checkFakeFidelity', () => {
  it('passes a fake that answers in the service shape', async () => {
    const fake = fakeAnswering({
      items: [{ id: 'a', title: 'b', likes: 0 }],
      nextPageToken: 'n',
    });
    expect(await checkFakeFidelity(recorded, fake)).toEqual([]);
  });

  it('flags a fake that is kinder: extra fields, a single page, another type, a success for an error', async () => {
    const fake = fakeAnswering(
      { items: [{ id: 'a', title: 'b', likes: '3', full_text: 'x' }] },
      200,
    );
    const gaps = await checkFakeFidelity(recorded, fake);
    const kinds = gaps.map((g) => `${g.kind} ${g.path}`);
    expect(kinds).toContain('extra $.items[].full_text');
    expect(kinds).toContain('type $.items[].likes');
    expect(kinds).toContain('paging ');
    expect(kinds).toContain('missing $.nextPageToken');
    expect(gaps.some((g) => g.kind === 'status' && g.request.endsWith('/gone'))).toBe(true);
  });
});
