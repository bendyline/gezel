import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DiscoveredSkill } from '@bendyline/gezel';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../fs/store.js';
import { HistoryManager } from '../history/manager.js';
import { TaskManager } from '../tasks/manager.js';
import type { TaskRunner } from '../tasks/runner.js';
import {
  SKILL_RUN_STEP_ID,
  SKILL_TRIAGE_STEP_ID,
  SKILL_VERIFY_STEP_ID,
  findDiscoveredSkill,
  invokeWorkspaceSkill,
  skillInvocationSteps,
} from './skill-invocation.js';

let home: string;
let store: Store;
let history: HistoryManager;
let tasks: TaskManager;

const SKILL: DiscoveredSkill = {
  name: 'developmentarchitect',
  source: '.claude/skills/developmentarchitect/SKILL.md',
  origin: 'claude',
  description: 'Review the architecture of a change.',
  body: '## Phase 1\n\nRead the diff.\n',
  hasShellScripts: false,
  files: [{ relPath: 'references/checklist.md', kind: 'reference', bytes: 120 }],
};

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-skillinvoke-'));
  history = new HistoryManager(home);
  store = new Store({ home, history });
  await store.ensureLayout();
  await store.createProject({ name: 'Squisq' });
  tasks = new TaskManager(store, history);
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function fakeRunner(): TaskRunner & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    enqueueHandoff(payload: unknown) {
      calls.push(payload);
    },
  } as unknown as TaskRunner & { calls: unknown[] };
}

describe('skillInvocationSteps', () => {
  it('scaffolds triage → run → verify with the run step deliberately role-less', () => {
    const steps = skillInvocationSteps(SKILL, { voormanGezelId: 'lieke' });
    expect(steps.map((s) => s.id)).toEqual([
      SKILL_TRIAGE_STEP_ID,
      SKILL_RUN_STEP_ID,
      SKILL_VERIFY_STEP_ID,
    ]);
    expect(steps[0]?.assignee).toEqual({ kind: 'gezel', gezelId: 'lieke' });
    expect(steps[2]?.assignee).toEqual({ kind: 'gezel', gezelId: 'lieke' });
    expect(steps[2]?.terminal).toBe(true);
    // The whole point of triaging first: nothing pre-empts the voorman's
    // read of the skill, because `maybeResolveStepRole` respects a binding
    // that is already there.
    expect(steps[1]?.suggestedRole).toBeUndefined();
    expect(steps[1]?.suggestedGezelId).toBeUndefined();
    expect(steps[1]?.assignee).toBeUndefined();
  });

  it('falls back to the voorman ROLE when the project has no foreman yet', () => {
    const steps = skillInvocationSteps(SKILL);
    expect(steps[0]?.suggestedRole).toBe('voorman');
    expect(steps[0]?.assignee).toBeUndefined();
  });

  it('names the run step so the triage prompt can address it', () => {
    const [triage, run] = skillInvocationSteps(SKILL);
    expect(triage?.prompt).toContain(`stepId: "${SKILL_RUN_STEP_ID}"`);
    expect(triage?.prompt).toContain('craftbook_update_step');
    expect(triage?.prompt).toContain('advance_task_step');
    // Pausing is the honest exit for a skill this workspace cannot run.
    expect(triage?.prompt).toContain('set_task_status');
    expect(run?.prompt).toContain(SKILL.body);
  });

  it('cites the skill and its companion files by workspace path', () => {
    const [triage, run] = skillInvocationSteps(SKILL);
    expect(triage?.prompt).toContain('.claude/skills/developmentarchitect/SKILL.md');
    expect(triage?.prompt).toContain('.claude/skills/developmentarchitect/references/checklist.md');
    expect(run?.prompt).toContain('.claude/skills/developmentarchitect/');
  });

  it('normalizes a Windows-scanned source path for the prompts', () => {
    const [triage] = skillInvocationSteps({
      ...SKILL,
      source: '.claude\\skills\\developmentarchitect\\SKILL.md',
    });
    expect(triage?.prompt).toContain('.claude/skills/developmentarchitect/SKILL.md');
    expect(triage?.prompt).not.toContain('\\skills\\');
  });

  it('warns the triager when the skill leans on shell blocks gezel cannot run', () => {
    const [triage] = skillInvocationSteps({ ...SKILL, hasShellScripts: true });
    expect(triage?.prompt).toMatch(/shell/i);
  });
});

describe('findDiscoveredSkill', () => {
  // The scanner stores whatever `path.relative` produced; callers type
  // forward slashes. Matching raw strings worked on macOS and 404'd on
  // Windows for the identical request.
  const windowsScanned = { ...SKILL, source: '.claude\\skills\\summarize\\SKILL.md' };

  it('matches across path separators in both directions', () => {
    expect(findDiscoveredSkill([windowsScanned], '.claude/skills/summarize/SKILL.md')).toBe(
      windowsScanned,
    );
    expect(findDiscoveredSkill([SKILL], SKILL.source.replace(/\//g, '\\'))).toBe(SKILL);
  });

  it('is undefined for a source nothing scanned', () => {
    expect(findDiscoveredSkill([SKILL], '.claude/skills/nope/SKILL.md')).toBeUndefined();
  });
});

describe('invokeWorkspaceSkill', () => {
  it('owns the task with the project voorman and dispatches the entry step', async () => {
    const voorman = await store.createGezel({ name: 'Lieke', role: 'Voorman' });
    await store.updateProject('squisq', { voormanGezelId: voorman.id });
    const taskRunner = fakeRunner();

    const { task, dispatch } = await invokeWorkspaceSkill(
      { store, tasks, taskRunner, history },
      'squisq',
      SKILL,
    );

    // The failure this replaces: assignee {kind:'user'}, nothing enqueued.
    expect(task.assignee).toEqual({ kind: 'gezel', gezelId: voorman.id });
    expect(task.activeStepId).toBe(SKILL_TRIAGE_STEP_ID);
    expect(task.craftbook.steps).toHaveLength(3);
    expect(dispatch.enqueued).toBe(true);
    expect(dispatch.assigneeName).toBe('Lieke');
    expect(taskRunner.calls).toEqual([
      expect.objectContaining({
        gezelId: voorman.id,
        taskRef: task.ref,
        stepId: SKILL_TRIAGE_STEP_ID,
        kind: 'entry',
      }),
    ]);
  });

  it('resolves the voorman role when no foreman is set, and still dispatches', async () => {
    const hendrik = await store.createGezel({ name: 'Hendrik', role: 'Voorman' });
    tasks.setRoleResolver(async (role) => (role === 'voorman' ? { gezelId: hendrik.id } : null));
    const taskRunner = fakeRunner();

    const { task, dispatch } = await invokeWorkspaceSkill(
      { store, tasks, taskRunner, history },
      'squisq',
      SKILL,
    );

    expect(task.assignee).toEqual({ kind: 'gezel', gezelId: hendrik.id });
    expect(dispatch.enqueued).toBe(true);
  });

  it('creates the task but reports it unstarted when nobody resolves', async () => {
    const taskRunner = fakeRunner();
    const { task, dispatch } = await invokeWorkspaceSkill(
      { store, tasks, taskRunner, history },
      'squisq',
      SKILL,
    );

    expect(task.craftbook.steps).toHaveLength(3);
    expect(dispatch.enqueued).toBe(false);
    expect(dispatch.reason).toBe('no-entry-gezel');
    expect(taskRunner.calls).toHaveLength(0);
  });

  it('logs the entry handoff to history so the audit trail shows the kickoff', async () => {
    const voorman = await store.createGezel({ name: 'Lieke', role: 'Voorman' });
    await store.updateProject('squisq', { voormanGezelId: voorman.id });
    const spy = vi.spyOn(history, 'log');

    await invokeWorkspaceSkill(
      { store, tasks, taskRunner: fakeRunner(), history },
      'squisq',
      SKILL,
    );

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'task.entry.dispatched', gezelId: voorman.id }),
    );
  });
});
