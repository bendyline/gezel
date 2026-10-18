import { describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));

const { partitionInstalls } = await import('./KnowledgeCatalogManager.js');
type ActiveInstall = import('./KnowledgeCatalogManager.js').ActiveInstall;

const E5 = { profileId: 'multilingual-e5-small@1', repo: 'intfloat/multilingual-e5-small' };

function install(catalogId: string, overrides: Partial<ActiveInstall>): ActiveInstall {
  return {
    jobId: catalogId,
    catalogId,
    phase: 'download',
    bytesDone: 0,
    bytesTotal: 0,
    origin: 'local',
    ...overrides,
  };
}

describe('partitionInstalls', () => {
  it('shows catalogs that share a search model as one model download', () => {
    const { catalogRows, modelRows } = partitionInstalls([
      install('regional-california-southwest', {
        phase: 'embedder',
        bytesDone: 118e6,
        bytesTotal: 465e6,
        searchModel: E5,
      }),
      install('wikipedia-food-drink', {
        phase: 'embedder',
        bytesDone: 117e6,
        bytesTotal: 465e6,
        searchModel: E5,
      }),
      install('wikipedia-history', { phase: 'download', bytesDone: 10e6, bytesTotal: 90e6 }),
    ]);

    expect(catalogRows.map((r) => r.catalogId)).toEqual(['wikipedia-history']);
    expect(modelRows).toEqual([
      {
        model: E5,
        bytesDone: 118e6,
        bytesTotal: 465e6,
        catalogs: ['regional-california-southwest', 'wikipedia-food-drink'],
      },
    ]);
  });

  it('keeps a catalog row when the daemon does not name the model, or the install failed', () => {
    const { catalogRows, modelRows } = partitionInstalls([
      install('older-daemon', { phase: 'embedder', bytesDone: 5, bytesTotal: 10 }),
      install('failed', { phase: 'embedder', searchModel: E5, error: 'download failed' }),
    ]);

    expect(catalogRows.map((r) => r.catalogId)).toEqual(['older-daemon', 'failed']);
    expect(modelRows).toEqual([]);
  });
});
