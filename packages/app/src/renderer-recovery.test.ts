import { describe, expect, it } from 'vitest';
import { RendererMemoryLog, RendererRecovery } from './renderer-recovery.js';

// A renderer that crashed at 01:47 left the window on its bare background for
// five hours (2026-10-10).
describe('renderer recovery', () => {
  it('reloads a crashed renderer, a few times, then stops', () => {
    let now = 0;
    const recovery = new RendererRecovery({ maxReloads: 3, windowMs: 600_000, now: () => now });
    expect(recovery.shouldReload('clean-exit')).toBe(false);
    expect([1, 2, 3, 4].map(() => recovery.shouldReload('crashed'))).toEqual([
      true,
      true,
      true,
      false,
    ]);
    // Crashes far apart are each a fresh incident.
    now += 600_000;
    expect(recovery.shouldReload('oom')).toBe(true);
  });

  it('logs memory only at each new high step, and from zero after a reload', () => {
    const log = new RendererMemoryLog(256);
    expect(log.reading(200)).toBeNull();
    expect(log.reading(300)).toBe('[renderer] memory 300 MB');
    expect(log.reading(500)).toBeNull();
    expect(log.reading(600)).toBe('[renderer] memory 600 MB');
    log.reset();
    expect(log.reading(260)).toBe('[renderer] memory 260 MB');
  });
});
