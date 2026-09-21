import { GezelConfigSchema, type ScriptRun, securityPolicyForLevel } from '@bendyline/gezel';
import { describe, expect, it, vi } from 'vitest';
import type { ScriptExecutionOptions } from './index.js';
import { PortableScriptRunner, type PortableScriptRunnerOptions } from './runner.js';

const manual = { kind: 'manual', userInitiated: true } as const;
const invocation = {
  projectId: 'default',
  scriptName: 'parent',
  scope: 'project' as const,
  trigger: manual,
};
function fixture(execute: (options: ScriptExecutionOptions) => Promise<void>) {
  const saved = new Map<string, ScriptRun>();
  const host: PortableScriptRunnerOptions = {
    executor: {
      execute: async (options) => {
        await execute(options);
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
      },
    },
    resolve: vi.fn(async (name, scope) => ({
      source: '',
      scope,
      meta: { name, description: 'Nested script', requires: ['artifacts.write', 'tasks.write'] },
    })),
    readConfig: vi.fn(async () => GezelConfigSchema.parse({})),
    workspaceWriteAllowed: async () => ({ ok: true }),
    dispatch: vi.fn(async () => undefined),
    persistRun: async (run) => {
      saved.set(run.id, structuredClone(run));
    },
  };
  return { host, saved, runner: new PortableScriptRunner(host) };
}
describe('portable nested script execution', () => {
  it('rechecks the parent execution policy before a delayed task transition', async () => {
    const { host, runner } = fixture(async (options) => {
      await options.onRequest('task.advance', { ref: 'default/1' });
    });
    let transitioned = false;
    host.dispatch = vi.fn(async (context) => {
      // A gate has finished after the user revoked agent-authored scripts.
      host.readConfig = async () =>
        GezelConfigSchema.parse({ securityPolicy: securityPolicyForLevel('super-lockdown') });
      await context.authorizeMethod!('task.advance');
      transitioned = true;
    });
    const run = await runner.run({
      ...invocation,
      trigger: { kind: 'chat', gezelId: 'noor', sessionId: 'chat' },
    });
    expect(run.status).toBe('error');
    expect(run.error).toContain('script execution is disabled');
    expect(transitioned).toBe(false);
  });
  it('runs host-owned completion children with their own step scope and parent audit link', async () => {
    const { host, saved, runner } = fixture(async (options) => {
      if (options.scriptName === 'parent')
        await options.onRequest('task.advance', { ref: 'default/1' });
      else await options.onRequest('artifact.write', { path: 'gate.md', content: 'Checked' });
    });
    const gateTrigger = {
      kind: 'step',
      taskRef: 'default/1',
      stepId: 'review',
      moment: 'gate',
    } as const;
    host.dispatch = vi.fn(async (context, method) => {
      if (method === 'task.advance')
        return context.runTaskScript!({
          scriptName: 'gate',
          scope: 'standard',
          trigger: gateTrigger,
          signal: context.signal,
        });
      expect(context.trigger).toEqual(gateTrigger);
    });
    const parent = await runner.run(invocation);
    expect(parent.status).toBe('ok');
    const child = [...saved.values()].find((run) => run.scriptName === 'gate');
    expect(child).toMatchObject({
      status: 'ok',
      scope: 'standard',
      parentRunId: parent.id,
      trigger: gateTrigger,
    });
  });
  it('keeps child scope, parent lineage and final audits while retaining task-note authority', async () => {
    let nested: unknown;
    const { host, saved, runner } = fixture(async (options) => {
      if (options.scriptName === 'parent')
        nested = await options.onRequest('script.run', { name: 'child', input: {} });
      else await options.onRequest('task.appendNote', { ref: 'default/1', text: 'Saved' });
    });
    const trigger = {
      kind: 'step',
      taskRef: 'default/1',
      stepId: 'work',
      moment: 'enter',
    } as const;
    const parent = await runner.run({ ...invocation, trigger });
    const child = [...saved.values()].find((run) => run.scriptName === 'child')!;
    expect(parent.status).toBe('ok');
    expect(child).toMatchObject({
      status: 'ok',
      projectId: 'default',
      scope: 'project',
      trigger: { kind: 'nested', parentRunId: parent.id },
    });
    expect(nested).toMatchObject({ status: 'ok', runId: child.id });
    expect(host.resolve).toHaveBeenCalledWith(
      'child',
      'project',
      expect.objectContaining({ projectId: 'default' }),
    );
    expect(host.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ trigger }),
      'task.appendNote',
      expect.anything(),
    );
    expect(parent.calls[0]?.kind).toBe('script.run');
  });
  it('refuses recursion beyond four children and leaves every admitted run inspectable', async () => {
    const { saved, runner } = fixture(async (options) => {
      const child = (await options.onRequest('script.run', { name: 'child' })) as {
        status: string;
        error?: string;
      };
      if (child.status !== 'ok') throw new Error(child.error);
    });
    const parent = await runner.run(invocation);
    expect(parent.status).toBe('error');
    expect(parent.error).toContain('nested script depth exceeded');
    expect(saved.size).toBe(5);
    expect([...saved.values()].every((run) => run.status === 'error')).toBe(true);
  });
  it('revokes the parent policy before nested host effects', async () => {
    const { host, saved, runner } = fixture(async (options) => {
      if (options.scriptName === 'parent') {
        const child = (await options.onRequest('script.run', { name: 'child' })) as {
          status: string;
          error?: string;
        };
        if (child.status !== 'ok') throw new Error(child.error);
      } else {
        vi.mocked(host.readConfig).mockResolvedValue(
          GezelConfigSchema.parse({ securityPolicy: securityPolicyForLevel('super-lockdown') }),
        );
        await options.onRequest('artifact.write', { path: 'denied.md', content: 'Denied' });
      }
    });
    const parent = await runner.run({
      ...invocation,
      trigger: { kind: 'chat', gezelId: 'noor', sessionId: 'session' },
    });
    expect(parent.error).toContain('script execution is disabled');
    expect(host.dispatch).not.toHaveBeenCalled();
    expect(
      [...saved.values()].find((run) => run.scriptName === 'child')?.calls[0]?.error,
    ).toContain('script execution is disabled');
  });
  it('cancels child work and awaits its final audit before releasing the parent', async () => {
    let ready!: () => void;
    const entered = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const { host, saved, runner } = fixture(async (options) => {
      if (options.scriptName === 'parent') await options.onRequest('script.run', { name: 'child' });
      else {
        ready();
        await new Promise<void>((resolve) =>
          options.signal?.addEventListener('abort', () => resolve(), { once: true }),
        );
        await options.onRequest('artifact.write', { path: 'late.md', content: 'Denied' });
      }
    });
    const controller = new AbortController();
    const running = runner.run({ ...invocation, signal: controller.signal });
    await entered;
    controller.abort();
    await running;
    expect(host.dispatch).not.toHaveBeenCalled();
    expect(saved.size).toBe(2);
    expect([...saved.values()].every((run) => run.status === 'error' && run.finishedAt)).toBe(true);
  });
  it.each([
    { name: 'child', scope: 'standard' },
    { name: 'child', projectId: 'other' },
  ])('rejects caller-supplied child authority: %s', async (args) => {
    const { host, runner } = fixture(async (options) => {
      await options.onRequest('script.run', args);
    });
    expect((await runner.run(invocation)).error).toContain('only a name and input');
    expect(host.resolve).toHaveBeenCalledOnce();
  });
  it('does not admit a fabricated nested trigger without a live parent', async () => {
    const { runner } = fixture(async () => {});
    await expect(
      runner.run({ ...invocation, trigger: { kind: 'nested', parentRunId: 'missing' } }),
    ).rejects.toThrow('Parent script execution has ended');
  });
});
