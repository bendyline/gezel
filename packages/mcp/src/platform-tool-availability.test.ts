import { describe, expect, it } from 'vitest';
import { unavailableToolsForPlatform } from './platform-tool-availability.js';

describe('unavailableToolsForPlatform', () => {
  it('hides deny-net script tools on Windows', () => {
    expect(unavailableToolsForPlatform('win32')).toEqual(['run_nodejs_script', 'derive_file']);
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
});
