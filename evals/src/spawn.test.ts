import { describe, expect, it, vi } from 'vitest';
import { findTrialNativeChildren } from './spawn.js';

describe('eval native-child cleanup', () => {
  it('finds same-home Windows native engines without relying on Unix ps', async () => {
    const home = 'C:\\Users\\Test\\AppData\\Local\\Temp\\gezel-eval-a';
    const listProcesses = vi.fn(async () => [
      {
        pid: 81001,
        ppid: 80000,
        command:
          '"D:\\native\\gezel-llama-server.exe" --model "c:\\users\\test\\appdata\\local\\temp\\gezel-eval-a\\models\\a.gguf"',
      },
      {
        pid: 81002,
        ppid: 80000,
        command:
          'node run.ts --llama-bin D:\\native\\gezel-llama-server.exe --home C:\\Users\\Test\\AppData\\Local\\Temp\\gezel-eval-a',
      },
      {
        pid: 81003,
        ppid: 80000,
        command: '"D:\\native\\gezel-sd-server.exe" --model "C:\\other-eval\\models\\sd.gguf"',
      },
    ]);

    await expect(
      findTrialNativeChildren(home, {
        platform: 'win32',
        listProcesses,
      }),
    ).resolves.toEqual([81001]);
    expect(listProcesses).toHaveBeenCalledWith({ platform: 'win32' });
  });

  it('fails closed with an empty target list when process discovery is unavailable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(
        findTrialNativeChildren('/tmp/gezel-eval', {
          platform: 'linux',
          listProcesses: async () => {
            throw new Error('process table denied');
          },
        }),
      ).resolves.toEqual([]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('process snapshot failed'));
    } finally {
      warn.mockRestore();
    }
  });
});
