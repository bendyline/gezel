import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_NIGHT_SHIFT_WINDOW, type Question } from '@bendyline/gezel';
import { BundledSource, CatalogService } from '@bendyline/gezel-catalog';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatManager } from '../chat/manager.js';
import { DiffpackManager } from '../diffpack/manager.js';
import { Store } from '../fs/store.js';
import { ReportActionManager } from '../report-actions/report-action-manager.js';
import { TaskManager } from './manager.js';
import {
  buildNightShiftReview,
  nightShiftReportAttachmentPath,
  normalizeNightShiftReportAttachment,
} from './night-review.js';
import type { TaskRunner } from './runner.js';

let home: string;
let dataDir: string;
let store: Store;
let tasks: TaskManager;
let reportActions: ReportActionManager;
let diffpacks: DiffpackManager;

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
  diffpacks = new DiffpackManager({ home, store, tasks });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(dataDir, { recursive: true, force: true });
});

describe('buildNightShiftReview', () => {
  it('qualifies a Default-project report as a project artifact attachment', () => {
    expect(
      nightShiftReportAttachmentPath({
        projectId: 'default',
        path: 'night-shift-report.md',
      }),
    ).toBe('projects/default/artifacts/night-shift-report.md');
  });

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
      { store, tasks, reportActions, diffpacks },
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

  it('does not count a declared data deliverable as a report', async () => {
    const project = await store.createProject({ name: 'Coverage' });
    const created = await tasks.create(project.id, {
      title: 'Coverage sweep',
      assignee: { kind: 'user' },
      steps: [{ name: 'Sweep', advanceWhen: { file: 'coverage-18.json', artifact: true } }],
      nightShift: { enabled: true, onceADay: true },
    });
    const record = await store.readTask(project.id, created.num);
    await store.writeTask({
      ...record!,
      status: 'complete',
      nightShift: { enabled: true, onceADay: true, lastRunDay: '2026-06-20' },
    });
    await store.writeProjectArtifact(project.id, 'coverage-18.json', '{"batchNumber": 18}\n');

    const review = await buildNightShiftReview(
      { store, tasks, reportActions, diffpacks },
      DEFAULT_NIGHT_SHIFT_WINDOW,
      NOW,
    );
    expect(review.tasksCompleted).toHaveLength(1);
    expect(review.reports).toEqual([]);
  });

  it('finds reports via the mtime sweep even without declared deliverables', async () => {
    const project = await store.createProject({ name: 'Docs' });
    await store.writeProjectArtifact(project.id, 'reports/digest-2026-W25.md', '# Weekly digest\n');
    // The freshly written artifact's mtime is "now" — outside last night's
    // window — so first confirm it is excluded…
    const stale = await buildNightShiftReview(
      { store, tasks, reportActions, diffpacks },
      DEFAULT_NIGHT_SHIFT_WINDOW,
      NOW,
    );
    expect(stale.reports).toHaveLength(0);

    // …then bring "now" forward so the write instant falls inside the
    // current window (always-open window for determinism).
    const insideNow = new Date(Date.now() + 1000);
    const review = await buildNightShiftReview(
      { store, tasks, reportActions, diffpacks },
      { startHour: 0, endHour: 0 },
      insideNow,
    );
    expect(review.reports.map((r) => r.path)).toContain('reports/digest-2026-W25.md');
  });

  it('returns an empty review when nothing ran', async () => {
    await store.createProject({ name: 'Quiet' });
    const review = await buildNightShiftReview(
      { store, tasks, reportActions, diffpacks },
      DEFAULT_NIGHT_SHIFT_WINDOW,
      NOW,
    );
    expect(review.tasksCompleted).toHaveLength(0);
    expect(review.reports).toHaveLength(0);
  });
});

describe('change proposals in the morning review', () => {
  async function seedPack(packId: string, status: 'ready' | 'dismissed'): Promise<void> {
    await store.createProject({ name: 'Fixture' });
    const wd = await store.projectWorkspaceDir('fixture');
    await mkdir(wd, { recursive: true });
    await writeFile(join(wd, `${packId}.ts`), 'before\n', 'utf8');
    await diffpacks.ensure('fixture', packId, {
      title: `Proposal ${packId}`,
      origin: { kind: 'boekwachter-issue', issueRefs: [`BW-${packId}`] },
      taskRef: `fixture/${packId}`,
    });
    await diffpacks.drafts.write('fixture', packId, `${packId}.ts`, 'after\n');
    await diffpacks.seal('fixture', packId);
    if (status === 'dismissed') await diffpacks.dismiss('fixture', packId);
  }

  it('lists proposals still waiting on the user', async () => {
    await seedPack('1', 'ready');
    const review = await buildNightShiftReview(
      { store, tasks, reportActions, diffpacks },
      DEFAULT_NIGHT_SHIFT_WINDOW,
      NOW,
    );
    expect(review.diffpacks).toEqual([
      {
        packId: '1',
        projectId: 'fixture',
        projectName: 'Fixture',
        title: 'Proposal 1',
        status: 'ready',
        fileCount: 1,
        additions: 1,
        deletions: 1,
        issueRefs: ['BW-1'],
        drifted: false,
      },
    ]);
  });

  it('drops proposals the user already answered', async () => {
    await seedPack('1', 'dismissed');
    const review = await buildNightShiftReview(
      { store, tasks, reportActions, diffpacks },
      DEFAULT_NIGHT_SHIFT_WINDOW,
      NOW,
    );
    expect(review.diffpacks).toEqual([]);
  });

  it('flags a proposal whose target moved under it', async () => {
    await seedPack('1', 'ready');
    const wd = await store.projectWorkspaceDir('fixture');
    await writeFile(join(wd, '1.ts'), 'edited by hand\n', 'utf8');
    const review = await buildNightShiftReview(
      { store, tasks, reportActions, diffpacks },
      DEFAULT_NIGHT_SHIFT_WINDOW,
      NOW,
    );
    expect(review.diffpacks[0]?.drifted).toBe(true);
  });
});

describe('normalizeNightShiftReportAttachment', () => {
  const card = (paths: string[], documentPath?: string): Question =>
    ({
      id: 'q1',
      projectId: 'default',
      gezelId: 'g1',
      sessionId: '',
      prompt: 'The night shift finished 1 task.',
      choices: ['Dismiss'],
      allowWriteIn: false,
      multiSelect: false,
      createdAt: '2026-06-21T07:00:00.000Z',
      ...(documentPath ? { documentPath } : {}),
      intent: {
        kind: 'night-shift-review',
        windowKey: '2026-06-20',
        tasksCompleted: 1,
        reports: paths.map((path) => ({ projectId: 'default', path, actionCount: 0 })),
      },
    }) as Question;

  it('points the attachment at the first report', () => {
    const out = normalizeNightShiftReportAttachment(card(['reports/night.md']));
    expect(out.documentPath).toBe('projects/default/artifacts/reports/night.md');
  });

  it('heals a legacy card that attached a data deliverable', () => {
    const out = normalizeNightShiftReportAttachment(
      card(['coverage-18.json'], 'projects/default/artifacts/coverage-18.json'),
    );
    expect(out.documentPath).toBeUndefined();
    expect(out.intent?.kind === 'night-shift-review' && out.intent.reports).toEqual([]);
  });

  it('skips past a data deliverable to the real report', () => {
    const out = normalizeNightShiftReportAttachment(card(['coverage-18.json', 'reports/night.md']));
    expect(out.documentPath).toBe('projects/default/artifacts/reports/night.md');
  });
});
