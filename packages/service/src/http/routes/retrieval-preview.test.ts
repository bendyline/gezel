import type {
  GezelConfig,
  GezelDetail,
  RetrievalPreviewResponse,
  UnifiedSearchResult,
} from '@bendyline/gezel';
import { describe, expect, it, vi } from 'vitest';
import type { Store } from '../../fs/store.js';
import { retrieveProjectContext } from '../../search/project-retrieval.js';
import type { SearchService } from '../../search/search-service.js';
import { scoreResult } from '../../search/search-service.js';
import type { ServiceContext } from '../context.js';
import { retrievalPreviewRoutes } from './retrieval-preview.js';

const RESULTS: UnifiedSearchResult[] = [
  {
    kind: 'content',
    id: 'content:p1:src/joints.ts:1',
    title: 'joints.ts',
    snippet: 'corner joints',
    projectId: 'p1',
    path: 'src/joints.ts',
    retrievalSource: 'workspace',
    line: 1,
    ...scoreResult('content', 0.9),
  },
  {
    kind: 'knowledge',
    id: 'knowledge:shop:dovetails:a',
    title: 'Dovetail Joints',
    snippet: 'Tails and pins interlock to form a strong corner joint.',
    retrievalSource: 'knowledge',
    catalogId: 'shop-notes',
    uri: 'knowledge://gezel-tests/shop-notes/dovetails#chunk=a',
    // As the knowledge manager labels a hit that cleared its catalog's floor.
    arm: 'vector',
    similarity: 0.8,
    ...scoreResult('knowledge', 0.8),
  },
];

const store = {
  getProject: async (id: string) => (id === 'p1' ? { id: 'p1' } : null),
  readConfig: async () => ({ meesterGezelId: 'g1' }) as GezelConfig,
  getGezel: async (id: string) => ({ id, parsed: { frontmatter: {} } }) as unknown as GezelDetail,
  linkedProjectIds: async () => [],
  readTask: async () => null,
  readProjectWorkspaceFile: async () => 'corner joints cut by hand\nline two',
  readProjectArtifact: async () => null,
  readDocumentAsMarkdown: async () => null,
} as unknown as Store;

const search = {
  searchProject: async () => ({ results: RESULTS, truncated: false }),
} as unknown as SearchService;

function app() {
  const history = { log: vi.fn(async () => {}) };
  const ctx = { store, search, history } as unknown as ServiceContext;
  return { routes: retrievalPreviewRoutes(ctx), history };
}

async function preview(body: Record<string, unknown>, project = 'p1') {
  const { routes, history } = app();
  const res = await routes.request(`/${project}/retrieval/preview`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as RetrievalPreviewResponse, history };
}

describe('POST /api/projects/:id/retrieval/preview', () => {
  const query = 'how do I cut strong corner joints by hand?';

  it('keeps exactly what the live turn would, and writes nothing', async () => {
    const live = await retrieveProjectContext({
      store,
      search,
      record: { id: 's', projectId: 'p1', gezelId: 'g1' },
      gezel: (await store.getGezel('g1'))!,
      config: await store.readConfig(),
      userText: query,
      messageOrigin: 'direct-user',
    });
    const { status, json, history } = await preview({ surface: 'turn', query, gezelId: 'g1' });
    expect(status).toBe(200);
    expect(json.kept.map((hit) => hit.docKey)).toEqual(live?.hits.map((hit) => hit.docKey));
    expect(json.kept.map((hit) => hit.docKey)).toEqual([
      'workspace:p1:src/joints.ts',
      'knowledge://gezel-tests/shop-notes/dovetails',
    ]);
    expect(json.trace?.counts).toEqual({ kept: 2 });
    expect(json.policy?.inheritedFrom).toBe('default');
    expect(json.prompt).toBeUndefined();
    expect(history.log).not.toHaveBeenCalled();
  });

  it('judges under an explicit policy for this preview only', async () => {
    const { json } = await preview({ surface: 'turn', query, gezelId: 'g1', mode: 'off' });
    expect(json.policy).toMatchObject({ mode: 'off', inheritedFrom: 'override' });
    expect(json.kept).toEqual([]);
  });

  it('returns the rendered block only when text is asked for', async () => {
    const { json } = await preview({ surface: 'turn', query, gezelId: 'g1', includeText: true });
    expect(json.prompt).toContain('Indexed context for this turn');
  });

  it('previews the launch reference list', async () => {
    const { json } = await preview({
      surface: 'references',
      query: 'dovetail joints',
      craftbookName: 'PowerPoint from Content',
      includeText: true,
    });
    expect(json.kept.map((hit) => hit.docKey)).toEqual([
      'knowledge://gezel-tests/shop-notes/dovetails',
    ]);
    expect(json.trace?.surface).toBe('references');
    expect(json.prompt).toContain('Reference material found at launch');
  });

  it('404s for an unknown project', async () => {
    expect((await preview({ surface: 'search', query }, 'nope')).status).toBe(404);
  });
});
