import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  close: vi.fn(async () => {}),
  destroy: vi.fn(async () => {}),
  fetch: vi.fn(async (_url: unknown, _init?: { dispatcher?: unknown }) => new Response('ok')),
  options: [] as unknown[],
}));
vi.mock('undici', () => ({
  Agent: class {
    constructor(options: unknown) {
      mocks.options.push(options);
    }
    close = mocks.close;
    destroy = mocks.destroy;
  },
  fetch: mocks.fetch,
}));
import { createPatientFetch, createTrustingFetch } from './node-tls.js';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.options.length = 0;
});
describe('managed Node transport', () => {
  it('pins a CA with hostname validation and caller-owned deadlines, using the matching fetch implementation', async () => {
    const request = createTrustingFetch({ cert: 'test certificate' });
    const signal = new AbortController().signal;
    const result = await request('https://localhost/api', {
      signal,
      headers: { Authorization: 'Bearer test' },
    });
    expect(await result.text()).toBe('ok');
    expect(mocks.options).toEqual([
      {
        connect: { ca: 'test certificate', rejectUnauthorized: true },
        allowH2: true,
        headersTimeout: 0,
        bodyTimeout: 0,
      },
    ]);
    expect(mocks.fetch).toHaveBeenCalledWith(
      'https://localhost/api',
      expect.objectContaining({
        signal,
        dispatcher: expect.anything(),
        headers: { Authorization: 'Bearer test' },
      }),
    );
    await request.close();
  });
  it('owns independent dispatchers and idempotent graceful/forced cleanup', async () => {
    const a = createPatientFetch();
    const b = createPatientFetch();
    await a('http://localhost/a');
    await b('http://localhost/b');
    expect(mocks.fetch.mock.calls[0]?.[1]?.dispatcher).not.toBe(
      mocks.fetch.mock.calls[1]?.[1]?.dispatcher,
    );
    expect(a.close()).toBe(a.close());
    expect(a.destroy()).toBe(a.destroy());
    await b.close();
    expect(mocks.close).toHaveBeenCalledTimes(2);
    expect(mocks.destroy).toHaveBeenCalledTimes(1);
    expect(mocks.options).toEqual([
      { headersTimeout: 0, bodyTimeout: 0 },
      { headersTimeout: 0, bodyTimeout: 0 },
    ]);
  });
});
