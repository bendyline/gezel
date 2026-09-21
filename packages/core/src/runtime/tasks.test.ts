import { describe, expect, it, vi } from 'vitest';
import { CraftbookSchema } from '../schemas/craftbook.js';
import { TaskSchema } from '../schemas/task.js';
import {
  type PortableFileEntry,
  type PortableFileSystem,
  encodeText,
  validatePortablePath,
} from './files.js';
import { PortableStore } from './store.js';
import { evaluatePortableTaskGate } from './task-gates.js';
import { PortableTaskRunner } from './task-routes.js';
import { taskActiveAssignee } from './tasks.js';

class MemoryFiles implements PortableFileSystem {
  readonly entries = new Map<string, Uint8Array | null>([['', null]]);
  fault: ((operation: string, path: string) => boolean) | undefined;
  private check(op: string, path: string) {
    validatePortablePath(path, op === 'list' || op === 'mkdir');
    if (this.fault?.(op, path)) throw new Error('Disk unavailable');
  }
  async read(path: string) {
    this.check('read', path);
    const value = this.entries.get(path);
    if (value === null) throw new Error('Cannot read directory');
    return value?.slice() ?? null;
  }
  async write(path: string, data: Uint8Array) {
    this.check('write', path);
    const slash = path.lastIndexOf('/');
    const parent = slash < 0 ? '' : path.slice(0, slash);
    if (this.entries.get(parent) !== null) throw new Error('Parent missing');
    if (this.entries.get(path) === null) throw new Error('Cannot replace directory');
    this.entries.set(path, data.slice());
  }
  async list(path: string): Promise<PortableFileEntry[]> {
    this.check('list', path);
    if (this.entries.get(path) !== null) throw new Error('Directory missing');
    const prefix = path ? `${path}/` : '';
    return [...this.entries].flatMap(([key, value]) => {
      const name = key.slice(prefix.length);
      return key.startsWith(prefix) && name && !name.includes('/')
        ? [
            {
              name,
              isDirectory: value === null,
              size: value?.byteLength ?? 0,
              mtime: Date.parse('2026-09-20T12:00:00Z'),
            },
          ]
        : [];
    });
  }
  async mkdir(path: string) {
    this.check('mkdir', path);
    let current = '';
    for (const part of path.split('/').filter(Boolean)) {
      current = current ? `${current}/${part}` : part;
      if (this.entries.has(current) && this.entries.get(current) !== null)
        throw new Error('File blocks directory');
      this.entries.set(current, null);
    }
  }
  async remove(path: string) {
    this.check('remove', path);
    for (const key of this.entries.keys())
      if (key === path || key.startsWith(`${path}/`)) this.entries.delete(key);
  }
  async rename(from: string, to: string) {
    this.check('rename', from);
    validatePortablePath(to);
    if (!this.entries.has(from) || this.entries.has(to)) throw new Error('Invalid rename');
    for (const [key, value] of [...this.entries])
      if (key === from || key.startsWith(`${from}/`)) {
        this.entries.set(`${to}${key.slice(from.length)}`, value);
        this.entries.delete(key);
      }
  }
}
function fixture() {
  const files = new MemoryFiles();
  let id = 0;
  const options = { files, createId: () => `generated-${++id}`, now: () => '2026-09-20T12:00:00Z' };
  return { files, options, store: new PortableStore(options) };
}

const brief = 'Read the project brief and produce a concise report with evidence.';
const input = {
  title: 'Project report',
  description: brief,
  steps: [{ name: 'Draft report' }, { name: 'Review report', terminal: true }],
};

describe('portable ordinary task lifecycle', () => {
  it('persists ordinary task/about/notes files, assigns monotonic numbers and restores them', async () => {
    const { store, files, options } = fixture();
    await store.ensureLayout();
    const [first, second] = await Promise.all([
      store.createTask('default', input),
      store.createTask('default', input),
    ]);
    expect([first.num, second.num]).toEqual([1, 2]);
    expect(TaskSchema.parse(first).artifactDir).toBe('tasks/1');
    expect(first.craftbook.steps[0]?.next).toBe('review-report');
    expect(files.entries.has('projects/default/tasks/1/task.json')).toBe(true);
    expect(new TextDecoder().decode(files.entries.get('projects/default/tasks/1/about.md')!)).toBe(
      brief,
    );
    expect(
      JSON.parse(new TextDecoder().decode(files.entries.get('projects/default/tasks/1/task.json')!))
        .description,
    ).toBeUndefined();
    const note = await store.appendTaskNote(first.ref, 'A useful observation', first.activeStepId);
    const reopened = new PortableStore(options);
    expect((await reopened.getTask(first.ref))?.description).toBe(brief);
    expect(await reopened.listTaskNotes(first.ref)).toEqual([note]);
    expect(await reopened.listTasks({ projectId: 'default', status: 'active' })).toHaveLength(2);
  });
  it('starts project, crew and task in one journal; a failed precommit creates none', async () => {
    const { store, files } = fixture();
    await store.ensureLayout();
    const leadGezelId = (await store.readConfig()).meesterGezelId!;
    files.fault = (op, path) =>
      op === 'write' && path.startsWith('.transactions/') && !path.endsWith('pending.json');
    await expect(
      store.startProject({ name: 'Atomic workshop', leadGezelId, taskDescription: brief }),
    ).rejects.toThrow('Disk unavailable');
    files.fault = undefined;
    expect(await store.getProject('atomic-workshop')).toBeNull();
    const result = await store.startProject({
      name: 'Atomic workshop',
      leadGezelId,
      taskDescription: brief,
    });
    expect(result.project.gezelIds).toEqual([leadGezelId]);
    expect(result.project.voormanGezelId).toBe(leadGezelId);
    expect(result.task.ref).toBe('atomic-workshop/1');
    expect(await store.getTask(result.task.ref)).toEqual(result.task);
  });
  it('shares JSON Schema defaults, required inputs and runtime-token interpolation with desktop', async () => {
    const { store } = fixture();
    await store.ensureLayout();
    const book = CraftbookSchema.parse({
      id: 'report-book',
      name: 'Report book',
      createdAt: '2026-09-20T12:00:00Z',
      updatedAt: '2026-09-20T12:00:00Z',
      entryStepId: 'write',
      paramSchema: {
        type: 'object',
        required: ['topic'],
        properties: {
          workPath: { type: 'string', default: '{{task.dir}}' },
          report: { type: 'string', default: '{{workPath}}/report.md' },
          retries: { type: 'number', default: 2 },
        },
      },
      steps: [
        {
          id: 'write',
          name: 'Write',
          terminal: true,
          prompt: '{{topic}} to {{report}}; {{task.ref}} / {{task.projectId}} / {{task.num}}',
          gate: {
            at: 'completion',
            checks: [{ kind: 'minBytes', artifact: true, file: '{{report}}', bytes: 1 }],
          },
        },
      ],
    });
    await expect(
      store.createTask('default', { ...input, steps: undefined, craftbookId: book.id }, book),
    ).rejects.toThrow('requires invocation parameter');
    const task = await store.createTask(
      'default',
      {
        ...input,
        steps: undefined,
        craftbookId: book.id,
        craftbookParams: { topic: 'Literal {{example}}', 'task.dir': 'spoofed' },
      },
      book,
    );
    expect(task.craftbook.steps[0]?.prompt).toBe(
      'Literal {{example}} to tasks/1/report.md; default/1 / default / 1',
    );
    expect(task.craftbookParams).toMatchObject({
      workPath: 'tasks/1',
      report: 'tasks/1/report.md',
      retries: '2',
      topic: 'Literal {{example}}',
    });
    expect(task.craftbook.steps[0]?.gate?.checks?.[0]).toMatchObject({ file: 'tasks/1/report.md' });
    expect(book.steps[0]?.prompt).toContain('{{topic}}');
    const fromForm = await store.createTask(
      'default',
      {
        ...input,
        steps: undefined,
        craftbookId: book.id,
        craftbookParams: { topic: 'Form value', workPath: '{{task.dir}}' },
      },
      book,
    );
    expect(fromForm.craftbookParams?.report).toBe('tasks/2/report.md');
  });
  it('resolves each active specialist, preserves the owner and allows existing explicit jump targets', async () => {
    const { store, options } = fixture();
    await store.ensureLayout();
    const planner = await store.createGezel({
      name: 'Planner',
      role: 'Planner',
      about: 'Plan the work.',
    });
    const writer = await store.createGezel({
      name: 'Writer',
      role: 'Writer',
      about: 'Write the work.',
    });
    const resolveStepRole = vi.fn(async (_project: string, role: string) =>
      role === 'Planner' ? planner.id : writer.id,
    );
    const runStep = vi.fn(async (_task: import('../schemas/task.js').Task) => {});
    const runner = new PortableTaskRunner({ store, runStep, resolveStepRole });
    const created = await runner.route('POST', '/api/projects/default/tasks', {
      ...input,
      assignee: { kind: 'gezel', gezelId: planner.id },
      steps: [
        { id: 'plan', name: 'Plan', suggestedRole: 'Planner', next: 'rewrite' },
        { id: 'rewrite', name: 'Rewrite', suggestedRole: 'Writer', next: 'evaluate' },
        { id: 'evaluate', name: 'Evaluate', suggestedRole: 'Planner', next: 'rewrite' },
        {
          id: 'finish',
          name: 'Finish',
          terminal: true,
          assignee: { kind: 'user' },
          suggestedRole: 'Writer',
        },
      ],
    });
    const task = TaskSchema.parse(await created!.json());
    expect(taskActiveAssignee(task)).toEqual({ kind: 'gezel', gezelId: planner.id });
    const writing = await runner.complete(task.ref, 'plan');
    expect(taskActiveAssignee(writing.task)).toEqual({ kind: 'gezel', gezelId: writer.id });
    expect(writing.task.assignee).toEqual({ kind: 'gezel', gezelId: planner.id });
    await runner.run(task.ref);
    await vi.waitFor(() => expect(runner.isBusy()).toBe(false));
    expect(taskActiveAssignee(runStep.mock.calls[0]![0])).toEqual({
      kind: 'gezel',
      gezelId: writer.id,
    });
    await runner.complete(task.ref, 'rewrite');
    const finished = await runner.complete(task.ref, 'evaluate', 'finish');
    expect(finished.task.activeStepId).toBe('finish');
    expect(taskActiveAssignee(finished.task)).toEqual({ kind: 'user' });
    expect(
      (await new PortableStore(options).getTask(task.ref))?.craftbook.steps[1]?.suggestedGezelId,
    ).toBe(writer.id);
    expect(resolveStepRole.mock.calls.map((call) => call[1])).toEqual([
      'Planner',
      'Writer',
      'Planner',
    ]);
    expect((await runner.complete(task.ref, 'finish')).task.status).toBe('complete');
  });
  it('holds failed gates, pauses after bounded rejection and requires declared transitions', async () => {
    const { store } = fixture();
    await store.ensureLayout();
    const task = await store.createTask('default', {
      ...input,
      steps: [
        {
          name: 'Deliver',
          terminal: true,
          gate: {
            at: 'completion',
            checks: [{ kind: 'minBytes', file: 'report.md', bytes: 5 }],
            maxAttempts: 2,
          },
        },
      ],
    });
    await expect(store.completeTaskStep(task.ref, task.activeStepId!)).rejects.toThrow(
      'completion check',
    );
    const rejected = await store.completeTaskStep(task.ref, task.activeStepId!, {
      gate: { approved: false, message: 'Report missing' },
    });
    expect(rejected.gate?.paused).toBe(false);
    expect(rejected.task.craftbook.steps[0]?.completedAt).toBeUndefined();
    const paused = await store.completeTaskStep(task.ref, task.activeStepId!, {
      gate: { approved: false },
    });
    expect(paused.task.status).toBe('paused');
    await expect(store.setTaskStatus(task.ref, 'complete')).rejects.toThrow('gates first');
    await store.setTaskStatus(task.ref, 'active');
    await expect(
      store.completeTaskStep(task.ref, task.activeStepId!, {
        gate: { approved: true },
        next: 'invented',
      }),
    ).rejects.toThrow('does not declare');
    const done = await store.completeTaskStep(task.ref, task.activeStepId!, {
      gate: { approved: true },
    });
    expect(done.task.status).toBe('complete');
    await expect(store.setTaskStatus(task.ref, 'active')).rejects.toThrow('Create a new task');
  });
  it('does not accept a gate verdict about a concurrently edited task', async () => {
    const { store } = fixture();
    await store.ensureLayout();
    const task = await store.createTask('default', input);
    await store.updateTask(task.ref, { title: 'Changed deliverable' });
    await expect(
      store.completeTaskStep(task.ref, task.activeStepId!, { expectedTask: task }),
    ).rejects.toThrow('changed during');
    expect((await store.getTask(task.ref))?.activeStepId).toBe(task.activeStepId);
  });
  it('records work before execution and pauses interrupted steps without replay', async () => {
    const { store, options } = fixture();
    await store.ensureLayout();
    const task = await store.createTask('default', input);
    await store.beginTaskRun(task.ref);
    await expect(store.beginTaskRun(task.ref)).rejects.toThrow('already running');
    const reopened = new PortableStore(options);
    const runStep = vi.fn();
    const runner = new PortableTaskRunner({ store: reopened, runStep });
    await runner.initialize();
    expect(runStep).not.toHaveBeenCalled();
    expect((await reopened.getTask(task.ref))?.status).toBe('paused');
    expect(await reopened.recoverTasks()).toEqual([]);
    await reopened.setTaskStatus(task.ref, 'active');
    const retry = await reopened.beginTaskRun(task.ref);
    expect(retry.task.craftbook.steps[0]?.attemptCount).toBe(2);
    await reopened.finishTaskRun(task.ref, retry.runId);
    expect((await reopened.getTask(task.ref))?.status).toBe('active');
  });
  it('returns before foreground execution completes and records a failed attempt without rerunning it', async () => {
    const { store } = fixture();
    await store.ensureLayout();
    const gezel = await store.createGezel({ name: 'Noor', role: 'Generalist' });
    const task = await store.createTask('default', {
      ...input,
      assignee: { kind: 'gezel', gezelId: gezel.id },
    });
    let fail!: (error: Error) => void;
    const runStep = vi.fn(
      () =>
        new Promise<void>((_, reject) => {
          fail = reject;
        }),
    );
    const runner = new PortableTaskRunner({ store, runStep });
    expect((await runner.run(task.ref)).dispatched).toBe(true);
    await expect(runner.run(task.ref)).rejects.toThrow('Wait for');
    await vi.waitFor(() => expect(runStep).toHaveBeenCalledOnce());
    fail(new Error('Interrupted during file write'));
    await vi.waitFor(async () => expect((await store.getTask(task.ref))?.status).toBe('paused'));
    expect(runStep).toHaveBeenCalledOnce();
  });
  it('fails unsupported behavior explicitly before allocating a task', async () => {
    const { store } = fixture();
    await store.ensureLayout();
    await expect(
      store.createTask('default', { ...input, cron: { expression: '* * * * *' } }),
    ).rejects.toThrow('desktop');
    await expect(
      store.createTask('default', {
        ...input,
        steps: [{ name: 'Hook', terminal: true, onEnter: { scope: 'craftbook', name: 'setup' } }],
      }),
    ).rejects.toThrow('embedded craftbook');
    await expect(store.getTask('../../outside/1')).rejects.toThrow();
    expect(await store.listTasks()).toHaveLength(0);
  });
});

describe('portable task gate contract', () => {
  it('uses shared predicates before invoking scripts and only exact script approval advances', async () => {
    const { store } = fixture();
    await store.ensureLayout();
    const task = await store.createTask('default', {
      ...input,
      steps: [
        {
          name: 'Report',
          terminal: true,
          gate: {
            at: 'completion',
            checks: [{ kind: 'minBytes', artifact: true, file: 'report.md', bytes: 10 }],
            scripts: [
              {
                scope: 'standard',
                name: 'checkContains',
                inputs: { file: 'report.md', pattern: 'Evidence' },
              },
            ],
          },
        },
      ],
    });
    const script = vi.fn(async () => ({ status: 'ok', output: { decision: 'approve' } }));
    const step = task.craftbook.steps[0]!;
    expect((await evaluatePortableTaskGate(store, task, step, script)).approved).toBe(false);
    expect(script).not.toHaveBeenCalled();
    await store.writeFile(
      'artifacts',
      'default',
      'report.md',
      '# Evidence\n\nThe result is verifiable.',
    );
    expect((await evaluatePortableTaskGate(store, task, step, script)).approved).toBe(true);
    expect(script).toHaveBeenCalledOnce();
    script.mockResolvedValueOnce({ status: 'ok', output: { decision: 'reject' } });
    expect((await evaluatePortableTaskGate(store, task, step, script)).approved).toBe(false);
    script.mockResolvedValueOnce({ status: 'error', output: { decision: 'approve' } });
    expect((await evaluatePortableTaskGate(store, task, step, script)).approved).toBe(false);
  });
  it('does not treat unsupported checks or unsafe file paths as approval', async () => {
    const { store } = fixture();
    await store.ensureLayout();
    const task = await store.createTask('default', input);
    const step = task.craftbook.steps[0]!;
    step.gate = { at: 'completion', checks: [{ kind: 'nodeRuns', file: 'script.js' }] };
    expect(await evaluatePortableTaskGate(store, task, step)).toMatchObject({ approved: false });
    step.gate = {
      at: 'completion',
      checks: [{ kind: 'minBytes', file: '../../config.json', bytes: 1 }],
    };
    expect(await evaluatePortableTaskGate(store, task, step)).toMatchObject({ approved: false });
  });
});
