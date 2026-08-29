import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Store } from '../fs/store.js';
import { compactCorpus } from '../observations/compactor.js';
import { DuckRunner } from '../observations/duck.js';
import {
  listPartitionFiles,
  listPartitions,
  listTables,
  readTableManifest,
  readTableState,
  tableRelDir,
} from '../observations/layout.js';
import { findRealDuckdb, hasRealDuckdb } from '../observations/testing/duck-fixture.js';
import { synthRequestsManifest } from '../observations/testing/synth.js';
import type { SecretStore } from '../secrets/types.js';
import { ConnectorManager } from './manager.js';
import {
  MOCK_OBSERVATIONS_ADAPTER_ID,
  registerMockObservationsAdapter,
} from './natives/mock-observations.js';

registerMockObservationsAdapter();

/**
 * A connector type declaring the observation shape with an authored table
 * manifest — the shape a real gilde connector-type would ship.
 */
function observationManifest(overrides?: Record<string, unknown>) {
  return {
    schemaVersion: 1 as const,
    kind: 'connector-type' as const,
    id: 'mock-traffic',
    name: 'Mock traffic',
    description: '',
    tags: [],
    maintainer: { name: 'gezel' },
    version: '1.0.0',
    releasedAt: '2026-01-01T00:00:00Z',
    driver: 'native' as const,
    source: { adapterId: MOCK_OBSERVATIONS_ADAPTER_ID },
    normalize: { kind: 'observations' as const, tables: [synthRequestsManifest('requests')] },
    actions: [],
    // Deliberately a lie the engine must not act on: an append-only corpus has
    // no notion of pruning what the source stopped returning.
    completeness: 'mirror' as const,
    availableVersions: ['1.0.0'],
    ...overrides,
  };
}

let ws: string;
beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), 'gezel-obs-sync-'));
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true }).catch(() => {});
});

interface FakeProject {
  id: string;
  connectors?: { id: string; type: string; corpusDir?: string; cursor?: unknown }[];
}

function harness(manifest: ReturnType<typeof observationManifest> = observationManifest()) {
  let project: FakeProject = { id: 'p1' };
  const store = {
    getProject: async () => project,
    updateProject: async (_id: string, patch: Partial<FakeProject>) => {
      project = { ...project, ...patch };
      return project;
    },
    projectWorkspaceDir: async () => ws,
    projectArtifactsDir: () => join(ws, 'artifacts'),
    get historyManager() {
      return undefined;
    },
  } as unknown as Store;

  const secrets = {
    get: async () => null,
    set: async () => {},
    delete: async () => {},
    has: async () => false,
  } as unknown as SecretStore;

  const catalog = {
    get: async () => ({ manifest, sourceId: 'bundled' }),
  } as unknown as ConstructorParameters<typeof ConnectorManager>[0]['catalog'];

  return {
    mgr: new ConnectorManager({ store, secrets, catalog }),
    getProject: () => project,
    artifacts: join(ws, 'artifacts'),
  };
}

describe('observation connector sync', () => {
  it('lands rows as partitioned NDJSON parts and advances the cursor', async () => {
    const { mgr, getProject, artifacts } = harness();
    const project = (await mgr.bind(getProject() as never, {
      type: 'mock-traffic',
      displayName: 'Traffic',
      config: { pageRows: 50, totalPages: 3, days: 2 },
    })) as unknown as { id: string; corpusDir: string };

    const result = await mgr.syncBinding(getProject() as never, project.id);
    expect(result.error).toBeUndefined();
    expect(result.errors).toBe(0);
    // One RecordRef is one PAGE, so the engine's counter reports pages.
    expect(result.written).toBe(3);

    const corpusDir = project.corpusDir;
    expect(await listTables(artifacts, corpusDir)).toEqual(['requests']);

    const partitions = await listPartitions(artifacts, corpusDir, 'requests');
    expect(partitions).toHaveLength(2);

    const state = await readTableState(artifacts, corpusDir, 'requests');
    expect(state.totalRows).toBe(150);

    // Nothing left open, and the authored manifest reached disk.
    for (const partition of partitions) {
      const files = await listPartitionFiles(artifacts, corpusDir, 'requests', partition);
      expect(files.open).toHaveLength(0);
      expect(files.sealed.length).toBeGreaterThan(0);
    }
    const manifest = await readTableManifest(artifacts, corpusDir, 'requests');
    expect(manifest?.timeColumn).toBe('ts');
    expect(manifest?.inferred).toBeUndefined();

    // `_meta.json` says plainly what kind of directory this is.
    const meta = JSON.parse(
      await readFile(join(artifacts, corpusDir, '_meta.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(meta.shape).toBe('observations');
    expect(meta.rowsLastPass).toBe(150);
    expect(meta.tables).toEqual([
      { table: 'requests', partitions: expect.any(Array), schemaInferred: false },
    ]);
  });

  it('resumes from the cursor instead of re-fetching pages', async () => {
    const { mgr, getProject, artifacts } = harness();
    const binding = (await mgr.bind(getProject() as never, {
      type: 'mock-traffic',
      config: { pageRows: 20, totalPages: 2, days: 1 },
    })) as unknown as { id: string; corpusDir: string };

    await mgr.syncBinding(getProject() as never, binding.id);
    const second = await mgr.syncBinding(getProject() as never, binding.id);

    // The source is exhausted; a second pass writes nothing new.
    expect(second.written).toBe(0);
    expect(second.errors).toBe(0);
    const state = await readTableState(artifacts, binding.corpusDir, 'requests');
    expect(state.totalRows).toBe(40);
  });

  it('keeps the cursor unadvanced when a page fails, so the page retries', async () => {
    const { mgr, getProject, artifacts } = harness();
    const binding = (await mgr.bind(getProject() as never, {
      type: 'mock-traffic',
      config: { pageRows: 10, totalPages: 3, days: 1, throwAtPage: 1 },
    })) as unknown as { id: string; corpusDir: string };

    const result = await mgr.syncBinding(getProject() as never, binding.id);
    expect(result.errors).toBeGreaterThan(0);

    // Pages 0 and 2 landed; page 1 threw. Because the batch had an error the
    // scope's cursor did not advance, so the next pass re-reads the whole
    // batch — the writer's job is then to not duplicate what already landed.
    const state = await readTableState(artifacts, binding.corpusDir, 'requests');
    expect(state.totalRows).toBe(20);
    const project = getProject();
    expect(project.connectors?.[0]?.cursor).toBeDefined();
  });

  it('backs off when the source reports a rate limit', async () => {
    const { mgr, getProject } = harness();
    const binding = (await mgr.bind(getProject() as never, {
      type: 'mock-traffic',
      config: { pageRows: 10, totalPages: 3, days: 1, rateLimitAtPage: 0 },
    })) as unknown as { id: string };

    const result = await mgr.syncBinding(getProject() as never, binding.id);
    expect(result.rateLimited).toBe(true);
    expect(mgr.backoffUntil(binding.id)).toBeGreaterThan(Date.now());
  });

  it('refuses a page whose declared row count disagrees with its payload', async () => {
    const { mgr, getProject, artifacts } = harness();
    const binding = (await mgr.bind(getProject() as never, {
      type: 'mock-traffic',
      config: { pageRows: 10, totalPages: 2, days: 1, miscountAtPage: 0 },
    })) as unknown as { id: string; corpusDir: string };

    const result = await mgr.syncBinding(getProject() as never, binding.id);
    expect(result.errors).toBeGreaterThan(0);
    // The good page still landed; only the lying one was refused.
    const state = await readTableState(artifacts, binding.corpusDir, 'requests');
    expect(state.totalRows).toBe(10);
  });

  it('never prunes, even when the type wrongly claims to be a mirror', async () => {
    // `completeness: 'mirror'` is set on the manifest above. Prune matches the
    // markdown filename grammar, which no Parquet part has — but the engine
    // must not be handed `allowPrune` at all for an append-only corpus.
    const { mgr, getProject } = harness();
    const binding = (await mgr.bind(getProject() as never, {
      type: 'mock-traffic',
      config: { pageRows: 10, totalPages: 1, days: 1 },
    })) as unknown as { id: string };
    const result = await mgr.syncBinding(getProject() as never, binding.id);
    expect(result.pruned).toBe(0);
  });

  it('infers a manifest when the connector type declares no tables', async () => {
    const { mgr, getProject, artifacts } = harness(
      observationManifest({ normalize: { kind: 'observations' as const } }),
    );
    const binding = (await mgr.bind(getProject() as never, {
      type: 'mock-traffic',
      config: { pageRows: 30, totalPages: 1, days: 1 },
    })) as unknown as { id: string; corpusDir: string };

    await mgr.syncBinding(getProject() as never, binding.id);
    const manifest = await readTableManifest(artifacts, binding.corpusDir, 'requests');
    expect(manifest?.inferred).toBe(true);
    expect(manifest?.columns.find((c) => c.name === 'latency_ms')?.type).toBe('DOUBLE');
    expect(manifest?.columns.find((c) => c.name === 'route')?.role).toBe('dimension');
  });
});

describe.runIf(hasRealDuckdb())('observation connector sync → compaction (real engine)', () => {
  it('produces Parquet a query can aggregate over', async () => {
    const { mgr, getProject, artifacts } = harness();
    const binding = (await mgr.bind(getProject() as never, {
      type: 'mock-traffic',
      config: { pageRows: 250, totalPages: 4, days: 3 },
    })) as unknown as { id: string; corpusDir: string };

    await mgr.syncBinding(getProject() as never, binding.id);

    const duck = new DuckRunner({ binaryPath: findRealDuckdb() as string });
    const [compaction] = await compactCorpus({
      storageDir: artifacts,
      corpusDir: binding.corpusDir,
      duck,
    });
    expect(compaction?.errors).toEqual([]);
    expect(compaction?.rowsCompacted).toBe(1_000);

    const tableRoot = join(artifacts, tableRelDir(binding.corpusDir, 'requests'));
    const rows = await duck.runTrusted<{ route: string; requests: number }>(
      `SELECT route, count(*) AS requests
         FROM read_parquet('${tableRoot}/*/*.parquet')
        GROUP BY 1 ORDER BY requests DESC`,
      { allowedDirectories: [tableRoot] },
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.reduce((sum, r) => sum + Number(r.requests), 0)).toBe(1_000);
  });
});
