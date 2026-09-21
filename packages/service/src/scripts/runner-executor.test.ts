import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ScriptExecutionOptions,
  ScriptExecutionResult,
  ScriptExecutor,
} from '@bendyline/gezel-script-runtime';
import { projectScriptRunFile } from '@bendyline/gezel/paths';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatManager } from '../chat/manager.js';
import { Store } from '../fs/store.js';
import { ScriptRunner } from './runner.js';

const success: ScriptExecutionResult = {
  exitCode: 0,
  stdout: '',
  stderr: '',
  timedOut: false,
};

let home: string;
let store: Store;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-script-executor-test-'));
  store = new Store({ home });
  await store.ensureLayout();
  await store.createProject({ name: 'Default' });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function runnerWith(execute: ScriptExecutor['execute']): ScriptRunner {
  // These cases exercise the real store/dispatcher without any inference.
  return new ScriptRunner({ store, chat: {} as ChatManager, executor: { execute } });
}

function source(requires: string[] = [], outputType = 'boolean'): string {
  return `export const meta = {
    name: 'portable', description: 'executor boundary fixture',
    requires: ${JSON.stringify(requires)},
    inputs: { message: { type: 'string', description: 'body', default: 'hello' } },
    outputs: { ok: { type: '${outputType}', description: 'result' } },
  };`;
}

const invocation = {
  projectId: 'default',
  scriptName: 'portable',
  trigger: { kind: 'manual', userInitiated: true } as const,
};

describe('ScriptRunner executor boundary', () => {
  it('uses the real artifact dispatcher and persists the shared call trace', async () => {
    const text = source(['artifacts.write']);
    let init: ScriptExecutionOptions['init'] | undefined;
    const runner = runnerWith(async (options) => {
      init = options.init;
      expect(options.source).toBe(text);
      expect(options.provenanceTrusted).toBe(false);
      expect(options.trustedReadOnlyStandard).toBe(false);
      await options.onRequest('artifact.write', { path: 'portable.txt', content: 'hello' });
      options.onNotification('script.log', { args: ['wrote artifact'] });
      options.onNotification('script.output', { value: { ok: true } });
      return success;
    });

    const run = await runner.run({ ...invocation, inlineSource: text });
    expect(run.status).toBe('ok');
    expect(run.output).toEqual({ ok: true });
    expect(init).toMatchObject({
      projectId: 'default',
      runId: run.id,
      input: { message: 'hello' },
    });
    expect(await store.readProjectArtifact('default', 'portable.txt')).toBe('hello');
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0]).toMatchObject({ kind: 'artifact.write', durationMs: expect.any(Number) });
    expect(run.logs).toContain('wrote artifact');
    const persisted = JSON.parse(
      await readFile(
        projectScriptRunFile(home, 'default', run.startedAt.slice(0, 10), run.id),
        'utf8',
      ),
    );
    expect(persisted).toEqual(run);
  });

  it('denies undeclared effects before they reach storage and records the denial', async () => {
    const runner = runnerWith(async (options) => {
      await options.onRequest('artifact.write', { path: 'denied.txt', content: 'no' });
      return success;
    });
    const run = await runner.run({ ...invocation, inlineSource: source() });
    expect(run.status).toBe('error');
    expect(run.error).toContain('did not declare it in meta.requires');
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0]?.error).toBe(run.error);
    expect(await store.readProjectArtifact('default', 'denied.txt')).toBeNull();
  });

  it('retains path confinement for a granted artifact capability', async () => {
    const runner = runnerWith(async (options) => {
      await options.onRequest('artifact.write', { path: '../outside.txt', content: 'no' });
      return success;
    });
    const run = await runner.run({ ...invocation, inlineSource: source(['artifacts.write']) });
    expect(run.status).toBe('error');
    expect(run.calls[0]?.error).toBeTruthy();
    await expect(readFile(join(home, 'projects', 'default', 'outside.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('validates an executor output through the same declared schema', async () => {
    const runner = runnerWith(async (options) => {
      options.onNotification('script.output', { value: { ok: 'not a boolean' } });
      return success;
    });
    const run = await runner.run({ ...invocation, inlineSource: source() });
    expect(run.status).toBe('error');
    expect(run.error).toBe('output field "ok" must be boolean, got string');
    expect(run.output).toBeUndefined();
  });

  it('validates inputs before calling any executor', async () => {
    const execute = vi.fn<ScriptExecutor['execute']>().mockResolvedValue(success);
    await expect(
      runnerWith(execute).run({
        ...invocation,
        inlineSource: source(),
        inputs: { message: 123 },
      }),
    ).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
  });

  it('persists executor setup failures as failed runs', async () => {
    const runner = runnerWith(async () => {
      throw new Error('runtime unavailable');
    });
    const run = await runner.run({ ...invocation, inlineSource: source() });
    expect(run).toMatchObject({
      status: 'error',
      error: 'runtime unavailable',
      finishedAt: expect.any(String),
    });
  });

  it('freezes the audit trace when a terminated guest leaves a host operation pending', async () => {
    let entered!: () => void;
    const writing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let finishWrite!: () => void;
    const write = new Promise<void>((resolve) => {
      finishWrite = resolve;
    });
    vi.spyOn(store, 'writeProjectArtifact').mockImplementation(() => {
      entered();
      return write;
    });
    let hostCall!: Promise<unknown>;
    let callbacks!: ScriptExecutionOptions;
    const runner = runnerWith(async (options) => {
      callbacks = options;
      hostCall = options.onRequest('artifact.write', { path: 'slow.txt', content: 'pending' });
      await writing;
      return { ...success, exitCode: 1, timedOut: true };
    });
    const run = await runner.run({ ...invocation, inlineSource: source(['artifacts.write']) });
    expect(run.calls[0]?.error).toContain('may still complete');
    const finished = JSON.stringify(run);
    finishWrite();
    await hostCall;
    callbacks.onNotification('script.output', { value: { late: true } });
    callbacks.onStderr('late error');
    await expect(callbacks.onRequest('artifact.write', {})).rejects.toThrow('execution has ended');
    expect(JSON.stringify(run)).toBe(finished);
  });
});
