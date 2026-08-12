import { describe, expect, it } from 'vitest';
import { windowsDetachedSpawnOptions, windowsHeadlessSpawnOptions } from './console-detach.js';

describe('Windows child-process console options', () => {
  it('hides owned Windows children without detaching them', () => {
    expect(windowsHeadlessSpawnOptions('win32')).toEqual({ windowsHide: true });
  });

  it('hides genuinely detached Windows children as they start', () => {
    expect(windowsDetachedSpawnOptions('win32')).toEqual({
      detached: true,
      windowsHide: true,
    });
  });

  it('does not change POSIX process-group behavior', () => {
    expect(windowsHeadlessSpawnOptions('linux')).toEqual({});
    expect(windowsDetachedSpawnOptions('darwin')).toEqual({});
  });
});
