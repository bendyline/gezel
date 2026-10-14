import { mkdtemp, rm, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ChatSession,
  NIGHT_WORK_PROPERTY,
  type NightShiftReviewIntent,
  type Question,
  normalizeStepGate,
} from '@bendyline/gezel';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../fs/store.js';
import { HistoryManager } from '../history/manager.js';
import { TaskManager } from '../tasks/manager.js';
import {
  ensureNightShiftOversightTask,
  findNightShiftOversightTask,
  isNightShiftOversightTask,
  prepareReviewForNight,
} from './night-shift-oversight.js';

const OVERSIGHT_TITLE = 'Night-shift oversight: project review';

let home: string;
let store: Store;
let tasks: TaskManager;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-night-shift-'));
  const history = new HistoryManager(home);
  store = new Store({ home, history });
  await store.ensureLayout();
  await store.ensureDefaultProject();
  tasks = new TaskManager(store, history);
  const meester = await store.createGezel({ name: 'Wren', role: 'Meester' });
  await store.writeConfig({ meesterGezelId: meester.id });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const oversightStep = async () => {
  const list = await store.listProjectTasks('default');
  const installed = list.find((t) => t.title === OVERSIGHT_TITLE);
  expect(installed).toBeDefined();
  const task = await store.readTask('default', installed!.num);
  return { task: task!, step: task!.craftbook.steps.find((s) => s.id === 'oversight')! };
};

/**
 * `advanceWhen` drives the auto-advance watcher only; `completeStep`
 * rejects a step solely on its `gate`. Without one, a run that never wrote
 * the report called `advance_task_step` and sailed through — observed at
 * attempt 7, after which the task re-armed for the next night as if the
 * review had happened.
 */
describe('night-shift oversight task', () => {
  const reviewScope = (prompt: string) =>
    JSON.parse(prompt.match(/Review ONLY these project IDs: (\[[^\n]*\])/u)![1]!) as string[];

  it('reviews eligible projects without including Default or opted-out projects', async () => {
    const included = await store.createProject({ name: 'Included' });
    const excluded = await store.createProject({ name: 'Excluded' });
    const inactive = await store.createProject({ name: 'Inactive' });
    await store.updateProject(excluded.id, { properties: { [NIGHT_WORK_PROPERTY]: 'off' } });
    await store.updateProject(inactive.id, { status: 'inactive' });

    await ensureNightShiftOversightTask(store, tasks);

    const { task, step } = await oversightStep();
    expect(reviewScope(step.prompt!)).toEqual([included.id]);
    expect(task.projectId).toBe('default'); // Report storage is independent of review scope.
  });

  it('has an empty review scope when Default is the only project', async () => {
    await ensureNightShiftOversightTask(store, tasks);
    expect(reviewScope((await oversightStep()).step.prompt!)).toEqual([]);
  });

  it('refreshes an installed review when Default is opted in and back out', async () => {
    await ensureNightShiftOversightTask(store, tasks);
    const original = await oversightStep();

    await store.updateProject('default', { properties: { [NIGHT_WORK_PROPERTY]: 'on' } });
    await ensureNightShiftOversightTask(store, tasks);
    expect(reviewScope((await oversightStep()).step.prompt!)).toEqual(['default']);

    await store.updateProject('default', { properties: { [NIGHT_WORK_PROPERTY]: 'off' } });
    await ensureNightShiftOversightTask(store, tasks);
    const updated = await oversightStep();
    expect(reviewScope(updated.step.prompt!)).toEqual([]);
    expect(updated.task.ref).toBe(original.task.ref);
    expect(await store.listProjectTasks('default')).toHaveLength(1);
  });

  it('installs the step with a completion gate on the report artifact', async () => {
    await ensureNightShiftOversightTask(store, tasks);
    const { step } = await oversightStep();

    expect(step.gate).toBeDefined();
    const gate = normalizeStepGate(step.gate!);
    expect(gate.at).toBe('completion');
    expect(gate.checks).toEqual([
      { kind: 'minBytes', file: 'night-shift-report.md', bytes: 200, artifact: true },
    ]);
    // The watcher path keeps its own freshness guard.
    expect(step.advanceWhen).toMatchObject({
      file: 'night-shift-report.md',
      artifact: true,
      requireChange: true,
    });
  });

  it('stamps the gate onto an install that predates it', async () => {
    await ensureNightShiftOversightTask(store, tasks);
    const { task } = await oversightStep();

    // Reproduce the shipped-before-the-fix shape: deliverable declared,
    // nothing enforcing it on an explicit advance.
    await store.writeTask({
      ...task,
      craftbook: {
        ...task.craftbook,
        steps: task.craftbook.steps.map((s) => {
          if (s.id !== 'oversight') return s;
          const { gate: _dropped, ...withoutGate } = s;
          return withoutGate;
        }),
      },
    });
    expect((await oversightStep()).step.gate).toBeUndefined();

    await ensureNightShiftOversightTask(store, tasks);

    const restamped = (await oversightStep()).step.gate;
    expect(restamped).toBeDefined();
    expect(normalizeStepGate(restamped!).checks).toEqual([
      { kind: 'minBytes', file: 'night-shift-report.md', bytes: 200, artifact: true },
    ]);
  });

  it('is idempotent once the gate is current', async () => {
    await ensureNightShiftOversightTask(store, tasks);
    const first = await oversightStep();
    await ensureNightShiftOversightTask(store, tasks);
    const second = await oversightStep();

    expect(second.task.updatedAt).toBe(first.task.updatedAt);
    expect(await store.listProjectTasks('default')).toHaveLength(1);
  });

  /**
   * Earlier builds charged the waiting oversight step on every launch and
   * paused it on the fourth, with a "Needs your input" card about a task that
   * had never run. Found on a dev home paused for a month.
   */
  describe('restart-budget pause from earlier builds', () => {
    const pauseLikeAnEarlierBuild = async (restartResumeCount: number) => {
      await ensureNightShiftOversightTask(store, tasks);
      const { task } = await oversightStep();
      await store.writeTask({
        ...task,
        status: 'paused',
        craftbook: {
          ...task.craftbook,
          steps: task.craftbook.steps.map((s) =>
            s.id === 'oversight' ? { ...s, restartResumeCount } : s,
          ),
        },
      });
      await store.writeQuestion({
        id: 'q-paused',
        projectId: 'default',
        gezelId: task.assignee.kind === 'gezel' ? task.assignee.gezelId : '',
        sessionId: '',
        prompt: `Task ${task.ref} paused for help at step \`oversight\``,
        choices: ['Dismiss'],
        allowWriteIn: false,
        multiSelect: false,
        taskRef: task.ref,
        intent: {
          kind: 'task-paused',
          taskRef: task.ref,
          stepId: 'oversight',
          reason: 'step_stalled',
        },
        createdAt: new Date().toISOString(),
      });
      return task;
    };

    it('resumes the task and clears its card', async () => {
      await pauseLikeAnEarlierBuild(4);
      await ensureNightShiftOversightTask(store, tasks);

      const { task, step } = await oversightStep();
      expect(task.status).toBe('active');
      expect(step.restartResumeCount).toBeUndefined();
      const card = await store.getQuestion('default', 'q-paused');
      expect(card?.answer?.silentSkip).toBe(true);
    });

    it('resumes a pause of any kind with a fresh budget, so nobody presses Resume', async () => {
      await pauseLikeAnEarlierBuild(2);
      const paused = await oversightStep();
      await store.writeTask({
        ...paused.task,
        craftbook: {
          ...paused.task.craftbook,
          steps: paused.task.craftbook.steps.map((s) =>
            s.id === 'oversight' ? { ...s, redriveCount: 3, gateAttempts: 3 } : s,
          ),
        },
      });
      await ensureNightShiftOversightTask(store, tasks);

      const { task, step } = await oversightStep();
      expect(task.status).toBe('active');
      expect(step.redriveCount ?? 0).toBe(0);
      expect(step.gateAttempts).toBeUndefined();
      expect((await store.getQuestion('default', 'q-paused'))?.answer?.silentSkip).toBe(true);
    });
  });

  // A re-driven run asked the person how to settle a mismatch between two
  // runtime guards (2026-10-08). Nobody is awake to answer the review.
  describe('never asks the person anything', () => {
    it('tells the run, in its step, that nobody can answer', async () => {
      await ensureNightShiftOversightTask(store, tasks);
      const { step } = await oversightStep();
      expect(step.prompt).toContain('never ask the user anything');
      // `ask_user_question` is a workflow safety tool no step policy may
      // remove; the question route declines it instead.
      expect(step.toolPolicy).toBeUndefined();
    });

    it("withdraws what a run already asked, and leaves other work's questions", async () => {
      await ensureNightShiftOversightTask(store, tasks);
      const { task } = await oversightStep();
      const ask = (id: string, taskRef?: string) =>
        store.writeQuestion({
          id,
          projectId: 'default',
          gezelId: 'wren',
          sessionId: 'session-1',
          prompt: 'The recurring re-arm is generating false re-nudges. How should I handle it?',
          choices: ['The report is done', 'Pause the task'],
          allowWriteIn: true,
          multiSelect: false,
          ...(taskRef ? { taskRef } : {}),
          createdAt: new Date().toISOString(),
        });
      await ask('q-review', task.ref);
      await ask('q-other', 'default/9');
      await ask('q-chat');

      await ensureNightShiftOversightTask(store, tasks);

      expect((await store.getQuestion('default', 'q-review'))?.answer?.silentSkip).toBe(true);
      expect((await store.getQuestion('default', 'q-other'))?.answer).toBeUndefined();
      expect((await store.getQuestion('default', 'q-chat'))?.answer).toBeUndefined();
    });

    it("is recognized as the runtime's own work, which files no paused-for-help card", async () => {
      await ensureNightShiftOversightTask(store, tasks);
      const { task } = await oversightStep();
      expect(isNightShiftOversightTask(task)).toBe(true);
      expect(isNightShiftOversightTask({ ...task, projectId: 'pics' })).toBe(false);
      expect(isNightShiftOversightTask({ ...task, title: 'Weekly digest' })).toBe(false);
    });
  });

  // The next night resumed last night's session, read the old report back,
  // and advanced on it: the gate passed on yesterday's file (2026-10-08).
  describe('each night starts from nothing', () => {
    const lastNight = async (lastRunDay: string) => {
      await ensureNightShiftOversightTask(store, tasks);
      const { task } = await oversightStep();
      await store.writeTask({ ...task, nightShift: { ...task.nightShift!, lastRunDay } });
      const at = new Date().toISOString();
      const session: ChatSession = {
        version: 1,
        id: 'review-session',
        gezelId: task.assignee.kind === 'gezel' ? task.assignee.gezelId : 'wren',
        projectId: 'default',
        providerName: 'mlx',
        title: task.title,
        createdAt: at,
        lastActivityAt: at,
        messages: [],
        providerState: {},
        taskRef: task.ref,
        stepId: 'oversight',
      };
      await store.writeSession(session);
      await store.writeProjectArtifact('default', 'night-shift-report.md', '# Last night\n');
      const archived: string[] = [];
      const archiveSession = async (id: string) => {
        archived.push(id);
        const record = await store.getSession(session.gezelId, id);
        await store.writeSession({ ...record!, archived: true });
      };
      return { archived, archiveSession };
    };

    // Local wall-clock instants, the way the window is defined (22:00 → 06:00).
    const local = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute);
    const artifact = (path: string) => join(store.projectArtifactsDir('default'), path);
    const writtenAt = (path: string, at: Date) => utimes(artifact(path), at, at);

    it("archives last night's session and dates last night's report aside", async () => {
      const { archived, archiveSession } = await lastNight('2026-10-07');
      const written = local(7, 23, 30);
      await writtenAt('night-shift-report.md', written);

      const moves: Array<[string, string]> = [];
      await prepareReviewForNight(
        {
          store,
          archiveSession,
          moveReportActions: async (from, to) => {
            moves.push([from, to]);
          },
        },
        '2026-10-08',
      );

      expect(archived).toEqual(['review-session']);
      expect(moves).toEqual([['night-shift-report.md', 'night-shift-report-2026-10-07.md']]);
      expect(await store.readProjectArtifact('default', 'night-shift-report.md')).toBeNull();
      expect(await store.readProjectArtifact('default', 'night-shift-report-2026-10-07.md')).toBe(
        '# Last night\n',
      );
      // Moved, not copied: a copy's fresh mtime falls inside tonight's window,
      // and the morning review read it as tonight's report.
      expect((await stat(artifact('night-shift-report-2026-10-07.md'))).mtimeMs).toBe(
        written.getTime(),
      );
    });

    const morningCard = (windowKey: string, answered = false): Question => ({
      id: `card-${windowKey}`,
      projectId: 'default',
      gezelId: 'wren',
      sessionId: '',
      prompt: 'The night shift left 2 reports for you.',
      choices: ['Dismiss'],
      allowWriteIn: false,
      multiSelect: false,
      createdAt: new Date().toISOString(),
      documentPath: 'projects/default/artifacts/night-shift-report.md',
      intent: {
        kind: 'night-shift-review',
        windowKey,
        tasksCompleted: 0,
        reports: [
          { projectId: 'default', path: 'night-shift-report.md', title: 'Review', actionCount: 1 },
          { projectId: 'shop', path: 'reports/security.md', title: 'Security', actionCount: 0 },
        ],
      },
      ...(answered ? { answer: { selectedChoices: [0], at: new Date().toISOString() } } : {}),
    });
    const cardById = async (id: string) =>
      (await store.listProjectQuestions('default')).find((q) => q.id === id)!;

    it('points an unanswered morning card at the dated report it showed', async () => {
      const { archiveSession } = await lastNight('2026-10-07');
      await writtenAt('night-shift-report.md', local(7, 23, 30));
      await store.writeQuestion(morningCard('2026-10-07'));
      await store.writeQuestion(morningCard('2026-10-06', true));

      await prepareReviewForNight({ store, archiveSession }, '2026-10-08');

      const card = await cardById('card-2026-10-07');
      expect(card.documentPath).toBe('projects/default/artifacts/night-shift-report-2026-10-07.md');
      expect((card.intent as NightShiftReviewIntent).reports.map((r) => r.path)).toEqual([
        'night-shift-report-2026-10-07.md',
        'reports/security.md',
      ]);
      // A card already dismissed is history; nothing reopens it.
      expect((await cardById('card-2026-10-06')).documentPath).toBe(
        'projects/default/artifacts/night-shift-report.md',
      );

      // Tonight's report is written and dated aside the next night; the
      // earlier card keeps the copy it already points at.
      await store.writeProjectArtifact('default', 'night-shift-report.md', '# The 8th\n');
      await writtenAt('night-shift-report.md', local(8, 23, 30));
      await store.writeQuestion(morningCard('2026-10-08'));
      await prepareReviewForNight({ store, archiveSession }, '2026-10-09');

      expect((await cardById('card-2026-10-07')).documentPath).toBe(
        'projects/default/artifacts/night-shift-report-2026-10-07.md',
      );
      expect((await cardById('card-2026-10-08')).documentPath).toBe(
        'projects/default/artifacts/night-shift-report-2026-10-08.md',
      );
    });

    it("leaves the cards alone when tonight's report stays put", async () => {
      const { archiveSession } = await lastNight('2026-10-07');
      await writtenAt('night-shift-report.md', local(8, 23, 10));
      await store.writeQuestion(morningCard('2026-10-07'));

      await prepareReviewForNight({ store, archiveSession }, '2026-10-08');

      expect((await cardById('card-2026-10-07')).documentPath).toBe(
        'projects/default/artifacts/night-shift-report.md',
      );
    });

    it("keeps tonight's report through a restart mid-window, and the dated copy too", async () => {
      const { archiveSession } = await lastNight('2026-10-07');
      await store.writeProjectArtifact(
        'default',
        'night-shift-report-2026-10-07.md',
        '# Last night\n',
      );
      await store.writeProjectArtifact('default', 'night-shift-report.md', '# Tonight, so far\n');
      await writtenAt('night-shift-report.md', local(8, 23, 10));

      await prepareReviewForNight({ store, archiveSession }, '2026-10-08');

      expect(await store.readProjectArtifact('default', 'night-shift-report.md')).toBe(
        '# Tonight, so far\n',
      );
      expect(await store.readProjectArtifact('default', 'night-shift-report-2026-10-07.md')).toBe(
        '# Last night\n',
      );
    });

    it('dates a report from a review that never finished by its own night, never over a copy', async () => {
      const { archiveSession } = await lastNight('2026-10-06');
      await store.writeProjectArtifact(
        'default',
        'night-shift-report-2026-10-06.md',
        '# The 6th\n',
      );
      await store.writeProjectArtifact(
        'default',
        'night-shift-report-2026-10-07.md',
        '# The 7th\n',
      );
      await store.writeProjectArtifact('default', 'night-shift-report.md', '# The 7th, again\n');
      // Written after midnight: still the night that began on the 7th.
      await writtenAt('night-shift-report.md', local(8, 2, 15));

      await prepareReviewForNight({ store, archiveSession }, '2026-10-08');

      expect(await store.readProjectArtifact('default', 'night-shift-report.md')).toBeNull();
      expect(await store.readProjectArtifact('default', 'night-shift-report-2026-10-06.md')).toBe(
        '# The 6th\n',
      );
      expect(await store.readProjectArtifact('default', 'night-shift-report-2026-10-07.md')).toBe(
        '# The 7th\n',
      );
      expect(await store.readProjectArtifact('default', 'night-shift-report-2026-10-07-2.md')).toBe(
        '# The 7th, again\n',
      );
    });

    it('leaves a night whose review already ran alone', async () => {
      const { archived, archiveSession } = await lastNight('2026-10-08');

      await prepareReviewForNight({ store, archiveSession }, '2026-10-08');

      expect(archived).toEqual([]);
      expect(await store.readProjectArtifact('default', 'night-shift-report.md')).toBe(
        '# Last night\n',
      );
    });
  });

  it('finds the installed task, paused or not, for the morning card', async () => {
    expect(await findNightShiftOversightTask(store)).toBeNull();
    await ensureNightShiftOversightTask(store, tasks);
    const found = await findNightShiftOversightTask(store);
    expect(found?.title).toBe(OVERSIGHT_TITLE);

    await tasks.setStatus('default', found!.num, 'paused');
    expect((await findNightShiftOversightTask(store))?.status).toBe('paused');
    // Ensuring again (each window open) resumes it for that night.
    await ensureNightShiftOversightTask(store, tasks);
    expect((await findNightShiftOversightTask(store))?.status).toBe('active');
  });
});
