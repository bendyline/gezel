import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

  it('stamps artifactDir and pre-creates the task artifact folder', async () => {
    const t = await tasks.create('website', {
      title: 'Foldered',
      assignee: { kind: 'user' },
      steps: [{ name: 'Main' }],
    });
    expect(t.artifactDir).toBe(`tasks/${t.num}`);
    const onDisk = await stat(
      join(home, 'projects', 'website', 'artifacts', 'tasks', String(t.num)),
    );
    expect(onDisk.isDirectory()).toBe(true);
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
            steps: [
              {
                id: 'produce',
                name: 'Produce',
                prompt:
                  'Author deck.md first, then use DocBlocks to publish and preview {{outputPath}}.',
                advanceWhen: {
                  file: '{{outputPath}}',
                  artifact: true,
                  minBytes: 1,
                },
                terminal: true,
              },
            ],
            entryStepId: 'produce',
            paramSchema: {
              type: 'object',
              properties: { outputPath: { type: 'string' } },
            },
            toolsets: [
              {
                toolsetId: 'docblocks',
                autoAllow: true,
                reason: 'produce and visually verify the real PPTX',
              },
            ],
            createdAt: '2026-07-27T00:00:00Z',
            updatedAt: '2026-07-27T00:00:00Z',
          },
          sourceId: 'bundled',
          version: '1.3.0',
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
      craftbookParams: { outputPath: 'marne-battle.pptx' },
    });
    expect(created.craftbook.id).toBe('powerpoint-deck');
    expect(created.craftbook.toolsets).toEqual([
      {
        toolsetId: 'docblocks',
        autoAllow: true,
        reason: 'produce and visually verify the real PPTX',
      },
    ]);
    expect(created.sourceCraftbookIds).toEqual([
      {
        role: 'main',
        catalogId: 'powerpoint-deck',
        version: '1.3.0',
        sourceId: 'bundled',
      },
    ]);
    expect(created.craftbookParams).toEqual({ outputPath: 'marne-battle.pptx' });
    expect(created.craftbook.steps[0]?.prompt).toContain(
      'DocBlocks to publish and preview marne-battle.pptx',
    );
    expect(created.craftbook.steps[0]?.advanceWhen?.file).toBe('marne-battle.pptx');
  });

  it('interpolates launch params everywhere inside a gate, not just check.file', async () => {
    // A gate buries its params below its own top level. The old
    // field-by-field walk touched `checks[].file` only, so Pull Request
    // Review's scope gate shipped the literal `#{{number}}` to the regex
    // engine: the reviewer wrote the note the step asked for, the gate
    // could never match it, and the only way past was to put the raw
    // template token into the task's permanent audit trail.
    tasks.setCraftbookResolver({
      async resolve(id) {
        return {
          craftbook: {
            id,
            name: 'Pull Request Review',
            steps: [
              {
                id: 'scope',
                name: 'Map PR #{{number}}',
                prompt: 'Read the corpus at {{corpusScope}}.',
                gate: {
                  at: 'completion',
                  scripts: [
                    {
                      name: 'checkTaskNoteContains',
                      scope: 'standard',
                      inputs: { pattern: '##\\s*Scope\\s*[—-]\\s*PR\\s*#{{number}}' },
                    },
                  ],
                  checks: [
                    {
                      kind: 'contains',
                      file: 'review-{{number}}.md',
                      pattern: 'Pull Request Review — PR #{{number}}',
                      artifact: true,
                    },
                    {
                      kind: 'corpusCoverage',
                      file: 'coverage.json',
                      corpusDir: '{{corpusScope}}',
                      artifact: true,
                    },
                  ],
                },
                terminal: true,
              },
            ],
            entryStepId: 'scope',
            createdAt: '2026-08-16T00:00:00Z',
            updatedAt: '2026-08-16T00:00:00Z',
          },
          sourceId: 'bundled',
        };
      },
    });

    const created = await tasks.create('website', {
      title: 'Review PR 46',
      assignee: { kind: 'user' },
      craftbookId: 'pull-request-review',
      craftbookParams: {
        number: '46',
        corpusScope: 'artifacts/data/github-pull-requests/pr-46',
      },
    });
    const gate = created.craftbook.steps[0]?.gate as {
      scripts?: Array<{ inputs?: Record<string, string> }>;
      checks?: Array<Record<string, unknown>>;
    };
    expect(created.craftbook.steps[0]?.name).toBe('Map PR #46');
    // The gate SCRIPT input — the one that actually rejected Ayza.
    expect(gate.scripts?.[0]?.inputs?.pattern).toBe('##\\s*Scope\\s*[—-]\\s*PR\\s*#46');
    // A check's non-`file` strings interpolate too.
    expect(gate.checks?.[0]?.file).toBe('review-46.md');
    expect(gate.checks?.[0]?.pattern).toBe('Pull Request Review — PR #46');
    expect(gate.checks?.[1]?.corpusDir).toBe('artifacts/data/github-pull-requests/pr-46');
    // Non-string fields survive the walk intact — including the drawer
    // flag the schema used to strip.
    expect(gate.checks?.[1]?.artifact).toBe(true);
    expect(JSON.stringify(gate)).not.toContain('{{');
  });

  it('interpolates launch params into onEnter/onExit script inputs', async () => {
    // Same class as the gate miss above, on the hook that does a step's
    // deterministic work with no model turn. Pull Request Review's scope step
    // publishes its fanout batches through an `onEnter` stdlib script; left
    // out of the walk, that script receives the literal `{{corpusScope}}`,
    // finds no corpus, and fails as if the connector had never synced.
    tasks.setCraftbookResolver({
      async resolve(id) {
        return {
          craftbook: {
            id,
            name: 'Pull Request Review',
            steps: [
              {
                id: 'scope',
                name: 'Map the corpus',
                prompt: 'Read {{corpusScope}}.',
                onEnter: [
                  {
                    name: 'publishCorpusBatches',
                    scope: 'standard',
                    inputs: { corpusDir: '{{corpusScope}}', outFile: 'pr-review/batches.json' },
                  },
                ],
                onExit: {
                  name: 'noteSomething',
                  scope: 'standard',
                  inputs: { label: 'PR #{{number}}' },
                },
                terminal: true,
              },
            ],
            entryStepId: 'scope',
            createdAt: '2026-08-17T00:00:00Z',
            updatedAt: '2026-08-17T00:00:00Z',
          },
          sourceId: 'bundled',
        };
      },
    });

    const created = await tasks.create('website', {
      title: 'Review PR 33',
      assignee: { kind: 'user' },
      craftbookId: 'pull-request-review',
      craftbookParams: {
        number: '33',
        corpusScope: 'artifacts/data/github-pull-requests/pr-33',
      },
    });
    const step = created.craftbook.steps[0] as {
      onEnter?: Array<{ inputs?: Record<string, string> }>;
      onExit?: { inputs?: Record<string, string> };
    };
    expect(step.onEnter?.[0]?.inputs?.corpusDir).toBe('artifacts/data/github-pull-requests/pr-33');
    // Untemplated inputs pass through unchanged.
    expect(step.onEnter?.[0]?.inputs?.outFile).toBe('pr-review/batches.json');
    // The legacy single-ref shape interpolates too.
    expect(step.onExit?.inputs?.label).toBe('PR #33');
    expect(JSON.stringify(step)).not.toContain('{{');
  });

  it('interpolates the fanout half of the recipe too, and hands children the host’s needs', async () => {
    // Same miss as the gate walk above, one level out: `interpolateStepsContext`
    // walks the HOST's steps, so `spawn.overFile` and every child-template
    // step kept their raw `{{…}}`. A batch fanout whose corpus lives at
    // `…/pr-{{number}}/…` reads a path that cannot exist, finds no items,
    // and logs "skipping fanout" while the host sails on to a collect
    // barrier with no children to wait for — a silent no-op review.
    await installProjectToolset('usb-camera');
    tasks.setCraftbookResolver({
      async resolve(id) {
        return {
          craftbook: {
            id,
            name: 'Pull Request Review',
            toolsets: [{ toolsetId: 'usb-camera', autoAllow: true, reason: 'read the PR' }],
            steps: [
              { id: 'scan', name: 'Scan', spawnFanout: true },
              { id: 'collect', name: 'Collect', terminal: true },
            ],
            entryStepId: 'scan',
            spawn: {
              overFile:
                'data/github-pull-requests/pr-{{number}}/attachments/001/pr-{{number}}-files.json',
              overArtifact: true,
              itemsPath: 'batches',
              entryStepId: 'review-batch',
              steps: [
                {
                  id: 'review-batch',
                  name: 'Review batch {{number}}',
                  prompt: 'Review PR #{{number}} batch {{batchNumber}}.',
                  gate: {
                    at: 'completion',
                    checks: [
                      {
                        kind: 'corpusCoverage',
                        file: 'pr-review/coverage-{{batchNumber}}.json',
                        corpusDir: 'artifacts/data/github-pull-requests/pr-{{number}}',
                        expectPaths: '{{paths}}',
                        artifact: true,
                      },
                    ],
                  },
                },
              ],
            },
            createdAt: '2026-08-16T00:00:00Z',
            updatedAt: '2026-08-16T00:00:00Z',
          },
          sourceId: 'bundled',
        };
      },
    });

    const created = await tasks.create('website', {
      title: 'Review PR 46',
      assignee: { kind: 'user' },
      craftbookId: 'pull-request-review',
      craftbookParams: { number: '46' },
    });

    // The file the fanout actually reads.
    expect(created.craftbook.spawn?.overFile).toBe(
      'data/github-pull-requests/pr-46/attachments/001/pr-46-files.json',
    );
    // Child-template steps carry the launch params as well; the per-item
    // `{{batchNumber}}`/`{{paths}}` stay for spawnChild to fill in.
    const child = created.spawnsCraftbook?.steps[0];
    expect(child?.prompt).toBe('Review PR #46 batch {{batchNumber}}.');
    const childCheck = (child?.gate as { checks?: Array<Record<string, unknown>> })?.checks?.[0];
    expect(childCheck?.corpusDir).toBe('artifacts/data/github-pull-requests/pr-46');
    expect(childCheck?.file).toBe('pr-review/coverage-{{batchNumber}}.json');

    // Children do the host's work on a slice of it, so they inherit its
    // toolset needs — the chat session's auto-allow reads them off the task.
    expect(created.spawnsCraftbook?.toolsets).toEqual([
      { toolsetId: 'usb-camera', autoAllow: true, reason: 'read the PR' },
    ]);
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

  it('addStep interpolates {{task.dir}} into a late-added step (prompt, advanceWhen, gate)', async () => {
    // create() interpolates the original recipe; a step added later must get
    // the same walk or an unresolved {{…}} in its gate hard-fails at
    // evaluation time as an infrastructure error (step-gate.ts guard).
    const t = await tasks.create('website', {
      title: 'Late steps',
      assignee: { kind: 'user' },
      steps: [{ name: 'Main' }],
    });
    const updated = await tasks.addStep('website', t.num, {
      name: 'Report for {{task.ref}}',
      prompt: 'Write {{task.dir}}/report.md with write_artifact.',
      advanceWhen: { file: '{{task.dir}}/report.md', artifact: true, minBytes: 10 },
    });
    const added = updated.craftbook.steps.at(-1)!;
    expect(added.name).toBe(`Report for website/${t.num}`);
    expect(added.prompt).toBe(`Write tasks/${t.num}/report.md with write_artifact.`);
    expect(added.advanceWhen?.file).toBe(`tasks/${t.num}/report.md`);
    expect(JSON.stringify(added)).not.toContain('{{');
  });

  it('updateStep interpolates {{task.dir}} in patched fields only', async () => {
    const t = await tasks.create('website', {
      title: 'Patchable',
      assignee: { kind: 'user' },
      steps: [{ name: 'Build' }],
    });
    const id = t.craftbook.steps[0]!.id;
    const updated = await tasks.updateStep('website', t.num, id, {
      prompt: 'Deliver {{task.dir}}/out.md',
      gate: {
        at: 'completion',
        checks: [{ kind: 'minBytes', file: '{{task.dir}}/out.md', bytes: 5, artifact: true }],
        onReject: id,
        maxAttempts: 2,
      },
    });
    const step = updated!.craftbook.steps[0]!;
    expect(step.prompt).toBe(`Deliver tasks/${t.num}/out.md`);
    expect((step.gate as { checks?: { file?: string }[] }).checks?.[0]?.file).toBe(
      `tasks/${t.num}/out.md`,
    );
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

  it('binds every shard of a proposal-drafting host to its own proposal', async () => {
    // Fail-safe, not fail-open: a shard that came up unbound would send its
    // edits to the real workspace, which is the one outcome the whole
    // change-proposal feature exists to prevent. The id is derived from the
    // child's own task number, never supplied by a model.
    const parent = await tasks.create(
      'website',
      {
        title: 'Nightly fixes',
        assignee: { kind: 'user' },
        steps: [{ name: 'Triage' }],
        spawnsSteps: [{ name: 'Draft' }],
        cron: { expression: '0 9 * * *' },
      },
      { draftsDiffpack: true },
    );
    expect(parent.diffpackId).toBe(String(parent.num));

    const first = await tasks.spawnChild(parent.ref);
    const second = await tasks.spawnChild(parent.ref);
    expect(first.diffpackId).toBe(String(first.num));
    expect(second.diffpackId).toBe(String(second.num));
    expect(first.diffpackId).not.toBe(second.diffpackId);
  });

  it("resolves {{diffpack.dir}} to each shard's own proposal folder", async () => {
    // `{{task.num}}` cannot be used here: create() froze the spawn template
    // with the HOST's context, so every shard would target the host's pack.
    const parent = await tasks.create(
      'website',
      {
        title: 'Nightly fixes',
        assignee: { kind: 'user' },
        steps: [{ name: 'Triage' }],
        spawnsSteps: [
          {
            name: 'Draft',
            prompt: 'Write your notes to {{diffpack.dir}}/notes.md',
            advanceWhen: { file: '{{diffpack.dir}}/notes.md', artifact: true },
          },
        ],
        cron: { expression: '0 9 * * *' },
      },
      { draftsDiffpack: true },
    );

    const first = await tasks.spawnChild(parent.ref);
    const second = await tasks.spawnChild(parent.ref);
    for (const child of [first, second]) {
      const step = child.craftbook.steps[0]!;
      expect(step.prompt).toContain(`diffpacks/${child.num}/notes.md`);
      expect(step.advanceWhen?.file).toBe(`diffpacks/${child.num}/notes.md`);
    }
    expect(first.craftbook.steps[0]?.advanceWhen?.file).not.toBe(
      second.craftbook.steps[0]?.advanceWhen?.file,
    );
  });

  it('leaves shards of an ordinary host unbound so they edit normally', async () => {
    const parent = await tasks.create('website', {
      title: 'Ordinary',
      assignee: { kind: 'user' },
      steps: [{ name: 'Wait' }],
      spawnsSteps: [{ name: 'Work' }],
      cron: { expression: '0 9 * * *' },
    });
    const child = await tasks.spawnChild(parent.ref);
    expect(child.diffpackId).toBeUndefined();
  });

  it('spawnChild inherits the host artifact folder — shards share one namespace', async () => {
    // The host's collect-barrier gates were interpolated with the HOST's
    // number; a per-child folder would leave them watching an empty dir.
    const parent = await tasks.create('website', {
      title: 'Sharded',
      assignee: { kind: 'user' },
      steps: [{ name: 'Wait' }],
      spawnsSteps: [{ name: 'Shard', suggestedGezelId: 'ada' }],
      cron: { expression: '0 9 * * *' },
    });
    expect(parent.artifactDir).toBe(`tasks/${parent.num}`);
    const child = await tasks.spawnChild(parent.ref);
    expect(child.artifactDir).toBe(parent.artifactDir);
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
      roleBasedNameOnlyMode: true,
    });
    expect(parent.fanout?.materializedAt).toBeDefined();
    expect(parent.roleBasedNameOnlyMode).toBe(true);
    const children = await tasks.listChildren(parent.ref);
    expect(children).toHaveLength(3);
    expect(children.every((child) => child.roleBasedNameOnlyMode === true)).toBe(true);

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

  it('persists the transition before slow recruitment and joins concurrent retries', async () => {
    let releaseDeveloper!: (value: { gezelId: string }) => void;
    const developer = new Promise<{ gezelId: string }>((resolve) => {
      releaseDeveloper = resolve;
    });
    const seen: string[] = [];
    tasks.setRoleResolver(async (role) => {
      seen.push(role);
      if (role === 'reviewer') return { gezelId: 'reviewer-id' };
      return developer;
    });
    const task = await tasks.create('website', {
      title: 'Review then recruit',
      assignee: { kind: 'user' },
      steps: [
        { id: 'review', name: 'Review', suggestedRole: 'reviewer' },
        { id: 'ship', name: 'Ship', suggestedRole: 'developer' },
      ],
      entryStepId: 'review',
    });

    const first = tasks.completeStepChecked('website', task.num, 'review');
    await vi.waitFor(() => expect(seen).toEqual(['reviewer', 'developer']));

    // The completed step is already durable even though recruitment has not
    // returned. This is the state the MCP retry observes.
    const durable = await tasks.get('website', task.num);
    expect(durable?.activeStepId).toBe('ship');
    expect(durable?.craftbook.steps[0]!.completedAt).toBeTruthy();
    expect(durable?.craftbook.steps[1]!.suggestedGezelId).toBeUndefined();

    const replay = tasks.completeStepChecked('website', task.num, 'review');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(seen).toEqual(['reviewer', 'developer']);

    releaseDeveloper({ gezelId: 'developer-id' });
    const [advanced, replayed] = await Promise.all([first, replay]);
    expect(advanced).toEqual(replayed);
    expect(advanced.task.craftbook.steps[1]!.suggestedGezelId).toBe('developer-id');
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

  it('rejects a launch when every declared source alternative is empty', async () => {
    tasks.setCraftbookResolver({
      async resolve(id) {
        return {
          craftbook: {
            ...bookWithPlaceholders,
            id,
            paramSchema: {
              type: 'object',
              properties: {
                sourcePath: { type: 'string', default: '' },
                topic: { type: 'string', default: '' },
                content: { type: 'string', default: '' },
              },
              anyOf: [
                {
                  required: ['sourcePath'],
                  properties: { sourcePath: { type: 'string', minLength: 1 } },
                },
                {
                  required: ['topic'],
                  properties: { topic: { type: 'string', minLength: 1 } },
                },
                {
                  required: ['content'],
                  properties: { content: { type: 'string', minLength: 1 } },
                },
              ],
            },
          },
          sourceId: 'bundled',
        };
      },
    });

    await expect(
      tasks.create('website', {
        title: 'Empty deck',
        craftbookId: 'powerpoint-deck',
        assignee: { kind: 'user' },
      }),
    ).rejects.toThrow(
      'requires at least one non-empty invocation parameter: sourcePath, topic, content',
    );
    await expect(tasks.list({ projectId: 'website' })).resolves.toEqual([]);
  });

  it('accepts a launch when one declared source alternative is non-empty', async () => {
    tasks.setCraftbookResolver({
      async resolve(id) {
        return {
          craftbook: {
            ...bookWithPlaceholders,
            id,
            paramSchema: {
              type: 'object',
              properties: {
                sourcePath: { type: 'string', default: '' },
                topic: { type: 'string', default: '' },
                content: { type: 'string', default: '' },
              },
              anyOf: [
                {
                  required: ['sourcePath'],
                  properties: { sourcePath: { type: 'string', minLength: 1 } },
                },
                {
                  required: ['topic'],
                  properties: { topic: { type: 'string', minLength: 1 } },
                },
                {
                  required: ['content'],
                  properties: { content: { type: 'string', minLength: 1 } },
                },
              ],
            },
          },
          sourceId: 'bundled',
        };
      },
    });

    const task = await tasks.create('website', {
      title: 'Ireland deck',
      craftbookId: 'powerpoint-deck',
      craftbookParams: { topic: 'Ireland' },
      assignee: { kind: 'user' },
    });
    expect(task.craftbookParams).toMatchObject({ topic: 'Ireland' });
  });

  it('provides per-task runtime placeholders and expands only declared defaults', async () => {
    tasks.setCraftbookResolver({
      async resolve(id) {
        return {
          craftbook: {
            ...bookWithPlaceholders,
            id,
            paramSchema: {
              type: 'object',
              properties: {
                workPath: { type: 'string', default: 'powerpoint/task-{{task.num}}' },
                outputPath: { type: 'string', default: '{{workPath}}/deck.pptx' },
                content: { type: 'string', default: '' },
              },
            },
            steps: [
              {
                id: 'report',
                name: 'Write {{task.ref}} for {{task.projectId}}',
                prompt: 'Write {{workPath}}/outline.md, then preserve this source: {{content}}.',
                advanceWhen: {
                  file: '{{workPath}}/outline.md',
                  artifact: true,
                  minBytes: 400,
                },
                gate: {
                  at: 'completion' as const,
                  checks: [
                    {
                      kind: 'minBytes' as const,
                      file: '{{workPath}}/outline.md',
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
          },
          sourceId: 'bundled',
        };
      },
    });

    const task = await tasks.create('website', {
      title: 'Named deck',
      craftbookId: 'powerpoint-deck',
      assignee: { kind: 'user' },
      craftbookParams: { content: 'Keep {{topic}} literal.' },
    });

    const step = task.craftbook.steps[0]!;
    expect(step.name).toBe(`Write website/${task.num} for website`);
    expect(step.prompt).toContain(`powerpoint/task-${task.num}/outline.md`);
    expect(step.prompt).toContain('Keep {{topic}} literal.');
    expect(step.advanceWhen?.file).toBe(`powerpoint/task-${task.num}/outline.md`);
    expect((step.gate?.checks?.[0] as { file?: string }).file).toBe(
      `powerpoint/task-${task.num}/outline.md`,
    );
    expect(task.craftbookParams).toEqual({
      workPath: `powerpoint/task-${task.num}`,
      outputPath: `powerpoint/task-${task.num}/deck.pptx`,
      content: 'Keep {{topic}} literal.',
    });
    expect(task.craftbookParams).not.toHaveProperty('task.num');

    const nextTask = await tasks.create('website', {
      title: 'Another deck',
      craftbookId: 'powerpoint-deck',
      assignee: { kind: 'user' },
    });
    expect(nextTask.num).not.toBe(task.num);
    expect(nextTask.craftbook.steps[0]?.advanceWhen?.file).toBe(
      `powerpoint/task-${nextTask.num}/outline.md`,
    );
    expect(nextTask.craftbookParams?.outputPath).toBe(`powerpoint/task-${nextTask.num}/deck.pptx`);
    expect(nextTask.craftbookParams?.workPath).not.toBe(task.craftbookParams?.workPath);
  });

  it('resolves {{task.dir}} in defaults and steps; a spoofed task.dir param never wins', async () => {
    tasks.setCraftbookResolver({
      async resolve(id) {
        return {
          craftbook: {
            ...bookWithPlaceholders,
            id,
            paramSchema: {
              type: 'object',
              properties: {
                workPath: { type: 'string', default: '{{task.dir}}' },
              },
            },
            steps: [
              {
                id: 'scope',
                name: 'Scope',
                prompt: 'Write {{workPath}}/scope.md and cite {{task.dir}}/sources.md.',
                advanceWhen: { file: '{{workPath}}/scope.md', artifact: true, minBytes: 40 },
                terminal: true,
              },
            ],
          },
          sourceId: 'bundled',
        };
      },
    });
    const task = await tasks.create('website', {
      title: 'Standard folder',
      craftbookId: 'spec-doc',
      assignee: { kind: 'user' },
      // Reserved runtime tokens win over a caller-supplied param of the
      // same name — the folder cannot be spoofed out from under the task.
      craftbookParams: { 'task.dir': 'somewhere/else' },
    });
    const dir = `tasks/${task.num}`;
    const step = task.craftbook.steps[0]!;
    expect(task.artifactDir).toBe(dir);
    expect(task.craftbookParams?.workPath).toBe(dir);
    expect(step.prompt).toBe(`Write ${dir}/scope.md and cite ${dir}/sources.md.`);
    expect(step.advanceWhen?.file).toBe(`${dir}/scope.md`);
  });

  it('resolves a reserved runtime token supplied as an explicit param, and only that', async () => {
    // The launcher form seeds declared defaults into its fields and renders
    // them back into the staged command, so `workPath`'s `{{task.dir}}`
    // default arrives as an EXPLICIT override — the one side that skips
    // `resolveCraftbookParamDefaults`. `interpolateStepsContext` is
    // single-pass, so every gate path built from `{{workPath}}` reached
    // `step-gate.ts` as a literal `{{task.dir}}` and the gate refused to
    // run at all (security-architecture-review 2.0.4, step `model-system`).
    tasks.setCraftbookResolver({
      async resolve(id) {
        return {
          craftbook: {
            ...bookWithPlaceholders,
            id,
            paramSchema: {
              type: 'object',
              properties: {
                workPath: { type: 'string', default: '{{task.dir}}' },
                note: { type: 'string' },
              },
            },
            steps: [
              {
                id: 'scope',
                name: 'Scope',
                prompt: 'Write {{workPath}}/security/review-scope.md. Template: {{note}}',
                gate: {
                  at: 'completion',
                  checks: [
                    {
                      kind: 'minBytes',
                      file: '{{workPath}}/security/review-scope.md',
                      bytes: 1000,
                      artifact: true,
                    },
                  ],
                },
                terminal: true,
              },
            ],
          },
          sourceId: 'bundled',
        };
      },
    });
    const task = await tasks.create('website', {
      title: 'Security architecture review',
      craftbookId: 'spec-doc',
      assignee: { kind: 'user' },
      craftbookParams: {
        workPath: '{{task.dir}}',
        // A caller's own `{{…}}` text stays byte-for-byte: only the four
        // reserved runtime keys are resolved inside overrides.
        note: 'emit {{heading}} verbatim',
      },
    });
    const dir = `tasks/${task.num}`;
    const step = task.craftbook.steps[0]!;
    expect(task.craftbookParams?.workPath).toBe(dir);
    expect(task.craftbookParams?.note).toBe('emit {{heading}} verbatim');
    expect(step.prompt).toBe(
      `Write ${dir}/security/review-scope.md. Template: emit {{heading}} verbatim`,
    );
    expect((step.gate as { checks: Array<{ file: string }> }).checks[0]?.file).toBe(
      `${dir}/security/review-scope.md`,
    );
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

describe('connector-backed craftbooks', () => {
  const bookWithConnector = {
    id: 'pull-request-review',
    name: 'Pull Request Review',
    steps: [
      {
        id: 'report',
        name: 'Review and write the report',
        prompt: 'Read every record under `{{corpusScope}}/` for PR #{{number}}.',
        advanceWhen: { file: 'reviews/pr-{{number}}/pr-review.md', artifact: true },
        terminal: true,
      },
    ],
    entryStepId: 'report',
    connectors: [{ typeId: 'github-pulls', reason: 'pull the PR diff down' }],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };

  const resolveConnectorBook = () => {
    tasks.setCraftbookResolver({
      async resolve(id) {
        return { craftbook: { ...bookWithConnector, id }, sourceId: 'bundled' };
      },
    });
  };

  const bindConnector = async () => {
    await store.updateProject('website', {
      connectors: [
        {
          id: 'pulls-1',
          type: 'github-pulls',
          sourceId: 'bundled',
          version: '1.0.0',
          displayName: 'GitHub Pulls',
          corpusDir: 'github-pulls',
          config: {},
        },
      ],
    });
  };

  it('refuses to launch when a required connector is not bound', async () => {
    resolveConnectorBook();
    await expect(
      tasks.create('website', {
        title: 'Review',
        craftbookId: 'pull-request-review',
        assignee: { kind: 'user' },
      }),
    ).rejects.toThrow(/SETUP REQUIRED.*github-pulls/s);
    // No half-built task is left behind for the user to clean up.
    expect(await tasks.list({ projectId: 'website' })).toEqual([]);
  });

  it('lets launch prep provision a declared zero-config connector', async () => {
    resolveConnectorBook();
    let called = false;
    tasks.setConnectorPrepHook(
      async () => {
        called = true;
        return {
          params: { number: '52', corpusScope: 'artifacts/data/github-pulls/pr-52' },
        };
      },
      { autoPreparedTypes: ['github-pulls'] },
    );

    const task = await tasks.create('website', {
      title: 'Review',
      craftbookId: 'pull-request-review',
      assignee: { kind: 'user' },
    });
    expect(called).toBe(true);
    expect(task.craftbook.steps[0]?.prompt).toContain('artifacts/data/github-pulls/pr-52');
  });

  it('interpolates the prep params into step prompts and gate paths', async () => {
    // The whole reason prep runs at launch: interpolation happens exactly
    // once, so the corpus paths must be concrete before it.
    resolveConnectorBook();
    await bindConnector();
    const seen: { craftbookId: string; typeIds: string[] }[] = [];
    tasks.setConnectorPrepHook(async ({ craftbookId, connectors }) => {
      seen.push({ craftbookId, typeIds: connectors.map((c) => c.typeId) });
      return {
        params: { number: '52', corpusScope: 'artifacts/data/github-pulls/pr-52' },
        note: '# Connector data pulled for this run\n\n- PR #52',
      };
    });

    const task = await tasks.create('website', {
      title: 'Review',
      craftbookId: 'pull-request-review',
      assignee: { kind: 'user' },
    });

    expect(seen).toEqual([{ craftbookId: 'pull-request-review', typeIds: ['github-pulls'] }]);
    const step = task.craftbook.steps[0]!;
    expect(step.prompt).toBe(
      'Read every record under `artifacts/data/github-pulls/pr-52/` for PR #52.',
    );
    expect(step.advanceWhen?.file).toBe('reviews/pr-52/pr-review.md');
    expect(task.craftbookParams).toMatchObject({ number: '52' });
    expect(task.craftbook.connectors).toEqual([
      { typeId: 'github-pulls', reason: 'pull the PR diff down' },
    ]);

    const notes = await tasks.listNotes('website', task.num);
    expect(notes.some((n) => n.text.includes('Connector data pulled'))).toBe(true);
  });

  it('an explicit param survives prep that does not override it', async () => {
    resolveConnectorBook();
    await bindConnector();
    tasks.setConnectorPrepHook(async ({ params }) => ({
      params: { corpusScope: `artifacts/data/github-pulls/pr-${params.number}` },
    }));
    const task = await tasks.create('website', {
      title: 'Review',
      craftbookId: 'pull-request-review',
      assignee: { kind: 'user' },
      craftbookParams: { number: '41' },
    });
    expect(task.craftbook.steps[0]!.prompt).toContain('artifacts/data/github-pulls/pr-41');
    expect(task.craftbook.steps[0]!.prompt).toContain('PR #41');
  });

  it('a prep failure fails the launch instead of creating an empty-corpus task', async () => {
    resolveConnectorBook();
    await bindConnector();
    tasks.setConnectorPrepHook(async () => {
      throw new Error('Could not pull down PR #52: rate limited');
    });
    await expect(
      tasks.create('website', {
        title: 'Review',
        craftbookId: 'pull-request-review',
        assignee: { kind: 'user' },
      }),
    ).rejects.toThrow(/rate limited/);
    expect(await tasks.list({ projectId: 'website' })).toEqual([]);
  });

  it('an optional connector need never blocks the launch', async () => {
    tasks.setCraftbookResolver({
      async resolve(id) {
        return {
          craftbook: {
            ...bookWithConnector,
            id,
            connectors: [{ typeId: 'github-pulls', optional: true }],
          },
          sourceId: 'bundled',
        };
      },
    });
    const task = await tasks.create('website', {
      title: 'Review',
      craftbookId: 'pull-request-review',
      assignee: { kind: 'user' },
    });
    expect(task.status).toBe('active');
  });
});
