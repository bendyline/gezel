import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_NIGHT_SHIFT_WINDOW } from '@bendyline/gezel';
import { BundledSource, CatalogService } from '@bendyline/gezel-catalog';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatManager } from '../chat/manager.js';
import { Store } from '../fs/store.js';
import { ReportActionManager } from '../reports/report-action-manager.js';
import { TaskManager } from './manager.js';
import { buildNightShiftReview } from './night-review.js';
import type { TaskRunner } from './runner.js';

let home: string;
let dataDir: string;
let store: Store;
let tasks: TaskManager;
let reportActions: ReportActionManager;

// Default window 22:00 → 06:00 local; "this morning" is 09:00 on the 21st,
// so last night's window is keyed 2026-06-20.
const NOW = new Date(2026, 5, 21, 9, 0);
const IN_WINDOW = new Date(2026, 5, 21, 2, 0).toISOString();

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'night-review-'));
  dataDir = await mkdtemp(join(tmpdir(), 'night-review-data-'));
  store = new Store({ home });
  await store.ensureLayout();
  tasks = new TaskManager(store);
  reportActions = new ReportActionManager({
    home,
    store,
    tasks,
    taskRunner: null as unknown as TaskRunner,
    catalog: new CatalogService([new BundledSource({ dataDir, noIndex: true })]),
    chat: null as unknown as ChatManager,
  });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(dataDir, { recursive: true, force: true });
});

describe('buildNightShiftReview', () => {
  it('collects night tasks by lastRunDay, their declared deliverables, and action tallies', async () => {
    const project = await store.createProject({ name: 'Shop' });
    const created = await tasks.create(project.id, {
      title: 'Nightly security review',
      assignee: { kind: 'user' },
      steps: [
        {
          name: 'Review',
          advanceWhen: { file: 'reports/security.md', artifact: true },
        },
      ],
      nightShift: { enabled: true, onceADay: true },
    });
    // Simulate the run having happened last night.
    const record = await store.readTask(project.id, created.num);
    await store.writeTask({
      ...record!,
      status: 'complete',
      nightShift: { enabled: true, onceADay: true, lastRunDay: '2026-06-20' },
    });
    await store.writeProjectArtifact(
      project.id,
      'reports/security.md',
      [
        '# Security posture',
        '',
        'One finding.',
        '',
        '```gezel-action',
        'kind: create-task',
        'id: fix-headers',
        'title: Add security headers',
        'prompt: Add the missing headers to responses.',
        '```',
        '',
      ].join('\n'),
    );

    const review = await buildNightShiftReview(
      { store, tasks, reportActions },
      DEFAULT_NIGHT_SHIFT_WINDOW,
      NOW,
    );
    expect(review.windowKey).toBe('2026-06-20');
    expect(review.tasksCompleted).toHaveLength(1);
    expect(review.tasksCompleted[0]?.title).toBe('Nightly security review');
    expect(review.reports).toHaveLength(1);
    expect(review.reports[0]).toMatchObject({
      path: 'reports/security.md',
      title: 'Security posture',
      actionCounts: { total: 1, suggested: 1, fired: 0, applied: 0, dismissed: 0 },
    });
  });

  it('finds reports via the mtime sweep even without declared deliverables', async () => {
    const project = await store.createProject({ name: 'Docs' });
    await store.writeProjectArtifact(project.id, 'reports/digest-2026-W25.md', '# Weekly digest\n');
    // The freshly written artifact's mtime is "now" — outside last night's
    // window — so first confirm it is excluded…
    const stale = await buildNightShiftReview(
      { store, tasks, reportActions },
      DEFAULT_NIGHT_SHIFT_WINDOW,
      NOW,
    );
    expect(stale.reports).toHaveLength(0);

    // …then bring "now" forward so the write instant falls inside the
    // current window (always-open window for determinism).
    const insideNow = new Date(Date.now() + 1000);
    const review = await buildNightShiftReview(
      { store, tasks, reportActions },
      { startHour: 0, endHour: 0 },
      insideNow,
    );
    expect(review.reports.map((r) => r.path)).toContain('reports/digest-2026-W25.md');
  });

  it('returns an empty review when nothing ran', async () => {
    await store.createProject({ name: 'Quiet' });
    const review = await buildNightShiftReview(
      { store, tasks, reportActions },
      DEFAULT_NIGHT_SHIFT_WINDOW,
      NOW,
    );
    expect(review.tasksCompleted).toHaveLength(0);
    expect(review.reports).toHaveLength(0);
  });
});
