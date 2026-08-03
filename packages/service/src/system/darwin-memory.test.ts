import { describe, expect, it, vi } from 'vitest';
import { parseDarwinVmStat, sampleDarwinSystemMemory } from './darwin-memory.js';

const MiB = 1024 ** 2;

describe('macOS system memory', () => {
  it('separates Activity Monitor cached files from memory used', () => {
    expect(
      parseDarwinVmStat(
        `Mach Virtual Memory Statistics: (page size of 4096 bytes)
Pages free:                                      256.
Pages purgeable:                                 256.
File-backed pages:                               512.
`,
        16 * MiB,
      ),
    ).toEqual({
      usedBytes: 12 * MiB,
      cachedBytes: 3 * MiB,
      freeBytes: 1 * MiB,
    });
  });

  it('rejects incomplete vm_stat output instead of reviving total-minus-free', () => {
    expect(
      parseDarwinVmStat(
        `Mach Virtual Memory Statistics: (page size of 4096 bytes)
Pages free: 256.
`,
        16 * MiB,
      ),
    ).toBeNull();
  });

  it('samples vm_stat only on macOS', async () => {
    const run = vi.fn(
      async () => `Mach Virtual Memory Statistics: (page size of 4096 bytes)
Pages free: 256.
Pages purgeable: 256.
File-backed pages: 512.
`,
    );

    await expect(
      sampleDarwinSystemMemory({
        totalBytes: 16 * MiB,
        platform: 'darwin',
        run,
      }),
    ).resolves.toEqual({
      usedBytes: 12 * MiB,
      cachedBytes: 3 * MiB,
      freeBytes: 1 * MiB,
    });
    expect(run).toHaveBeenCalledWith('/usr/bin/vm_stat', []);

    run.mockClear();
    await expect(
      sampleDarwinSystemMemory({ totalBytes: 16 * MiB, platform: 'linux', run }),
    ).resolves.toBeNull();
    expect(run).not.toHaveBeenCalled();
  });
});
