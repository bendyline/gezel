import { describe, expect, it, vi } from 'vitest';
import { reapOrphanedGezelEngineProcesses } from './gezel-process-cleanup.js';
import type { ProcessListEntry } from './gezel-process-memory.js';

const HOME = '/Users/test/.gezel-dev';

describe('Gezel startup orphan cleanup', () => {
  it('reaps every same-home orphaned engine family, not only the next engine launched', async () => {
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
    ]);
    const psRunner = vi.fn(async () => [...processes.values()]);
    const killProcess = vi.fn((pid: number) => {
      processes.delete(pid);
    });

    await expect(
      reapOrphanedGezelEngineProcesses({
        home: HOME,
        platform: 'darwin',
        servicePid: 83487,
        psRunner,
        killProcess,
        sleep: async () => {},
      }),
    ).resolves.toEqual({
      targetedPids: [39957, 71381],
      remainingPids: [],
    });
    expect(killProcess.mock.calls).toEqual([
      [39957, 'SIGKILL'],
      [71381, 'SIGKILL'],
    ]);
  });

  it('does nothing on platforms without the ps-based ownership proof', async () => {
    const psRunner = vi.fn();
    const killProcess = vi.fn();

    await expect(
      reapOrphanedGezelEngineProcesses({
        home: HOME,
        platform: 'win32',
        psRunner,
        killProcess,
      }),
    ).resolves.toEqual({ targetedPids: [], remainingPids: [] });
    expect(psRunner).not.toHaveBeenCalled();
    expect(killProcess).not.toHaveBeenCalled();
  });
});
