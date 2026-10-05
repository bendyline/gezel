import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { bearerAuth, requireScope } from '../auth.js';
import type { ServiceContext } from '../context.js';
import { createTokenStore } from '../token-store.js';
import { v1KnowledgeRoutes } from './v1-knowledge.js';

const catalog = {
  ref: { catalogId: 'science', version: '1' },
  enabled: true,
  mounted: true,
  source: 'gilde',
  updateAvailable: false,
};
function fixture() {
  const score = vi.fn(async () => ({ status: 'scored', scores: [0.2, 0.9] }));
  const search = vi.fn(async () => [
    { uri: 'knowledge://pub/science/a' },
    { uri: 'knowledge://pub/science/b' },
  ]);
  const install = vi.fn(() => ({ jobId: 'science' }));
  const remove = vi.fn(async () => true);
  const forSurface = vi.fn(async () => ({
    model: { id: 'reranker' },
    thresholds: null,
  }));
  const ctx = {
    knowledge: {
      list: async () => [catalog],
      available: async () => [
        {
          id: 'science',
          name: 'Science',
          description: 'Reference',
          version: '2',
          archiveBytes: 20,
          documents: 2,
        },
      ],
      activeInstalls: () => [],
      getJob: () => undefined,
      startInstall: install,
      remove,
      setEnabled: vi.fn(async () => true),
      cancelJob: vi.fn(),
      searchUnified: search,
      resolveCitation: async (uri: string) => ({
        ok: true,
        uri: { catalogId: 'science' },
        title: uri.endsWith('a') ? 'A' : 'B',
        catalogVersion: '1',
        chunk: { text: uri.endsWith('a') ? 'Less relevant' : 'Best passage' },
      }),
    },
    relevance: {
      forSurface,
      scorer: { score },
      status: async () => ({
        models: [{ id: 'reranker', installed: true }],
        modelId: 'reranker',
      }),
      setting: async () => ({ spec: { id: 'reranker' } }),
      install: vi.fn(async () => ({ started: true })),
    },
  } as unknown as Pick<ServiceContext, 'knowledge' | 'relevance'>;
  const app = new Hono();
  app.onError((error, c) => c.json({ error: error.message }, 400));
  app.route('/v1/knowledge', v1KnowledgeRoutes(ctx));
  const request = (path: string, body: unknown) =>
    app.request(`/v1/knowledge/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  return { app, ctx, request, score, search, forSurface, install, remove };
}
const query = {
  query: 'science',
  rerank: 'required',
  maxResults: 1,
  maxCharacters: 200,
};
describe('app knowledge boundary', () => {
  it('requires the dedicated knowledge grant', async () => {
    const { ctx } = fixture();
    const home = await mkdtemp(join(tmpdir(), 'app-knowledge-'));
    const tokens = await createTokenStore({ home, rootToken: 'root' });
    const denied = await tokens.issue({
      appId: 'plain',
      appName: 'Plain',
      scopes: ['openai'],
    });
    const granted = await tokens.issue({
      appId: 'reader',
      appName: 'Reader',
      scopes: ['knowledge'],
    });
    const app = new Hono();
    app.use('*', bearerAuth(tokens));
    app.use('*', requireScope('knowledge'));
    app.route('/v1/knowledge', v1KnowledgeRoutes(ctx));
    try {
      expect(
        (
          await app.request('/v1/knowledge/state', {
            headers: { authorization: `Bearer ${denied.token}` },
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await app.request('/v1/knowledge/state', {
            headers: { authorization: `Bearer ${granted.token}` },
          })
        ).status,
      ).toBe(200);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
  it('reranks before limiting and injects only bounded passages', async () => {
    const f = fixture();
    const response = await f.request('retrieve', query);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      reranked: true,
      passages: [{ title: 'B', text: 'Best passage' }],
    });
    expect(f.forSurface).toHaveBeenCalledWith('search', { enabled: true });
    expect(f.score).toHaveBeenCalledWith(
      expect.objectContaining({
        waitForLoad: true,
        passages: ['Less relevant', 'Best passage'],
      }),
    );
  });
  it('refuses missing, partial, cold, and failed reranking', async () => {
    for (const status of ['partial', 'cold', 'timeout', 'unavailable']) {
      const f = fixture();
      f.score.mockResolvedValue({ status, scores: [] });
      const response = await f.request('retrieve', query);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: { code: 'reranker_required' },
      });
    }
    const f = fixture();
    f.forSurface.mockResolvedValue(null as never);
    expect((await f.request('retrieve', query)).status).toBe(409);
    expect(f.search).not.toHaveBeenCalled();
  });
  it('does not download during state reads or retrieval', async () => {
    const f = fixture();
    await f.app.request('/v1/knowledge/state');
    await f.request('retrieve', query);
    expect(f.install).not.toHaveBeenCalled();
    expect(f.search).toHaveBeenCalledWith(
      'science',
      expect.objectContaining({ localModelsOnly: true, vector: null }),
    );
    expect(f.ctx.relevance.install).not.toHaveBeenCalled();
  });
  it('admits catalog IDs only, rejects path/URL installs and unknown fields', async () => {
    const f = fixture();
    for (const body of [
      { action: 'install', catalogId: '../secret' },
      { action: 'install', catalogId: 'science', url: 'https://example.com' },
      { action: 'install', path: 'C:/secret' },
    ])
      expect((await f.request('update', body)).status).toBe(400);
    expect(f.install).not.toHaveBeenCalled();
    expect((await f.request('update', { action: 'install', catalogId: 'science' })).status).toBe(
      200,
    );
    expect(f.install).toHaveBeenCalledWith({
      kind: 'catalog',
      id: 'science',
      placement: 'user',
    });
  });
  it('rejects attempts to disable reranking', async () => {
    const f = fixture();
    expect((await f.request('retrieve', { ...query, rerank: false })).status).toBe(400);
    expect(f.score).not.toHaveBeenCalled();
  });
});
