import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findRecentGpuPanics } from './gpu-panic.js';

const GPU_PANIC_BODY =
  '{"bug_type":"210"}\n{"panicString":"panic(cpu 9): \\"completeMemory() prepare count ' +
  'underflow\\" @IOGPUMemory.cpp:550","name":"AGXAcceleratorG16X"}';
const UNRELATED_PANIC = '{"bug_type":"210"}\n{"panicString":"panic: watchdog timeout on cpu 3"}';

describe('findRecentGpuPanics', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gezel-gpupanic-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function write(name: string, body: string, ageMs: number): void {
    const p = join(dir, name);
    writeFileSync(p, body);
    const when = (Date.now() - ageMs) / 1000;
    utimesSync(p, when, when);
  }

  it('detects a recent GPU-driver panic', () => {
    write('panic-full-1.panic', GPU_PANIC_BODY, 60 * 60 * 1000);
    const found = findRecentGpuPanics({ dirs: [dir] });
    expect(found).toHaveLength(1);
    expect(found[0]?.signature).toMatch(/IOGPUMemory|completeMemory/);
  });

  it('ignores a non-GPU panic', () => {
    write('panic-wdog.panic', UNRELATED_PANIC, 60 * 60 * 1000);
    expect(findRecentGpuPanics({ dirs: [dir] })).toEqual([]);
  });

  it('respects the time window', () => {
    write('panic-old.panic', GPU_PANIC_BODY, 48 * 60 * 60 * 1000);
    expect(findRecentGpuPanics({ dirs: [dir], withinMs: 24 * 60 * 60 * 1000 })).toEqual([]);
    expect(findRecentGpuPanics({ dirs: [dir], withinMs: 72 * 60 * 60 * 1000 })).toHaveLength(1);
  });

  it('sorts newest first', () => {
    write('panic-a.panic', GPU_PANIC_BODY, 5 * 60 * 60 * 1000);
    write('panic-b.panic', GPU_PANIC_BODY, 1 * 60 * 60 * 1000);
    const found = findRecentGpuPanics({ dirs: [dir] });
    expect(found).toHaveLength(2);
    expect(found[0]!.when.getTime()).toBeGreaterThan(found[1]!.when.getTime());
  });

  it('returns [] for a missing dir', () => {
    expect(findRecentGpuPanics({ dirs: [join(dir, 'nope')] })).toEqual([]);
  });
});
