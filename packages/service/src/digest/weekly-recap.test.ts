import type { HistoryEvent, Project } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { isoWeekBounds, writeWeeklyRecap } from './weekly-recap.js';

function night(at: string, details: Record<string, unknown>): HistoryEvent {
  return {
    id: at,
    at,
    kind: 'night-shift.window-settled',
    projectId: 'default',
    summary: '',
    details,
  } as HistoryEvent;
}

function fakeDeps(opts: {
  nights: HistoryEvent[];
  artifacts?: Record<string, string>;
  projects?: Array<Pick<Project, 'id' | 'name'>>;
}) {
  const artifacts = new Map(Object.entries(opts.artifacts ?? {}));
  return {
    artifacts,
    deps: {
      store: {
        listProjects: async () => (opts.projects ?? []) as Project[],
        getProject: async () => null,
        readProjectArtifact: async (id: string, path: string) =>
          artifacts.get(`${id}:${path}`) ?? null,
        writeProjectArtifact: async (id: string, path: string, body: string) => {
          artifacts.set(`${id}:${path}`, body);
        },
      },
      history: { listEvents: async () => opts.nights },
    } as unknown as Parameters<typeof writeWeeklyRecap>[0],
  };
}

describe('writeWeeklyRecap', () => {
  // Monday 2026-10-12: the recap covers the ISO week before it.
  const monday = new Date(2026, 9, 12, 7, 0);

  it("writes last week's recap once, with the nights, the quiet ones and each digest", async () => {
    const { deps, artifacts } = fakeDeps({
      nights: [
        night('2026-10-06T06:00:00Z', { ran: true, tasksCompleted: 2, reports: 1, proposals: 1 }),
        night('2026-10-07T06:00:00Z', { ran: false, reason: 'asleep' }),
        night('2026-10-08T06:00:00Z', { ran: true, tasksCompleted: 1, reports: 0, proposals: 0 }),
      ],
      projects: [{ id: 'pics', name: 'Pictures' }],
      artifacts: { 'pics:reports/digest-2026-W41.md': '# digest' },
    });

    const recap = await writeWeeklyRecap(deps, monday);

    expect(recap).toEqual({ week: '2026-W41', path: 'reports/weekly-recap-2026-W41.md' });
    const body = artifacts.get('default:reports/weekly-recap-2026-W41.md')!;
    expect(body).toContain('worked 2 nights of 3 recorded nights');
    expect(body).toContain('3 tasks finished, 1 report written, 1 change proposal drafted');
    expect(body).toContain("1 night: Your crew couldn't work last night");
    expect(body).toContain('**Pictures**: `reports/digest-2026-W41.md`');

    expect(await writeWeeklyRecap(deps, monday)).toBeNull();
  });

  it('writes nothing for a week with no nights and no digests', async () => {
    const { deps } = fakeDeps({ nights: [] });
    expect(await writeWeeklyRecap(deps, monday)).toBeNull();
  });
});

describe('isoWeekBounds', () => {
  it('runs Monday to Monday', () => {
    const { from, to } = isoWeekBounds(new Date(2026, 9, 8, 15, 0));
    expect([from.getDay(), from.getDate(), to.getDate()]).toEqual([1, 5, 12]);
  });
});
