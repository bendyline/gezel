import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { GATE_MAX_PROGRESS_ATTEMPTS, type Task } from '@bendyline/gezel';
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
  // This suite injects a mock under the 'copilot' key. Pin it as the default
  // too — otherwise routing falls through to the platform default (an
  // on-device engine) and the injected mock is never reached.
  await store.writeConfig({ provider: 'copilot' });
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

async function writeArtifactFile(path: string, content: string): Promise<void> {
  const file = join(home, 'projects', 'default', 'artifacts', path);
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

  it('a self-looping gate keeps its budget across re-activation and can actually exhaust it', async () => {
    // `onReject: <self>` re-activates the step it just rejected, and the
    // activation reset handed it a brand-new budget every time — so
    // `maxAttempts` was unreachable and the pause-for-help it exists to
    // trigger never fired. Wild-caught on Pull Request Review: the step
    // reached attemptCount 3 while every rejection the model saw read
    // "attempt 1/3", and the loop could have run forever.
    const task = await tasks.create('default', {
      title: 'Self-looping gate',
      description: 'the reject route points back at the gated step.',
      assignee: { kind: 'user' },
      steps: [
        {
          name: 'Scope',
          id: 'scope',
          assignee: { kind: 'user' },
          gate: {
            at: 'completion',
            checks: [{ kind: 'minBytes', file: 'scope.md', bytes: 500 }],
            onReject: 'scope',
            maxAttempts: 3,
          },
        },
        { name: 'Done', id: 'done', assignee: { kind: 'user' } },
      ] as never,
    });

    const attemptsAfterReject = async (content: string): Promise<number> => {
      // Vary the deliverable each pass so the identical-resubmit damper
      // doesn't short-circuit and mask the counter.
      await writeWorkspaceFile('scope.md', content);
      await tasks.completeStepChecked('default', task.num, 'scope');
      const after = await tasks.get('default', task.num);
      return after!.craftbook.steps.find((s) => s.id === 'scope')!.gateAttempts ?? 0;
    };

    expect(await attemptsAfterReject('one')).toBe(1);
    expect(await attemptsAfterReject('two')).toBe(2);
    expect(await attemptsAfterReject('three')).toBe(3);

    // Budget spent → paused, instead of looping on "attempt 1/3" forever.
    const paused = await tasks.get('default', task.num);
    expect(paused!.status).toBe('paused');
    // The step really was re-activated each pass; the count and the
    // budget are separate facts and both must be true.
    expect(paused!.craftbook.steps.find((s) => s.id === 'scope')!.attemptCount).toBeGreaterThan(1);
  });

  it('a loop through a DIFFERENT step still earns a clean budget', async () => {
    // Routing rejection upstream means real rework happened there, so the
    // reset is correct — only the self-route is a continuation.
    const task = await tasks.create('default', {
      title: 'Upstream loop',
      description: 'reject routes to an earlier step, not to itself.',
      assignee: { kind: 'user' },
      steps: [
        { name: 'Build', id: 'build', assignee: { kind: 'user' } },
        {
          name: 'Check',
          id: 'check',
          assignee: { kind: 'user' },
          gate: {
            at: 'completion',
            checks: [{ kind: 'minBytes', file: 'out.md', bytes: 500 }],
            onReject: 'build',
          },
        },
      ] as never,
    });
    const gateAttempts = async (): Promise<number | undefined> =>
      (await tasks.get('default', task.num))!.craftbook.steps.find((s) => s.id === 'check')!
        .gateAttempts;

    await writeWorkspaceFile('out.md', 'short');
    await tasks.activateStep('default', task.num, 'check');
    await tasks.completeStepChecked('default', task.num, 'check'); // reject → routes to build
    // The reject bumped `build`, not `check`, so the persisted count is
    // untouched — the carve-out is scoped to the self-route and doesn't
    // leak into ordinary upstream loop-backs.
    expect(await gateAttempts()).toBe(1);

    await tasks.completeStep('default', task.num, 'build', 'check'); // rework done → back to check
    expect(await gateAttempts()).toBeUndefined();
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
      model: 'gemma4-e4b-q4',
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
      model: 'gemma4-e4b-q4',
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

  // A bounded batch loop fails the SAME check every pass by design. Before
  // `remaining` entered the signature the ladder read that as a plateau: on
  // the real Pull Request Review run of squisq PR #46 the reviewer went
  // 25 → 50 of 68 files and got "your last edits did not move the gate …
  // correct only the section the check names" — a directive whose literal
  // reading is "append the unread paths to the ledger", which passes the
  // gate with 18 files never opened.
  describe('bounded batch loops', () => {
    const CORPUS = 'data/pr-46';
    const LEDGER = 'pr-review-coverage.json';
    const PATHS = ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts', 'src/f.ts'];
    const recordPath = (i: number) => `${CORPUS}/files/${String(i + 1).padStart(3, '0')}--rec.md`;
    const corpusPaths = (total: number) =>
      total <= PATHS.length ? PATHS : Array.from({ length: total }, (_, i) => `src/f${i}.ts`);

    async function seedCorpus(total = PATHS.length): Promise<void> {
      await Promise.all(
        corpusPaths(total).map((path, i) =>
          writeArtifactFile(recordPath(i), `---\npath: ${path}\n---\n\npatch for ${path}\n`),
        ),
      );
    }

    async function writeLedger(count: number, total = PATHS.length): Promise<void> {
      const all = corpusPaths(total);
      await writeArtifactFile(
        LEDGER,
        JSON.stringify({
          reviewedFiles: all.slice(0, count),
          reviewedRecords: all.slice(0, count).map((_, i) => recordPath(i)),
        }),
      );
    }

    async function createCoverageTask(maxAttempts = 10) {
      const task = await tasks.create('default', {
        title: 'PR review',
        assignee: { kind: 'user' },
        steps: gatedSteps({
          at: 'completion',
          checks: [{ kind: 'corpusCoverage', file: LEDGER, corpusDir: CORPUS, artifact: true }],
          maxAttempts,
        }),
      });
      return { task, stepId: task.craftbook.steps[0]!.id };
    }

    const stepOf = async (num: number, stepId: string) => {
      const t = await tasks.get('default', num);
      return t!.craftbook.steps.find((s) => s.id === stepId)!;
    };

    it('reads a falling coverage count as progress, not a plateau', async () => {
      await seedCorpus();
      const { task, stepId } = await createCoverageTask();

      await writeLedger(2);
      const batch1 = holdOf(
        await tasks.completeStepChecked('default', task.num, stepId, undefined, {
          cause: 'model',
        }),
      );
      expect(batch1.escalationStage).toBeUndefined();
      expect(batch1.message).not.toContain('Progress:');

      await writeLedger(4);
      const batch2 = holdOf(
        await tasks.completeStepChecked('default', task.num, stepId, undefined, {
          cause: 'model',
        }),
      );
      expect(batch2.escalationStage).toBeUndefined();
      expect(batch2.message).not.toContain('GATE_TARGETED_EDIT');
      expect(batch2.message).toContain('Progress: 4 more item(s) covered');
      expect(batch2.message).toContain('4 still outstanding');
      // The gate's own verdict still rides along under the preamble.
      expect(batch2.message).toContain('src/e.ts');

      const mid = await tasks.get('default', task.num);
      const trail = mid!.craftbook.steps.find((s) => s.id === stepId)!.gateAttemptHistory!;
      expect(trail.map((entry) => entry.remaining)).toEqual([8, 4]);
      expect(trail[0]!.signatureHash).not.toBe(trail[1]!.signatureHash);

      await writeLedger(PATHS.length);
      const done = await tasks.completeStepChecked('default', task.num, stepId, undefined, {
        cause: 'model',
      });
      expect(done.status).toBe('advanced');
    });

    it('still escalates when the count stops falling', async () => {
      await seedCorpus();
      const { task, stepId } = await createCoverageTask();

      await writeLedger(2);
      await tasks.completeStepChecked('default', task.num, stepId, undefined, { cause: 'model' });
      // Same ledger, same outstanding set: a real stall, and the ladder
      // must still say so.
      const stalled = holdOf(
        await tasks.completeStepChecked('default', task.num, stepId, undefined, {
          cause: 'model',
        }),
      );
      expect(stalled.escalationStage).toBe(1);
      expect(stalled.message).toContain('GATE_TARGETED_EDIT');
      expect(stalled.message).not.toContain('Progress:');
    });

    // Problem 2: charging converging passes to `maxAttempts` made it a
    // ceiling on CORPUS SIZE. A PR needing more batches than the budget
    // paused for help mid-review however well the reviewer worked.
    it('does not spend the attempt budget while converging', async () => {
      await seedCorpus();
      // Two rejections would exhaust this budget under the old accounting.
      const { task, stepId } = await createCoverageTask(2);

      await writeLedger(2);
      holdOf(
        await tasks.completeStepChecked('default', task.num, stepId, undefined, {
          cause: 'model',
        }),
      );
      expect((await stepOf(task.num, stepId)).gateAttempts).toBe(1);

      await writeLedger(4);
      const batch2 = holdOf(
        await tasks.completeStepChecked('default', task.num, stepId, undefined, {
          cause: 'model',
        }),
      );
      expect(batch2.paused).toBe(false);
      expect((await tasks.get('default', task.num))?.status).toBe('active');
      const mid = await stepOf(task.num, stepId);
      expect(mid.gateAttempts).toBe(1);
      expect(mid.gateProgressAttempts).toBe(1);

      const notes = await tasks.listNotes('default', task.num, stepId);
      expect(
        notes.some((n) => n.text.includes('batch accepted, corpus incomplete (pass 1/24)')),
      ).toBe(true);

      await writeLedger(PATHS.length);
      const done = await tasks.completeStepChecked('default', task.num, stepId, undefined, {
        cause: 'model',
      });
      expect(done.status).toBe('advanced');
    });

    it('charges a stall to the attempt budget even after converging passes', async () => {
      await seedCorpus();
      const { task, stepId } = await createCoverageTask(10);

      await writeLedger(2);
      await tasks.completeStepChecked('default', task.num, stepId, undefined, { cause: 'model' });
      await writeLedger(4);
      await tasks.completeStepChecked('default', task.num, stepId, undefined, { cause: 'model' });
      // Same ledger twice: not converging, so the budget moves again.
      await tasks.completeStepChecked('default', task.num, stepId, undefined, { cause: 'model' });

      const after = await stepOf(task.num, stepId);
      expect(after.gateProgressAttempts).toBe(1);
      expect(after.gateAttempts).toBe(2);
    });

    // Termination is already guaranteed (the count is a non-negative
    // integer that must fall each pass), but "one item per pass across a
    // large corpus" is a runaway to whoever pays for the sessions.
    it('pauses when the progress budget is spent on a loop that creeps', async () => {
      const TOTAL = GATE_MAX_PROGRESS_ATTEMPTS + 2;
      await seedCorpus(TOTAL);
      const { task, stepId } = await createCoverageTask(10);

      let outcome: Awaited<ReturnType<TaskManager['completeStepChecked']>> | undefined;
      for (let covered = 1; covered <= GATE_MAX_PROGRESS_ATTEMPTS + 1; covered++) {
        await writeLedger(covered, TOTAL);
        outcome = await tasks.completeStepChecked('default', task.num, stepId, undefined, {
          cause: 'model',
        });
        if (holdOf(outcome).paused) break;
      }

      expect(holdOf(outcome!).paused).toBe(true);
      expect((await tasks.get('default', task.num))?.status).toBe('paused');
      const step = await stepOf(task.num, stepId);
      expect(step.gateProgressAttempts).toBe(GATE_MAX_PROGRESS_ATTEMPTS);
      // Never a stall — the attempt budget is untouched beyond the opener.
      expect(step.gateAttempts).toBe(1);

      // The resumer must be pointed at throughput, not at a phantom defect.
      const notes = await tasks.listNotes('default', task.num, stepId);
      expect(notes.some((n) => n.text.includes('# Gate progress budget spent'))).toBe(true);
      expect(notes.some((n) => n.text.includes('This is a throughput problem'))).toBe(true);
      expect(notes.some((n) => n.text.includes('# Gate plateau — paused for help'))).toBe(false);
    });
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

describe('completion gates — unsatisfiable under writes-off', () => {
  it('pauses without consuming an attempt when a failing workspace check cannot be repaired', async () => {
    await store.updateProject('default', { managedWorkspaceWritePolicy: 'deny' });
    const task = await tasks.create('default', {
      title: 'Dependency audit',
      description: 'workspace-path deliverable gate on a writes-off project.',
      assignee: { kind: 'user' },
      steps: gatedSteps({
        at: 'completion',
        checks: [{ kind: 'minBytes', file: 'notes/scan.md', bytes: 120 }],
      }),
    });
    const buildId = task.craftbook.steps[0]!.id;

    const outcome = await tasks.completeStepChecked('default', task.num, buildId, undefined, {
      cause: 'model',
    });
    expect(outcome.status).toBe('held');
    if (outcome.status !== 'held') return;
    expect(outcome.gate.paused).toBe(true);
    expect(outcome.gate.unsatisfiable).toBe(true);
    expect(outcome.gate.attempt).toBe(0);
    expect(outcome.gate.message).toContain('workspace writes are OFF');

    const after = await tasks.get('default', task.num);
    expect(after!.status).toBe('paused');
    const step = after!.craftbook.steps[0]!;
    expect(step.completedAt).toBeUndefined();
    expect(step.gateAttempts ?? 0).toBe(0);

    const notes = await tasks.listNotes('default', task.num, buildId);
    expect(notes.some((n) => n.text.includes('Gate unsatisfiable — task paused'))).toBe(true);
    expect(
      notes.some((n) =>
        n.text.includes('Allow built-in tools and background work to modify the workspace'),
      ),
    ).toBe(true);
  });

  it('pauses at activation, before any gezel is dispatched to an unwritable deliverable', async () => {
    // The reactive pause needs an `advance_task_step` call to fire. A
    // stalled gezel never makes one (Pull Request Review: it asked which
    // PR to review and the task sat active), so the step is judged when
    // it activates instead.
    await store.updateProject('default', { managedWorkspaceWritePolicy: 'deny' });
    const task = await tasks.create('default', {
      title: 'Dependency audit',
      description: 'entry step targets a workspace file nobody can write.',
      assignee: { kind: 'user' },
      steps: gatedSteps({
        at: 'completion',
        checks: [{ kind: 'minBytes', file: 'notes/scan.md', bytes: 120 }],
      }),
    });

    expect(task.status).toBe('paused');
    const stored = await tasks.get('default', task.num);
    expect(stored!.status).toBe('paused');
    const notes = await tasks.listNotes('default', task.num, task.craftbook.steps[0]!.id);
    expect(notes.some((n) => n.text.includes('Step unsatisfiable — task paused'))).toBe(true);
    expect(
      notes.some((n) =>
        n.text.includes('Allow built-in tools and background work to modify the workspace'),
      ),
    ).toBe(true);
  });

  it('does not pre-pause a verify-only step whose file already exists', async () => {
    // Writes-off does not make every workspace gate unwinnable: a step
    // that only INSPECTS an existing file can still pass. Only a
    // deliverable that must be created (or changed) is hopeless.
    await writeWorkspaceFile('notes/scan.md', 'x'.repeat(200));
    await store.updateProject('default', { managedWorkspaceWritePolicy: 'deny' });
    const task = await tasks.create('default', {
      title: 'Verify the scan',
      description: 'gate over a file that is already on disk.',
      assignee: { kind: 'user' },
      steps: gatedSteps({
        at: 'completion',
        checks: [{ kind: 'minBytes', file: 'notes/scan.md', bytes: 120 }],
      }),
    });

    expect(task.status).toBe('active');
    const outcome = await tasks.completeStepChecked(
      'default',
      task.num,
      task.craftbook.steps[0]!.id,
      undefined,
      {
        cause: 'model',
      },
    );
    expect(outcome.status).toBe('advanced');
  });

  it('a drawer-targeted gate stays repairable on a writes-off project', async () => {
    await store.updateProject('default', { managedWorkspaceWritePolicy: 'deny' });
    const task = await tasks.create('default', {
      title: 'Threat model',
      description: 'artifact-drawer deliverable gate on a writes-off project.',
      assignee: { kind: 'user' },
      steps: gatedSteps({
        at: 'completion',
        checks: [{ kind: 'minBytes', file: 'reports/threat-model.md', bytes: 120, artifact: true }],
      }),
    });
    const buildId = task.craftbook.steps[0]!.id;

    const outcome = await tasks.completeStepChecked('default', task.num, buildId, undefined, {
      cause: 'model',
    });
    expect(outcome.status).toBe('held');
    if (outcome.status !== 'held') return;
    expect(outcome.gate.unsatisfiable).toBeUndefined();
    expect(outcome.gate.paused).toBe(false);
    expect(outcome.gate.attempt).toBe(1);

    const after = await tasks.get('default', task.num);
    expect(after!.status).not.toBe('paused');
    expect(after!.craftbook.steps[0]!.gateAttempts).toBe(1);
  });

  it('a writable project keeps the ordinary attempt-charging reject path', async () => {
    const task = await tasks.create('default', {
      title: 'Gated build',
      description: 'control: same gate, writable project.',
      assignee: { kind: 'user' },
      steps: gatedSteps({
        at: 'completion',
        checks: [{ kind: 'minBytes', file: 'notes/scan.md', bytes: 120 }],
      }),
    });
    const buildId = task.craftbook.steps[0]!.id;
    const outcome = await tasks.completeStepChecked('default', task.num, buildId, undefined, {
      cause: 'model',
    });
    expect(outcome.status).toBe('held');
    if (outcome.status !== 'held') return;
    expect(outcome.gate.unsatisfiable).toBeUndefined();
    expect(outcome.gate.attempt).toBe(1);
  });

  it('fires the needs-help hook with gate_unsatisfiable on the policy pause', async () => {
    await store.updateProject('default', { managedWorkspaceWritePolicy: 'deny' });
    const events: { reason: string; ref: string; stepId?: string }[] = [];
    tasks.setTaskNeedsHelpHook(({ task, reason, stepId }) => {
      events.push({ reason, ref: task.ref, ...(stepId ? { stepId } : {}) });
    });
    const task = await tasks.create('default', {
      title: 'Dependency audit',
      description: 'needs-help hook coverage for the unsatisfiable pause.',
      assignee: { kind: 'user' },
      steps: gatedSteps({
        at: 'completion',
        checks: [{ kind: 'minBytes', file: 'notes/scan.md', bytes: 120 }],
      }),
    });
    const buildId = task.craftbook.steps[0]!.id;
    await tasks.completeStepChecked('default', task.num, buildId, undefined, { cause: 'model' });
    expect(events).toEqual([{ reason: 'gate_unsatisfiable', ref: task.ref, stepId: buildId }]);
  });

  it('fires the needs-help hook with gate_exhausted when the budget is spent', async () => {
    const events: string[] = [];
    tasks.setTaskNeedsHelpHook(({ reason }) => {
      events.push(reason);
    });
    const task = await tasks.create('default', {
      title: 'Gated build',
      description: 'needs-help hook coverage for the exhausted pause.',
      assignee: { kind: 'user' },
      steps: gatedSteps({
        at: 'completion',
        checks: [{ kind: 'minBytes', file: 'notes/scan.md', bytes: 120 }],
        maxAttempts: 1,
      }),
    });
    const buildId = task.craftbook.steps[0]!.id;
    const outcome = await tasks.completeStepChecked('default', task.num, buildId, undefined, {
      cause: 'model',
    });
    expect(outcome.status).toBe('held');
    if (outcome.status !== 'held') return;
    expect(outcome.gate.paused).toBe(true);
    expect(events).toEqual(['gate_exhausted']);
  });

  /**
   * A gate SCRIPT names no file, so "a script rejected" is not by itself
   * evidence that a workspace write was needed. Pull Request Review's scope
   * step is gated on a TASK NOTE: the note was written correctly, the gate
   * rejected for an unrelated reason, and the task paused telling the user
   * to enable workspace writes — a fix that would have changed nothing.
   */
  function rejectingScriptRunner(): Parameters<TaskManager['setScriptRunner']>[0] {
    return {
      run: async () => ({
        id: 'run-1',
        projectId: 'default',
        scriptName: 'checkTaskNoteContains',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        status: 'ok' as const,
        trigger: { kind: 'manual' as const },
        inputs: {},
        output: { decision: 'reject', message: 'The note does not match the pattern.' },
        calls: [],
        logs: '',
      }),
    } as unknown as Parameters<TaskManager['setScriptRunner']>[0];
  }

  it('keeps a note-only script gate repairable on a writes-off project', async () => {
    const task = await tasks.create('default', {
      title: 'Map the corpus',
      description: 'script gate over a task note, no workspace deliverable.',
      assignee: { kind: 'user' },
      steps: gatedSteps({
        at: 'completion',
        scripts: [{ name: 'checkTaskNoteContains', scope: 'standard' }],
      }),
    });
    const buildId = task.craftbook.steps[0]!.id;
    // Flip the policy AFTER creation: the activation pre-check would
    // otherwise never let a writes-off task reach its completion gate.
    await store.updateProject('default', { managedWorkspaceWritePolicy: 'deny' });
    tasks.setScriptRunner(rejectingScriptRunner());

    const outcome = await tasks.completeStepChecked('default', task.num, buildId, undefined, {
      cause: 'model',
    });
    expect(outcome.status).toBe('held');
    if (outcome.status !== 'held') return;
    expect(outcome.gate.unsatisfiable).toBeUndefined();
    expect(outcome.gate.paused).toBe(false);
    expect(outcome.gate.attempt).toBe(1);
    expect(outcome.gate.message).not.toContain('workspace writes are OFF');

    const after = await tasks.get('default', task.num);
    expect(after!.status).not.toBe('paused');
  });

  it('still pauses a script gate whose step owes an unwritable workspace file', async () => {
    const task = await tasks.create('default', {
      title: 'Synthesize the review',
      description: 'script gate on a step whose deliverable is a workspace file.',
      assignee: { kind: 'user' },
      steps: [
        {
          name: 'Report',
          assignee: { kind: 'user' } as const,
          advanceWhen: { file: 'pr-review.md', minBytes: 500 } as never,
          gate: {
            at: 'completion',
            scripts: [{ name: 'checkTaskNoteContains', scope: 'standard' }],
          } as never,
        },
        { name: 'Done', assignee: { kind: 'user' } as const },
      ],
    });
    const buildId = task.craftbook.steps[0]!.id;
    await store.updateProject('default', { managedWorkspaceWritePolicy: 'deny' });
    tasks.setScriptRunner(rejectingScriptRunner());

    const outcome = await tasks.completeStepChecked('default', task.num, buildId, undefined, {
      cause: 'model',
    });
    expect(outcome.status).toBe('held');
    if (outcome.status !== 'held') return;
    expect(outcome.gate.unsatisfiable).toBe(true);
    expect(outcome.gate.attempt).toBe(0);
    expect(outcome.gate.message).toContain('pr-review.md');
  });
});

/**
 * A gate SCRIPT's inputs are opaque to the runtime: it can read the task
 * notes, an artifact the step never declared, anything. Everything the
 * gate machinery infers from the step's declarative shape alone is
 * therefore a guess, and these are the two places that guess was wrong.
 */
describe('completion gates — scripted gates', () => {
  /**
   * Pull Request Review's `scope` gate, reproduced: the `advanceWhen`
   * deliverable is a batch file the runtime publishes onEnter and the
   * prompt forbids touching, and the only rejecting check is a script
   * reading the TASK NOTE. The repeat-reject damper hashes the
   * deliverable alone, so on the real run the hash never moved, the
   * cached rejection was replayed three times without the script ever
   * running again, and the ladder paused the task on a verdict that was
   * false by the time it was shown.
   */
  function flippingScriptRunner(decisions: readonly ('approve' | 'reject')[]) {
    const calls: number[] = [];
    let i = 0;
    const runner = {
      run: async () => {
        const decision = decisions[Math.min(i, decisions.length - 1)]!;
        i += 1;
        calls.push(i);
        return {
          id: `run-${i}`,
          projectId: 'default',
          scriptName: 'checkTaskNoteContains',
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          status: 'ok' as const,
          trigger: { kind: 'manual' as const },
          inputs: {},
          output:
            decision === 'approve'
              ? { decision: 'approve', message: 'task notes match' }
              : { decision: 'reject', message: 'The task notes do not yet contain the header.' },
          calls: [],
          logs: '',
        };
      },
    } as unknown as Parameters<TaskManager['setScriptRunner']>[0];
    return { runner, runCount: () => calls.length };
  }

  async function scopeShapedTask(): Promise<{ task: Task; stepId: string }> {
    await writeArtifactFile('pr-review/batches.json', '{"batches":[1,2,3]}');
    const task = await tasks.create('default', {
      title: 'Map the pull request corpus',
      description: 'runtime-published deliverable, note-judging script gate.',
      assignee: { kind: 'user' },
      steps: [
        {
          name: 'Scope',
          assignee: { kind: 'user' } as const,
          advanceWhen: {
            file: 'pr-review/batches.json',
            minBytes: 2,
            artifact: true,
          } as never,
          gate: {
            at: 'completion',
            scripts: [{ name: 'checkTaskNoteContains', scope: 'standard' }],
            maxAttempts: 3,
          } as never,
        },
        { name: 'Done', assignee: { kind: 'user' } as const },
      ],
    });
    return { task, stepId: task.craftbook.steps[0]!.id };
  }

  it('re-runs a gate script when the unchanged deliverable is not what it judges', async () => {
    const { task, stepId } = await scopeShapedTask();
    const { runner, runCount } = flippingScriptRunner(['reject', 'approve']);
    tasks.setScriptRunner(runner);

    const first = await tasks.completeStepChecked('default', task.num, stepId, undefined, {
      cause: 'model',
    });
    expect(first.status).toBe('held');
    expect(runCount()).toBe(1);

    // The deliverable is byte-identical — the model repaired the note the
    // script reads, which the damper's hash cannot see. It must re-run.
    const second = await tasks.completeStepChecked('default', task.num, stepId, undefined, {
      cause: 'model',
    });
    expect(runCount()).toBe(2);
    expect(second.status).toBe('advanced');
  });

  it('never damps a scripted gate into a cached verdict', async () => {
    const { task, stepId } = await scopeShapedTask();
    const { runner, runCount } = flippingScriptRunner(['reject']);
    tasks.setScriptRunner(runner);

    for (let i = 0; i < 2; i++) {
      const outcome = await tasks.completeStepChecked('default', task.num, stepId, undefined, {
        cause: 'model',
      });
      expect(outcome.status).toBe('held');
      if (outcome.status !== 'held') return;
      expect(outcome.gate.cached).toBe(false);
      expect(outcome.gate.attempt).toBe(i + 1);
    }
    expect(runCount()).toBe(2);
    const step = (await tasks.get('default', task.num))!.craftbook.steps.find(
      (s) => s.id === stepId,
    )!;
    expect(step.gateAttemptHistory?.some((e) => e.frozen)).toBeFalsy();
    expect(step.lastGateReject?.contentHash).toBeUndefined();
  });

  it('aims a script-only rejection at the task record, not the passing deliverable', async () => {
    const { task, stepId } = await scopeShapedTask();
    const { runner } = flippingScriptRunner(['reject']);
    tasks.setScriptRunner(runner);

    // Attempt 1 is stage 0 (the gate's own verdict); attempt 2 shares the
    // failing signature and climbs to the stage-1 directive.
    await tasks.completeStepChecked('default', task.num, stepId, undefined, { cause: 'model' });
    const second = await tasks.completeStepChecked('default', task.num, stepId, undefined, {
      cause: 'model',
    });
    expect(second.status).toBe('held');
    if (second.status !== 'held') return;
    expect(second.gate.escalationStage).toBe(1);
    expect(second.gate.message).toContain('This gate reads the task record, not a file');
    expect(second.gate.message).toContain('write_task_note');
    // The batch file passes every check — never name it as the repair target.
    expect(second.gate.message).not.toContain('batches.json');
    expect(second.gate.message).not.toContain('write_artifact');

    // Stage 2's whole-file rewrite has no meaning here; it must stay at 1.
    const third = await tasks.completeStepChecked('default', task.num, stepId, undefined, {
      cause: 'model',
    });
    expect(third.status).toBe('held');
    if (third.status !== 'held') return;
    expect(third.gate.message).not.toContain('GATE_FULL_REWRITE');
  });
});

describe('completion gates — draft overlay', () => {
  async function draftingTask(gate: unknown) {
    const task = await tasks.create(
      'default',
      {
        title: 'Drafted change',
        description: 'A drafting task whose gate must judge the proposed tree.',
        assignee: { kind: 'user' },
        steps: gatedSteps(gate),
      },
      { draftsDiffpack: true },
    );
    expect(task.diffpackId).toBe(String(task.num));
    return task;
  }

  it('approves a deliverable that exists only in the draft overlay', async () => {
    const { DiffpackDraftStore } = await import('../diffpack/draft-store.js');
    const drafts = new DiffpackDraftStore(store);
    tasks.setDraftReader(drafts);
    const task = await draftingTask({
      at: 'completion',
      checks: [{ kind: 'minBytes', file: 'index.html', bytes: 100 }],
    });
    await drafts.write('default', task.diffpackId!, 'index.html', 'x'.repeat(200));

    const outcome = await tasks.completeStepChecked(
      'default',
      task.num,
      task.craftbook.steps[0]!.id,
    );
    expect(outcome.status).toBe('advanced');
  });

  it('rejects on the DRAFTED content of a file the workspace copy would pass', async () => {
    const { DiffpackDraftStore } = await import('../diffpack/draft-store.js');
    const drafts = new DiffpackDraftStore(store);
    tasks.setDraftReader(drafts);
    const task = await draftingTask({
      at: 'completion',
      checks: [{ kind: 'contains', file: 'src/app.js', pattern: 'MARKER' }],
    });
    // The real workspace file satisfies the check; the draft rewrote it and
    // dropped the marker. A workspace-reading gate would falsely approve.
    await writeWorkspaceFile('src/app.js', 'const MARKER = 1;\n');
    await drafts.write('default', task.diffpackId!, 'src/app.js', 'const other = 2;\n');

    const outcome = await tasks.completeStepChecked(
      'default',
      task.num,
      task.craftbook.steps[0]!.id,
    );
    expect(outcome.status).toBe('held');
  });

  it('lists (workspace minus proposed deletions) plus drafted paths', async () => {
    const { DiffpackDraftStore } = await import('../diffpack/draft-store.js');
    const drafts = new DiffpackDraftStore(store);
    tasks.setDraftReader(drafts);
    const task = await draftingTask({
      at: 'completion',
      checks: [{ kind: 'fileCount', ext: ['.html'], min: 2 }],
    });
    // Workspace: two .html files. Draft: deletes one, adds two new ones.
    // Overlay listing = 2 - 1 + 2 = 3 → min 2 passes; a deletions-blind
    // listing that missed drafted paths would count only the workspace pair.
    await writeWorkspaceFile('a.html', '<p>a</p>');
    await writeWorkspaceFile('b.html', '<p>b</p>');
    await drafts.delete('default', task.diffpackId!, 'b.html');
    await drafts.write('default', task.diffpackId!, 'c.html', '<p>c</p>');
    await drafts.write('default', task.diffpackId!, 'd.html', '<p>d</p>');

    const ws = tasks.gateWorkspaceReader('default', {
      ref: task.ref,
      diffpackId: task.diffpackId,
    });
    const listed = await ws.list();
    expect(listed).toContain('a.html');
    expect(listed).toContain('c.html');
    expect(listed).toContain('d.html');
    expect(listed).not.toContain('b.html');

    const outcome = await tasks.completeStepChecked(
      'default',
      task.num,
      task.craftbook.steps[0]!.id,
    );
    expect(outcome.status).toBe('advanced');
  });

  it('falls back to the real workspace (with a warning) when no draft reader is wired', async () => {
    const task = await draftingTask({
      at: 'completion',
      checks: [{ kind: 'minBytes', file: 'real.txt', bytes: 5 }],
    });
    await writeWorkspaceFile('real.txt', 'workspace content');
    const outcome = await tasks.completeStepChecked(
      'default',
      task.num,
      task.craftbook.steps[0]!.id,
    );
    expect(outcome.status).toBe('advanced');
  });
});

describe('delivery-mode resolution (diffpackCapable)', () => {
  function installCapableBook(opts: { file: string; diffpackCapable?: boolean }) {
    tasks.setCraftbookResolver({
      async resolve(id: string) {
        return {
          craftbook: {
            id,
            name: 'Fix a bug',
            ...(opts.diffpackCapable === false ? {} : { diffpackCapable: true }),
            steps: [
              {
                id: 'fix',
                name: 'Fix',
                gate: {
                  at: 'completion',
                  checks: [{ kind: 'contains', file: opts.file, pattern: 'MARKER' }],
                },
                next: 'done',
              },
              { id: 'done', name: 'Done', terminal: true },
            ],
            entryStepId: 'fix',
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
          },
          sourceId: 'bundled',
        } as never;
      },
    });
  }

  it('propose mode stamps diffpackId on a capable book and records the capability', async () => {
    installCapableBook({ file: 'src/x.js' });
    const task = await tasks.create('default', {
      title: 'Fix it',
      description: 'Propose-mode run of a diffpackCapable catalog book.',
      assignee: { kind: 'user' },
      craftbookId: 'bug-fix',
      deliveryMode: 'propose',
    });
    expect(task.diffpackId).toBe(String(task.num));
    expect(task.craftbook.diffpackCapable).toBe(true);
  });

  it('rejects propose mode on a book that is not diffpackCapable', async () => {
    installCapableBook({ file: 'src/x.js', diffpackCapable: false });
    await expect(
      tasks.create('default', {
        title: 'Fix it',
        description: 'Propose-mode request against a book without the capability.',
        assignee: { kind: 'user' },
        craftbookId: 'bug-fix',
        deliveryMode: 'propose',
      }),
    ).rejects.toThrow(/not diffpackCapable/);
  });

  it('auto mode proposes for an unattended (night-shift) run', async () => {
    installCapableBook({ file: 'src/x.js' });
    const task = await tasks.create('default', {
      title: 'Nightly fix',
      description: 'Auto delivery mode on an unattended run drafts a proposal.',
      assignee: { kind: 'user' },
      craftbookId: 'bug-fix',
      nightShift: { enabled: true },
    });
    expect(task.diffpackId).toBe(String(task.num));
  });

  it('auto mode proposes when the crew holds no workspace write grant', async () => {
    installCapableBook({ file: 'src/x.js' });
    await store.updateProject('default', { managedWorkspaceWritePolicy: 'deny' });
    const task = await tasks.create('default', {
      title: 'Fix on locked workspace',
      description: 'Auto delivery mode drafts when the workspace is not writable.',
      assignee: { kind: 'user' },
      craftbookId: 'bug-fix',
    });
    expect(task.diffpackId).toBe(String(task.num));
  });

  it('auto mode edits in place for an attended run on a writable workspace', async () => {
    installCapableBook({ file: 'src/x.js' });
    const task = await tasks.create('default', {
      title: 'Attended fix',
      description: 'Auto delivery mode edits directly when someone is watching.',
      assignee: { kind: 'user' },
      craftbookId: 'bug-fix',
    });
    expect(task.diffpackId).toBeUndefined();
  });

  it('edit mode never overrides a service draftsDiffpack binding', async () => {
    installCapableBook({ file: 'src/x.js' });
    const task = await tasks.create(
      'default',
      {
        title: 'Night host',
        description: 'A caller-owned drafting binding survives an edit-mode request.',
        assignee: { kind: 'user' },
        craftbookId: 'bug-fix',
        deliveryMode: 'edit',
      },
      { draftsDiffpack: true },
    );
    expect(task.diffpackId).toBe(String(task.num));
  });

  it('the same book clears its gate identically in edit and propose modes', async () => {
    const { DiffpackDraftStore } = await import('../diffpack/draft-store.js');
    const drafts = new DiffpackDraftStore(store);
    tasks.setDraftReader(drafts);
    const CONTENT = 'const MARKER = "fixed";\n';

    installCapableBook({ file: 'src/mode-a.js' });
    const proposeTask = await tasks.create('default', {
      title: 'Propose run',
      description: 'Mode-agnostic book run in propose mode judges the draft.',
      assignee: { kind: 'user' },
      craftbookId: 'bug-fix',
      deliveryMode: 'propose',
    });
    await drafts.write('default', proposeTask.diffpackId!, 'src/mode-a.js', CONTENT);
    const proposeOutcome = await tasks.completeStepChecked('default', proposeTask.num, 'fix');
    expect(proposeOutcome.status).toBe('advanced');
    // The proposal never touched the project.
    expect(await store.readProjectWorkspaceFile('default', 'src/mode-a.js')).toBeNull();

    installCapableBook({ file: 'src/mode-b.js' });
    const editTask = await tasks.create('default', {
      title: 'Edit run',
      description: 'Mode-agnostic book run in edit mode judges the workspace.',
      assignee: { kind: 'user' },
      craftbookId: 'bug-fix',
      deliveryMode: 'edit',
    });
    expect(editTask.diffpackId).toBeUndefined();
    await writeWorkspaceFile('src/mode-b.js', CONTENT);
    const editOutcome = await tasks.completeStepChecked('default', editTask.num, 'fix');
    expect(editOutcome.status).toBe('advanced');
  });

  it('a sealed and applied proposal lands the same bytes an edit run writes', async () => {
    const { DiffpackDraftStore } = await import('../diffpack/draft-store.js');
    const { DiffpackManager } = await import('../diffpack/manager.js');
    const drafts = new DiffpackDraftStore(store);
    tasks.setDraftReader(drafts);
    const CONTENT = 'const MARKER = "equivalent";\n';

    installCapableBook({ file: 'src/apply-me.js' });
    const task = await tasks.create('default', {
      title: 'Propose then apply',
      description: 'Applying the sealed proposal reproduces the edit-mode result.',
      assignee: { kind: 'user' },
      craftbookId: 'bug-fix',
      deliveryMode: 'propose',
    });
    await drafts.write('default', task.diffpackId!, 'src/apply-me.js', CONTENT);
    expect((await tasks.completeStepChecked('default', task.num, 'fix')).status).toBe('advanced');

    const diffpacks = new DiffpackManager({ home, store, tasks });
    await diffpacks.ensureForDraft('default', task.diffpackId!);
    const sealed = await diffpacks.seal('default', task.diffpackId!);
    expect(sealed.status).toBe('ready');
    expect(sealed.files.map((f) => f.path)).toEqual(['src/apply-me.js']);

    await diffpacks.apply('default', task.diffpackId!);
    expect(await store.readProjectWorkspaceFile('default', 'src/apply-me.js')).toBe(CONTENT);
  });
});

describe('completion gates — commandEvidence receipts', () => {
  it('verifies runs by task/step attribution and activation window', async () => {
    const { HistoryManager } = await import('../history/manager.js');
    const history = new HistoryManager(home);
    tasks = new TaskManager(store, history);
    tasks.setScriptRunner(new ScriptRunner({ store, chat }));

    const task = await tasks.create('default', {
      title: 'Fix with proof',
      description: 'A commandEvidence gate reads the run receipts, not claims.',
      assignee: { kind: 'user' },
      steps: gatedSteps({
        at: 'completion',
        checks: [{ kind: 'commandEvidence', script: 'test', expect: 'pass' }],
      }),
    });
    const buildId = task.craftbook.steps[0]!.id;
    const receipt = (details: Record<string, unknown>) =>
      history.log({
        kind: 'workspace.script.run',
        projectId: 'default',
        summary: 'Ran npm run test',
        details: { name: 'test', args: [], durationMs: 10, timedOut: false, ...details },
      });

    // No receipt at all → prescriptive reject.
    const none = await tasks.completeStepChecked('default', task.num, buildId);
    expect(none.status).toBe('held');
    if (none.status === 'held') {
      expect(none.gate.message).toMatch(/No `npm run test` run was observed/);
    }

    // A receipt from ANOTHER task/step must not count.
    await receipt({ exitCode: 0, taskRef: 'default/999', stepId: buildId });
    await receipt({ exitCode: 0, taskRef: task.ref, stepId: 'other-step' });
    // Nor an unattributed one (ad-hoc chat run).
    await receipt({ exitCode: 0 });
    const foreign = await tasks.completeStepChecked('default', task.num, buildId);
    expect(foreign.status).toBe('held');

    // A failing attributed run → reject naming the exit code.
    await receipt({
      exitCode: 1,
      taskRef: task.ref,
      stepId: buildId,
      stderrTail: '2 tests failed',
    });
    const failing = await tasks.completeStepChecked('default', task.num, buildId);
    expect(failing.status).toBe('held');
    if (failing.status === 'held') {
      expect(failing.gate.message).toMatch(/exit 1/);
      expect(failing.gate.message).toMatch(/2 tests failed/);
    }

    // A later passing attributed run → the latest wins, gate advances.
    await receipt({ exitCode: 0, taskRef: task.ref, stepId: buildId });
    const passing = await tasks.completeStepChecked('default', task.num, buildId);
    expect(passing.status).toBe('advanced');
  });

  it('defers with a note on a drafting task', async () => {
    const { HistoryManager } = await import('../history/manager.js');
    const history = new HistoryManager(home);
    tasks = new TaskManager(store, history);
    tasks.setScriptRunner(new ScriptRunner({ store, chat }));

    const task = await tasks.create(
      'default',
      {
        title: 'Propose with deferred proof',
        description: 'commandEvidence defers honestly while drafting a proposal.',
        assignee: { kind: 'user' },
        steps: gatedSteps({
          at: 'completion',
          checks: [{ kind: 'commandEvidence', script: 'test', expect: 'pass' }],
        }),
      },
      { draftsDiffpack: true },
    );
    const outcome = await tasks.completeStepChecked(
      'default',
      task.num,
      task.craftbook.steps[0]!.id,
    );
    expect(outcome.status).toBe('advanced');
  });
});
