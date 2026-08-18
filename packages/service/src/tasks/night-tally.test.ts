import type { HistoryEvent, NightShiftWindow } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import {
  type NightShiftTallyDeps,
  buildNightShiftTally,
  nightShiftTallyIsEmpty,
  nightShiftTallyPeriod,
} from './night-tally.js';

const OVERNIGHT: NightShiftWindow = { startHour: 22, endHour: 6 };
const at = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(y, mo - 1, d, h, mi);

const event = (kind: string, details?: Record<string, unknown>): HistoryEvent =>
  ({
    id: `${kind}-${Math.random()}`,
    at: new Date().toISOString(),
    kind,
    summary: kind,
    ...(details ? { details } : {}),
  }) as HistoryEvent;

function deps(overrides: Partial<NightShiftTallyDeps> = {}): NightShiftTallyDeps {
  return {
    history: { listEvents: async () => [] },
    store: { listProjects: async () => [] },
    contentIndex: { workCountsSince: async () => null },
    ...overrides,
  };
}

describe('nightShiftTallyPeriod', () => {
  it('covers the whole window a scheduled shift runs in, not just its ON edge', () => {
    // Quota parked the shift at 22:00 and it only turned on at 01:00 — the
    // work done before the park is still this night's work.
    const period = nightShiftTallyPeriod(at(2026, 6, 21, 2, 0), OVERNIGHT, {
      active: true,
      startedAt: at(2026, 6, 21, 1, 0).toISOString(),
    });
    expect(period.since).toEqual(at(2026, 6, 20, 22, 0));
    expect(period.until).toEqual(at(2026, 6, 21, 2, 0));
    expect(period.live).toBe(true);
  });

  it('counts a manual daytime shift from the moment it was started', () => {
    const period = nightShiftTallyPeriod(at(2026, 6, 20, 15, 0), OVERNIGHT, {
      active: true,
      startedAt: at(2026, 6, 20, 13, 30).toISOString(),
    });
    expect(period.since).toEqual(at(2026, 6, 20, 13, 30));
    expect(period.until).toEqual(at(2026, 6, 20, 15, 0));
  });

  it('keeps a manual start that predates the window it is now inside', () => {
    const period = nightShiftTallyPeriod(at(2026, 6, 20, 23, 0), OVERNIGHT, {
      active: true,
      startedAt: at(2026, 6, 20, 21, 0).toISOString(),
    });
    expect(period.since).toEqual(at(2026, 6, 20, 21, 0));
  });

  it('reports the last completed window once nothing is running', () => {
    const period = nightShiftTallyPeriod(at(2026, 6, 21, 10, 0), OVERNIGHT, {
      active: false,
      startedAt: null,
    });
    expect(period.since).toEqual(at(2026, 6, 20, 22, 0));
    expect(period.until).toEqual(at(2026, 6, 21, 6, 0));
    expect(period.live).toBe(false);
  });
});

describe('buildNightShiftTally', () => {
  const period = { since: at(2026, 6, 20, 22, 0), until: at(2026, 6, 21, 6, 0), live: false };

  it('separates finished tasks from other status flips', async () => {
    const tally = await buildNightShiftTally(
      deps({
        history: {
          listEvents: async () => [
            event('task.status.changed', { status: 'complete' }),
            event('task.status.changed', { status: 'complete' }),
            event('task.status.changed', { status: 'canceled' }),
            event('task.status.changed'),
          ],
        },
      }),
      period,
    );
    expect(tally.tasksCompleted).toBe(2);
  });

  it('sums indexing work across projects and survives one without an index', async () => {
    const tally = await buildNightShiftTally(
      deps({
        store: { listProjects: async () => [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }] },
        contentIndex: {
          workCountsSince: async (projectId) =>
            projectId === 'p3'
              ? null // no index yet — contributes nothing, not a zeroed total
              : { summarized: 10, reviewed: 3, described: 1 },
        },
      }),
      period,
    );
    expect(tally.filesIndexed).toBe(20);
    expect(tally.filesReviewed).toBe(6);
    expect(tally.mediaDescribed).toBe(2);
  });

  it('reads the period back out and counts every wired kind', async () => {
    const tally = await buildNightShiftTally(
      deps({
        history: {
          listEvents: async () => [
            event('workspace.write'),
            event('document.created'),
            event('render.generated'),
            event('user.question.asked'),
            event('tool.called'),
            event('task.step.completed'),
          ],
        },
      }),
      period,
    );
    expect(tally).toMatchObject({
      since: period.since.toISOString(),
      until: period.until.toISOString(),
      live: false,
      filesWritten: 1,
      documentsCreated: 1,
      imagesRendered: 1,
      questionsRaised: 1,
      toolCalls: 1,
      stepsCompleted: 1,
    });
  });

  it('survives an unreadable audit log rather than failing the menu', async () => {
    const tally = await buildNightShiftTally(
      deps({
        history: {
          listEvents: async () => {
            throw new Error('history unreadable');
          },
        },
      }),
      period,
    );
    expect(nightShiftTallyIsEmpty(tally)).toBe(true);
  });
});
