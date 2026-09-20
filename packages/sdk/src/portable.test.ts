import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { type ScriptInit, type ScriptTransport, createGezelSDK } from './portable.js';

function init(input: unknown = {}): ScriptInit {
  return {
    input,
    runId: 'run-1',
    projectId: 'project-1',
    engagementMode: 'reactive',
    engagementFlags: { llmAllowed: false },
  };
}

function transport(input?: unknown): ScriptTransport {
  const rpc: ScriptTransport = {
    init: init(input),
    call: async <T>() => undefined as T,
    notify: vi.fn(),
  };
  vi.spyOn(rpc, 'call');
  return rpc;
}

/** Load the real entry graph with standard JS globals and no Node access. */
function loadWithoutPlatformGlobals(path: string): Record<string, unknown> {
  const exports: Record<string, unknown> = {};
  const { outputText } = transpileModule(readFileSync(path, 'utf8'), {
    compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
  });
  runInNewContext(
    outputText,
    {
      exports,
      require(specifier: string) {
        if (!specifier.startsWith('.')) {
          throw new Error(`Portable SDK cannot import ${specifier}`);
        }
        return loadWithoutPlatformGlobals(
          resolve(dirname(path), specifier.replace(/\.js$/, '.ts')),
        );
      },
    },
    { filename: path, timeout: 1_000 },
  );
  return exports;
}

describe('portable script SDK', () => {
  it('imports and runs with no process, Buffer, timers, or platform modules', async () => {
    const entry = loadWithoutPlatformGlobals(
      fileURLToPath(new URL('./portable.ts', import.meta.url)),
    );
    const create = entry.createGezelSDK as typeof createGezelSDK;
    const rpc = transport({ message: 'hello' });
    const gezel = create(rpc);

    expect(gezel.input).toEqual({ message: 'hello' });
    await gezel.artifacts.write('result.txt', 'hello');
    gezel.log('saved');
    gezel.output({ path: 'result.txt' });

    expect(rpc.call).toHaveBeenCalledWith('artifact.write', {
      path: 'result.txt',
      content: 'hello',
    });
    expect(rpc.notify).toHaveBeenCalledWith('script.log', { args: ['saved'] });
    expect(rpc.notify).toHaveBeenCalledWith('script.output', { value: { path: 'result.txt' } });
  });

  it('isolates input and one-output state between runs in the same interpreter', () => {
    const first = transport({ title: 'first' });
    const second = transport({ title: 'second' });
    const firstSdk = createGezelSDK(first);
    const secondSdk = createGezelSDK(second);

    firstSdk.output(firstSdk.input);
    secondSdk.output(secondSdk.input);

    expect(first.notify).toHaveBeenCalledExactlyOnceWith('script.output', {
      value: { title: 'first' },
    });
    expect(second.notify).toHaveBeenCalledExactlyOnceWith('script.output', {
      value: { title: 'second' },
    });
    expect(() => firstSdk.output({})).toThrow('called more than once');
    expect(first.notify).toHaveBeenCalledTimes(1);
  });

  it('awaits host completion before a script stamps its artifact', async () => {
    const rpc = transport();
    let completeWrite!: () => void;
    rpc.call = <T>() =>
      new Promise<T>((resolveCall) => {
        completeWrite = () => resolveCall(undefined as T);
      });
    const gezel = createGezelSDK(rpc);
    const script = (async () => {
      await gezel.artifacts.write('note.md', 'My note');
      gezel.output({ path: 'note.md' });
    })();

    expect(rpc.notify).not.toHaveBeenCalled();
    completeWrite();
    await script;
    expect(rpc.notify).toHaveBeenCalledExactlyOnceWith('script.output', {
      value: { path: 'note.md' },
    });
  });

  it('preserves host permission denials without reporting successful output', async () => {
    const rpc = transport();
    const denied = Object.assign(new Error('Workspace writes are not granted'), {
      code: 'CAPABILITY_DENIED',
    });
    rpc.call = vi.fn(async () => {
      throw denied;
    });
    const gezel = createGezelSDK(rpc);

    await expect(gezel.fs.write('notes.md', 'private')).rejects.toBe(denied);
    expect(rpc.notify).not.toHaveBeenCalled();
  });

  it('delivers logs through the transport and the optional runtime log sink', () => {
    const rpc = transport();
    const log = vi.fn();
    const gezel = createGezelSDK(rpc, { log });

    gezel.log('created', { path: 'report.md' });

    expect(rpc.notify).toHaveBeenCalledExactlyOnceWith('script.log', {
      args: ['created', { path: 'report.md' }],
    });
    expect(log).toHaveBeenCalledExactlyOnceWith('created', { path: 'report.md' });
  });

  it('propagates synchronous notification failures to the script', () => {
    const rpc = transport();
    rpc.notify = () => {
      throw new Error('script run disposed');
    };

    expect(() => createGezelSDK(rpc).output({ ok: true })).toThrow('script run disposed');
  });
});
