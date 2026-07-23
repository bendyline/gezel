import type { GpuPanicRecord } from '@bendyline/gezel/native';
import { describe, expect, it } from 'vitest';
import { GpuPanicGuard } from './gpu-panic-guard.js';

function panic(agoMs: number): GpuPanicRecord {
  return {
    file: '/Library/Logs/DiagnosticReports/panic-full.panic',
    when: new Date(Date.now() - agoMs),
    signature: 'completeMemory() prepare count underflow',
  };
}

describe('GpuPanicGuard', () => {
  it('blocks a local GPU engine spawn when a recent panic exists', () => {
    const guard = new GpuPanicGuard({ enabled: true, find: () => [panic(60 * 60 * 1000)] });
    const d = guard.check('mlx');
    expect(d.blocked).toBe(true);
    expect(d.reason).toMatch(/GPU kernel panic/);
    expect(d.reason).toMatch(/GEZEL_GPU_PANIC_GUARD=off/);
  });

  it('blocks llama-cpp + ds4 too (all Metal on a Mac)', () => {
    const guard = new GpuPanicGuard({ enabled: true, find: () => [panic(60 * 60 * 1000)] });
    expect(guard.check('llama-cpp').blocked).toBe(true);
    expect(guard.check('ds4').blocked).toBe(true);
  });

  it('does not block when there is no recent panic', () => {
    const guard = new GpuPanicGuard({ enabled: true, find: () => [] });
    expect(guard.check('mlx').blocked).toBe(false);
  });

  it('is a no-op when disabled (e.g. non-macOS or GEZEL_GPU_PANIC_GUARD=off)', () => {
    const guard = new GpuPanicGuard({ enabled: false, find: () => [panic(60 * 60 * 1000)] });
    expect(guard.check('mlx').blocked).toBe(false);
  });

  it('passes its cooldown window to the detector', () => {
    let seenWithin: number | undefined;
    const guard = new GpuPanicGuard({
      enabled: true,
      cooldownMs: 3 * 60 * 60 * 1000,
      find: (o) => {
        seenWithin = o?.withinMs;
        return [];
      },
    });
    guard.check('mlx');
    expect(seenWithin).toBe(3 * 60 * 60 * 1000);
  });

  it('defaults the cooldown window to one hour', () => {
    let seenWithin: number | undefined;
    const guard = new GpuPanicGuard({
      enabled: true,
      find: (o) => {
        seenWithin = o?.withinMs;
        return [];
      },
    });
    guard.check('mlx');
    expect(seenWithin).toBe(60 * 60 * 1000);
  });
});
