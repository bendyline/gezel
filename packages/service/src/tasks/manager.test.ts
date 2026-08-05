import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../fs/store.js';
import { HistoryManager } from '../history/manager.js';
import { TaskManager } from './manager.js';

let home: string;
let store: Store;
let history: HistoryManager;
let tasks: TaskManager;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-taskmgr-'));
  history = new HistoryManager(home);
  store = new Store({ home, history });
  await store.ensureLayout();
  await store.createProject({ name: 'Website' });
  tasks = new TaskManager(store, history);
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('TaskManager', () => {
  const installProjectToolset = async (toolsetId: string) => {
    await store.writeInstalledToolsets({ kind: 'project', projectId: 'website' }, [
      {
        toolsetId,
        sourceId: 'bundled',
        version: '1.0.0',
        installedAt: '2026-07-27T00:00:00.000Z',
        runtime: { kind: 'builtin', toolsetGroupId: toolsetId },
      },
    ]);
  };

  it('create allocates num=1 then increments', async () => {
    const a = await tasks.create('website', {
      title: 'First',
      assignee: { kind: 'user' },
      steps: [{ name: 'Main' }],
    });
    const b = await tasks.create('website', {
      title: 'Second',
      assignee: { kind: 'user' },
      steps: [{ name: 'Main' }],
    });
    expect(a.num).toBe(1);
    expect(a.ref).toBe('website/1');
    expect(b.num).toBe(2);
    expect(b.ref).toBe('website/2');
  });

  it('concurrent creates never collide', async () => {
    const N = 15;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        tasks.create('website', {
          title: `t${i}`,
          assignee: { kind: 'user' },
          steps: [{ name: 'Main' }],
        }),
      ),
    );
    const nums = results.map((t) => t.num);
    expect(new Set(nums).size).toBe(N);
    expect(Math.min(...nums)).toBe(1);
    expect(Math.max(...nums)).toBe(N);
  });

  it('snapshots a craftbook’s toolsets and basedOn credit onto the task', async () => {
    await installProjectToolset('usb-camera');
    tasks.setCraftbookResolver({
      async resolve(id) {
        return {
          craftbook: {
            id,
            name: 'Home Monitoring',
            steps: [{ id: 'capture', name: 'Capture', terminal: true }],
            entryStepId: 'capture',
            basedOn: { name: 'Camera recipe', url: 'https://example.com/camera-recipe' },
            toolsets: [{ toolsetId: 'usb-camera', autoAllow: true, reason: 'pull frames' }],
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
          },
          sourceId: 'bundled',
        };
      },
    });
    const t = await tasks.create('website', {
      title: 'Watch',
      assignee: { kind: 'user' },
      craftbookId: 'home-monitoring',
    });
    expect(t.craftbook.toolsets).toEqual([
      { toolsetId: 'usb-camera', autoAllow: true, reason: 'pull frames' },
    ]);
    expect(t.craftbook.basedOn).toEqual({
      name: 'Camera recipe',
      url: 'https://example.com/camera-recipe',
    });
  });

  it('refuses to create a craftbook task until required project toolsets are installed', async () => {
    tasks.setCraftbookResolver({
      async resolve(id) {
        return {
          craftbook: {
            id,
            name: 'PowerPoint Deck',
            steps: [{ id: 'produce', name: 'Produce', terminal: true }],
            entryStepId: 'produce',
            toolsets: [
              {
                toolsetId: 'docblocks',
                reason: 'produce and visually verify the real PPTX',
              },
            ],
            createdAt: '2026-07-27T00:00:00Z',
            updatedAt: '2026-07-27T00:00:00Z',
          },
          sourceId: 'bundled',
        };
      },
    });

    await expect(
      tasks.create('website', {
        title: 'D-Day deck',
        assignee: { kind: 'user' },
        craftbookId: 'powerpoint-deck',
      }),
    ).rejects.toThrow(/SETUP REQUIRED.*docblocks.*No task was created/i);
    expect(await tasks.list({ projectId: 'website' })).toHaveLength(0);

    await installProjectToolset('docblocks');
    const created = await tasks.create('website', {
      title: 'D-Day deck',
      assignee: { kind: 'user' },
      craftbookId: 'powerpoint-deck',
    });
    expect(created.craftbook.toolsets?.[0]?.toolsetId).toBe('docblocks');
  });

  it('emits task.created history', async () => {
    await tasks.create('website', {
      title: 'Ship',
      assignee: { kind: 'user' },
      steps: [{ name: 'Main' }],
    });
    const events = await history.listEvents({ kinds: ['task.created'] });
    expect(events).toHaveLength(1);
    expect(events[0]?.summary).toMatch(/Ship/);
  });

  it('update with description change emits task.about.updated and not task.updated', async () => {
    const t = await tasks.create('website', {
      title: 'Ship',
      assignee: { kind: 'user' },
      steps: [{ name: 'Main' }],
    });
    await tasks.update('website', t.num, { description: '# Why\n\nNew prose.' });
    const aboutEvents = await history.listEvents({ kinds: ['task.about.updated'] });
    const updatedEvents = await history.listEvents({ kinds: ['task.updated'] });
    expect(aboutEvents).toHaveLength(1);
    expect(updatedEvents).toHaveLength(0);

    const reloaded = await tasks.get('website', t.num);
    expect(reloaded?.description).toBe('# Why\n\nNew prose.');
  });

  it('clears a persisted description sidecar and preserves it when the patch omits the field', async () => {
    const t = await tasks.create('website', {
      title: 'Ship',
      description: 'A persisted description that should be removable again.',
      assignee: { kind: 'user' },
      steps: [{ name: 'Main' }],
    });

    const titleOnly = await tasks.update('website', t.num, { title: 'Ship safely' });
    expect(titleOnly.description).toBe('A persisted description that should be removable again.');
    expect(await store.readTaskAbout('website', t.num)).toBe(
      'A persisted description that should be removable again.',
    );

    const cleared = await tasks.update('website', t.num, { description: '  \n ' });
    expect(cleared.description).toBeUndefined();
    expect((await tasks.get('website', t.num))?.description).toBeUndefined();
    expect(await store.readTaskAbout('website', t.num)).toBe('');
  });

  it('setStatus fires a status.changed (or task.canceled for cancel)', async () => {
    const t = await tasks.create('website', {
      title: 'X',
      assignee: { kind: 'user' },
      steps: [{ name: 'Main' }],
    });
    await tasks.setStatus('website', t.num, 'paused');
    await tasks.setStatus('website', t.num, 'canceled');
    const changed = await history.listEvents({ kinds: ['task.status.changed'] });
    const canceled = await history.listEvents({ kinds: ['task.canceled'] });
    expect(changed).toHaveLength(1);
    expect(canceled).toHaveLength(1);
  });

  it('notifies the terminal hook for completed and canceled tasks', async () => {
    const settled: Array<{ ref: string; outcome: string }> = [];
    tasks.setTaskSettledHook(({ task, outcome }) => {
      settled.push({ ref: task.ref, outcome });
    });
    const completed = await tasks.create('website', {
      title: 'Fix finding',
      assignee: { kind: 'user' },
      steps: [{ name: 'Fix', terminal: true }],
    });
    await tasks.completeStep('website', completed.num, completed.activeStepId!);

    const canceled = await tasks.create('website', {
      title: 'Canceled fix',
      assignee: { kind: 'user' },
      steps: [{ name: 'Fix', terminal: true }],
    });
    await tasks.setStatus('website', canceled.num, 'canceled');

    expect(settled).toEqual([
      { ref: completed.ref, outcome: 'complete' },
      { ref: canceled.ref, outcome: 'canceled' },
    ]);
  });

  it('completePhase advances activeStepId and emits events', async () => {
    const t = await tasks.create('website', {
      title: 'Three phase',
      assignee: { kind: 'user' },
      steps: [{ name: 'Design' }, { name: 'Build' }, { name: 'Ship' }],
    });
    const first = t.craftbook.steps[0]!.id;
    const second = t.craftbook.steps[1]!.id;
    const updated = await tasks.completeStep('website', t.num, first);
    expect(updated.activeStepId).toBe(second);
    expect(updated.craftbook.steps[0]!.completedAt).toBeTruthy();

    const completed = await history.listEvents({ kinds: ['task.step.completed'] });
    const activated = await history.listEvents({ kinds: ['task.step.activated'] });
    expect(completed).toHaveLength(1);
    expect(activated).toHaveLength(1);
  });

  it('treats a duplicate completion of the prior step as an idempotent no-op', async () => {
    const activations: string[] = [];
    tasks.setStepActivatedHook(async ({ newStep }) => {
      activations.push(newStep.id);
    });
    const t = await tasks.create('website', {
      title: 'Duplicate model advance',
      assignee: { kind: 'user' },
      steps: [{ name: 'Design' }, { name: 'Build' }, { name: 'Review' }],
    });
    const designId = t.craftbook.steps[0]!.id;
    const buildId = t.craftbook.steps[1]!.id;

    const advanced = await tasks.completeStep('website', t.num, designId);
    const buildBeforeReplay = advanced.craftbook.steps[1]!;
    expect(advanced.activeStepId).toBe(buildId);
    expect(buildBeforeReplay.attemptCount).toBe(1);
    expect(buildBeforeReplay.lastActivatedAt).toBeTruthy();

    const replayed = await tasks.completeStep('website', t.num, designId);
    const buildAfterReplay = replayed.craftbook.steps[1]!;
    expect(replayed.activeStepId).toBe(buildId);
    expect(buildAfterReplay.attemptCount).toBe(1);
    expect(buildAfterReplay.lastActivatedAt).toBe(buildBeforeReplay.lastActivatedAt);
    expect(activations).toEqual([buildId]);

    const completed = await history.listEvents({ kinds: ['task.step.completed'] });
    const activated = await history.listEvents({ kinds: ['task.step.activated'] });
    expect(completed).toHaveLength(1);
    expect(activated).toHaveLength(1);
  });

  it('rejects completion of a different unfinished step', async () => {
    const t = await tasks.create('website', {
      title: 'Wrong step',
      assignee: { kind: 'user' },
      steps: [{ name: 'Design' }, { name: 'Build' }],
    });
    const buildId = t.craftbook.steps[1]!.id;

    await expect(tasks.completeStep('website', t.num, buildId)).rejects.toThrow(
      /step "build" is not active.*active step: "design"/,
    );
  });

  it('preserves advanceWhen on inline-steps tasks (regression: inlineStepsToCraftbook dropped it)', async () => {
    const t = await tasks.create('website', {
      title: 'Has advanceWhen',
      assignee: { kind: 'user' },
      steps: [
        {
          name: 'Build',
          advanceWhen: { file: 'index.html', minBytes: 800, sniff: 'html-complete' },
        },
        { name: 'Evaluate' },
      ],
    });
    // The observable-advance gate must survive the inline-steps → craftbook
    // reconstruction (the solo-collapse path relies on this).
    expect(t.craftbook.steps[0]!.advanceWhen).toEqual({
      file: 'index.html',
      minBytes: 800,
      sniff: 'html-complete',
    });
  });

  it('requires a change when a new task reuses an existing observable deliverable', async () => {
    await store.writeProjectWorkspaceFile('website', 'notes/outline.md', '# Old outline\n');

    const guarded = await tasks.create('website', {
      title: 'Rewrite the outline',
      assignee: { kind: 'user' },
      steps: [{ name: 'Outline', advanceWhen: { file: 'notes/outline.md', minBytes: 5 } }],
    });
    const explicitLegacy = await tasks.create('website', {
      title: 'Accept the existing outline',
      assignee: { kind: 'user' },
      steps: [
        {
          name: 'Outline',
          advanceWhen: { file: 'notes/outline.md', minBytes: 5, requireChange: false },
        },
      ],
    });

    expect(guarded.craftbook.steps[0]!.advanceWhen?.requireChange).toBe(true);
    expect(explicitLegacy.craftbook.steps[0]!.advanceWhen?.requireChange).toBe(false);
  });

  it('guards an existing legacy deliverable when a paused task resumes', async () => {
    const task = await tasks.create('website', {
      title: 'Resume the outline',
      assignee: { kind: 'user' },
      steps: [{ name: 'Outline', advanceWhen: { file: 'notes/resume-outline.md' } }],
    });
    expect(task.craftbook.steps[0]!.advanceWhen?.requireChange).toBeUndefined();

    await tasks.setStatus('website', task.num, 'paused');
    await store.writeProjectWorkspaceFile(
      'website',
      'notes/resume-outline.md',
      '# Stale pre-resume outline\n',
    );
    const resumed = await tasks.setStatus('website', task.num, 'active');

    expect(resumed.craftbook.steps[0]!.advanceWhen?.requireChange).toBe(true);
  });

  it('tracks attemptCount + lastActivatedAt across activations and loop-backs', async () => {
    const t = await tasks.create('website', {
      title: 'Build loop',
      assignee: { kind: 'user' },
      steps: [{ name: 'Design' }, { name: 'Build' }, { name: 'Evaluate' }, { name: 'Finish' }],
    });
    const [design, build, evaluate] = t.craftbook.steps.map((s) => s.id);

    // Entry step is stamped on create; later steps are untouched until reached.
    expect(t.craftbook.steps[0]!.attemptCount).toBe(1);
    expect(t.craftbook.steps[0]!.lastActivatedAt).toBeTruthy();
    expect(t.craftbook.steps[1]!.attemptCount).toBeUndefined();

    // Linear advance Design -> Build: Build's first activation.
    let task = await tasks.completeStep('website', t.num, design!);
    expect(task.activeStepId).toBe(build);
    expect(task.craftbook.steps[1]!.attemptCount).toBe(1);
    expect(task.craftbook.steps[1]!.lastActivatedAt).toBeTruthy();

    // Build -> Evaluate.
    task = await tasks.completeStep('website', t.num, build!);
    expect(task.craftbook.steps[2]!.attemptCount).toBe(1);

    // Loop back Evaluate -> Build (explicit jump): Build re-activates, count
    // climbs to 2, and the stale completedAt from its first pass is cleared.
    task = await tasks.completeStep('website', t.num, evaluate!, build!);
    expect(task.activeStepId).toBe(build);
    expect(task.craftbook.steps[1]!.attemptCount).toBe(2);
    expect(task.craftbook.steps[1]!.completedAt).toBeUndefined();

    // Build -> Evaluate again (linear): Evaluate's second activation.
    task = await tasks.completeStep('website', t.num, build!);
    expect(task.craftbook.steps[2]!.attemptCount).toBe(2);
  });

  it('completePhase fires onPhaseActivated hook with old + new phase when the active phase changes', async () => {
    const calls: Array<{
      projectId: string;
      taskRef: string;
      newStepId: string;
      completedStepId: string;
    }> = [];
    tasks.setStepActivatedHook(async (ctx) => {
      calls.push({
        projectId: ctx.projectId,
        taskRef: ctx.task.ref,
        newStepId: ctx.newStep.id,
        completedStepId: ctx.completedStep.id,
      });
    });
    const t = await tasks.create('website', {
      title: 'Two phase',
      assignee: { kind: 'user' },
      steps: [
        { name: 'Design', assignee: { kind: 'gezel', gezelId: 'leo' } },
        { name: 'Build', assignee: { kind: 'gezel', gezelId: 'maya' } },
      ],
    });
    await tasks.completeStep('website', t.num, t.craftbook.steps[0]!.id);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      projectId: 'website',
      taskRef: t.ref,
      newStepId: t.craftbook.steps[1]!.id,
      completedStepId: t.craftbook.steps[0]!.id,
    });
  });

  it('onPhaseActivated failures do not break completePhase', async () => {
    tasks.setStepActivatedHook(async () => {
      throw new Error('handoff blew up');
    });
    const t = await tasks.create('website', {
      title: 'Two phase',
      assignee: { kind: 'user' },
      steps: [{ name: 'Design' }, { name: 'Build' }],
    });
    const updated = await tasks.completeStep('website', t.num, t.craftbook.steps[0]!.id);
    expect(updated.activeStepId).toBe(t.craftbook.steps[1]!.id);
  });

  it('completePhase does not fire the hook when no new phase activates (final phase)', async () => {
    const calls: unknown[] = [];
    tasks.setStepActivatedHook(async () => {
      calls.push(true);
    });
    const t = await tasks.create('website', {
      title: 'Single-phase shelf',
      assignee: { kind: 'user' },
      steps: [{ name: 'Only' }],
    });
    await tasks.completeStep('website', t.num, t.craftbook.steps[0]!.id);
    expect(calls).toHaveLength(0);
  });

  it('completePhase with explicit "next" jumps back to an earlier phase (quality loop)', async () => {
    const t = await tasks.create('website', {
      title: 'Mocks',
      assignee: { kind: 'user' },
      steps: [{ name: 'Design' }, { name: 'Copy' }, { name: 'Quality' }],
    });
    const [design, , quality] = [
      t.craftbook.steps[0]!.id,
      t.craftbook.steps[1]!.id,
      t.craftbook.steps[2]!.id,
    ];
    await tasks.activateStep('website', t.num, quality);
    const looped = await tasks.completeStep('website', t.num, quality, design);
    expect(looped.activeStepId).toBe(design);
  });

  it('list filters by status / assignee', async () => {
    await tasks.create('website', {
      title: 'A',
      assignee: { kind: 'gezel', gezelId: 'ada' },
      steps: [{ name: 'Main' }],
    });
    const b = await tasks.create('website', {
      title: 'B',
      assignee: { kind: 'user' },
      steps: [{ name: 'Main' }],
    });
    await tasks.setStatus('website', b.num, 'paused');
    expect(await tasks.list({ status: 'paused' })).toHaveLength(1);
    expect(await tasks.list({ assigneeGezelId: 'ada' })).toHaveLength(1);
  });

  it('updatePhase patches description / prompt / assignee and leaves siblings alone', async () => {
    const t = await tasks.create('website', {
      title: 'Multi-phase',
      assignee: { kind: 'user' },
      steps: [{ name: 'Design' }, { name: 'Build' }, { name: 'Ship' }],
    });
    const targetId = t.craftbook.steps[1]!.id;
    const updated = await tasks.updateStep('website', t.num, targetId, {
      description: 'wire up the canvas + game loop',
      prompt: 'You are Ada. Focus on the engine for this phase.',
      assignee: { kind: 'gezel', gezelId: 'ada' },
    });
    expect(updated).not.toBeNull();
    const target = updated!.craftbook.steps.find((s) => s.id === targetId)!;
    expect(target.description).toBe('wire up the canvas + game loop');
    expect(target.prompt).toBe('You are Ada. Focus on the engine for this phase.');
    expect(target.assignee).toEqual({ kind: 'gezel', gezelId: 'ada' });
    // Other steps untouched.
    expect(updated!.craftbook.steps[0]!.description).toBeUndefined();
    expect(updated!.craftbook.steps[0]!.prompt).toBeUndefined();
    expect(updated!.craftbook.steps[2]!.description).toBeUndefined();

    const events = await history.listEvents({ kinds: ['task.step.updated'] });
    expect(events).toHaveLength(1);
    expect(events[0]!.summary).toContain(target.name);
  });

  it('updatePhase clears optional fields when given null / empty', async () => {
    const t = await tasks.create('website', {
      title: 'Clearable',
      assignee: { kind: 'user' },
      steps: [
        { name: 'Design', description: 'initial', assignee: { kind: 'gezel', gezelId: 'leo' } },
      ],
    });
    const id = t.craftbook.steps[0]!.id;
    // Pre-populate prompt so we can clear it.
    await tasks.updateStep('website', t.num, id, { prompt: 'old prompt' });
    const cleared = await tasks.updateStep('website', t.num, id, {
      description: '',
      prompt: '',
      assignee: null,
    });
    expect(cleared).not.toBeNull();
    const step = cleared!.craftbook.steps[0]!;
    expect(step.description).toBeUndefined();
    expect(step.prompt).toBeUndefined();
    expect(step.assignee).toBeUndefined();
  });

  it('updatePhase returns null when the phase id is unknown', async () => {
    const t = await tasks.create('website', {
      title: 'Solo',
      assignee: { kind: 'user' },
      steps: [{ name: 'Main' }],
    });
    expect(await tasks.updateStep('website', t.num, 'nope', { prompt: 'x' })).toBeNull();
  });
});

describe('TaskManager spawn craftbooks & children', () => {
  it('allows a schedule-host task with a placeholder main step + spawn craftbook', async () => {
    const parent = await tasks.create('website', {
      title: 'Daily brief',
      assignee: { kind: 'user' },
      steps: [{ name: 'Wait for tick' }],
      spawnsSteps: [
        { name: 'Collect', suggestedGezelId: 'maya' },
        { name: 'Summarize', suggestedGezelId: 'ada' },
      ],
      cron: { expression: '0 9 * * *' },
    });
    expect(parent.craftbook.steps).toHaveLength(1);
    expect(parent.spawnsCraftbook?.steps).toHaveLength(2);
    expect(parent.cron?.nextTickAt).toBeDefined();
  });

  it('derives the spawn host from a resolved main book’s .spawn (any create path)', async () => {
    // A craftbook that ships a declarative `spawn` block is a spawn host by
    // construction: creating a task from it by craftbookId ALONE (no explicit
    // spawnsSteps / spawnsCraftbookId, no cron/fanout) must yield a task
    // carrying `spawnsCraftbook` AND the main snapshot's `spawn` config — the
    // HTTP create route, MCP invoke, and the eval harness all rely on this.
    tasks.setCraftbookResolver({
      async resolve(id) {
        return {
          craftbook: {
            id,
            name: 'Monthly Invoice Run',
            steps: [
              { id: 'scope', name: 'Scope', next: 'draft' },
              { id: 'draft', name: 'Draft', spawnFanout: true, terminal: true },
            ],
            entryStepId: 'scope',
            spawn: {
              overFile: 'notes/billables.json',
              entryStepId: 'draft-invoice',
              steps: [{ id: 'draft-invoice', name: 'Draft {{client}}', terminal: true }],
            },
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
          },
          sourceId: 'bundled',
        };
      },
    });
    const t = await tasks.create('website', {
      title: 'Monthly Invoice Run',
      assignee: { kind: 'user' },
      craftbookId: 'invoice-run',
    });
    // Spawn host derived from the book's own `.spawn` — no cron/fanout needed.
    expect(t.spawnsCraftbook).toBeDefined();
    expect(t.spawnsCraftbook?.steps[0]?.name).toBe('Draft {{client}}');
    // The runtime reads `task.craftbook.spawn` when the spawnFanout step fires.
    expect(t.craftbook.spawn?.overFile).toBe('notes/billables.json');
    expect(t.activeStepId).toBe('scope');
  });

  it('does not override an explicit spawn side with the main book’s .spawn', async () => {
    // Belt-and-suspenders guard: when the caller already supplies a spawn
    // side (spawnsSteps here), the derivation must NOT clobber it.
    tasks.setCraftbookResolver({
      async resolve(id) {
        return {
          craftbook: {
            id,
            name: 'Has Spawn',
            steps: [{ id: 'draft', name: 'Draft', spawnFanout: true, terminal: true }],
            entryStepId: 'draft',
            spawn: {
              overFile: 'notes/billables.json',
              steps: [{ id: 'from-book', name: 'From book', terminal: true }],
            },
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
          },
          sourceId: 'bundled',
        };
      },
    });
    const t = await tasks.create('website', {
      title: 'Explicit spawn wins',
      assignee: { kind: 'user' },
      craftbookId: 'has-spawn',
      spawnsSteps: [{ name: 'From caller' }],
    });
    expect(t.spawnsCraftbook?.steps[0]?.name).toBe('From caller');
  });

  it('spawnChild clones spawn-craftbook steps with fresh ids and sets parentTaskRef', async () => {
    const parent = await tasks.create('website', {
      title: 'Write story',
      assignee: { kind: 'user' },
      steps: [{ name: 'Wait' }],
      spawnsSteps: [{ name: 'Draft', suggestedGezelId: 'ada' }, { name: 'Edit' }],
      cron: { expression: '0 9 * * *' },
    });
    const child = await tasks.spawnChild(parent.ref);
    expect(child.parentTaskRef).toBe(parent.ref);
    expect(child.craftbook.steps).toHaveLength(2);
    expect(child.craftbook.steps[0]?.id).toBe('draft');
    expect(child.craftbook.steps[0]?.completedAt).toBeUndefined();
    expect(child.activeStepId).toBe(child.craftbook.steps[0]!.id);
    // First-step assignee was a suggestion — child should inherit.
    expect(child.assignee).toEqual({ kind: 'gezel', gezelId: 'ada' });
  });

  it('copies scheduled craftbook parameters onto each spawned child', async () => {
    const parent = await tasks.create('website', {
      title: 'Weekly review',
      assignee: { kind: 'user' },
      steps: [{ name: 'Wait' }],
      spawnsSteps: [{ name: 'Review' }],
      spawnsCraftbookParams: { depth: 'thorough', includeMetrics: 'true' },
      cron: { expression: '0 9 * * 1' },
    });

    const child = await tasks.spawnChild(parent.ref);
    expect(parent.spawnsCraftbookParams).toEqual({
      depth: 'thorough',
      includeMetrics: 'true',
    });
    expect(child.craftbookParams).toEqual({
      depth: 'thorough',
      includeMetrics: 'true',
    });
  });

  it('spawnChild binds the child entry step to a gezel so it can dispatch', async () => {
    // onStepActivated dispatches off the STEP's binding, not the task
    // assignee. A binding-less spawn step must still land a concrete
    // suggestedGezelId on the child's entry step (here from the parent's
    // gezel assignee), or the fanout child would sit idle forever.
    const parent = await tasks.create('website', {
      title: 'Bill the clients',
      assignee: { kind: 'gezel', gezelId: 'ada' },
      steps: [{ name: 'Wait' }],
      spawnsSteps: [{ name: 'Draft one invoice' }],
      fanout: { count: 2 },
    });
    const child = await tasks.spawnChild(parent.ref);
    const entry = child.craftbook.steps.find((s) => s.id === child.activeStepId)!;
    expect(entry.assignee?.kind === 'gezel' ? entry.assignee.gezelId : entry.suggestedGezelId).toBe(
      'ada',
    );
  });

  it('spawnChild applies variations', async () => {
    const parent = await tasks.create('website', {
      title: 'Write story',
      assignee: { kind: 'user' },
      steps: [{ name: 'Wait' }],
      spawnsSteps: [{ name: 'Draft' }],
      cron: { expression: '0 9 * * *' },
    });
    const child = await tasks.spawnChild(parent.ref, {
      title: 'Story: The lighthouse',
      plan: 'Focus on atmosphere.',
      context: { protagonist: 'Mara', setting: 'coastal Maine' },
    });
    expect(child.title).toBe('Story: The lighthouse');
    expect(child.plan).toBe('Focus on atmosphere.');
    const notes = await tasks.listNotes(child.projectId, child.num, child.activeStepId);
    expect(notes.length).toBe(1);
    expect(notes[0]!.text).toContain('protagonist');
    expect(notes[0]!.text).toContain('Mara');
  });

  it('spawnChild interpolates variation context into child step prompt + gate/advanceWhen paths', async () => {
    // Declarative-fanout children carry per-item context; the runtime
    // string-substitutes {{key}} into the child recipe so the child's turn
    // AND its gate both target the resolved per-item file.
    const parent = await tasks.create('website', {
      title: 'Bill the clients',
      assignee: { kind: 'gezel', gezelId: 'ada' },
      steps: [{ name: 'Wait' }],
      spawnsSteps: [
        {
          id: 'draft-invoice',
          name: 'Draft {{client}}',
          prompt: 'Write invoices/{{number}}.html for {{client}}.',
          advanceWhen: { file: 'invoices/{{number}}.html', minBytes: 1 },
          gate: {
            at: 'completion',
            checks: [{ kind: 'minBytes', file: 'invoices/{{number}}.html', bytes: 1 }],
            onReject: 'draft-invoice',
            maxAttempts: 2,
          },
        },
      ],
      cron: { expression: '0 9 * * *' },
    });
    const child = await tasks.spawnChild(parent.ref, {
      context: { client: 'Harbor & Pine', number: '2026-042' },
    });
    const step = child.craftbook.steps.find((s) => s.id === child.activeStepId)!;
    expect(step.name).toBe('Draft Harbor & Pine');
    expect(step.prompt).toContain('invoices/2026-042.html');
    expect(step.prompt).toContain('Harbor & Pine');
    expect(step.advanceWhen?.file).toBe('invoices/2026-042.html');
    const check = (step.gate as { checks: Array<{ file?: string }> }).checks[0];
    expect(check?.file).toBe('invoices/2026-042.html');
  });

  it('listChildren scopes to the given parent', async () => {
    const parent = await tasks.create('website', {
      title: 'Batch',
      assignee: { kind: 'user' },
      steps: [{ name: 'Wait' }],
      spawnsSteps: [{ name: 'Main' }],
      cron: { expression: '0 9 * * *' },
    });
    const other = await tasks.create('website', {
      title: 'Other parent',
      assignee: { kind: 'user' },
      steps: [{ name: 'Wait' }],
      spawnsSteps: [{ name: 'Main' }],
      cron: { expression: '0 9 * * *' },
    });
    await tasks.spawnChild(parent.ref);
    await tasks.spawnChild(parent.ref);
    await tasks.spawnChild(other.ref);
    const children = await tasks.listChildren(parent.ref);
    expect(children).toHaveLength(2);
    expect(children.every((c) => c.parentTaskRef === parent.ref)).toBe(true);
  });

  it('declarative fanout materializes once on create', async () => {
    const parent = await tasks.create('website', {
      title: '50 stories',
      assignee: { kind: 'user' },
      steps: [{ name: 'Wait' }],
      spawnsSteps: [{ name: 'Draft', suggestedGezelId: 'ada' }],
      fanout: { count: 3 },
    });
    expect(parent.fanout?.materializedAt).toBeDefined();
    const children = await tasks.listChildren(parent.ref);
    expect(children).toHaveLength(3);

    // Calling materializeFanout again is idempotent.
    const again = await tasks.materializeFanout('website', parent.num);
    expect(again.children).toHaveLength(0);
    expect((await tasks.listChildren(parent.ref)).length).toBe(3);
  });

  it('declarative fanout applies variations by index', async () => {
    const parent = await tasks.create('website', {
      title: 'Stories',
      assignee: { kind: 'user' },
      steps: [{ name: 'Wait' }],
      spawnsSteps: [{ name: 'Draft' }],
      fanout: {
        count: 2,
        variations: [{ title: 'Story A' }, { title: 'Story B', plan: 'Make it weird.' }],
      },
    });
    const children = (await tasks.listChildren(parent.ref)).sort((a, b) =>
      a.ref.localeCompare(b.ref),
    );
    const titles = children.map((c) => c.title).sort();
    expect(titles).toEqual(['Story A', 'Story B']);
    const storyB = children.find((c) => c.title === 'Story B');
    expect(storyB?.plan).toBe('Make it weird.');
  });

  it('spawnInstances (imperative fanout) spawns N children independent of fanout config', async () => {
    const parent = await tasks.create('website', {
      title: 'Ad hoc',
      assignee: { kind: 'user' },
      steps: [{ name: 'Wait' }],
      spawnsSteps: [{ name: 'Main' }],
      cron: { expression: '0 9 * * *' },
    });
    const children = await tasks.spawnInstances(parent.ref, 4);
    expect(children).toHaveLength(4);
    expect(new Set(children.map((c) => c.num)).size).toBe(4);
    // Parent fanout stays unset.
    const refreshed = await tasks.getByRef(parent.ref);
    expect(refreshed?.fanout).toBeUndefined();
  });

  it('rejects fanout without a spawn craftbook', async () => {
    await expect(
      tasks.create('website', {
        title: 'Bad',
        assignee: { kind: 'user' },
        steps: [{ name: 'Main' }],
        fanout: { count: 2 },
      }),
    ).rejects.toThrow(/fanout requires a spawn craftbook/);
  });

  it('update rejects fanout edits after materialization', async () => {
    const parent = await tasks.create('website', {
      title: 'X',
      assignee: { kind: 'user' },
      steps: [{ name: 'Wait' }],
      spawnsSteps: [{ name: 'Main' }],
      fanout: { count: 1 },
    });
    await expect(tasks.update('website', parent.num, { fanout: { count: 5 } })).rejects.toThrow(
      /already materialized/,
    );
  });
});

describe('TaskManager — suggestedRole auto-assignment', () => {
  it('resolves entry-step suggestedRole into suggestedGezelId at create time', async () => {
    const calls: Array<{ role: string; projectId: string }> = [];
    tasks.setRoleResolver(async (role, projectId) => {
      calls.push({ role, projectId });
      return { gezelId: 'reviewer-jane' };
    });
    const task = await tasks.create('website', {
      title: 'Review PR',
      assignee: { kind: 'user' },
      steps: [{ name: 'Load PR', suggestedRole: 'reviewer' }],
    });
    expect(calls).toEqual([{ role: 'reviewer', projectId: 'website' }]);
    const entry = task.craftbook.steps[0]!;
    expect(entry.suggestedGezelId).toBe('reviewer-jane');
  });

  it('skips resolution when the step has an explicit suggestedGezelId', async () => {
    let calls = 0;
    tasks.setRoleResolver(async () => {
      calls++;
      return { gezelId: 'reviewer-jane' };
    });
    const task = await tasks.create('website', {
      title: 'Review PR',
      assignee: { kind: 'user' },
      steps: [{ name: 'Load PR', suggestedRole: 'reviewer', suggestedGezelId: 'breno-explicit' }],
    });
    expect(calls).toBe(0);
    expect(task.craftbook.steps[0]!.suggestedGezelId).toBe('breno-explicit');
  });

  it('skips resolution when the step has an explicit gezel assignee', async () => {
    let calls = 0;
    tasks.setRoleResolver(async () => {
      calls++;
      return { gezelId: 'reviewer-jane' };
    });
    const task = await tasks.create('website', {
      title: 'Review PR',
      assignee: { kind: 'user' },
      steps: [
        {
          name: 'Load PR',
          suggestedRole: 'reviewer',
          assignee: { kind: 'gezel', gezelId: 'breno' },
        },
      ],
    });
    expect(calls).toBe(0);
    expect(task.craftbook.steps[0]!.suggestedGezelId).toBeUndefined();
  });

  it('falls back gracefully when the resolver returns null', async () => {
    tasks.setRoleResolver(async () => null);
    const task = await tasks.create('website', {
      title: 'Review PR',
      assignee: { kind: 'user' },
      steps: [{ name: 'Load PR', suggestedRole: 'reviewer' }],
    });
    expect(task.craftbook.steps[0]!.suggestedGezelId).toBeUndefined();
  });

  it('swallows resolver errors and leaves the step alone', async () => {
    tasks.setRoleResolver(async () => {
      throw new Error('boom');
    });
    const task = await tasks.create('website', {
      title: 'Review PR',
      assignee: { kind: 'user' },
      steps: [{ name: 'Load PR', suggestedRole: 'reviewer' }],
    });
    expect(task.craftbook.steps[0]!.suggestedGezelId).toBeUndefined();
  });

  it('resolves the newly-activated step on completeStep', async () => {
    const seen: string[] = [];
    tasks.setRoleResolver(async (role) => {
      seen.push(role);
      return { gezelId: `${role}-id` };
    });
    const task = await tasks.create('website', {
      title: 'Review then ship',
      assignee: { kind: 'user' },
      steps: [
        { id: 'review', name: 'Review', suggestedRole: 'reviewer' },
        { id: 'ship', name: 'Ship', suggestedRole: 'developer' },
      ],
      entryStepId: 'review',
    });
    // Entry step resolved.
    expect(seen).toEqual(['reviewer']);
    expect(task.craftbook.steps[0]!.suggestedGezelId).toBe('reviewer-id');
    expect(task.craftbook.steps[1]!.suggestedGezelId).toBeUndefined();

    const advanced = await tasks.completeStep('website', task.num, 'review');
    // Newly-activated step picks up its own role.
    expect(seen).toEqual(['reviewer', 'developer']);
    expect(advanced.craftbook.steps[1]!.suggestedGezelId).toBe('developer-id');
  });

  it('no-ops when no resolver is wired', async () => {
    const task = await tasks.create('website', {
      title: 'Review PR',
      assignee: { kind: 'user' },
      steps: [{ name: 'Load PR', suggestedRole: 'reviewer' }],
    });
    expect(task.craftbook.steps[0]!.suggestedRole).toBe('reviewer');
    expect(task.craftbook.steps[0]!.suggestedGezelId).toBeUndefined();
  });
});

describe('TaskManager — derived assignee', () => {
  it('mirrors the entry step role when no assignee is named', async () => {
    tasks.setRoleResolver(async () => ({ gezelId: 'reviewer-jane' }));
    const task = await tasks.create('website', {
      title: 'Review PR',
      steps: [{ name: 'Load PR', suggestedRole: 'reviewer' }],
    });
    expect(task.assignee).toEqual({ kind: 'gezel', gezelId: 'reviewer-jane' });
    expect(task.assigneeAuto).toBe(true);
  });

  it('respects an explicitly named assignee over the entry step role', async () => {
    tasks.setRoleResolver(async () => ({ gezelId: 'reviewer-jane' }));
    const task = await tasks.create('website', {
      title: 'Review PR',
      assignee: { kind: 'gezel', gezelId: 'magnus' },
      steps: [{ name: 'Load PR', suggestedRole: 'reviewer' }],
    });
    expect(task.assignee).toEqual({ kind: 'gezel', gezelId: 'magnus' });
    expect(task.assigneeAuto).toBeUndefined();
    // The step still resolves its own role — the pin is task-level only.
    expect(task.craftbook.steps[0]!.suggestedGezelId).toBe('reviewer-jane');
  });

  it("mirrors the entry step's explicit assignee when no role is named", async () => {
    const task = await tasks.create('website', {
      title: 'Review PR',
      steps: [{ name: 'Load PR', assignee: { kind: 'gezel', gezelId: 'breno' } }],
    });
    expect(task.assignee).toEqual({ kind: 'gezel', gezelId: 'breno' });
  });

  it('falls back to the user when nothing resolves', async () => {
    tasks.setRoleResolver(async () => null);
    const task = await tasks.create('website', {
      title: 'Review PR',
      steps: [{ name: 'Load PR', suggestedRole: 'reviewer' }],
    });
    expect(task.assignee).toEqual({ kind: 'user' });
    expect(task.assigneeAuto).toBe(true);
  });

  it('stops mirroring once someone pins an assignee by hand', async () => {
    tasks.setRoleResolver(async () => ({ gezelId: 'reviewer-jane' }));
    const task = await tasks.create('website', {
      title: 'Review PR',
      steps: [{ name: 'Load PR', suggestedRole: 'reviewer' }],
    });
    expect(task.assigneeAuto).toBe(true);
    const pinned = await tasks.setAssignee('website', task.num, {
      kind: 'gezel',
      gezelId: 'magnus',
    });
    expect(pinned.assignee).toEqual({ kind: 'gezel', gezelId: 'magnus' });
    expect(pinned.assigneeAuto).toBeUndefined();
  });

  it('keeps the entry-step owner as the task advances', async () => {
    tasks.setRoleResolver(async (role) => ({ gezelId: `${role}-id` }));
    const task = await tasks.create('website', {
      title: 'Review then ship',
      steps: [
        { id: 'review', name: 'Review', suggestedRole: 'reviewer' },
        { id: 'ship', name: 'Ship', suggestedRole: 'developer' },
      ],
      entryStepId: 'review',
    });
    expect(task.assignee).toEqual({ kind: 'gezel', gezelId: 'reviewer-id' });
    const advanced = await tasks.completeStep('website', task.num, 'review');
    // Step 2 has its own specialist; the task owner does not churn.
    expect(advanced.craftbook.steps[1]!.suggestedGezelId).toBe('developer-id');
    expect(advanced.assignee).toEqual({ kind: 'gezel', gezelId: 'reviewer-id' });
  });
});

describe('TaskManager craftbookParams interpolation', () => {
  const bookWithPlaceholders = {
    id: 'code-review',
    name: 'Code Review',
    steps: [
      {
        id: 'report',
        name: 'Write the report for {{reviewId}}',
        prompt: 'Write the review to reviews/{{reviewId}}/report.md. Leave {{unknown}} alone.',
        advanceWhen: { file: 'reviews/{{reviewId}}/report.md', artifact: true, minBytes: 400 },
        gate: {
          at: 'completion' as const,
          checks: [
            {
              kind: 'minBytes' as const,
              file: 'reviews/{{reviewId}}/report.md',
              bytes: 400,
              artifact: true,
            },
          ],
          onReject: 'report',
          maxAttempts: 3,
        },
        next: 'done',
      },
      { id: 'done', name: 'Done', terminal: true },
    ],
    entryStepId: 'report',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };

  it('lands params in the snapshot: prompts, advanceWhen paths, and gate check paths', async () => {
    tasks.setCraftbookResolver({
      async resolve(id) {
        return { craftbook: { ...bookWithPlaceholders, id }, sourceId: 'bundled' };
      },
    });
    const task = await tasks.create('website', {
      title: 'Review',
      description: 'Review the snapshotted change set and write the gated report artifact now.',
      craftbookId: 'code-review',
      assignee: { kind: 'user' },
      craftbookParams: { reviewId: 'commit-20260729-1200-ab12' },
    });
    const step = task.craftbook.steps.find((s) => s.id === 'report');
    expect(step?.name).toBe('Write the report for commit-20260729-1200-ab12');
    expect(step?.prompt).toContain('reviews/commit-20260729-1200-ab12/report.md');
    // Unknown placeholders survive untouched — half-substitution would be
    // worse than none.
    expect(step?.prompt).toContain('{{unknown}}');
    expect(step?.advanceWhen?.file).toBe('reviews/commit-20260729-1200-ab12/report.md');
    const check = step?.gate?.checks?.[0] as { file?: string } | undefined;
    expect(check?.file).toBe('reviews/commit-20260729-1200-ab12/report.md');
    // Copy-on-write regression: the resolver's template must never see the
    // substitution — an in-place mutation here would leak this task's
    // params into every later task resolved from the same book object.
    const templateStep = bookWithPlaceholders.steps[0]!;
    expect(templateStep.advanceWhen?.file).toBe('reviews/{{reviewId}}/report.md');
    expect((templateStep.gate?.checks?.[0] as { file?: string }).file).toBe(
      'reviews/{{reviewId}}/report.md',
    );
  });

  it('applies paramSchema defaults before snapshotting and lets invocation values override them', async () => {
    tasks.setCraftbookResolver({
      async resolve(id) {
        return {
          craftbook: {
            ...bookWithPlaceholders,
            id,
            paramSchema: {
              type: 'object',
              properties: { reviewId: { type: 'string', default: 'latest' } },
            },
          },
          sourceId: 'bundled',
        };
      },
    });

    const withDefault = await tasks.create('website', {
      title: 'Default review',
      craftbookId: 'code-review',
      assignee: { kind: 'user' },
    });
    expect(withDefault.craftbook.steps[0]?.advanceWhen?.file).toBe('reviews/latest/report.md');
    expect(withDefault.craftbookParams).toEqual({ reviewId: 'latest' });
    expect(withDefault.craftbook.paramSchema).toEqual({
      type: 'object',
      properties: { reviewId: { type: 'string', default: 'latest' } },
    });

    const overridden = await tasks.create('website', {
      title: 'Named review',
      craftbookId: 'code-review',
      assignee: { kind: 'user' },
      craftbookParams: { reviewId: 'release-candidate' },
    });
    expect(overridden.craftbook.steps[0]?.advanceWhen?.file).toBe(
      'reviews/release-candidate/report.md',
    );
    expect(overridden.craftbookParams).toEqual({ reviewId: 'release-candidate' });
  });

  it('leaves the snapshot byte-identical when no params are given', async () => {
    tasks.setCraftbookResolver({
      async resolve(id) {
        return { craftbook: { ...bookWithPlaceholders, id }, sourceId: 'bundled' };
      },
    });
    const task = await tasks.create('website', {
      title: 'Review',
      craftbookId: 'code-review',
      assignee: { kind: 'user' },
    });
    const step = task.craftbook.steps.find((s) => s.id === 'report');
    expect(step?.advanceWhen?.file).toBe('reviews/{{reviewId}}/report.md');
    expect(step?.prompt).toContain('{{reviewId}}');
  });
});
