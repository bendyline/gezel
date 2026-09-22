import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ScriptExecutionOptions } from '@bendyline/gezel-script-runtime';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatManager } from '../chat/manager.js';
import { Store } from '../fs/store.js';
import { QuickJSWorkerExecutor } from './quickjs-executor.js';
import { ScriptRunner } from './runner.js';

let home: string;
let store: Store;
let runner: ScriptRunner;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-quickjs-worker-test-'));
  store = new Store({ home });
  await store.ensureLayout();
  await store.createProject({ name: 'Default' });
  runner = new ScriptRunner({
    store,
    chat: {} as ChatManager,
    executor: new QuickJSWorkerExecutor(),
  });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const invocation = {
  projectId: 'default',
  scriptName: 'portable',
  trigger: { kind: 'manual', userInitiated: true } as const,
};

function directOptions(
  source: string,
  overrides: Partial<ScriptExecutionOptions> = {},
): ScriptExecutionOptions {
  return {
    source,
    scriptName: 'portable',
    timeoutMs: 5_000,
    init: {
      runId: 'run-test',
      projectId: 'default',
      input: {},
      engagementMode: 'off',
      engagementFlags: { llmAllowed: false },
    },
    provenanceTrusted: false,
    trustedReadOnlyStandard: false,
    onRequest: async () => undefined,
    onNotification: () => {},
    onStdout: () => {},
    onStderr: () => {},
    ...overrides,
  };
}

describe('QuickJS worker through ScriptRunner', () => {
  it('strips TypeScript and creates/reads a real artifact through the dispatcher', async () => {
    const run = await runner.run({
      ...invocation,
      inlineSource: `
      import { gezel, defineScript } from '@bendyline/gezel-sdk';
      import { gateResult } from '@bendyline/gezel-sdk/checks';
      export const meta = defineScript({
        name: 'portable', description: 'worker artifact test',
        requires: ['artifacts.write', 'artifacts.read'],
        outputs: { body: { type: 'string', description: 'artifact text' } },
      } as const);
      type Message = { text: string };
      const message: Message = { text: 'hello from QuickJS' };
      await gezel.artifacts.write('portable.txt', message.text);
      const body: string = await gezel.artifacts.read('portable.txt');
      if (gateResult(body.length > 0, 'nonempty').decision !== 'approve') throw new Error('empty artifact');
      gezel.output({ body });
    `,
    });
    expect(run.error).toBeUndefined();
    expect(run.status).toBe('ok');
    expect(run.output).toEqual({ body: 'hello from QuickJS' });
    expect(await store.readProjectArtifact('default', 'portable.txt')).toBe('hello from QuickJS');
    expect(run.calls.map((call) => call.kind)).toEqual(['artifact.write', 'artifact.read']);
  });

  it('preserves typed permission denials inside the guest and the shared trace', async () => {
    const run = await runner.run({
      ...invocation,
      inlineSource: `
      import { gezel } from '@bendyline/gezel-sdk';
      export const meta = { name: 'portable', description: 'denied write' };
      try { await gezel.artifacts.write('denied.txt', 'no'); }
      catch (error) { gezel.output({ code: error.code }); }
    `,
    });
    expect(run.error).toBeUndefined();
    expect(run.status).toBe('ok');
    expect(run.output).toEqual({ code: 'CAPABILITY_DENIED' });
    expect(run.calls[0]?.error).toContain('did not declare');
    expect(await store.readProjectArtifact('default', 'denied.txt')).toBeNull();
  });

  it('rejects Node imports and retains output validation', async () => {
    const forbidden = await runner.run({
      ...invocation,
      inlineSource: `
      import fs from 'node:fs';
      export const meta = { name: 'portable', description: 'forbidden import' };
      fs.readFileSync('/etc/passwd');
    `,
    });
    expect(forbidden.status).toBe('error');
    expect(forbidden.error).toContain('node:fs');
    const invalid = await runner.run({
      ...invocation,
      inlineSource: `
      import { gezel } from '@bendyline/gezel-sdk';
      export const meta = { name: 'portable', description: 'invalid output', outputs: { ok: { type: 'boolean', description: 'ok' } } };
      gezel.output({ ok: 'wrong' });
    `,
    });
    expect(invalid.status).toBe('error');
    expect(invalid.error).toContain('must be boolean');
  });

  it('keeps the daemon event loop responsive during runaway guest compute', async () => {
    let ticks = 0;
    const timer = setInterval(() => ticks++, 10);
    try {
      const result = await new QuickJSWorkerExecutor().execute(
        directOptions('while (true) {}', { timeoutMs: 500 }),
      );
      expect(result.timedOut).toBe(true);
      expect(result.exitCode).toBe(1);
      expect(ticks).toBeGreaterThan(3);
    } finally {
      clearInterval(timer);
    }
  });

  it('terminates cancelled guest compute and ignores a late host reply', async () => {
    const controller = new AbortController();
    let resolveHost!: (value: unknown) => void;
    let started!: () => void;
    const requestStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const notifications: string[] = [];
    const execution = new QuickJSWorkerExecutor().execute(
      directOptions(
        `
      import { gezel } from '@bendyline/gezel-sdk';
      await gezel.artifacts.read('slow.txt');
      gezel.output({ late: true });
    `,
        {
          signal: controller.signal,
          onRequest: () =>
            new Promise((resolve) => {
              resolveHost = resolve;
              started();
            }),
          onNotification: (method) => {
            notifications.push(method);
          },
        },
      ),
    );
    await requestStarted;
    controller.abort();
    const result = await execution;
    expect(result.stderr).toContain('cancelled');
    expect(result.timedOut).toBe(false);
    resolveHost('late result');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(notifications).toEqual([]);
    const loopController = new AbortController();
    let guestStarted = false;
    const loop = new QuickJSWorkerExecutor().execute(
      directOptions(
        `import { gezel } from '@bendyline/gezel-sdk'; gezel.log('started'); while (true) {}`,
        {
          signal: loopController.signal,
          onNotification: () => {
            guestStarted = true;
            setTimeout(() => loopController.abort(), 30);
          },
        },
      ),
    );
    expect((await loop).stderr).toContain('cancelled');
    expect(guestStarted).toBe(true);
  });

  it('reports a script that will not compile as a failed run, not a thrown host error', async () => {
    // The in-worker executor and the Node sandbox both surface this as exit 1.
    // Throwing instead made the runner log the same failure a different way.
    const executor = new QuickJSWorkerExecutor();
    const result = await executor.execute(directOptions('const broken: = 1;'));
    expect(result.exitCode).toBe(1);
    expect(result.timedOut).toBe(false);
    expect(result.stderr).toMatch(/Error:/);
  });
});
