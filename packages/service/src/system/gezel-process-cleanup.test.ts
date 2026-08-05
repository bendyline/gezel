import { describe, expect, it, vi } from 'vitest';
import { reapOrphanedGezelEngineProcesses } from './gezel-process-cleanup.js';
import type { ProcessListEntry } from './gezel-process-memory.js';

const HOME = '/Users/test/.gezel-dev';

describe('Gezel startup orphan cleanup', () => {
  it('reaps every owner-less first-party engine family, including shared-store launches', async () => {
    const processes = new Map<number, ProcessListEntry>([
      [
        39957,
        {
          pid: 39957,
          ppid: 1,
          command: `/opt/gezel/gezel-ds4-server --model ${HOME}/engines/ds4/model.gguf`,
        },
      ],
      [
        71381,
        {
          pid: 71381,
          ppid: 1,
          command: `/usr/bin/python /opt/gezel/gezel_mlx_server.py --model ${HOME}/engines/mlx/model`,
        },
      ],
      [
        83733,
        {
          pid: 83733,
          ppid: 83487,
          command: `/opt/gezel/gezel-ds4-server --model ${HOME}/engines/ds4/model.gguf`,
        },
      ],
      [
        90000,
        {
          pid: 90000,
          ppid: 1,
          command: '/opt/gezel/gezel-llama-server --model /tmp/other-home/model.gguf',
        },
      ],
      [
        90001,
        {
          pid: 90001,
          ppid: 1,
          command: `/usr/bin/python /tmp/unrelated.py --cache ${HOME}/engines/cache`,
        },
      ],
      [
        90002,
        {
          pid: 90002,
          ppid: 1,
          command: '/usr/local/bin/llama-server --model /tmp/unrelated/model.gguf',
        },
      ],
    ]);
    const psRunner = vi.fn(async () => [...processes.values()]);
    const killProcess = vi.fn((pid: number) => {
      processes.delete(pid);
    });

    await expect(
      reapOrphanedGezelEngineProcesses({
        platform: 'darwin',
        servicePid: 83487,
        psRunner,
        killProcess,
        sleep: async () => {},
      }),
    ).resolves.toEqual({
      targetedPids: [39957, 71381, 90000],
      remainingPids: [],
    });
    expect(killProcess.mock.calls).toEqual([
      [39957, 'SIGKILL'],
      [71381, 'SIGKILL'],
      [90000, 'SIGKILL'],
    ]);
  });

  it('reaps Windows engines whose retained creator pid is no longer alive', async () => {
    const windowsHome = 'C:\\Users\\test\\.gezel';
    const processes = new Map<number, ProcessListEntry>([
      [
        40001,
        {
          pid: 40001,
          ppid: 39999,
          command: `"C:\\Gezel\\gezel-llama-server.exe" --model "${windowsHome}\\models\\a.gguf"`,
        },
      ],
      [
        41000,
        {
          pid: 41000,
          ppid: 30000,
          command: `node "${windowsHome}\\service\\dist\\bin\\gezeld.js"`,
        },
      ],
      [
        41001,
        {
          pid: 41001,
          ppid: 41000,
          command: `"C:\\Gezel\\gezel-sd-server.exe" --model "${windowsHome}\\models\\sd.gguf"`,
        },
      ],
      [
        42001,
        {
          pid: 42001,
          ppid: 39998,
          command: '"C:\\Gezel\\gezel-llama-server.exe" --model "C:\\other\\model.gguf"',
        },
      ],
    ]);
    const psRunner = vi.fn(async () => [...processes.values()]);
    const killProcess = vi.fn((pid: number) => {
      processes.delete(pid);
    });

    await expect(
      reapOrphanedGezelEngineProcesses({
        platform: 'win32',
        servicePid: 43000,
        psRunner,
        killProcess,
        sleep: async () => {},
      }),
    ).resolves.toEqual({ targetedPids: [40001, 42001], remainingPids: [] });
    expect(killProcess).toHaveBeenCalledWith(40001, 'SIGKILL');
    expect(killProcess).toHaveBeenCalledWith(42001, 'SIGKILL');
    expect(killProcess).not.toHaveBeenCalledWith(41001, 'SIGKILL');
  });

  it('does nothing on unsupported platforms without a process snapshot', async () => {
    const psRunner = vi.fn();
    const killProcess = vi.fn();

    await expect(
      reapOrphanedGezelEngineProcesses({
        platform: 'freebsd',
        psRunner,
        killProcess,
      }),
    ).resolves.toEqual({ targetedPids: [], remainingPids: [] });
    expect(psRunner).not.toHaveBeenCalled();
    expect(killProcess).not.toHaveBeenCalled();
  });
});
