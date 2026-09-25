import { readFileSync } from 'node:fs';
import { getQuickJS } from 'quickjs-emscripten';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { ScriptExecutionOptions } from './index.js';
import { QuickJSScriptExecutor, type QuickJSScriptExecutorOptions } from './quickjs.js';

const sdkModuleSource = readFileSync(
  new URL('../../sdk/dist/portable.js', import.meta.url),
  'utf8',
);

function executor(limits: Partial<QuickJSScriptExecutorOptions> = {}) {
  return new QuickJSScriptExecutor({
    sdkModuleSource,
    compile: (source, fileName) =>
      transpileModule(source, {
        fileName,
        compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 },
      }).outputText,
    now: () => performance.now(),
    ...limits,
  });
}

function runOptions(
  source: string,
  overrides: Partial<ScriptExecutionOptions> = {},
): ScriptExecutionOptions {
  return {
    source,
    scriptName: 'test-script.ts',
    init: {
      input: { title: 'Pocket note' },
      runId: 'run-1',
      projectId: 'project-1',
      engagementMode: 'reactive',
      engagementFlags: { llmAllowed: false },
    },
    timeoutMs: 2_000,
    provenanceTrusted: false,
    trustedReadOnlyStandard: false,
    onRequest: vi.fn(async () => undefined),
    onNotification: vi.fn(),
    onStdout: vi.fn(),
    onStderr: vi.fn(),
    ...overrides,
  };
}

beforeAll(async () => {
  await getQuickJS();
});

describe('QuickJS script execution', () => {
  it('runs TypeScript using init, asynchronous artifacts, logs, and one output', async () => {
    const files = new Map<string, string>();
    const options = runOptions(
      `
      import { gezel, defineScript } from '@bendyline/gezel-sdk';
      export const meta = defineScript({ name: 'note', requires: ['artifacts.write'] });
      const title: string = String(gezel.input.title);
      await gezel.artifacts.write('note.md', title);
      const saved = await gezel.artifacts.read('note.md');
      gezel.log('saved', saved);
      console.info('complete');
      gezel.output({ text: saved });
    `,
      {
        onRequest: vi.fn(async (method, params) => {
          await new Promise<void>((resolve) => setTimeout(resolve, 1));
          const frame = params as { path: string; content: string };
          if (method === 'artifact.write') files.set(frame.path, frame.content);
          else if (method === 'artifact.read') return files.get(frame.path);
          else throw new Error(`Unexpected method ${method}`);
        }),
      },
    );

    expect(await executor().execute(options)).toMatchObject({
      exitCode: 0,
      timedOut: false,
      stderr: '',
    });
    expect(files.get('note.md')).toBe('Pocket note');
    expect(options.onNotification).toHaveBeenNthCalledWith(1, 'script.log', {
      args: ['saved', 'Pocket note'],
    });
    expect(options.onNotification).toHaveBeenNthCalledWith(2, 'script.log', { args: ['complete'] });
    expect(options.onNotification).toHaveBeenNthCalledWith(3, 'script.output', {
      value: { text: 'Pocket note' },
    });
  });

  it('lets scripts recover from structured capability denials', async () => {
    const options = runOptions(
      `
      import { gezel } from '@bendyline/gezel-sdk';
      try { await gezel.fs.write('private.md', 'data'); }
      catch (error) { gezel.output({ code: error.code, message: error.message }); }
    `,
      {
        onRequest: async () => {
          throw Object.assign(new Error('Write denied'), { code: 'CAPABILITY_DENIED' });
        },
      },
    );

    expect((await executor().execute(options)).exitCode).toBe(0);
    expect(options.onNotification).toHaveBeenCalledExactlyOnceWith('script.output', {
      value: { code: 'CAPABILITY_DENIED', message: 'Write denied' },
    });
  });

  it('exposes no platform globals or raw bridge functions', async () => {
    const options = runOptions(`
      import { gezel } from '@bendyline/gezel-sdk';
      gezel.output([typeof process, typeof fetch, typeof Buffer, typeof require,
        typeof __gezelCall, typeof __gezelNotify, typeof __gezelInit]);
    `);

    expect((await executor().execute(options)).exitCode).toBe(0);
    expect(options.onNotification).toHaveBeenCalledExactlyOnceWith('script.output', {
      value: Array(7).fill('undefined'),
    });
  });

  it.each([
    "import fs from 'node:fs'; fs.readFileSync('/tmp/secret');",
    "await import('node:fs');",
    "await import('https://example.invalid/script.js');",
    "await import('./neighbor.js');",
  ])('rejects unbundled imports: %s', async (source) => {
    const result = await executor().execute(runOptions(source));
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('unavailable in portable scripts');
  });

  it.each(['while (true) {}', 'while (true) { await Promise.resolve(); }'])(
    'times out guest execution: %s',
    async (source) => {
      const result = await executor().execute(runOptions(source, { timeoutMs: 40 }));
      expect(result).toMatchObject({ exitCode: 1, timedOut: true });
      expect(result.stderr).toContain('timed out');
    },
  );

  it('refuses the internal SDK module to anything but the bootstrap', async () => {
    // The compiler rejects this import, but eval() never reaches the compiler,
    // so the loader has to be the one that says no.
    const result = await executor().execute(
      runOptions('await eval("import(\'@gezel-internal/portable-sdk\')");'),
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('unavailable in portable scripts');
  });

  it('still lets the bootstrap reach it, so ordinary scripts work', async () => {
    const result = await executor().execute(
      runOptions("import { gezel } from '@bendyline/gezel-sdk';\ngezel.output({ ok: true });"),
    );
    expect(result.exitCode).toBe(0);
  });

  it('fails a guest nothing can resume instead of burning the whole budget', async () => {
    const started = Date.now();
    // No host call outstanding, no queued job, and the guest has no timers.
    const result = await executor().execute(
      runOptions('await new Promise(() => {});', { timeoutMs: 20_000 }),
    );
    expect(result).toMatchObject({ exitCode: 1, timedOut: false });
    expect(result.stderr).toMatch(/nothing can resume it/);
    // The point of the fix: it stops immediately rather than at the deadline.
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('caps guest allocations before exhausting host memory', async () => {
    const result = await executor({ memoryLimitBytes: 2 * 1024 * 1024 }).execute(
      runOptions(`
      const arrays = [];
      while (true) arrays.push(new Array(10000).fill('payload'));
    `),
    );
    expect(result).toMatchObject({ exitCode: 1, timedOut: false });
    expect(result.stderr).toMatch(/memory/i);
  });

  it('stops ordinary allocation growth through the guest allocator', async () => {
    // Object churn stays inside QuickJS's own accounting, so its limit fires
    // first and the run ends well before any deadline.
    const result = await executor({ memoryLimitBytes: 2 * 1024 * 1024 }).execute(
      runOptions("const a = []; while (true) a.push({ x: 1, y: 2, z: 'abc' });"),
    );
    expect(result).toMatchObject({ exitCode: 1, timedOut: false });
    expect(result.stderr).toMatch(/memory/i);
  });

  it('bounds concurrent host calls', async () => {
    const options = runOptions(
      `
      import { gezel } from '@bendyline/gezel-sdk';
      await Promise.all([gezel.fs.read('one'), gezel.fs.read('two'), gezel.fs.read('three')]);
    `,
      { onRequest: vi.fn(() => new Promise(() => {})) },
    );
    const result = await executor({ maxPendingCalls: 2 }).execute(options);
    expect(result).toMatchObject({ exitCode: 1, timedOut: false });
    expect(result.stderr).toContain('host call limit exceeded');
    expect(vi.mocked(options.onRequest).mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('bounds total host calls, including notifications', async () => {
    const options = runOptions(`
      import { gezel } from '@bendyline/gezel-sdk';
      gezel.log('one'); gezel.log('two'); gezel.output('three');
    `);
    const result = await executor({ maxCalls: 2 }).execute(options);
    expect(result.stderr).toContain('host call limit exceeded');
    expect(options.onNotification).toHaveBeenCalledTimes(2);
  });

  it('rejects oversized outgoing messages before host dispatch', async () => {
    const options = runOptions(`
      import { gezel } from '@bendyline/gezel-sdk';
      await gezel.artifacts.write('large.txt', 'x'.repeat(2048));
    `);
    const result = await executor({ maxMessageChars: 1024 }).execute(options);
    expect(result.stderr).toContain('message size limit exceeded');
    expect(options.onRequest).not.toHaveBeenCalled();
  });

  it('rejects oversized host replies', async () => {
    const options = runOptions(
      `
      import { gezel } from '@bendyline/gezel-sdk';
      gezel.output(await gezel.artifacts.read('large.txt'));
    `,
      { onRequest: async () => 'x'.repeat(2048) },
    );
    const result = await executor({ maxMessageChars: 1024 }).execute(options);
    expect(result.stderr).toContain('message size limit exceeded');
    expect(options.onNotification).not.toHaveBeenCalled();
  });

  it('bounds host rejection messages before passing them into the guest', async () => {
    const options = runOptions(
      `
      import { gezel } from '@bendyline/gezel-sdk';
      try { await gezel.fs.read('large-error'); }
      catch (error) { gezel.output({ size: error.message.length }); }
    `,
      {
        onRequest: async () => {
          throw new Error('x'.repeat(2048));
        },
      },
    );
    const result = await executor({ maxMessageChars: 1024 }).execute(options);
    expect(result.exitCode).toBe(0);
    const message = vi.mocked(options.onNotification).mock.calls[0]?.[1] as {
      value: { size: number };
    };
    expect(message.value.size).toBeGreaterThan(0);
    expect(message.value.size).toBeLessThanOrEqual(1024);
  });

  it('bounds uncaught host rejection messages reported to the host', async () => {
    const options = runOptions(
      `
      import { gezel } from '@bendyline/gezel-sdk';
      await gezel.fs.read('large-error');
    `,
      {
        onRequest: async () => {
          throw new Error('x'.repeat(2048));
        },
      },
    );
    const result = await executor({ maxMessageChars: 1024 }).execute(options);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.length).toBeLessThanOrEqual(1024);
    expect(options.onStderr).toHaveBeenCalledExactlyOnceWith(result.stderr);
  });

  it('applies frame limits to structured host error codes', async () => {
    const options = runOptions(
      `
      import { gezel } from '@bendyline/gezel-sdk';
      await gezel.fs.read('large-error-code');
    `,
      {
        onRequest: async () => {
          throw Object.assign(new Error('denied'), { code: 'x'.repeat(2048) });
        },
      },
    );
    const result = await executor({ maxMessageChars: 1024 }).execute(options);
    expect(result.stderr).toContain('message size limit exceeded');
  });

  it('bounds reported guest errors before forwarding them to the host', async () => {
    const options = runOptions("throw new Error('x'.repeat(2048));");
    const result = await executor({ maxMessageChars: 1024 }).execute(options);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.length).toBeLessThanOrEqual(1024);
    expect(options.onStderr).toHaveBeenCalledExactlyOnceWith(result.stderr);
  });

  it('rejects oversized source before invoking the host compiler', async () => {
    const compile = vi.fn((source: string) => source);
    const result = await executor({ maxMessageChars: 1024, compile }).execute(
      runOptions(' '.repeat(2048)),
    );
    expect(result.stderr).toContain('message size limit exceeded');
    expect(compile).not.toHaveBeenCalled();
  });

  it('bounds cumulative traffic even when each notification fits', async () => {
    const options = runOptions(`
      import { gezel } from '@bendyline/gezel-sdk';
      for (let i = 0; i < 10; i++) gezel.log('x'.repeat(512));
    `);
    const result = await executor({ maxMessageChars: 1024, maxTotalMessageChars: 2048 }).execute(
      options,
    );
    expect(result.stderr).toContain('message size limit exceeded');
    expect(vi.mocked(options.onNotification).mock.calls.length).toBeLessThan(10);
  });

  it('rejects output while an unawaited host call is pending', async () => {
    const options = runOptions(
      `
      import { gezel } from '@bendyline/gezel-sdk';
      gezel.fs.write('private.md', 'data');
      gezel.output({ ok: true });
    `,
      {
        onRequest: async () => {
          throw new Error('Detached write denied');
        },
      },
    );
    const result = await executor().execute(options);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('must await host calls before writing output');
    expect(options.onNotification).not.toHaveBeenCalled();
  });

  it.each([
    "gezel.fs.write('private.md', 'data');",
    "(async () => { await gezel.fs.write('private.md', 'data'); })();",
    "Promise.all([gezel.fs.write('private.md', 'data')]);",
  ])('rejects module completion with detached host work: %s', async (source) => {
    const options = runOptions(`import { gezel } from '@bendyline/gezel-sdk'; ${source}`, {
      onRequest: async () => {
        throw new Error('Detached write denied');
      },
    });
    const result = await executor().execute(options);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('unawaited host calls');
  });

  it('isolates globals and output stamps across independent runs', async () => {
    const runtime = executor();
    const first = runOptions(
      `import { gezel } from '@bendyline/gezel-sdk'; globalThis.secret = 42; gezel.output(1);`,
    );
    const second = runOptions(
      `import { gezel } from '@bendyline/gezel-sdk'; gezel.output(typeof globalThis.secret);`,
    );

    expect((await runtime.execute(first)).exitCode).toBe(0);
    expect((await runtime.execute(second)).exitCode).toBe(0);
    expect(second.onNotification).toHaveBeenCalledExactlyOnceWith('script.output', {
      value: 'undefined',
    });
  });

  it('ignores host replies that arrive after timeout and disposal', async () => {
    let finish!: (value: unknown) => void;
    const options = runOptions(
      `import { gezel } from '@bendyline/gezel-sdk'; gezel.output(await gezel.fs.read('slow'));`,
      {
        timeoutMs: 40,
        onRequest: () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      },
    );
    const runtime = executor();
    expect(await runtime.execute(options)).toMatchObject({ exitCode: 1, timedOut: true });
    expect(finish).toBeTypeOf('function');
    finish('late result');
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    expect(options.onNotification).not.toHaveBeenCalled();
    expect((await runtime.execute(runOptions('export const alive = true;'))).exitCode).toBe(0);
  });

  it('honors cancellation while a host call is pending', async () => {
    const controller = new AbortController();
    const options = runOptions(
      `import { gezel } from '@bendyline/gezel-sdk'; await gezel.fs.read('slow');`,
      {
        signal: controller.signal,
        onRequest: () => {
          controller.abort();
          return new Promise(() => {});
        },
      },
    );
    const result = await executor().execute(options);
    expect(result).toMatchObject({ exitCode: 1, timedOut: false });
    expect(result.stderr).toContain('cancelled');
  });
});
