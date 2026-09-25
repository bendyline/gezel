import { describe, expect, it } from 'vitest';
import { runUnderMacSandbox } from './macos.js';

describe('macOS browser subprocess policy', () => {
  it('allows only Chromium rendezvous registration for opted-in workspace commands', () => {
    const ctx = { workdir: '/tmp/work', scratch: '/tmp/scratch' };
    const normal = runUnderMacSandbox('node', ['test.mjs'], ctx, { allowBrowserIpc: true })
      .args[1]!;
    expect(normal).toContain(
      '(allow mach-register (global-name-regex #"^org[.]chromium[.].*[.]MachPortRendezvousServer[.][0-9]+$"))',
    );
    expect(normal).toContain('(deny default)');
    expect(normal).toContain('(subpath "/tmp/work")');
    const gate = runUnderMacSandbox('node', ['gate.mjs'], ctx, { denyNet: true }).args[1]!;
    expect(gate).not.toContain('mach-register');
    expect(gate).toContain('(deny network*)');
  });
});
