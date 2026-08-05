import { describe, expect, it, vi } from 'vitest';
import {
  isGezelEngineCommand,
  listProcessSnapshots,
  parseUnixProcessSnapshot,
  parseWindowsProcessSnapshot,
  stopProcessByPid,
} from './processes.js';

describe('cross-platform process snapshots', () => {
  it('identifies engine processes without matching wrappers that only mention a binary', () => {
    expect(
      isGezelEngineCommand(
        '"C:\\Program Files\\Gezel\\gezel-llama-server.exe" --model C:\\models\\a.gguf',
      ),
    ).toBe(true);
    expect(
      isGezelEngineCommand('/usr/bin/python /opt/gezel/gezel_mlx_server.py --model /models/qwen'),
    ).toBe(true);
    expect(
      isGezelEngineCommand(
        'node run.ts --llama-bin C:\\Gezel\\gezel-llama-server.exe --home C:\\eval',
      ),
    ).toBe(false);
    expect(isGezelEngineCommand('/usr/local/bin/llama-server --model /tmp/unrelated.gguf')).toBe(
      false,
    );
  });

  it('parses Unix pid, ppid, and the untruncated command tail', () => {
    expect(
      parseUnixProcessSnapshot(`
  120 1 /opt/gezel/gezel-llama-server --model /tmp/a model.gguf
  bad row
  121 120 /usr/bin/node gezeld.js
`),
    ).toEqual([
      {
        pid: 120,
        ppid: 1,
        command: '/opt/gezel/gezel-llama-server --model /tmp/a model.gguf',
      },
      { pid: 121, ppid: 120, command: '/usr/bin/node gezeld.js' },
    ]);
  });

  it('parses Windows CIM JSON arrays and preserves Unicode command lines', () => {
    expect(
      parseWindowsProcessSnapshot(
        JSON.stringify([
          {
            ProcessId: 410,
            ParentProcessId: 200,
            ExecutablePath: 'C:\\Gezel\\gezel-llama-server.exe',
            CommandLine:
              '"C:\\Gezel\\gezel-llama-server.exe" --model "C:\\Users\\Tést\\model.gguf"',
          },
          {
            ProcessId: 411,
            ParentProcessId: 200,
            ExecutablePath: 'C:\\Gezel\\gezel-sd-server.exe',
            CommandLine: null,
          },
        ]),
      ),
    ).toEqual([
      {
        pid: 410,
        ppid: 200,
        command: '"C:\\Gezel\\gezel-llama-server.exe" --model "C:\\Users\\Tést\\model.gguf"',
      },
      { pid: 411, ppid: 200, command: 'C:\\Gezel\\gezel-sd-server.exe' },
    ]);
  });

  it('accepts PowerShell single-object JSON and ignores malformed rows', () => {
    expect(
      parseWindowsProcessSnapshot(
        JSON.stringify({
          ProcessId: 99,
          ParentProcessId: 0,
          ExecutablePath: 'C:\\Windows\\System32\\smss.exe',
          CommandLine: '',
        }),
      ),
    ).toEqual([{ pid: 99, ppid: 0, command: 'C:\\Windows\\System32\\smss.exe' }]);
    expect(
      parseWindowsProcessSnapshot(
        JSON.stringify([{ ProcessId: 'nope', ParentProcessId: 1, CommandLine: 'bad' }]),
      ),
    ).toEqual([]);
  });

  it('uses the Windows PowerShell CIM query instead of Unix ps', async () => {
    const run = vi.fn(async (_command: string, _args: string[]) =>
      JSON.stringify({
        ProcessId: 500,
        ParentProcessId: 400,
        ExecutablePath: 'C:\\Gezel\\gezel-llama-server.exe',
        CommandLine: 'gezel-llama-server.exe --port 9999',
      }),
    );

    await expect(listProcessSnapshots({ platform: 'win32', run })).resolves.toEqual([
      { pid: 500, ppid: 400, command: 'gezel-llama-server.exe --port 9999' },
    ]);
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]?.[0].toLowerCase()).toContain('powershell.exe');
    expect(run.mock.calls[0]?.[1]).toContain('-NoProfile');
    expect(run.mock.calls[0]?.[1].at(-1)).toContain('Get-CimInstance Win32_Process');
  });

  it('stops a Windows pid as a tree without sending a single-process signal', async () => {
    let alive = true;
    const signalProcess = vi.fn();
    const terminateWindowsTree = vi.fn(async () => {
      alive = false;
    });

    await expect(
      stopProcessByPid(500, {
        platform: 'win32',
        isAlive: () => alive,
        signalProcess,
        terminateWindowsTree,
      }),
    ).resolves.toBe(true);
    expect(terminateWindowsTree).toHaveBeenCalledWith(500);
    expect(signalProcess).not.toHaveBeenCalled();
  });

  it('keeps the bounded POSIX graceful-to-force signal ladder', async () => {
    vi.useFakeTimers();
    try {
      let alive = true;
      const signals: NodeJS.Signals[] = [];
      const stopping = stopProcessByPid(501, {
        platform: 'linux',
        graceMs: 100,
        pollIntervalMs: 10,
        isAlive: () => alive,
        signalProcess: (_pid, signal) => {
          signals.push(signal);
          if (signal === 'SIGKILL') alive = false;
        },
      });

      await vi.advanceTimersByTimeAsync(100);
      await expect(stopping).resolves.toBe(true);
      expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
    } finally {
      vi.useRealTimers();
    }
  });
});
