import { afterEach, describe, expect, it } from 'vitest';
import {
  SCRIPT_DENY_NET_BOUNDARY_ENV,
  unavailableToolsForPlatform,
} from './platform-tool-availability.js';

describe('unavailableToolsForPlatform', () => {
  const saved = process.env[SCRIPT_DENY_NET_BOUNDARY_ENV];
  afterEach(() => {
    if (saved === undefined) delete process.env[SCRIPT_DENY_NET_BOUNDARY_ENV];
    else process.env[SCRIPT_DENY_NET_BOUNDARY_ENV] = saved;
  });

  it('hides deny-net script tools on Windows when the service reports no container', () => {
    delete process.env[SCRIPT_DENY_NET_BOUNDARY_ENV];
    expect(unavailableToolsForPlatform('win32')).toEqual(['run_nodejs_script', 'derive_file']);
    expect(unavailableToolsForPlatform('win32', { windowsMxcAvailable: false })).toEqual([
      'run_nodejs_script',
      'derive_file',
    ]);
  });

  it('keeps them on Windows when the service reports a working container', () => {
    process.env[SCRIPT_DENY_NET_BOUNDARY_ENV] = 'windows-mxc';
    expect(unavailableToolsForPlatform('win32')).toEqual([]);
    expect(unavailableToolsForPlatform('win32', { windowsMxcAvailable: true })).toEqual([]);
  });

  it('hides them on Linux when the systemd boundary probe fails', () => {
    expect(unavailableToolsForPlatform('linux', { linuxSystemdAvailable: false })).toEqual([
      'run_nodejs_script',
      'derive_file',
    ]);
  });

  it('keeps them on Linux when the systemd boundary probe succeeds', () => {
    expect(unavailableToolsForPlatform('linux', { linuxSystemdAvailable: true })).toEqual([]);
  });

  it('keeps deny-net script tools on macOS where Seatbelt supplies the boundary', () => {
    expect(unavailableToolsForPlatform('darwin')).toEqual([]);
  });

  it('offers them without a boundary when the policy already allows the network', () => {
    expect(unavailableToolsForPlatform('win32', { networkAllowed: true })).toEqual([]);
    expect(
      unavailableToolsForPlatform('linux', { linuxSystemdAvailable: false, networkAllowed: true }),
    ).toEqual([]);
  });
});
