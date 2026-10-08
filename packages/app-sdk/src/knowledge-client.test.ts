import { describe, expect, it } from 'vitest';
import { GezelApp } from './client.js';
import { authorize } from './connect.js';

describe('knowledge SDK', () => {
  it('does not reuse an inference-only grant or prompt during a silent scope upgrade', async () => {
    const paths: string[] = [];
    await expect(
      authorize({
        appId: 'docblocks',
        appName: 'DocBlocks',
        scopes: ['openai', 'knowledge'],
        existingToken: 'old',
        baseUrl: 'http://127.0.0.1',
        fetch: async (url) => {
          const path = new URL(String(url)).pathname;
          paths.push(path);
          return path === '/v1/models'
            ? Response.json({ data: [] })
            : Response.json(
                {
                  error: {
                    code: 'missing_scope:knowledge',
                    message: 'Knowledge grant required',
                  },
                },
                { status: 403 },
              );
        },
      }),
    ).rejects.toMatchObject({ code: 'verification_code_handler_required' });
    expect(paths).toEqual(['/v1/models', '/v1/knowledge/state']);
  });
  it('preserves scoped transport, required reranking, and cancellation', async () => {
    const controller = new AbortController();
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const app = new GezelApp({
      baseUrl: 'http://127.0.0.1:1234',
      token: 'app-token',
      fetch: async (url, init) => {
        calls.push({ url: String(url), init });
        return Response.json({ reranked: true, passages: [] });
      },
    });
    const query = {
      query: 'query',
      rerank: 'required' as const,
      maxResults: 4,
      maxCharacters: 4000,
    };
    expect(await app.knowledge.retrieve(query, { signal: controller.signal })).toEqual({
      reranked: true,
      passages: [],
    });
    expect(calls[0]?.url).toBe('http://127.0.0.1:1234/v1/knowledge/retrieve');
    expect(calls[0]?.init?.signal).toBe(controller.signal);
    expect(new Headers(calls[0]?.init?.headers).get('authorization')).toBe('Bearer app-token');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual(query);
  });
  it('defaults to auto retrieval and accepts unranked passages', async () => {
    const bodies: unknown[] = [];
    const app = new GezelApp({
      baseUrl: 'http://127.0.0.1',
      token: 'test',
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return Response.json({ reranked: false, passages: [] });
      },
    });
    expect(
      await app.knowledge.retrieve({ query: 'query', maxResults: 4, maxCharacters: 4000 }),
    ).toEqual({ reranked: false, passages: [] });
    expect(bodies).toEqual([
      { query: 'query', rerank: 'auto', maxResults: 4, maxCharacters: 4000 },
    ]);
  });
  it('answers auto on a Gezel that predates it, without passages when unranked', async () => {
    const sent: string[] = [];
    const app = new GezelApp({
      baseUrl: 'http://127.0.0.1',
      token: 'test',
      fetch: async (_url, init) => {
        const rerank = (JSON.parse(String(init?.body)) as { rerank: string }).rerank;
        sent.push(rerank);
        return rerank === 'auto'
          ? Response.json({ error: 'Invalid enum value' }, { status: 422 })
          : Response.json(
              { error: { code: 'reranker_required', message: 'Download the relevance model.' } },
              { status: 409 },
            );
      },
    });
    const query = { query: 'query', maxResults: 4, maxCharacters: 4000 };
    expect(await app.knowledge.retrieve(query)).toEqual({ reranked: false, passages: [] });
    expect(await app.knowledge.retrieve(query)).toEqual({ reranked: false, passages: [] });
    // The second call goes straight to the mode that Gezel understands.
    expect(sent).toEqual(['auto', 'required', 'required']);
  });
  it('offers the improvement download only when a catalog would use it', async () => {
    const catalog = {
      id: 'science',
      name: 'Science',
      description: '',
      version: '1',
      installedVersion: '1',
      enabled: true,
      updateAvailable: false,
      downloadBytes: null,
      documents: null,
      state: 'installed',
      percent: null,
      message: null,
    };
    const missing = { ready: false, downloading: false, percent: null, downloadBytes: 300 };
    const offer = async (catalogs: unknown[], relevance: () => Response) => {
      const app = new GezelApp({
        baseUrl: 'http://127.0.0.1',
        token: 'test',
        fetch: async (url) =>
          new URL(String(url)).pathname.endsWith('/relevance')
            ? relevance()
            : Response.json({
                catalogs,
                reranker: { ready: false, downloading: false, message: null },
              }),
      });
      return (await app.knowledge.state()).improvement;
    };
    expect(await offer([catalog], () => Response.json(missing))).toEqual({
      downloadBytes: 300,
      downloading: false,
      percent: null,
    });
    expect(await offer([{ ...catalog, enabled: false }], () => Response.json(missing))).toBe(null);
    expect(await offer([catalog], () => Response.json({ ...missing, ready: true }))).toBe(null);
    expect(await offer([catalog], () => Response.json({ ...missing, downloadBytes: null }))).toBe(
      null,
    );
    // A Gezel without the route: a 404, or its UI shell for unknown paths.
    expect(
      await offer([catalog], () => Response.json({ error: 'not found' }, { status: 404 })),
    ).toBe(null);
    expect(await offer([catalog], () => new Response('<!doctype html>'))).toBe(null);
  });
  it('rejects malformed and unranked responses', async () => {
    for (const response of [
      { reranked: false, passages: [] },
      { reranked: true, passages: [], extra: 1 },
    ]) {
      const app = new GezelApp({
        baseUrl: 'http://127.0.0.1',
        token: 'test',
        fetch: async () => Response.json(response),
      });
      await expect(
        app.knowledge.retrieve({
          query: 'query',
          rerank: 'required',
          maxResults: 4,
          maxCharacters: 4000,
        }),
      ).rejects.toThrow();
    }
  });
});
