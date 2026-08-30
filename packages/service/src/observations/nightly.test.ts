import { existsSync } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ObservationTableManifestSchema } from '@bendyline/gezel';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Store } from '../fs/store.js';
import { DuckRunner } from './duck.js';
import {
  listPartitionFiles,
  listPartitions,
  readTableState,
  rollupsRelDir,
  tableRelDir,
  writeTableManifest,
} from './layout.js';
import { runProjectObservationNightly } from './nightly.js';
import { findRealDuckdb, hasRealDuckdb } from './testing/duck-fixture.js';
import { synthRequests, synthRequestsManifest } from './testing/synth.js';
import { ObservationWriter } from './writer.js';

const CORPUS = 'data/traffic';
const WINDOW = { startHour: 1, endHour: 6 } as never;

let artifacts: string;
let duck: DuckRunner;

const PROJECT = {
  id: 'p1',
  connectors: [{ id: 'b1', type: 'mock-traffic', displayName: 'Web traffic', corpusDir: CORPUS }],
};

function makeStore(project: unknown = PROJECT): Store {
  return {
    projectArtifactsDir: () => artifacts,
    getProject: async () => project,
    listProjects: async () => [{ id: 'p1' }],
  } as unknown as Store;
}

/** A manifest with a declared rollup and, optionally, a retention window. */
function manifestWith(opts: { retentionDays?: number; rollup?: boolean }) {
  const base = synthRequestsManifest('requests') as Record<string, unknown>;
  return ObservationTableManifestSchema.parse({
    ...base,
    ...(opts.rollup !== false
      ? {
          rollups: [
            {
              name: 'daily_by_route',
              grain: ['dt', 'route'],
              sql: 'SELECT dt, route, count(*) AS requests, avg(latency_ms) AS avg_latency FROM {{table}} GROUP BY 1, 2',
            },
          ],
        }
      : {}),
    ...(opts.retentionDays ? { retention: { rawDays: opts.retentionDays } } : {}),
  });
}

async function seed(opts: {
  rows?: number;
  days?: number;
  startDate?: string;
  retentionDays?: number;
  rollup?: boolean;
}) {
  const manifest = manifestWith(opts);
  const writer = new ObservationWriter({
    storageDir: artifacts,
    corpusDir: CORPUS,
    manifests: new Map([['requests', manifest]]),
  });
  const rows = synthRequests({
    rows: opts.rows ?? 300,
    seed: 5,
    days: opts.days ?? 3,
    ...(opts.startDate ? { startDate: opts.startDate } : {}),
  });
  await writer.writeBatch({ table: 'requests', rows });
  await writer.finish();
  // The writer persists the manifest it was given; rewrite so a test that
  // changes retention after seeding is reading its own intent.
  await writeTableManifest(artifacts, CORPUS, manifest);
  return rows;
}

function deps(now?: Date) {
  return {
    store: makeStore(),
    duck,
    nightShiftWindow: () => WINDOW,
    ...(now ? { now: () => now } : {}),
  };
}

beforeEach(async () => {
  artifacts = await mkdtemp(join(tmpdir(), 'gezel-obs-night-'));
  duck = new DuckRunner({ binaryPath: findRealDuckdb() ?? '/nonexistent/duckdb' });
});
afterEach(async () => {
  await rm(artifacts, { recursive: true, force: true }).catch(() => {});
});

describe('nightly gating', () => {
  it.each(['readonly', 'inactive', 'stable'])(
    'skips a %s project — the same ambient-work gate every background job uses',
    async (status) => {
      await seed({});
      const d = { ...deps(), store: makeStore({ ...PROJECT, status }) };
      expect((await runProjectObservationNightly(d, 'p1')).skipped).toBe('inactive');
    },
  );

  it('skips when the query engine is not installed', async () => {
    await seed({});
    const d = { ...deps(), duck: new DuckRunner({ binaryPath: '' }) };
    // `binaryPath: ''` is falsy, so the runner falls back to the env var —
    // clear it so this genuinely models an uninstalled engine.
    const prior = process.env.GEZEL_DUCKDB_BIN;
    delete process.env.GEZEL_DUCKDB_BIN;
    try {
      expect((await runProjectObservationNightly(d, 'p1')).skipped).toBe('engine-unavailable');
    } finally {
      if (prior !== undefined) process.env.GEZEL_DUCKDB_BIN = prior;
    }
  });

  it('skips a project with no observation tables', async () => {
    expect((await runProjectObservationNightly(deps(), 'p1')).skipped).toBe('no-tables');
  });
});

describe.runIf(hasRealDuckdb())('nightly maintenance (real engine)', () => {
  it('compacts what the daytime sync left sealed', async () => {
    await seed({ rows: 400, days: 3 });
    for (const partition of await listPartitions(artifacts, CORPUS, 'requests')) {
      expect(
        (await listPartitionFiles(artifacts, CORPUS, 'requests', partition)).sealed.length,
      ).toBeGreaterThan(0);
    }

    const result = await runProjectObservationNightly(deps(), 'p1');
    expect(result.errors).toEqual([]);
    expect(result.compactedRows).toBe(400);

    for (const partition of await listPartitions(artifacts, CORPUS, 'requests')) {
      const files = await listPartitionFiles(artifacts, CORPUS, 'requests', partition);
      expect(files.sealed).toHaveLength(0);
      expect(files.parquet.length).toBeGreaterThan(0);
    }
  });

  it('materializes a rollup per raw partition, with correct aggregates', async () => {
    const rows = await seed({ rows: 600, days: 3 });
    const result = await runProjectObservationNightly(deps(), 'p1');
    expect(result.errors).toEqual([]);
    expect(result.rollupPartitions).toBe(3);

    const rollupRoot = join(artifacts, rollupsRelDir(CORPUS, 'requests'), 'daily_by_route');
    const totals = await duck.runTrusted<{ dt: string; requests: number }>(
      `SELECT dt, sum(requests) AS requests FROM read_parquet('${rollupRoot}/*/*.parquet') GROUP BY 1 ORDER BY 1`,
      { allowedDirectories: [rollupRoot] },
    );
    // The rollup must account for every raw row, day by day.
    const perDay = new Map<string, number>();
    for (const row of rows) {
      const day = row.ts.slice(0, 10);
      perDay.set(day, (perDay.get(day) ?? 0) + 1);
    }
    expect(totals).toHaveLength(perDay.size);
    for (const row of totals) {
      expect(Number(row.requests), row.dt).toBe(perDay.get(row.dt));
    }
  });

  it('is incremental: a second night re-rolls nothing when nothing changed', async () => {
    await seed({ rows: 200, days: 2 });
    const first = await runProjectObservationNightly(deps(new Date('2026-08-10T02:00:00Z')), 'p1');
    expect(first.rollupPartitions).toBe(2);

    // A different window key, so the table is eligible again — but the data
    // has not moved, so the watermark should spare every partition.
    const second = await runProjectObservationNightly(deps(new Date('2026-08-11T02:00:00Z')), 'p1');
    expect(second.rollupPartitions).toBe(0);
    expect(second.errors).toEqual([]);
  });

  it('re-rolls only the partition whose raw data changed', async () => {
    await seed({ rows: 200, days: 2, startDate: '2026-08-01' });
    await runProjectObservationNightly(deps(new Date('2026-08-10T02:00:00Z')), 'p1');

    // A later sync lands more rows in one existing day.
    const writer = new ObservationWriter({
      storageDir: artifacts,
      corpusDir: CORPUS,
      manifests: new Map([['requests', manifestWith({})]]),
    });
    await writer.writeBatch({
      table: 'requests',
      partition: '2026-08-01',
      rows: synthRequests({ rows: 40, seed: 77, days: 1, startDate: '2026-08-01' }),
    });
    await writer.finish();

    const second = await runProjectObservationNightly(deps(new Date('2026-08-11T02:00:00Z')), 'p1');
    expect(second.rollupPartitions).toBe(1);

    const rollupRoot = join(artifacts, rollupsRelDir(CORPUS, 'requests'), 'daily_by_route');
    const [total] = await duck.runTrusted<{ n: number }>(
      `SELECT sum(requests) AS n FROM read_parquet('${rollupRoot}/dt=2026-08-01/*.parquet')`,
      { allowedDirectories: [rollupRoot] },
    );
    expect(Number(total?.n)).toBe(140);
  });

  it('runs once per night-shift window and then stands down', async () => {
    await seed({ rows: 100, days: 1 });
    const now = new Date('2026-08-10T02:00:00Z');
    expect((await runProjectObservationNightly(deps(now), 'p1')).skipped).toBeUndefined();
    expect((await runProjectObservationNightly(deps(now), 'p1')).skipped).toBe('already-run');

    const state = await readTableState(artifacts, CORPUS, 'requests');
    expect(state.lastNightlyWindow).toBeTruthy();
  });

  it('refuses a rollup whose SQL is not a single read-only statement', async () => {
    await seed({ rows: 50, days: 1 });
    const manifest = ObservationTableManifestSchema.parse({
      ...(synthRequestsManifest('requests') as Record<string, unknown>),
      rollups: [
        {
          name: 'sneaky',
          grain: ['dt'],
          // Authored content is still interpolated into a script that runs.
          sql: "SELECT 1 AS x FROM {{table}}; ATTACH '/tmp/gezel-rollup-injection.db' AS w",
        },
      ],
    });
    await writeTableManifest(artifacts, CORPUS, manifest);

    const result = await runProjectObservationNightly(deps(), 'p1');
    expect(result.rollupPartitions).toBe(0);
    expect(result.errors.join(' ')).toMatch(/refused/);
    expect(existsSync('/tmp/gezel-rollup-injection.db')).toBe(false);
  });
});

/**
 * Retention is the one operation here that destroys information, and it
 * cannot be undone from gezel's side because the upstream window has usually
 * moved on. These are the guards that make it safe.
 */
describe.runIf(hasRealDuckdb())('retention', () => {
  const NOW = new Date('2026-09-01T02:00:00Z');

  it('keeps everything when no window is declared', async () => {
    await seed({ rows: 100, days: 3, startDate: '2026-01-01' });
    const before = (await listPartitions(artifacts, CORPUS, 'requests')).length;
    const result = await runProjectObservationNightly(deps(NOW), 'p1');
    expect(result.prunedPartitions).toBe(0);
    expect(await listPartitions(artifacts, CORPUS, 'requests')).toHaveLength(before);
  });

  it('deletes raw partitions past the window once their rollups exist', async () => {
    await seed({ rows: 150, days: 3, startDate: '2026-01-01', retentionDays: 30 });
    const result = await runProjectObservationNightly(deps(NOW), 'p1');

    expect(result.errors).toEqual([]);
    // Every raw partition is far older than 30 days, and each was rolled up
    // in the same pass before retention ran.
    expect(result.prunedPartitions).toBe(3);
    expect(await listPartitions(artifacts, CORPUS, 'requests')).toHaveLength(0);

    // The rollups survive. That asymmetry is the entire point of the tier:
    // the answers outlive the rows they were computed from.
    const rollupRoot = join(artifacts, rollupsRelDir(CORPUS, 'requests'), 'daily_by_route');
    const totals = await duck.runTrusted<{ n: number }>(
      `SELECT sum(requests) AS n FROM read_parquet('${rollupRoot}/*/*.parquet')`,
      { allowedDirectories: [rollupRoot] },
    );
    expect(Number(totals[0]?.n)).toBe(150);
  });

  it('never deletes a partition no rollup covers', async () => {
    await seed({ rows: 100, days: 2, startDate: '2026-01-01', retentionDays: 30 });
    // Materialize normally, then remove one rollup output to model a partition
    // that was never summarized.
    await runProjectObservationNightly(deps(NOW), 'p1');
    const survived = await listPartitions(artifacts, CORPUS, 'requests');
    expect(survived).toHaveLength(0);

    // Now the same shape with the rollup materialization disabled: nothing
    // covers the partitions, so nothing may be deleted.
    await rm(artifacts, { recursive: true, force: true });
    artifacts = await mkdtemp(join(tmpdir(), 'gezel-obs-night-'));
    await seed({ rows: 100, days: 2, startDate: '2026-01-01', retentionDays: 30 });
    const manifest = manifestWith({ retentionDays: 30 });
    // Keep the rollup declared but make it unrunnable, so coverage is never
    // achieved and retention must decline.
    const broken = ObservationTableManifestSchema.parse({
      ...(manifest as unknown as Record<string, unknown>),
      rollups: [{ name: 'daily_by_route', grain: ['dt'], sql: 'DELETE FROM {{table}}' }],
    });
    await writeTableManifest(artifacts, CORPUS, broken);

    const result = await runProjectObservationNightly(deps(NOW), 'p1');
    expect(result.prunedPartitions).toBe(0);
    expect((await listPartitions(artifacts, CORPUS, 'requests')).length).toBeGreaterThan(0);
  });

  it('never deletes a partition still holding uncompacted rows', async () => {
    await seed({ rows: 100, days: 2, startDate: '2026-01-01', retentionDays: 30 });
    // Roll up and compact everything.
    await runProjectObservationNightly(deps(NOW), 'p1');
    await rm(artifacts, { recursive: true, force: true });

    // Reseed, roll up, then land a NEW uncompacted part into an old partition
    // and force another window. The partition is old and covered, but its new
    // rows have not been compacted — so it must survive.
    artifacts = await mkdtemp(join(tmpdir(), 'gezel-obs-night-'));
    await seed({ rows: 100, days: 1, startDate: '2026-01-01', retentionDays: 30 });
    await runProjectObservationNightly(deps(new Date('2026-09-01T02:00:00Z')), 'p1');

    const writer = new ObservationWriter({
      storageDir: artifacts,
      corpusDir: CORPUS,
      manifests: new Map([['requests', manifestWith({ retentionDays: 30 })]]),
    });
    await writer.writeBatch({
      table: 'requests',
      partition: '2026-01-01',
      rows: synthRequests({ rows: 10, seed: 3, days: 1, startDate: '2026-01-01' }),
    });
    await writer.finish();

    // A later window, with the fresh part deliberately left uncompacted by
    // giving the pass no compaction budget.
    const result = await runProjectObservationNightly(
      { ...deps(new Date('2026-09-02T02:00:00Z')), maxParts: 0 },
      'p1',
    );
    expect(result.prunedPartitions).toBe(0);
    const files = await listPartitionFiles(artifacts, CORPUS, 'requests', 'dt=2026-01-01');
    expect(files.sealed.length).toBeGreaterThan(0);
  });

  it('never deletes a partition whose value is not a date', async () => {
    const writer = new ObservationWriter({ storageDir: artifacts, corpusDir: CORPUS });
    await writer.writeBatch({
      table: 'lookup',
      partition: 'region-emea',
      rows: [{ code: 'NL', name: 'Netherlands' }],
    });
    await writer.finish();
    const inferred = ObservationTableManifestSchema.parse({
      schemaVersion: 1,
      table: 'lookup',
      partitionColumn: 'dt',
      columns: [
        { name: 'code', type: 'VARCHAR', role: 'dimension' },
        { name: 'name', type: 'VARCHAR', role: 'attribute' },
      ],
      retention: { rawDays: 1 },
    });
    await writeTableManifest(artifacts, CORPUS, inferred);

    const result = await runProjectObservationNightly(deps(NOW), 'p1');
    expect(result.prunedPartitions).toBe(0);
    expect(await listPartitions(artifacts, CORPUS, 'lookup')).toContain('dt=region-emea');
  });
});
