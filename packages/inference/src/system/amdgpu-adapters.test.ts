import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readAmdgpuAdapters } from './amdgpu-adapters.js';

const GiB = 1024 ** 3;

function fakeSysfs(files: Record<string, string>, entries: string[]) {
  return {
    readDir: (path: string) => {
      if (path !== '/sys/class/drm') throw new Error(`ENOENT: ${path}`);
      return entries;
    },
    readFile: (path: string) => {
      const value = files[path];
      if (value === undefined) throw new Error(`ENOENT: ${path}`);
      return value;
    },
  };
}

const device = (card: string, file: string) => join('/sys/class/drm', card, 'device', file);

describe('readAmdgpuAdapters', () => {
  it("lists each amdgpu device's VRAM, skipping connectors and other vendors", () => {
    const io = fakeSysfs(
      {
        [device('card0', 'vendor')]: '0x8086\n',
        [device('card1', 'vendor')]: '0x1002\n',
        [device('card1', 'mem_info_vram_total')]: `${8 * GiB}\n`,
      },
      ['card0', 'card1', 'card1-eDP-1', 'renderD128', 'version'],
    );
    expect(readAmdgpuAdapters(io)).toEqual([{ vendorId: 0x1002, dedicatedBytes: 8 * GiB }]);
  });

  it('reads GTT beside VRAM when amdgpu publishes it', () => {
    const io = fakeSysfs(
      {
        [device('card0', 'vendor')]: '0x1002',
        [device('card0', 'mem_info_vram_total')]: `${512 * 1024 ** 2}`,
        [device('card0', 'mem_info_gtt_total')]: `${120 * GiB}`,
      },
      ['card0'],
    );
    expect(readAmdgpuAdapters(io)).toEqual([
      { vendorId: 0x1002, dedicatedBytes: 512 * 1024 ** 2, sharedSystemBytes: 120 * GiB },
    ]);
  });

  it('skips an AMD device that is not driven by amdgpu or reports nothing usable', () => {
    const io = fakeSysfs(
      {
        [device('card0', 'vendor')]: '0x1002',
        [device('card1', 'vendor')]: '0x1002',
        [device('card1', 'mem_info_vram_total')]: '\n',
        [device('card2', 'vendor')]: '0x1002',
        [device('card2', 'mem_info_vram_total')]: 'n/a',
      },
      ['card0', 'card1', 'card2'],
    );
    expect(readAmdgpuAdapters(io)).toEqual([]);
  });

  it('answers empty where there is no DRM directory', () => {
    expect(readAmdgpuAdapters(fakeSysfs({}, []))).toEqual([]);
    expect(
      readAmdgpuAdapters({
        readDir: () => {
          throw new Error('ENOENT');
        },
      }),
    ).toEqual([]);
  });
});
