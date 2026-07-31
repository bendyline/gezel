import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { CatalogService } from '@bendyline/gezel-catalog';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChatEventBus } from '../chat/events.js';
import { ChatManager } from '../chat/manager.js';
import { Store } from '../fs/store.js';
import type { MemoryManager } from '../memory/manager.js';
import { MockProvider } from '../providers/mock.js';
import { ScriptRunner } from '../scripts/runner.js';
import { FileSecretStore } from '../secrets/file-store.js';
import { GateRejectionError, TaskManager } from './manager.js';

const noopMemory = {
  search: async () => [],
  searchAll: async () => [],
  reindex: async () => 0,
  writeSummary: async () => {},
  getRecent: async () => '',
} as unknown as MemoryManager;

let home: string;
let store: Store;
let tasks: TaskManager;
let chat: ChatManager;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-tasks-gates-test-'));
  store = new Store({ home });
  await store.ensureLayout();
  await store.createProject({ name: 'Default' });
  await store.createGezel({ name: 'Ada', role: 'Developer' });

  const mock = new MockProvider({ name: 'copilot' });
  chat = new ChatManager({
    store,
    events: new ChatEventBus(),
    memory: noopMemory,
    getPort: () => 0,
    getToken: () => 'test-token',
    home,
    providers: [['copilot', mock]],
    catalog: new CatalogService(),
    secrets: new FileSecretStore(home),
  });

  tasks = new TaskManager(store);
  tasks.setScriptRunner(new ScriptRunner({ store, chat }));
});

afterEach(async () => {
  await chat.drainBackground();
  await chat.shutdown();
  await rm(home, { recursive: true, force: true });
});

async function writeWorkspaceFile(path: string, content: string): Promise<void> {
  const file = join(home, 'projects', 'default', 'workspace', path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content, 'utf8');
}

async function writeScript(name: string, source: string): Promise<void> {
  const dir = join(home, 'projects', 'default', 'scripts');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${name}.ts`), source, 'utf8');
}

/** Two-step task whose first step carries a completion gate. */
function gatedSteps(gate: unknown) {
  return [
    { name: 'Build', assignee: { kind: 'user' } as const, gate: gate as never },
    { name: 'Done', assignee: { kind: 'user' } as const },
  ];
}

describe('completion gates — checks floor', () => {
  it('holds the step (not completed, gateAttempts bumped, note appended) on reject', async () => {
    const task = await tasks.create('default', {
      title: 'Gated build',
      description: 'checks-floor completion gate holds an unmet deliverable.',
      assignee: { kind: 'user' },
      steps: gatedSteps({
        at: 'completion',
        checks: [{ kind: 'minBytes', file: 'index.html', bytes: 100 }],
      }),
    });
    const buildId = task.craftbook.steps[0]!.id;

    const outcome = await tasks.completeStepChecked('default', task.num, buildId);
    expect(outcome.status).toBe('held');
    if (outcome.status !== 'held') return;
    expect(outcome.gate.message).toContain('index.html');
    expect(outcome.gate.attempt).toBe(1);
    expect(outcome.gate.paused).toBe(false);

    const after = await tasks.get('default', task.num);
    const step = after!.craftbook.steps[0]!;
    expect(step.completedAt).toBeUndefined();
    expect(step.gateAttempts).toBe(1);
    expect(after!.activeStepId).toBe(buildId);

    const notes = await tasks.listNotes('default', task.num, buildId);
    expect(notes.some((n) => n.text.includes('Gate — not yet met'))).toBe(true);
  });

  it('advances once the deliverable meets the checks', async () => {
    const task = await tasks.create('default', {
      title: 'Gated build',
      description: 'checks-floor completion gate approves a met deliverable.',
      assignee: { kind: 'user' },
      steps: gatedSteps({
        at: 'completion',
        checks: [{ kind: 'minBytes', file: 'index.html', bytes: 10 }],
      }),
    });
    await writeWorkspaceFile('index.html', '<!doctype html><html><body>hello</body></html>');
    const outcome = await tasks.completeStepChecked(
      'default',
      task.num,
      task.craftbook.steps[0]!.id,
    );
    expect(outcome.status).toBe('advanced');
    if (outcome.status !== 'advanced') return;
    expect(outcome.task.activeStepId).toBe(task.craftbook.steps[1]!.id);
    expect(outcome.task.craftbook.steps[0]!.completedAt).toBeTruthy();
  });

  it('does not re-run an old completion gate when its successful advance is replayed', async () => {
    const task = await tasks.create('default', {
      title: 'Replayed gated advance',
      description: 'A duplicate model tool call must be idempotent.',
      assignee: { kind: 'user' },
      steps: gatedSteps({
        at: 'completion',
        checks: [{ kind: 'minBytes', file: 'index.html', bytes: 10 }],
      }),
    });
    const buildId = task.craftbook.steps[0]!.id;
    const doneId = task.craftbook.steps[1]!.id;
    await writeWorkspaceFile('index.html', '<!doctype html><html><body>hello</body></html>');

    const advanced = await tasks.completeStepChecked('default', task.num, buildId);
    expect(advanced.status).toBe('advanced');
    if (advanced.status !== 'advanced') return;
    const doneActivation = advanced.task.craftbook.steps[1]!.lastActivatedAt;

    // If the stale call reached the gate again this missing file would reject
    // it. The replay must instead return the already-advanced task unchanged.
    await rm(join(home, 'projects', 'default', 'workspace', 'index.html'));
    const replayed = await tasks.completeStepChecked('default', task.num, buildId);
    expect(replayed.status).toBe('advanced');
    if (replayed.status !== 'advanced') return;
    expect(replayed.task.activeStepId).toBe(doneId);
    expect(replayed.task.craftbook.steps[1]!.lastActivatedAt).toBe(doneActivation);
  });

  it('pauses the task when maxAttempts is exhausted', async () => {
    const task = await tasks.create('default', {
      title: 'Gated build',
      description: 'completion gate pauses after repeated rejections.',
      assignee: { kind: 'user' },
      steps: gatedSteps({
        at: 'completion',
        checks: [{ kind: 'minBytes', file: 'index.html', bytes: 100 }],
        maxAttempts: 2,
      }),
    });
    const buildId = task.craftbook.steps[0]!.id;
    const first = await tasks.completeStepChecked('default', task.num, buildId);
    expect(first.status === 'held' && first.gate.paused).toBe(false);
    const second = await tasks.completeStepChecked('default', task.num, buildId);
    expect(second.status === 'held' && second.gate.paused).toBe(true);
    const after = await tasks.get('default', task.num);
    expect(after!.status).toBe('paused');
  });

  it('damps repeat rejections: unchanged advanceWhen deliverable → cached, no attempt bump', async () => {
    const task = await tasks.create('default', {
      title: 'Gated build',
      description: 'repeat rejections on a byte-identical deliverable are cached.',
      assignee: { kind: 'user' },
      steps: [
        {
          name: 'Build',
          assignee: { kind: 'user' },
          advanceWhen: { file: 'index.html' },
          gate: {
            at: 'completion',
            checks: [{ kind: 'minBytes', file: 'index.html', bytes: 500 }],
          },
        },
        { name: 'Done', assignee: { kind: 'user' } },
      ] as never,
    });
    const buildId = task.craftbook.steps[0]!.id;
    await writeWorkspaceFile('index.html', 'too small');

    const first = await tasks.completeStepChecked('default', task.num, buildId);
    expect(first.status === 'held' && first.gate.cached).toBe(false);
    const second = await tasks.completeStepChecked('default', task.num, buildId);
    expect(second.status === 'held' && second.gate.cached).toBe(true);
    const after = await tasks.get('default', task.num);
    expect(after!.craftbook.steps[0]!.gateAttempts).toBe(1);

    // The damper releases once the deliverable changes.
    await writeWorkspaceFile('index.html', 'still too small but DIFFERENT');
    const third = await tasks.completeStepChecked('default', task.num, buildId);
    expect(third.status === 'held' && third.gate.cached).toBe(false);
    expect((await tasks.get('default', task.num))!.craftbook.steps[0]!.gateAttempts).toBe(2);
  });

  it('force bypasses the gate and completes the step', async () => {
    const task = await tasks.create('default', {
      title: 'Gated build',
      description: 'a forced completion skips the gate entirely.',
      assignee: { kind: 'user' },
      steps: gatedSteps({
        at: 'completion',
        checks: [{ kind: 'minBytes', file: 'index.html', bytes: 100 }],
      }),
    });
    const outcome = await tasks.completeStepChecked(
      'default',
      task.num,
      task.craftbook.steps[0]!.id,
      undefined,
      { force: true },
    );
    expect(outcome.status).toBe('advanced');
  });

  it('legacy completeStep throws GateRejectionError on a hold', async () => {
    const task = await tasks.create('default', {
      title: 'Gated build',
      description: 'callers that cannot render a rejection get a typed throw.',
      assignee: { kind: 'user' },
      steps: gatedSteps({
        at: 'completion',
        checks: [{ kind: 'minBytes', file: 'index.html', bytes: 100 }],
      }),
    });
    await expect(
      tasks.completeStep('default', task.num, task.craftbook.steps[0]!.id),
    ).rejects.toThrow(GateRejectionError);
  });

  it('onReject loops back: re-activates the target with a fresh attemptCount bump', async () => {
    const task = await tasks.create('default', {
      title: 'Looping book',
      description: 'gate rejection re-activates an earlier step for a fresh pass.',
      assignee: { kind: 'user' },
      steps: [
        { name: 'Design', id: 'design', assignee: { kind: 'user' } },
        {
          name: 'Build',
          id: 'build',
          assignee: { kind: 'user' },
          gate: {
            at: 'completion',
            checks: [{ kind: 'minBytes', file: 'index.html', bytes: 100 }],
            onReject: 'design',
          },
        },
      ] as never,
    });
    await tasks.activateStep('default', task.num, 'build');
    const outcome = await tasks.completeStepChecked('default', task.num, 'build');
    expect(outcome.status).toBe('held');
    const after = await tasks.get('default', task.num);
    expect(after!.activeStepId).toBe('design');
    expect(after!.craftbook.steps.find((s) => s.id === 'design')!.attemptCount).toBeGreaterThan(0);
    // The gated step itself was NOT completed.
    expect(after!.craftbook.steps.find((s) => s.id === 'build')!.completedAt).toBeUndefined();
  });

  it('a fresh activation resets the gate budget', async () => {
    const task = await tasks.create('default', {
      title: 'Budget reset',
      description: 'bumpStepActivation clears gateAttempts and the damper.',
      assignee: { kind: 'user' },
      steps: [
        { name: 'Build', id: 'build', assignee: { kind: 'user' } },
        {
          name: 'Check',
          id: 'check',
          assignee: { kind: 'user' },
          gate: {
            at: 'completion',
            checks: [{ kind: 'minBytes', file: 'x.txt', bytes: 5 }],
            onReject: 'build',
          },
        },
      ] as never,
    });
    await tasks.activateStep('default', task.num, 'check');
    await tasks.completeStepChecked('default', task.num, 'check'); // reject → loops to build
    // Loop back to check (simulating the next pass).
    await tasks.completeStep('default', task.num, 'build', 'check');
    const after = await tasks.get('default', task.num);
    expect(after!.craftbook.steps.find((s) => s.id === 'check')!.gateAttempts).toBeUndefined();
  });
});

describe('completion gates — script verdicts', () => {
  it('pauses on a gate infrastructure error without consuming an attempt', async () => {
    tasks.setScriptRunner({
      run: async () => ({
        id: 'broken-run',
        projectId: 'default',
        scriptName: 'broken-gate',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        status: 'error' as const,
        trigger: { kind: 'manual' as const, userInitiated: true },
        inputs: {},
        calls: [],
        logs: '[stderr] node: bad option: --permission',
        error: 'script exited with code 9',
      }),
    } as unknown as ScriptRunner);
    const task = await tasks.create('default', {
      title: 'Broken gate runtime',
      description: 'A runtime failure is not a deliverable rejection.',
      assignee: { kind: 'user' },
      steps: gatedSteps({
        at: 'completion',
        scripts: [{ name: 'broken-gate', scope: 'standard' }],
      }),
    });
    const stepId = task.craftbook.steps[0]!.id;

    const held = await tasks.completeStepChecked('default', task.num, stepId, undefined, {
      cause: 'model',
    });

    expect(held.status).toBe('held');
    if (held.status !== 'held') return;
    expect(held.gate.infrastructureError).toBe(true);
    expect(held.gate.scriptRuns?.[0]).toMatchObject({
      scriptName: 'broken-gate',
      runId: 'broken-run',
      error: 'script exited with code 9',
      logsTail: '[stderr] node: bad option: --permission',
    });
    expect(held.gate.attempt).toBe(0);
    expect(held.gate.paused).toBe(true);
    const after = await tasks.get('default', task.num);
    expect(after?.status).toBe('paused');
    expect(after?.craftbook.steps[0]?.gateAttempts).toBeUndefined();
    expect(after?.craftbook.steps[0]?.gateAttemptHistory).toBeUndefined();
    const notes = await tasks.listNotes('default', task.num, stepId);
    expect(notes.some((n) => n.text.includes('Gate unavailable — task paused'))).toBe(true);
    expect(notes.some((n) => n.text.includes('No completion attempt was consumed'))).toBe(true);
    expect(notes.some((n) => n.text.includes('broken-run'))).toBe(true);
    expect(notes.some((n) => n.text.includes('node: bad option: --permission'))).toBe(true);
  });

  it.runIf(process.platform === 'darwin')(
    'a gate script reject holds with the script message; approve advances with handoff',
    async () => {
      await writeScript(
        'judge',
        `
        import { gezel, defineScript } from '@bendyline/gezel-sdk';
        export const meta = defineScript({
          name: 'judge',
          description: 'approves iff the marker input says so.',
          kind: 'gate',
          inputs: { verdict: { type: 'string', description: 'approve|reject', required: true } },
          outputs: {
            decision: { type: 'string', description: 'the decision' },
            message: { type: 'string', description: 'guidance' },
          },
        });
        const v = (gezel.input as { verdict: string }).verdict;
        gezel.output(
          v === 'approve'
            ? { decision: 'approve', message: 'looks good', handoff: { message: 'carry on with polish' } }
            : { decision: 'reject', message: 'add a restart button to index.html' },
        );
      `,
      );

      const make = (verdict: string) =>
        tasks.create('default', {
          title: `Script gate ${verdict}`,
          description: 'script-based completion gate verdict handling.',
          assignee: { kind: 'user' },
          steps: gatedSteps({
            at: 'completion',
            scripts: [{ name: 'judge', inputs: { verdict } }],
          }),
        });

      const rejecting = await make('reject');
      const held = await tasks.completeStepChecked(
        'default',
        rejecting.num,
        rejecting.craftbook.steps[0]!.id,
      );
      expect(held.status).toBe('held');
      if (held.status === 'held') {
        expect(held.gate.message).toContain('restart button');
      }

      const approving = await make('approve');
      const advanced = await tasks.completeStepChecked(
        'default',
        approving.num,
        approving.craftbook.steps[0]!.id,
      );
      expect(advanced.status).toBe('advanced');
      if (advanced.status === 'advanced') {
        expect(advanced.task.lastGateHandoff?.message).toBe('carry on with polish');
        const notes = await tasks.listNotes('default', approving.num);
        expect(notes.some((n) => n.text.includes('Handoff from gate'))).toBe(true);
      }
    },
    60_000,
  );

  it.runIf(process.platform === 'darwin')(
    'onExit runs only after an approved completion (finally semantics)',
    async () => {
      await writeScript(
        'leave-marker',
        `
        import { gezel, defineScript } from '@bendyline/gezel-sdk';
        export const meta = defineScript({
          name: 'leave-marker',
          description: 'cleanup script that writes a workspace marker.',
          outputs: { ok: { type: 'boolean', description: 'done' } },
          requires: ['workspace.write'],
        });
        await gezel.fs.write('exit-ran.txt', 'yes');
        gezel.output({ ok: true });
      `,
      );

      const task = await tasks.create('default', {
        title: 'Finally semantics',
        description: 'onExit must not run when the completion gate rejects.',
        assignee: { kind: 'user' },
        steps: [
          {
            name: 'Build',
            assignee: { kind: 'user' },
            onExit: { name: 'leave-marker' },
            gate: {
              at: 'completion',
              checks: [{ kind: 'minBytes', file: 'deliverable.txt', bytes: 5 }],
            },
          },
          { name: 'Done', assignee: { kind: 'user' } },
        ] as never,
      });
      const buildId = task.craftbook.steps[0]!.id;

      const held = await tasks.completeStepChecked('default', task.num, buildId);
      expect(held.status).toBe('held');
      expect(
        await store.readProjectWorkspaceFile('default', 'exit-ran.txt').catch(() => null),
      ).toBe(null);

      await writeWorkspaceFile('deliverable.txt', 'present!');
      const advanced = await tasks.completeStepChecked('default', task.num, buildId);
      expect(advanced.status).toBe('advanced');
      expect(await store.readProjectWorkspaceFile('default', 'exit-ran.txt')).toBe('yes');
    },
    60_000,
  );
});

describe('completion gates — self-loop recovery ownership', () => {
  async function createSelfLoopTask(): Promise<{ num: number; stepId: string }> {
    const task = await tasks.create('default', {
      title: 'Self-loop gate',
      description: 'A rejected build loops to itself.',
      assignee: { kind: 'gezel', gezelId: 'ada' },
      steps: [
        {
          id: 'build',
          name: 'Build',
          assignee: { kind: 'gezel', gezelId: 'ada' },
          gate: {
            at: 'completion',
            checks: [{ kind: 'minBytes', file: 'index.html', bytes: 100 }],
            onReject: 'build',
          },
        },
      ] as never,
    });
    return { num: task.num, stepId: task.craftbook.steps[0]!.id };
  }

  it('lets the current model turn own recovery instead of dispatching a duplicate session', async () => {
    const { num, stepId } = await createSelfLoopTask();
    const activations: string[] = [];
    tasks.setStepActivatedHook(async ({ newStep }) => {
      activations.push(newStep.id);
    });

    const held = await tasks.completeStepChecked('default', num, stepId, undefined, {
      cause: 'model',
    });

    expect(held.status).toBe('held');
    expect(activations).toEqual([]);
  });

  it('dispatches recovery when an idle sweep has no current model turn', async () => {
    const { num, stepId } = await createSelfLoopTask();
    const activations: string[] = [];
    tasks.setStepActivatedHook(async ({ newStep }) => {
      activations.push(newStep.id);
    });

    const held = await tasks.completeStepChecked('default', num, stepId, undefined, {
      cause: 'sweep',
    });

    expect(held.status).toBe('held');
    expect(activations).toEqual(['build']);
  });
});

describe('completion gates — inline craftbook scripts', () => {
  const inlineGateSource = `
    import { gezel, defineScript } from '@bendyline/gezel-sdk';
    export const meta = defineScript({
      name: 'inlineJudge',
      description: 'approves when the deliverable marker file exists.',
      kind: 'gate',
      outputs: {
        decision: { type: 'string', description: 'the decision' },
        message: { type: 'string', description: 'guidance' },
      },
      requires: ['workspace.read'],
    });
    let present = false;
    try {
      await gezel.fs.read('marker.txt');
      present = true;
    } catch {
      present = false;
    }
    gezel.output(
      present
        ? { decision: 'approve', message: 'marker found' }
        : { decision: 'reject', message: 'write marker.txt before completing this step' },
    );
  `;

  it.runIf(process.platform === 'darwin')(
    'a scope:craftbook gate script runs from the task snapshot with no installed copy',
    async () => {
      // No project-installed script exists — resolution must come from the
      // embedded map the snapshot carries.
      tasks.setCraftbookResolver({
        resolve: async (id) =>
          id !== 'inline-book'
            ? null
            : {
                craftbook: {
                  id: 'inline-book',
                  name: 'Inline Book',
                  steps: [
                    {
                      id: 'build',
                      name: 'Build',
                      assignee: { kind: 'user' },
                      gate: {
                        at: 'completion',
                        scripts: [{ name: 'inlineJudge', scope: 'craftbook' }],
                        onReject: 'build',
                      },
                      next: 'done',
                    },
                    { id: 'done', name: 'Done', assignee: { kind: 'user' }, terminal: true },
                  ],
                  entryStepId: 'build',
                  scripts: { inlineJudge: inlineGateSource },
                  createdAt: new Date().toISOString(),
                  updatedAt: new Date().toISOString(),
                },
                sourceId: 'local',
              },
      });

      const task = await tasks.create('default', {
        title: 'Inline gate',
        description: 'gate script resolves from the embedded snapshot scripts map.',
        assignee: { kind: 'user' },
        craftbookId: 'inline-book',
      });
      expect(task.craftbook.scripts?.inlineJudge).toBeDefined();

      const held = await tasks.completeStepChecked('default', task.num, 'build');
      expect(held.status).toBe('held');
      if (held.status === 'held') {
        expect(held.gate.message).toContain('marker.txt');
      }

      await writeWorkspaceFile('marker.txt', 'present');
      const advanced = await tasks.completeStepChecked('default', task.num, 'build');
      expect(advanced.status).toBe('advanced');
    },
    60_000,
  );

  it('a scope:craftbook ref with no embedded source and no installed copy fails closed', async () => {
    tasks.setCraftbookResolver({
      resolve: async () => ({
        craftbook: {
          id: 'legacy-book',
          name: 'Legacy Book',
          steps: [
            {
              id: 'build',
              name: 'Build',
              assignee: { kind: 'user' },
              gate: {
                at: 'completion',
                scripts: [{ name: 'missingScript', scope: 'craftbook' }],
              },
              next: 'done',
            },
            { id: 'done', name: 'Done', assignee: { kind: 'user' }, terminal: true },
          ],
          entryStepId: 'build',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        sourceId: 'local',
      }),
    });
    const task = await tasks.create('default', {
      title: 'Legacy gate',
      description: 'missing script source rejects the completion (fail closed).',
      assignee: { kind: 'user' },
      craftbookId: 'legacy-book',
    });
    const held = await tasks.completeStepChecked('default', task.num, 'build');
    expect(held.status).toBe('held');
  }, 60_000);
});

describe('single-call gated authoring — blueprint deliverables', () => {
  it('create with a deliverable per step yields fully-gated steps in one call', async () => {
    const task = await tasks.create('default', {
      title: 'One-call gated',
      description: 'inline steps with deliverable sugar expand to enforced gates at create.',
      assignee: { kind: 'user' },
      steps: [
        { name: 'Build the page', deliverable: { path: 'index.html', kind: 'html-page' } },
        { name: 'Write the notes', deliverable: { path: 'notes.md' } },
        { name: 'Done', terminal: true },
      ],
    });
    const [build, notes, done] = task.craftbook.steps;
    expect(build!.advanceWhen?.file).toBe('index.html');
    expect(build!.gate).toMatchObject({ at: 'completion', onReject: build!.id });
    // kind inferred from extension for the second step
    expect(notes!.advanceWhen?.file).toBe('notes.md');
    expect(notes!.gate).toMatchObject({ at: 'completion', onReject: notes!.id });
    expect(done!.gate).toBeUndefined();
    // And the gate actually holds an empty completion attempt.
    const held = await tasks.completeStepChecked('default', task.num, build!.id);
    expect(held.status).toBe('held');
  });

  it('addStep expands the deliverable against the post-mint id on slug collision', async () => {
    const task = await tasks.create('default', {
      title: 'Collision',
      description: 'the expanded onReject must use the de-duped step id, never the base slug.',
      assignee: { kind: 'user' },
      steps: [{ name: 'Build', id: 'build' }],
    });
    const updated = await tasks.addStep('default', task.num, {
      name: 'Build',
      deliverable: { path: 'x.md' },
    });
    const added = updated.craftbook.steps.find((s) => s.id === 'build-2');
    expect(added).toBeDefined();
    expect(added!.gate).toMatchObject({ onReject: 'build-2' });
  });
});

describe('gate hardening — code-class deliverables', () => {
  it('a truncated .ts deliverable loops back with the parse error in the rejection', async () => {
    const task = await tasks.create('default', {
      title: 'Code module',
      description: 'the sourceParses floor rejects a truncated source file.',
      assignee: { kind: 'user' },
      steps: [
        { name: 'Write parser', deliverable: { path: 'src/parser.ts', kind: 'code-module' } },
        { name: 'Done', terminal: true },
      ],
    });
    const stepId = task.craftbook.steps[0]!.id;
    await writeWorkspaceFile(
      'src/parser.ts',
      `export function parse(x: string): number {\n${'  // padding line\n'.repeat(20)}  return x.len`,
    );
    const held = await tasks.completeStepChecked('default', task.num, stepId);
    expect(held.status).toBe('held');
    if (held.status === 'held') {
      expect(held.gate.message).toMatch(/does not parse/);
    }

    await writeWorkspaceFile(
      'src/parser.ts',
      `export function parse(x: string): number {\n${'  // padding line\n'.repeat(20)}  return x.length;\n}\n`,
    );
    const advanced = await tasks.completeStepChecked('default', task.num, stepId);
    expect(advanced.status).toBe('advanced');
  });

  it.runIf(process.platform === 'darwin')(
    'execute:true runs the deliverable in the sandbox — failing asserts hold, passing exits advance',
    async () => {
      const task = await tasks.create('default', {
        title: 'Tests must pass',
        description: 'the nodeRuns gate executes a node:test deliverable and requires exit 0.',
        assignee: { kind: 'user' },
        steps: [
          {
            name: 'Write tests',
            deliverable: { path: 'contract.test.mjs', kind: 'code-with-tests', execute: true },
          },
          { name: 'Done', terminal: true },
        ],
      });
      const stepId = task.craftbook.steps[0]!.id;
      const failing = `import test from 'node:test';\nimport assert from 'node:assert';\n${'// padding to clear the byte floor\n'.repeat(12)}test('adds', () => {\n  assert.strictEqual(1 + 1, 3);\n});\n`;
      await writeWorkspaceFile('contract.test.mjs', failing);
      const held = await tasks.completeStepChecked('default', task.num, stepId);
      expect(held.status).toBe('held');
      if (held.status === 'held') {
        expect(held.gate.message).toMatch(/exited with code|did not finish/);
      }

      await writeWorkspaceFile('contract.test.mjs', failing.replace('1 + 1, 3', '1 + 1, 2'));
      const advanced = await tasks.completeStepChecked('default', task.num, stepId);
      expect(advanced.status).toBe('advanced');
    },
    120_000,
  );
});

describe('completion gates — task.step.gated telemetry events', () => {
  it('emits one event per real evaluation (reject + approve), none for damped replays', async () => {
    const events: Array<{ kind: string; details?: Record<string, unknown> }> = [];
    const recordingHistory = {
      log: async (e: { kind: string; details?: Record<string, unknown> }) => {
        events.push(e);
      },
    } as unknown as import('../history/manager.js').HistoryManager;
    const gatedTasks = new TaskManager(store, recordingHistory);
    gatedTasks.setScriptRunner(new ScriptRunner({ store, chat }));

    const task = await gatedTasks.create('default', {
      title: 'Gated build with telemetry',
      description: 'gate evaluations append task.step.gated history events.',
      assignee: { kind: 'user' },
      steps: [
        {
          name: 'Build',
          assignee: { kind: 'user' } as const,
          advanceWhen: { file: 'index.html' } as never,
          gate: {
            at: 'completion',
            checks: [{ kind: 'minBytes', file: 'index.html', bytes: 100 }],
          } as never,
        },
        { name: 'Done', assignee: { kind: 'user' } as const },
      ],
    });
    const buildId = task.craftbook.steps[0]!.id;

    // Genuine reject → one event with the failing kind + book join key.
    await writeWorkspaceFile('index.html', 'too small');
    const held = await gatedTasks.completeStepChecked('default', task.num, buildId, undefined, {
      cause: 'model',
    });
    expect(held.status).toBe('held');
    const gated = events.filter((e) => e.kind === 'task.step.gated');
    expect(gated).toHaveLength(1);
    expect(gated[0]?.details).toMatchObject({
      decision: 'reject',
      gateAt: 'completion',
      attempt: 1,
      paused: false,
      firstFailKind: 'minBytes',
      bookCatalogId: task.craftbook.id,
    });

    // Byte-identical resubmit from the SWEEP → quiet damper replay, no
    // new event. (A model-driven frozen resubmit is different: it climbs
    // the escalation ladder and emits with `frozen: true` — covered in
    // the ladder suite below.)
    const heldAgain = await gatedTasks.completeStepChecked(
      'default',
      task.num,
      buildId,
      undefined,
      { cause: 'sweep' },
    );
    expect(heldAgain.status).toBe('held');
    if (heldAgain.status === 'held') expect(heldAgain.gate.cached).toBe(true);
    expect(events.filter((e) => e.kind === 'task.step.gated')).toHaveLength(1);

    // Fixed deliverable → approve event.
    await writeWorkspaceFile(
      'index.html',
      `<!doctype html><html><body>${'x'.repeat(200)}</body></html>`,
    );
    const advanced = await gatedTasks.completeStepChecked('default', task.num, buildId, undefined, {
      cause: 'model',
    });
    expect(advanced.status).toBe('advanced');
    const afterApprove = events.filter((e) => e.kind === 'task.step.gated');
    expect(afterApprove).toHaveLength(2);
    expect(afterApprove[1]?.details).toMatchObject({ decision: 'approve', paused: false });
  });

  it('stamps the working session model+provider onto the event (newest wins; absent without one)', async () => {
    const events: Array<{ kind: string; details?: Record<string, unknown> }> = [];
    const recordingHistory = {
      log: async (e: { kind: string; details?: Record<string, unknown> }) => {
        events.push(e);
      },
    } as unknown as import('../history/manager.js').HistoryManager;
    const gatedTasks = new TaskManager(store, recordingHistory);
    gatedTasks.setScriptRunner(new ScriptRunner({ store, chat }));

    const task = await gatedTasks.create('default', {
      title: 'Gated build with model stamp',
      description: 'gate events carry the working model for routing evidence.',
      assignee: { kind: 'gezel', gezelId: 'ada' },
      steps: [
        {
          name: 'Build',
          assignee: { kind: 'gezel', gezelId: 'ada' } as const,
          advanceWhen: { file: 'stamp.html' } as never,
          gate: {
            at: 'completion',
            checks: [{ kind: 'minBytes', file: 'stamp.html', bytes: 100 }],
          } as never,
        },
        { name: 'Done', assignee: { kind: 'user' } as const },
      ],
    });
    const buildId = task.craftbook.steps[0]!.id;

    // Two sessions on the (task, step): the stamp must pick the newest.
    const base = {
      version: 1 as const,
      gezelId: 'ada',
      projectId: 'default',
      providerName: 'llama-cpp' as const,
      title: 'work',
      messages: [],
      providerState: {},
      taskRef: task.ref,
      stepId: buildId,
    };
    await store.writeSession({
      ...base,
      id: 'older-session',
      model: 'stale-2b',
      createdAt: '2026-07-07T00:00:00.000Z',
      lastActivityAt: '2026-07-07T00:00:00.000Z',
    });
    await store.writeSession({
      ...base,
      id: 'newer-session',
      model: 'gemma4-e4b-q8',
      createdAt: '2026-07-07T01:00:00.000Z',
      lastActivityAt: '2026-07-07T01:00:00.000Z',
    });

    await writeWorkspaceFile('stamp.html', 'too small');
    const held = await gatedTasks.completeStepChecked('default', task.num, buildId, undefined, {
      cause: 'model',
    });
    expect(held.status).toBe('held');
    const gated = events.filter((e) => e.kind === 'task.step.gated');
    expect(gated).toHaveLength(1);
    expect(gated[0]?.details).toMatchObject({
      model: 'gemma4-e4b-q8',
      provider: 'llama-cpp',
    });

    // A step with no matching session emits a valid event without the stamp.
    const bare = await gatedTasks.create('default', {
      title: 'No session',
      description: 'no working session exists for this step.',
      assignee: { kind: 'gezel', gezelId: 'ada' },
      steps: [
        {
          name: 'Build',
          assignee: { kind: 'gezel', gezelId: 'ada' } as const,
          advanceWhen: { file: 'unstamped.html' } as never,
          gate: {
            at: 'completion',
            checks: [{ kind: 'minBytes', file: 'unstamped.html', bytes: 100 }],
          } as never,
        },
        { name: 'Done', assignee: { kind: 'user' } as const },
      ],
    });
    const bareBuildId = bare.craftbook.steps[0]!.id;
    await writeWorkspaceFile('unstamped.html', 'too small');
    await gatedTasks.completeStepChecked('default', bare.num, bareBuildId, undefined, {
      cause: 'model',
    });
    const bareGated = events.filter((e) => e.kind === 'task.step.gated').at(-1);
    expect(bareGated?.details?.model).toBeUndefined();
    expect(bareGated?.details?.provider).toBeUndefined();
    expect(bareGated?.details?.decision).toBe('reject');
  });
});

describe('completion gates — plateau escalation ladder', () => {
  async function createGatedTask(mgr: TaskManager) {
    const task = await mgr.create('default', {
      title: 'Ladder build',
      description: 'plateaued rejections climb targeted-edit, full-rewrite, pause.',
      assignee: { kind: 'user' },
      steps: [
        {
          name: 'Build',
          assignee: { kind: 'user' } as const,
          advanceWhen: { file: 'index.html' } as never,
          gate: {
            at: 'completion',
            checks: [{ kind: 'minBytes', file: 'index.html', bytes: 100 }],
            maxAttempts: 10,
          } as never,
        },
        { name: 'Done', assignee: { kind: 'user' } as const },
      ],
    });
    return { task, stepId: task.craftbook.steps[0]!.id };
  }

  const holdOf = (outcome: Awaited<ReturnType<TaskManager['completeStepChecked']>>) => {
    expect(outcome.status).toBe('held');
    if (outcome.status !== 'held') throw new Error('unreachable');
    return outcome.gate;
  };

  it('frozen resubmits climb stage 1 → stage 2 → paused-with-diagnosis, with fresh fingerprints', async () => {
    const { task, stepId } = await createGatedTask(tasks);
    await writeWorkspaceFile('index.html', 'too small');

    const first = holdOf(
      await tasks.completeStepChecked('default', task.num, stepId, undefined, { cause: 'model' }),
    );
    expect(first.cached).toBe(false);
    expect(first.escalationStage).toBeUndefined();

    // Byte-identical resubmit #1 → stage 1 targeted-edit, NEW fingerprint
    // (the old behavior replayed the cached message, which the chat layer
    // deduped into silence).
    const second = holdOf(
      await tasks.completeStepChecked('default', task.num, stepId, undefined, { cause: 'model' }),
    );
    expect(second.cached).toBe(true);
    expect(second.escalationStage).toBe(1);
    expect(second.message).toContain('resubmitting unchanged content cannot pass');
    expect(second.messageFingerprint).not.toBe(first.messageFingerprint);

    // Resubmit #2 → stage 2 full rewrite with the mode marker.
    const third = holdOf(
      await tasks.completeStepChecked('default', task.num, stepId, undefined, { cause: 'model' }),
    );
    expect(third.escalationStage).toBe(2);
    expect(third.message).toContain('GATE_FULL_REWRITE');
    expect(third.message).toContain('index.html');

    // Resubmit #3 → stage 3: paused with the diagnosis note.
    const fourth = holdOf(
      await tasks.completeStepChecked('default', task.num, stepId, undefined, { cause: 'model' }),
    );
    expect(fourth.escalationStage).toBe(3);
    expect(fourth.paused).toBe(true);
    const after = await tasks.get('default', task.num);
    expect(after?.status).toBe('paused');
    const step = after!.craftbook.steps.find((s) => s.id === stepId)!;
    expect(step.gateAttemptHistory?.length).toBeGreaterThanOrEqual(4);
    expect(step.gateAttemptHistory?.at(-1)?.frozen).toBe(true);
    const notes = await tasks.listNotes('default', task.num, stepId);
    expect(notes.some((n) => n.text.includes('# Gate plateau — paused for help'))).toBe(true);
    expect(notes.some((n) => n.text.includes('content unchanged (frozen resubmit)'))).toBe(true);
  });

  it('churn with the same failing set climbs too; clearing a check resets the ladder', async () => {
    const { task, stepId } = await createGatedTask(tasks);

    await writeWorkspaceFile('index.html', 'v1 too small');
    holdOf(
      await tasks.completeStepChecked('default', task.num, stepId, undefined, { cause: 'model' }),
    );
    await writeWorkspaceFile('index.html', 'v2 still small');
    const second = holdOf(
      await tasks.completeStepChecked('default', task.num, stepId, undefined, { cause: 'model' }),
    );
    expect(second.cached).toBe(false);
    expect(second.escalationStage).toBe(1);
    expect(second.message).toContain('Your last edits did not move the gate');

    // A deliverable that clears the failing check resets everything.
    await writeWorkspaceFile('index.html', `<!doctype html><body>${'x'.repeat(200)}</body>`);
    const advanced = await tasks.completeStepChecked('default', task.num, stepId, undefined, {
      cause: 'model',
    });
    expect(advanced.status).toBe('advanced');
  });

  it("cause 'sweep' takes the legacy quiet-cached path and never climbs", async () => {
    const { task, stepId } = await createGatedTask(tasks);
    await writeWorkspaceFile('index.html', 'too small');
    const first = holdOf(
      await tasks.completeStepChecked('default', task.num, stepId, undefined, { cause: 'model' }),
    );

    for (let i = 0; i < 3; i++) {
      const swept = holdOf(
        await tasks.completeStepChecked('default', task.num, stepId, undefined, { cause: 'sweep' }),
      );
      expect(swept.cached).toBe(true);
      expect(swept.escalationStage).toBeUndefined();
      expect(swept.messageFingerprint).toBe(first.messageFingerprint);
    }
    const after = await tasks.get('default', task.num);
    expect(after?.status).toBe('active');
  });

  it('GEZEL_DISABLE_GATE_ESCALATION=1 restores legacy damper behavior', async () => {
    process.env.GEZEL_DISABLE_GATE_ESCALATION = '1';
    try {
      const { task, stepId } = await createGatedTask(tasks);
      await writeWorkspaceFile('index.html', 'too small');
      const first = holdOf(
        await tasks.completeStepChecked('default', task.num, stepId, undefined, { cause: 'model' }),
      );
      const second = holdOf(
        await tasks.completeStepChecked('default', task.num, stepId, undefined, { cause: 'model' }),
      );
      expect(second.cached).toBe(true);
      expect(second.escalationStage).toBeUndefined();
      expect(second.messageFingerprint).toBe(first.messageFingerprint);
    } finally {
      delete process.env.GEZEL_DISABLE_GATE_ESCALATION;
    }
  });

  it('carries escalationStage on the task.step.gated telemetry event', async () => {
    const events: Array<{ kind: string; details?: Record<string, unknown> }> = [];
    const recordingHistory = {
      log: async (e: { kind: string; details?: Record<string, unknown> }) => {
        events.push(e);
      },
    } as unknown as import('../history/manager.js').HistoryManager;
    const gatedTasks = new TaskManager(store, recordingHistory);
    gatedTasks.setScriptRunner(new ScriptRunner({ store, chat }));

    const { task, stepId } = await createGatedTask(gatedTasks);
    await writeWorkspaceFile('index.html', 'too small');
    await gatedTasks.completeStepChecked('default', task.num, stepId, undefined, {
      cause: 'model',
    });
    await gatedTasks.completeStepChecked('default', task.num, stepId, undefined, {
      cause: 'model',
    });

    const gated = events.filter((e) => e.kind === 'task.step.gated');
    expect(gated).toHaveLength(2);
    expect(gated[1]?.details).toMatchObject({ escalationStage: 1, frozen: true });
  });
});

describe('completion gates — judge checks (advisory ride-along + budget)', () => {
  const ARTIFACT =
    '<!doctype html><html><body>The launch copy promises a full refund within thirty days.</body></html>';
  const VERBATIM_QUOTE = 'promises a full refund within thirty days';

  function judgeFake(onCall?: () => void) {
    return {
      noteStepAdvanced: () => {},
      judgeOneShot: async () => {
        onCall?.();
        return {
          text: JSON.stringify({
            verdict: 'fail',
            reasons: ['makes a guarantee the sources do not support'],
            evidence: [VERBATIM_QUOTE],
          }),
        };
      },
    } as unknown as import('../keurmeester/manager.js').KeurmeesterManager;
  }

  it('advisory judge fail rides the APPROVE: note + advisoryJudge telemetry, step advances', async () => {
    const events: Array<{ kind: string; details?: Record<string, unknown> }> = [];
    const recordingHistory = {
      log: async (e: { kind: string; details?: Record<string, unknown> }) => {
        events.push(e);
      },
    } as unknown as import('../history/manager.js').HistoryManager;
    const judged = new TaskManager(store, recordingHistory);
    judged.setScriptRunner(new ScriptRunner({ store, chat }));
    judged.setKeurmeester(judgeFake());

    const task = await judged.create('default', {
      title: 'Judged build',
      description: 'advisory judge opinion rides the approve.',
      assignee: { kind: 'user' },
      steps: gatedSteps({
        at: 'completion',
        checks: [
          { kind: 'minBytes', file: 'index.html', bytes: 10 },
          { kind: 'judge', file: 'index.html', rubric: 'no unsupported guarantees' },
        ],
      }),
    });
    const buildId = task.craftbook.steps[0]!.id;
    await writeWorkspaceFile('index.html', ARTIFACT);

    const outcome = await judged.completeStepChecked('default', task.num, buildId);
    expect(outcome.status).toBe('advanced');

    const notes = await judged.listNotes('default', task.num, buildId);
    const advisory = notes.find((n) => n.text.includes('# Advisory judge notes'));
    expect(advisory).toBeTruthy();
    expect(advisory!.text).toContain('judge would reject');
    expect(advisory!.text).toContain(VERBATIM_QUOTE);

    const approve = events.find(
      (e) => e.kind === 'task.step.gated' && e.details?.decision === 'approve',
    );
    expect(approve?.details?.advisoryJudge).toMatchObject({
      verdict: 'fail',
      quote: VERBATIM_QUOTE,
    });
  });

  it('an enforcing judge holds at most 3 attempts, then the per-step budget fail-opens', async () => {
    let judgeCalls = 0;
    const judged = new TaskManager(store);
    judged.setScriptRunner(new ScriptRunner({ store, chat }));
    judged.setKeurmeester(
      judgeFake(() => {
        judgeCalls += 1;
      }),
    );

    const task = await judged.create('default', {
      title: 'Enforcing judge',
      description: 'the per-step judge budget bounds enforcing-judge holds.',
      assignee: { kind: 'user' },
      steps: gatedSteps({
        at: 'completion',
        checks: [{ kind: 'judge', file: 'index.html', rubric: 'no guarantees', advisory: false }],
        maxAttempts: 10,
      }),
    });
    const buildId = task.craftbook.steps[0]!.id;

    for (let attempt = 1; attempt <= 3; attempt++) {
      await writeWorkspaceFile('index.html', `${ARTIFACT}<!-- rev ${attempt} -->`);
      const held = await judged.completeStepChecked('default', task.num, buildId, undefined, {
        cause: 'model',
      });
      expect(held.status).toBe('held');
      if (held.status === 'held') expect(held.gate.message).toContain('judge would reject');
      expect(judgeCalls).toBe(attempt);
    }

    await writeWorkspaceFile('index.html', `${ARTIFACT}<!-- rev 4 -->`);
    const finall = await judged.completeStepChecked('default', task.num, buildId, undefined, {
      cause: 'model',
    });
    expect(finall.status).toBe('advanced');
    expect(judgeCalls).toBe(3);
  });
});
