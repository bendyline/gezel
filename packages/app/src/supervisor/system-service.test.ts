import { describe, expect, it } from 'vitest';
import { systemServiceHome } from './system-service.js';

describe('system-service platform boundary', () => {
  it('discovers the machine-wide Windows service through ProgramData', () => {
    expect(systemServiceHome('win32', { ProgramData: 'D:\\MachineData' })).toBe(
      'D:\\MachineData\\Gezel',
    );
  });

  it('accepts the conventional uppercase ProgramData environment key', () => {
    expect(systemServiceHome('win32', { PROGRAMDATA: 'E:\\SharedData' })).toBe(
      'E:\\SharedData\\Gezel',
    );
  });

  it('retains the dedicated non-root service homes on Unix', () => {
    expect(systemServiceHome('darwin')).toBe('/Library/Application Support/Gezel');
    expect(systemServiceHome('linux')).toBe('/var/lib/gezel');
  });
});
