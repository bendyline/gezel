import {
  GezelConfigSchema,
  type ScriptMeta,
  type ScriptRun,
  ScriptRunSchema,
  securityPolicyForLevel,
} from '@bendyline/gezel';
import { describe, expect, it, vi } from 'vitest';
import type { ScriptExecutionOptions } from './index.js';
import { PortableScriptRunner, type PortableScriptRunnerOptions } from './runner.js';

const meta: ScriptMeta = {
  name: 'example',
  description: 'Portable test script',
  requires: ['artifacts.write'],
  inputs: { title: { type: 'string', description: 'Title', required: true } },
  outputs: { ok: { type: 'boolean', description: 'Saved' } },
};
const request = {
  scope: 'standard' as const,
  projectId: 'default',
  scriptName: 'example',
  inputs: { title: 'hello' },
  trigger: { kind: 'manual' as const, userInitiated: true as const },
};
function setup(execute: (options: ScriptExecutionOptions) => Promise<void>) {
  const saved: ScriptRun[] = [];
  const host: PortableScriptRunnerOptions = {
    executor: {
      execute: async (options) => {
        await execute(options);
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
      },
    },
    resolve: vi.fn(async () => ({ meta, source: '', scope: 'standard' as const })),
    readConfig: vi.fn(async () => GezelConfigSchema.parse({})),
    workspaceWriteAllowed: vi.fn(async () => ({ ok: true })),
    dispatch: vi.fn(async () => undefined),
    persistRun: vi.fn(async (run) => {
      saved.push(structuredClone(run));
    }),
    createId: () => 'test-run',
    now: () => 1000,
  };
  return { host, saved, runner: new PortableScriptRunner(host) };
}

describe('portable script runner', () => {
  it('persists admission and call intent before effects, then validates and records the result', async () => {
    const { host, saved, runner } = setup(async (options) => {
      expect(saved).toHaveLength(1);
      expect(options.init.input).toEqual({ title: 'hello' });
      await options.onRequest('artifact.write', { path: 'note.md', content: 'hello' });
      options.onNotification('script.output', { value: { ok: true } });
    });
    host.dispatch = vi.fn(async () => {
      expect(saved.at(-1)?.calls[0]?.error).toContain('Host operation started');
    });
    const run = await runner.run(request);
    expect(ScriptRunSchema.parse(run)).toMatchObject({ status: 'ok', output: { ok: true } });
    expect(saved.at(-1)).toEqual(run);
    expect(run.calls[0]?.error).toBeUndefined();
  });

  it('rejects invalid input before admission or execution', async () => {
    const { runner, host } = setup(async () => {});
    await expect(runner.run({ ...request, inputs: { title: 4 } })).rejects.toThrow('string');
    expect(host.persistRun).not.toHaveBeenCalled();
  });

  it('stops effects if the audit cannot be persisted', async () => {
    const { runner, host } = setup(async (options) => {
      await options.onRequest('artifact.write', { path: 'note', content: 'body' });
    });
    vi.mocked(host.persistRun).mockResolvedValueOnce().mockRejectedValue(new Error('disk full'));
    await expect(runner.run(request)).rejects.toThrow('disk full');
    expect(host.dispatch).not.toHaveBeenCalled();
  });

  it('denies undeclared methods and records the denial', async () => {
    const { runner, host } = setup(async (options) => {
      await options.onRequest('fs.write', { path: 'secret', content: 'oops' });
    });
    const run = await runner.run(request);
    expect(run).toMatchObject({
      status: 'error',
      error: expect.stringContaining('did not declare'),
    });
    expect(run.calls[0]?.error).toContain('did not declare');
    expect(host.dispatch).not.toHaveBeenCalled();
  });

  it('denies AI after engagement changes mid-run', async () => {
    const { host, runner } = setup(async (options) => {
      vi.mocked(host.readConfig).mockResolvedValue(
        GezelConfigSchema.parse({ aiEngagementMode: 'off' }),
      );
      await options.onRequest('llm.oneShot', { prompt: 'Hello' });
    });
    host.resolve = async () => ({
      source: '',
      scope: 'standard',
      meta: { ...meta, requires: ['llm'] },
    });
    expect(await runner.run(request)).toMatchObject({
      status: 'error',
      error: expect.stringContaining('off'),
    });
    expect(host.dispatch).not.toHaveBeenCalled();
  });

  it.each(['chat', 'step'] as const)(
    'revokes an authored %s script before its next durable effect',
    async (kind) => {
      const { host, saved, runner } = setup(async (options) => {
        await options.onRequest('artifact.write', { path: 'first.md', content: 'Saved' });
        await options.onRequest('artifact.write', { path: 'second.md', content: 'Denied' });
      });
      host.resolve = async () => ({ source: '', scope: 'project', meta });
      const persist = host.persistRun;
      host.persistRun = async (run) => {
        await persist(run);
        // A settings change can arrive while the second call intent is saving.
        if (run.calls.length === 2)
          vi.mocked(host.readConfig).mockResolvedValue(
            GezelConfigSchema.parse({ securityPolicy: securityPolicyForLevel('super-lockdown') }),
          );
      };
      const trigger =
        kind === 'chat'
          ? { kind, gezelId: 'noor', sessionId: 'session' }
          : { kind, taskRef: 'default/1', stepId: 'work', moment: 'enter' as const };
      const run = await runner.run({ ...request, scope: 'project', trigger });
      expect(run).toMatchObject({
        status: 'error',
        error: expect.stringContaining('script execution is disabled'),
      });
      expect(host.dispatch).toHaveBeenCalledOnce();
      expect(run.calls[1]?.error).toContain('script execution is disabled');
      expect(saved.at(-1)).toEqual(run);
    },
  );

  it.each(['standard', 'project'] as const)(
    'preserves the %s scope manual action contract after policy changes',
    async (scope) => {
      const { host, runner } = setup(async (options) => {
        vi.mocked(host.readConfig).mockResolvedValue(
          GezelConfigSchema.parse({ securityPolicy: securityPolicyForLevel('super-lockdown') }),
        );
        await options.onRequest('artifact.write', { path: 'note.md', content: 'Saved' });
        options.onNotification('script.output', { value: { ok: true } });
      });
      host.resolve = async () => ({ source: '', scope, meta });
      expect(await runner.run({ ...request, scope })).toMatchObject({ status: 'ok' });
      expect(host.dispatch).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ['documents.write', 'document.write'],
    ['network', 'http.request'],
    ['workspace.write', 'fs.write'],
  ] as const)('revokes declared %s before a host effect', async (capability, method) => {
    const { host, runner } = setup(async (options) => {
      vi.mocked(host.readConfig).mockResolvedValue(
        GezelConfigSchema.parse({ securityPolicy: securityPolicyForLevel('super-lockdown') }),
      );
      vi.mocked(host.workspaceWriteAllowed).mockResolvedValue({ ok: false });
      await options.onRequest(method, { path: 'note.md', content: 'Denied' });
    });
    host.resolve = async () => ({
      source: '',
      scope: 'standard',
      meta: { ...meta, requires: [capability] },
    });
    vi.mocked(host.readConfig).mockResolvedValue(
      GezelConfigSchema.parse({ securityPolicy: securityPolicyForLevel('free') }),
    );
    expect(await runner.run(request)).toMatchObject({
      status: 'error',
      error: expect.stringContaining('currently denied'),
    });
    expect(host.dispatch).not.toHaveBeenCalled();
  });

  it('does not dispatch if cancellation arrives during the policy recheck', async () => {
    const controller = new AbortController();
    const { host, runner } = setup(async (options) => {
      vi.mocked(host.readConfig).mockImplementation(async () => {
        controller.abort();
        return GezelConfigSchema.parse({});
      });
      await options.onRequest('artifact.write', { path: 'note.md', content: 'Denied' });
    });
    expect(await runner.run({ ...request, signal: controller.signal })).toMatchObject({
      status: 'error',
    });
    expect(host.dispatch).not.toHaveBeenCalled();
  });

  it('keeps standard scope immutable and does not fall back to another scope', async () => {
    const { host, runner } = setup(async () => {});
    host.resolve = async () => ({ source: '', scope: 'project', meta });
    await expect(runner.run(request)).rejects.toThrow('different scope');
  });

  it.each([undefined, { ok: 'yes' }])(
    'rejects missing or invalid declared outputs: %s',
    async (value) => {
      const { runner } = setup(async (options) => {
        if (value) options.onNotification('script.output', { value });
      });
      expect(await runner.run(request)).toMatchObject({ status: 'error' });
    },
  );

  it('does not execute after cancellation and persists the cancelled run', async () => {
    let executed = false;
    const { runner, saved } = setup(async () => {
      executed = true;
    });
    const controller = new AbortController();
    controller.abort();
    const run = await runner.run({ ...request, signal: controller.signal });
    expect(executed).toBe(false);
    expect(run.status).toBe('error');
    expect(saved.at(-1)?.status).toBe('error');
  });
});
