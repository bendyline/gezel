import { describe, expect, it } from 'vitest';
import { resolveHostMode } from './host-mode.js';

describe('resolveHostMode', () => {
  it('spawns a child under Electron', () => {
    // Importing the service into Electron's main process would need every
    // native dependency rebuilt for Electron's ABI.
    expect(resolveHostMode({}, true)).toBe('child');
  });

  it('stays in-process everywhere else', () => {
    expect(resolveHostMode({}, false)).toBe('in-process');
  });

  it('lets the caller override either default', () => {
    expect(resolveHostMode({ mode: 'in-process' }, true)).toBe('in-process');
    expect(resolveHostMode({ mode: 'child' }, false)).toBe('child');
  });
});
