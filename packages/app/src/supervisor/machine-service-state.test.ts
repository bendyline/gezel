import { describe, expect, it } from 'vitest';
import { machineServiceInstallFailed, parseRegDword } from './machine-service-state.js';

/** Real `reg.exe query` output, including its leading blank line. */
const regOutput = (value: string) =>
  `\r\nHKEY_LOCAL_MACHINE\\Software\\Bendyline\\Gezel\r\n    MachineServiceInstalled    REG_DWORD    ${value}\r\n\r\n`;

describe('parseRegDword', () => {
  it('reads the value regardless of radix or column padding', () => {
    expect(parseRegDword(regOutput('0x0'), 'MachineServiceInstalled')).toBe(0);
    expect(parseRegDword(regOutput('0x1'), 'MachineServiceInstalled')).toBe(1);
    // Padding varies by Windows build, so the parser must not depend on it.
    expect(
      parseRegDword('    MachineServiceInstalled REG_DWORD 0x0\r\n', 'MachineServiceInstalled'),
    ).toBe(0);
  });

  it('returns null when the value is absent or not a DWORD', () => {
    expect(parseRegDword('', 'MachineServiceInstalled')).toBeNull();
    expect(parseRegDword(regOutput('0x0'), 'SomethingElse')).toBeNull();
    expect(
      parseRegDword(
        '    MachineServiceInstalled    REG_SZ    hello\r\n',
        'MachineServiceInstalled',
      ),
    ).toBeNull();
  });
});

describe('machineServiceInstallFailed', () => {
  it('reports failure only on a positive 0', async () => {
    await expect(
      machineServiceInstallFailed({ platform: 'win32', regQuery: async () => regOutput('0x0') }),
    ).resolves.toBe(true);
  });

  it('stays quiet when the service registered', async () => {
    await expect(
      machineServiceInstallFailed({ platform: 'win32', regQuery: async () => regOutput('0x1') }),
    ).resolves.toBe(false);
  });

  it('stays quiet when the key is missing', async () => {
    // Every install predating this breadcrumb looks like this. Reporting it as
    // a failure would put a permanent, wrong notice in front of users we have
    // no evidence about — reg.exe exits non-zero, which surfaces as a throw.
    await expect(
      machineServiceInstallFailed({
        platform: 'win32',
        regQuery: async () => {
          throw new Error('ERROR: The system was unable to find the specified registry key');
        },
      }),
    ).resolves.toBe(false);
    await expect(
      machineServiceInstallFailed({ platform: 'win32', regQuery: async () => '' }),
    ).resolves.toBe(false);
  });

  it('never shells out on non-Windows', async () => {
    let called = false;
    const spy = async () => {
      called = true;
      return regOutput('0x0');
    };
    await expect(machineServiceInstallFailed({ platform: 'darwin', regQuery: spy })).resolves.toBe(
      false,
    );
    await expect(machineServiceInstallFailed({ platform: 'linux', regQuery: spy })).resolves.toBe(
      false,
    );
    expect(called).toBe(false);
  });
});
