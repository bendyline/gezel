import type { ActivityItem, ActivityStatusResponse } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import {
  type IndexProgress,
  type IndexingJob,
  foldIndexingJob,
  indexingActivityId,
  indexingJobLive,
  withoutIndexingBackground,
} from './indexing-activity.js';

const event = (overrides: Partial<IndexProgress>): IndexProgress => ({
  type: 'index_progress',
  phase: 'scan',
  state: 'started',
  projectId: 'squisq',
  ...overrides,
});

function fold(...events: IndexProgress[]): IndexingJob {
  let job: IndexingJob | undefined;
  for (const next of events) job = foldIndexingJob(job, next);
  if (!job) throw new Error('no events');
  return job;
}

describe('indexing jobs', () => {
  it('keys every phase of a project to one row', () => {
    expect(indexingActivityId(event({ phase: 'scan' }))).toBe(
      indexingActivityId(event({ phase: 'enrich', state: 'progress' })),
    );
    expect(indexingActivityId(event({ projectId: 'shop' }))).not.toBe(
      indexingActivityId(event({})),
    );
  });

  it('keeps a drive live through the static rescan it wraps', () => {
    const drive = fold(
      event({ detail: 'Index catch-up' }),
      event({ gezelId: 'saara' }),
      event({ state: 'ended', gezelId: 'saara', detail: '2305 files' }),
    );
    expect(indexingJobLive(drive)).toBe(true);
    expect(drive.shown).toMatchObject({ state: 'started', gezelId: 'saara' });

    const study = foldIndexingJob(drive, event({ phase: 'enrich', state: 'progress' }));
    expect(study.shown.phase).toBe('enrich');
    const done = foldIndexingJob(study, event({ state: 'ended', detail: 'finished' }));
    expect(indexingJobLive(done)).toBe(false);
    expect(done.shown).toMatchObject({ state: 'ended', detail: 'finished' });
  });

  it('lets an end nothing started close nothing', () => {
    const drive = fold(event({}), event({ phase: 'digest', state: 'ended' }));
    expect(indexingJobLive(drive)).toBe(true);
    expect(drive.shown.phase).toBe('scan');
    expect(indexingJobLive(fold(event({ phase: 'enrich', state: 'ended' })))).toBe(false);
  });
});

describe('the background row beside indexing', () => {
  const background: ActivityItem = {
    id: 'background:running',
    section: 'working',
    title: 'Background work',
    detail: '1 background operation running.',
    questionIds: [],
  };
  const studying: ActivityItem = {
    id: 'index:squisq',
    section: 'working',
    title: 'Studying · Squisq',
    detail: '8 files enriched',
    projectId: 'squisq',
    gezelId: 'saara',
    questionIds: [],
  };
  const queues = (
    active: Array<{ sessionId?: string; gezelId?: string; projectId?: string }>,
    running = active.length,
  ) =>
    ({
      providers: {
        mlx: {
          running,
          queuedInteractive: 0,
          queuedBackground: 0,
          concurrency: 2,
          active: active.map((row) => ({ ...row, runningForMs: 1_000 })),
          pending: [],
        },
      },
      sessions: [],
      cache: [],
      at: '',
      taskRunner: { pendingCount: 0, pendingByGezel: {}, pendingByProject: {} },
    }) as unknown as ActivityStatusResponse['queues'];

  it('drops it when every anonymous slot is a listed indexing job', () => {
    const items = withoutIndexingBackground(
      [background],
      queues([{ gezelId: 'saara', projectId: 'squisq' }]),
      [studying],
    );
    expect(items).toEqual([]);
  });

  it('keeps it for any other chore, or when indexing has only a receipt', () => {
    const slot = { gezelId: 'saara', projectId: 'squisq' };
    expect(
      withoutIndexingBackground(
        [background],
        queues([slot, { gezelId: 'noor', projectId: 'squisq' }]),
        [studying],
      ),
    ).toEqual([background]);
    expect(withoutIndexingBackground([background], queues([slot], 2), [studying])).toEqual([
      background,
    ]);
    expect(
      withoutIndexingBackground([background], queues([slot]), [
        { ...studying, section: 'ready', title: 'Study finished · Squisq' },
      ]),
    ).toEqual([background]);
  });
});
