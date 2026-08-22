import { describe, expect, it } from 'vitest';
import type { ServiceContext } from '../context.js';
import { searchRoutes } from './search.js';

function context(search: Record<string, unknown>): ServiceContext {
  return { search } as unknown as ServiceContext;
}

describe('/api/search', () => {
  it('passes sourcesIncomplete through to the caller', async () => {
    // Without this the palette can never say "results may be partial": it
    // reads the flag off the response, and the route used to drop it.
    const app = searchRoutes(
      context({
        search: async () => ({ results: [], truncated: true, sourcesIncomplete: true }),
      }),
    );
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'kim', mode: 'full' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ results: [], truncated: true, sourcesIncomplete: true });
  });

  it('omits the flag when every source answered', async () => {
    const app = searchRoutes(context({ search: async () => ({ results: [], truncated: false }) }));
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'kim' }),
    });
    expect(await res.json()).toEqual({ results: [], truncated: false });
  });
});
