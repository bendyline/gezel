import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ScriptExecutionOptions } from '@bendyline/gezel-script-runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runInSandbox } from '../sandbox/runner.js';
import { NodeScriptExecutor } from './node-executor.js';
import { resolveSdkDir } from './sdk.js';

const scratchState = vi.hoisted(() => ({ path: '' }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...fs,
    mkdtemp: async (prefix: string) => {
      const path = await fs.mkdtemp(prefix);
      if (prefix.endsWith('gezel-script-')) scratchState.path = path;
      return path;
    },
  };
});
vi.mock('../sandbox/runner.js', () => ({ runInSandbox: vi.fn() }));
vi.mock('./sdk.js', () => ({
  SDK_PACKAGE_NAME: '@bendyline/gezel-sdk',
  resolveSdkDir: vi.fn(),
  shouldVendorSdkPath: (_root: string, path: string) => !path.endsWith('ignored.txt'),
}));

let sdk: string;
const options = (): ScriptExecutionOptions => ({
  source: 'export const value = 1;',
  scriptName: 'fixture',
  init: {
    runId: 'run-1',
    projectId: 'default',
    input: {},
    engagementMode: 'off',
    engagementFlags: { llmAllowed: false },
  },
  timeoutMs: 5_000,
  provenanceTrusted: false,
  trustedReadOnlyStandard: false,
  onRequest: vi.fn(),
  onNotification: vi.fn(),
  onStdout: vi.fn(),
  onStderr: vi.fn(),
});

beforeEach(async () => {
  vi.resetAllMocks();
  scratchState.path = '';
  sdk = await mkdtemp(join(tmpdir(), 'gezel-executor-sdk-'));
  await writeFile(join(sdk, 'package.json'), '{"name":"@bendyline/gezel-sdk"}');
  await writeFile(join(sdk, 'ignored.txt'), 'not vendored');
  vi.mocked(resolveSdkDir).mockResolvedValue(sdk);
});

afterEach(async () => {
  await rm(sdk, { recursive: true, force: true });
});

describe('NodeScriptExecutor', () => {
  it('preserves desktop confinement and cleans scratch after success', async () => {
    let scratch = '';
    vi.mocked(runInSandbox).mockImplementation(async (sandbox) => {
      scratch = sandbox.cwd;
      expect(sandbox).toMatchObject({
        entry: 'user-script.ts',
        timeoutMs: 5_000,
        stripTypes: true,
        denyNet: true,
        allowMissingNetBoundary: false,
        allowMacSandboxStartupFallback: false,
        maxOldSpaceMb: 1024,
        relaxReads: true,
        extraEnv: { GEZEL_SCRIPT_RUNTIME: '1' },
      });
      expect(JSON.parse(sandbox.input)).toEqual(options().init);
      expect(await readFile(join(scratch, 'user-script.ts'), 'utf8')).toBe(options().source);
      await access(join(scratch, 'node_modules', '@bendyline', 'gezel-sdk', 'package.json'));
      await expect(
        access(join(scratch, 'node_modules', '@bendyline', 'gezel-sdk', 'ignored.txt')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
    });
    expect(await new NodeScriptExecutor().execute(options())).toMatchObject({ exitCode: 0 });
    await expect(access(scratch)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps typed host denials on the RPC response and forwards notifications', async () => {
    const opts = options();
    opts.onRequest = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('denied'), { code: 'CAPABILITY_DENIED' }));
    vi.mocked(runInSandbox).mockImplementation(async (sandbox) => {
      const frames: string[] = [];
      sandbox.rpcChannel!.onOpen!((line) => frames.push(line));
      sandbox.rpcChannel!.onLine('{"id":1,"method":"artifact.write","params":{"path":"a.txt"}}');
      sandbox.rpcChannel!.onLine('{"method":"script.output","params":{"value":{"ok":true}}}');
      await vi.waitFor(() => expect(frames).toHaveLength(1));
      expect(JSON.parse(frames[0]!)).toEqual({
        id: 1,
        error: { message: 'denied', code: 'CAPABILITY_DENIED' },
      });
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
    });
    await new NodeScriptExecutor().execute(opts);
    expect(opts.onNotification).toHaveBeenCalledWith('script.output', { value: { ok: true } });
  });

  it('cleans scratch when sandbox startup fails', async () => {
    let scratch = '';
    vi.mocked(runInSandbox).mockImplementation(async (sandbox) => {
      scratch = sandbox.cwd;
      throw new Error('cannot start');
    });
    await expect(new NodeScriptExecutor().execute(options())).rejects.toThrow('cannot start');
    await expect(access(scratch)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('cleans the source when SDK setup fails before sandbox startup', async () => {
    vi.mocked(resolveSdkDir).mockRejectedValue(new Error('SDK missing'));
    await expect(new NodeScriptExecutor().execute(options())).rejects.toThrow('SDK missing');
    expect(scratchState.path).not.toBe('');
    await expect(access(scratchState.path)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(runInSandbox).not.toHaveBeenCalled();
  });
});
