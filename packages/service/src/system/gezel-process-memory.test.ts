import { describe, expect, it, vi } from 'vitest';
import {
  findGezelEngineProcesses,
  parseFootprintBytes,
  parseProcessList,
  sampleDarwinGezelProcessMemory,
} from './gezel-process-memory.js';

const HOME = '/Users/test/.gezel-dev';

describe('Gezel macOS process memory', () => {
  it('finds native and Python engines for the current home, including orphans', () => {
    const entries = parseProcessList(`
  39957     1 /Applications/Gezel.app/gezel-ds4-server --model ${HOME}/engines/ds4/model.gguf
  71381 34907 /usr/bin/python ${HOME}/service/gezel_mlx_server.py --model ${HOME}/engines/mlx/model
  80000     1 /Applications/Gezel.app/gezel-llama-server --model /tmp/other-home/model.gguf
  80001     1 /usr/bin/python /tmp/tool.py --cache ${HOME}/engines/cache
`);

    expect(findGezelEngineProcesses(entries, HOME)).toEqual([
      expect.objectContaining({ pid: 39957, ppid: 1 }),
      expect.objectContaining({ pid: 71381, ppid: 34907 }),
    ]);
  });

  it('matches Windows engine paths case-insensitively with backslash separators', () => {
    const home = 'C:\\Users\\Test\\.gezel';
    const entries = [
      {
        pid: 510,
        ppid: 500,
        command:
          '"C:\\Program Files\\Gezel\\gezel-llama-server.exe" --model "c:\\users\\test\\.gezel\\models\\a.gguf"',
      },
      {
        pid: 511,
        ppid: 500,
        command: '"C:\\Program Files\\Gezel\\gezel-sd-server.exe" --model "C:\\other\\model.gguf"',
      },
    ];

    expect(findGezelEngineProcesses(entries, home, 'win32')).toEqual([
      expect.objectContaining({ pid: 510 }),
    ]);
  });

  it('parses the combined physical-footprint byte summary', () => {
    expect(
      parseFootprintBytes(`
Auxiliary data:
    phys_footprint: 40977328936 B
Auxiliary data:
    phys_footprint: 39542993000 B
Summary Footprint: 80520158096 B
`),
    ).toBe(80_520_158_096);
  });

  it('sums surviving targets when footprint omits its summary', () => {
    expect(
      parseFootprintBytes(`
    phys_footprint: 100 B
    phys_footprint: 250 B
`),
    ).toBe(350);
  });

  it('measures the daemon and every same-home engine in one footprint call', async () => {
    const run = vi.fn(async (command: string, args: string[]) => {
      if (command === '/bin/ps') {
        return `
  39957     1 /opt/gezel/gezel-ds4-server --model ${HOME}/engines/ds4/model.gguf
  71381 12345 /usr/bin/python /opt/gezel/gezel_mlx_server.py --model ${HOME}/engines/mlx/model
`;
      }
      expect(command).toBe('/usr/bin/footprint');
      expect(args).toEqual([
        '--noCategories',
        '--format',
        'bytes',
        '--pid',
        '12345',
        '--pid',
        '39957',
        '--pid',
        '71381',
      ]);
      return 'Summary Footprint: 80520158096 B';
    });

    await expect(
      sampleDarwinGezelProcessMemory({
        home: HOME,
        platform: 'darwin',
        servicePid: 12345,
        run,
      }),
    ).resolves.toEqual({
      bytes: 80_520_158_096,
      engineProcessCount: 2,
      orphanedEngineProcessCount: 1,
    });
  });

  it('uses the portable fallback off macOS without running commands', async () => {
    const run = vi.fn();
    await expect(
      sampleDarwinGezelProcessMemory({
        home: HOME,
        platform: 'linux',
        run,
      }),
    ).resolves.toBeNull();
    expect(run).not.toHaveBeenCalled();
  });
});
