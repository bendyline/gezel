import { describe, expect, it, vi } from 'vitest';
import {
  macUninstallAppleScript,
  macUninstallShellCommand,
  parseMacUninstallSelection,
  scheduleMacUninstall,
} from './macos.js';

const KEEP_DATA = {
  removeMachineData: false,
  removeSharedData: false,
  removeCurrentUserData: false,
};

describe('macOS uninstaller handoff', () => {
  it('accepts only the three boolean renderer choices', () => {
    expect(parseMacUninstallSelection(KEEP_DATA)).toEqual(KEEP_DATA);
    expect(parseMacUninstallSelection({ ...KEEP_DATA, removeMachineData: '/tmp/anything' })).toBe(
      null,
    );
    expect(parseMacUninstallSelection({ ...KEEP_DATA, path: '/tmp/anything' })).toBe(null);
    expect(parseMacUninstallSelection(null)).toBe(null);
  });

  it('builds a fixed, quoted command with explicit data-scope flags', () => {
    const command = macUninstallShellCommand({
      scriptPath: "/Applications/Gezel's Copy.app/Contents/Resources/uninstall.sh",
      appPid: 4321,
      userUid: 501,
      selection: {
        removeMachineData: true,
        removeSharedData: true,
        removeCurrentUserData: true,
      },
    });

    expect(command).toContain("'/bin/bash'");
    expect(command).toContain("Gezel'\\''s Copy.app");
    expect(command).toContain("'--detach'");
    expect(command).toContain("'--wait-for-pid=4321'");
    expect(command).toContain("'--user-uid=501'");
    expect(command).toContain("'--remove-machine-data'");
    expect(command).toContain("'--remove-shared-data'");
    expect(command).toContain("'--remove-current-user-data'");
    expect(macUninstallAppleScript(command)).toMatch(/with administrator privileges$/);
  });

  it('uses osascript only after resolving the signed bundled script', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
    const result = await scheduleMacUninstall({
      resourcesPath: '/Applications/Gezel.app/Contents/Resources',
      appPid: 4321,
      userUid: 501,
      selection: KEEP_DATA,
      platform: 'darwin',
      isPackaged: true,
      exists: () => true,
      exec,
    });

    expect(result).toEqual({ ok: true });
    expect(exec).toHaveBeenCalledWith(
      '/usr/bin/osascript',
      ['-e', expect.stringContaining('/Applications/Gezel.app/Contents/Resources/uninstall.sh')],
      { timeout: 120_000, maxBuffer: 1024 * 1024 },
    );
  });

  it('reports a canceled administrator prompt without treating it as a system failure', async () => {
    const result = await scheduleMacUninstall({
      resourcesPath: '/Applications/Gezel.app/Contents/Resources',
      appPid: 4321,
      userUid: 501,
      selection: KEEP_DATA,
      platform: 'darwin',
      isPackaged: true,
      exists: () => true,
      exec: vi.fn().mockRejectedValue(new Error('execution error: User canceled. (-128)')),
    });

    expect(result).toEqual({
      ok: false,
      canceled: true,
      error: 'Administrator authorization was canceled.',
    });
  });
});
