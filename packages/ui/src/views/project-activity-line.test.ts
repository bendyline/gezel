import type { HistoryEntry } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import {
  plainActivitySummary,
  projectActivityLine,
  taskTitlesFrom,
} from './project-activity-line.js';

function event(kind: string, summary: string, details?: Record<string, unknown>): HistoryEntry {
  return {
    entryType: 'event',
    id: `${kind}-1`,
    at: '2026-11-09T21:00:00Z',
    kind,
    projectId: 'willow-rye-bakery-office',
    summary,
    ...(details ? { details } : {}),
  } as HistoryEntry;
}

const PROJECT = 'willow-rye-bakery-office';

describe('projectActivityLine', () => {
  it('words the review project’s activity as plain sentences', () => {
    const created = event(
      'task.created',
      `Created task ${PROJECT}/1 — "Willow & Rye Bakery Office"`,
      { ref: `${PROJECT}/1`, title: 'Willow & Rye Bakery Office' },
    );
    const titles = taskTitlesFrom([created]);
    const lines = [
      event('task.status.changed', `Task ${PROJECT}/1 → complete`, {
        ref: `${PROJECT}/1`,
        status: 'complete',
        previous: 'active',
      }),
      event(
        'project.status.changed',
        'Project "Willow & Rye Bakery Office" status: active → stable',
        {
          previousStatus: 'active',
          status: 'stable',
        },
      ),
      created,
      event('project.updated', 'Applied project type freelance-office@1.1.0', {
        projectType: 'freelance-office',
        version: '1.1.0',
      }),
      event('project.created', 'Created project "Willow & Rye Bakery Office"', {
        name: 'Willow & Rye Bakery Office',
      }),
    ].map((entry) => projectActivityLine(entry, PROJECT, titles));

    expect(lines).toEqual([
      'Finished "Willow & Rye Bakery Office"',
      'Status changed to Stable',
      'New task: Willow & Rye Bakery Office',
      'Set up as Freelance Office',
      'Project created',
    ]);
  });

  it('names a task by number when its title is not in the list', () => {
    expect(
      projectActivityLine(
        event('task.status.changed', `Task ${PROJECT}/4 → paused`, {
          ref: `${PROJECT}/4`,
          status: 'paused',
          previous: 'active',
        }),
        PROJECT,
      ),
    ).toBe('Paused task 4');
    expect(
      projectActivityLine(
        event('task.status.changed', `Task ${PROJECT}/4 → active`, {
          ref: `${PROJECT}/4`,
          status: 'active',
          previous: 'paused',
        }),
        PROJECT,
      ),
    ).toBe('Resumed task 4');
  });

  it('names an added folder by its last name, never the full path', () => {
    expect(
      projectActivityLine(
        event(
          'project.inferred',
          'Created project "Bakery" for C:\\Users\\malika\\Documents\\Bakery',
          {
            root: 'C:\\Users\\malika\\Documents\\Bakery',
            created: true,
          },
        ),
        PROJECT,
      ),
    ).toBe('Project created for the folder "Bakery"');
  });

  it('keeps a chat line as the thread title', () => {
    const session = {
      entryType: 'session',
      id: 's1',
      gezelId: 'anna',
      projectId: PROJECT,
      title: 'Write a short reminder email',
      createdAt: '2026-11-09T21:00:00Z',
      lastActivityAt: '2026-11-09T21:01:00Z',
      messageCount: 2,
      durationMs: 60_000,
      providerName: 'llama-cpp',
    } as HistoryEntry;
    expect(projectActivityLine(session, PROJECT)).toBe('Chat: Write a short reminder email');
  });
});

describe('plainActivitySummary', () => {
  it('takes task refs, versions and absolute paths out of any other summary', () => {
    expect(plainActivitySummary(`Weekly digest for ${PROJECT}/2 done`, PROJECT)).toBe(
      'Weekly digest for task 2 done',
    );
    expect(plainActivitySummary('Applied AI App invoices@2.0.1 to Office', PROJECT)).toBe(
      'Applied AI App invoices to Office',
    );
    expect(
      plainActivitySummary(
        'Rendered 1024×1024 image/png to /home/ana/.gezel/out/cake.png',
        PROJECT,
      ),
    ).toBe('Rendered 1024×1024 image/png to cake.png');
    expect(plainActivitySummary('Linked "Shop" to https://github.com/foo/shop', PROJECT)).toBe(
      'Linked "Shop" to https://github.com/foo/shop',
    );
  });
});
