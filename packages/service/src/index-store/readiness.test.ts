import type { WorkspaceIndexStatus } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import {
  type IndexReadinessDeps,
  MAX_WAIT_BUDGET_MS,
  ensureIndexFresh,
  indexReadinessSnapshot,
} from './readiness.js';

interface Harness {
  deps: IndexReadinessDeps;
  calls: { refreshAndWait: number; driveStarted: number };
}

function harness(opts: {
  statuses: WorkspaceIndexStatus[];
  staffed?: boolean;
  paused?: boolean;
  drive?: Promise<void> | null;
  driveModeAfter?: 'background' | 'full' | null;
}): Harness {
  const calls = { refreshAndWait: 0, driveStarted: 0 };
  const statuses = [...opts.statuses];
  const next = () => (statuses.length > 1 ? statuses.shift()! : statuses[0]!);
  let driving = false;
  const deps: IndexReadinessDeps = {
    workspaceIndex: {
      statusForUi: async () => next(),
      refreshAndWait: async () => {
        calls.refreshAndWait++;
        return next();
      },
    },
    enrichment: {
      drive: () => {
        calls.driveStarted++;
        driving = true;
        return { started: true, alreadyRunning: false };
      },
      awaitDrive: () => (driving ? (opts.drive ?? Promise.resolve()) : null),
      driveMode: () => opts.driveModeAfter ?? null,
    },
    resolveBoekwachter: async () => (opts.staffed !== false ? { id: 'bw' } : null),
    isPaused: () => opts.paused ?? false,
    now: () => new Date('2026-08-23T12:00:00Z'),
  };
  return { deps, calls };
}

const DRAINED_FRESH: WorkspaceIndexStatus = {
  state: 'fresh',
  meta: {
    version: 4,
    scannedAt: '2026-08-23T11:59:30Z',
    root: '/w',
    durationMs: 100,
    fileCount: 12,
    commandCount: 0,
  },
  enrichment: {
    eligible: 12,
    summarized: 12,
    embedded: 12,
    searchReady: 12,
    pending: 0,
    shadowsPending: 0,
    embedOnlyPending: 0,
    reviews: { eligible: 12, reviewed: 12, stale: 0, pending: 0 },
  },
};

const PENDING_FRESH: WorkspaceIndexStatus = {
  ...DRAINED_FRESH,
  enrichment: {
    ...DRAINED_FRESH.enrichment!,
    summarized: 4,
    pending: 8,
    reviews: { eligible: 12, reviewed: 2, stale: 0, pending: 10 },
  },
};

describe('ensureIndexFresh', () => {
  it('returns immediately with honest caveats when indexing is disabled', async () => {
    const h = harness({ statuses: [{ state: 'disabled' }] });
    const report = await ensureIndexFresh(h.deps, 'p1');
    expect(report.indexingEnabled).toBe(false);
    expect(report.staticState).toBe('disabled');
    expect(report.aiTier.achievable).toBe(false);
    expect(report.wait.drained).toBe(false);
    expect(report.notes.join(' ')).toContain('Indexing is turned off');
    expect(h.calls.refreshAndWait).toBe(0);
    expect(h.calls.driveStarted).toBe(0);
  });

  it('skips the rescan on a fresh index and skips the drive when drained', async () => {
    const h = harness({ statuses: [DRAINED_FRESH] });
    const report = await ensureIndexFresh(h.deps, 'p1', { waitBudgetMs: 1_000 });
    expect(h.calls.refreshAndWait).toBe(0);
    expect(h.calls.driveStarted).toBe(0);
    expect(report.wait.drained).toBe(true);
    expect(report.search.ready).toBe(true);
    expect(report.aiTier.achievable).toBe(true);
    expect(report.notes).toEqual([]);
    expect(report.fileCount).toBe(12);
  });

  it('awaits a static rescan when the index is stale', async () => {
    const h = harness({ statuses: [{ state: 'stale' }, DRAINED_FRESH] });
    const report = await ensureIndexFresh(h.deps, 'p1', { waitBudgetMs: 1_000 });
    expect(h.calls.refreshAndWait).toBe(1);
    expect(report.staticState).toBe('fresh');
  });

  it('drives and waits until the catch-up drains', async () => {
    const h = harness({
      statuses: [PENDING_FRESH, PENDING_FRESH, DRAINED_FRESH],
      drive: new Promise((resolve) => setTimeout(resolve, 20)),
    });
    const report = await ensureIndexFresh(h.deps, 'p1', { waitBudgetMs: 5_000 });
    expect(h.calls.driveStarted).toBe(1);
    expect(report.wait.drained).toBe(true);
    expect(report.aiTier.reviews?.pending).toBe(0);
  });

  it('returns a snapshot with a caveat when the budget expires mid-drive', async () => {
    const h = harness({
      statuses: [PENDING_FRESH],
      drive: new Promise(() => {}),
      driveModeAfter: 'full',
    });
    const report = await ensureIndexFresh(h.deps, 'p1', { waitBudgetMs: 30 });
    expect(report.wait.drained).toBe(false);
    expect(report.wait.driveStillRunning).toBe(true);
    expect(report.notes.join(' ')).toContain('continues in the background');
  });

  it('never waits on the roster-gated tiers of an unstaffed project', async () => {
    const status: WorkspaceIndexStatus = {
      ...PENDING_FRESH,
      enrichment: { ...PENDING_FRESH.enrichment!, embedOnlyPending: 0 },
    };
    const h = harness({ statuses: [status], staffed: false });
    const started = Date.now();
    const report = await ensureIndexFresh(h.deps, 'p1', { waitBudgetMs: 10_000 });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(h.calls.driveStarted).toBe(0);
    expect(report.aiTier.staffed).toBe(false);
    expect(report.aiTier.achievable).toBe(false);
    expect(report.wait.drained).toBe(true);
    expect(report.notes.join(' ')).toContain('Boekwachter');
  });

  it('does not drive while the indexing job is paused, and says so', async () => {
    const h = harness({ statuses: [PENDING_FRESH], paused: true });
    const report = await ensureIndexFresh(h.deps, 'p1', { waitBudgetMs: 1_000 });
    expect(h.calls.driveStarted).toBe(0);
    expect(report.aiTier.paused).toBe(true);
    expect(report.aiTier.achievable).toBe(false);
    expect(report.notes.join(' ')).toContain('paused');
  });

  it('clamps the wait budget to the service-side maximum', async () => {
    const h = harness({ statuses: [DRAINED_FRESH] });
    const report = await ensureIndexFresh(h.deps, 'p1', { waitBudgetMs: 99_999_999 });
    expect(report.wait.budgetMs).toBe(MAX_WAIT_BUDGET_MS);
  });
});

describe('indexReadinessSnapshot', () => {
  it('reports without refreshing or driving', async () => {
    const h = harness({ statuses: [PENDING_FRESH] });
    const report = await indexReadinessSnapshot(h.deps, 'p1');
    expect(h.calls.refreshAndWait).toBe(0);
    expect(h.calls.driveStarted).toBe(0);
    expect(report.aiTier.summariesPending).toBe(8);
    expect(report.wait.budgetMs).toBe(0);
  });
});
