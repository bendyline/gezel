import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkGpuPanicGate,
  findRecentGpuPanics,
  formatGpuPanicWarning,
} from './gpu-panic-guard.ts';

const GPU_PANIC_BODY =
  '{"bug_type":"210"}\n{"panicString":"panic(cpu 9 caller 0x...): ' +
  '\\"completeMemory() prepare count underflow\\" @IOGPUMemory.cpp:550","name":"AGXAcceleratorG16X"}';
const UNRELATED_PANIC_BODY =
  '{"bug_type":"210"}\n{"panicString":"panic: watchdog timeout on cpu 3"}';

describe('gpu-panic-guard', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gezel-panic-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function writePanic(name: string, body: string, ageMs: number): void {
    const path = join(dir, name);
    writeFileSync(path, body);
    const when = (Date.now() - ageMs) / 1000;
    utimesSync(path, when, when);
  }

  it('detects a recent GPU-driver panic', () => {
    writePanic('panic-full-1.panic', GPU_PANIC_BODY, 30 * 60 * 1000); // 30m ago
    const found = findRecentGpuPanics({ dirs: [dir] });
    expect(found).toHaveLength(1);
    expect(found[0]?.signature).toMatch(/IOGPUMemory|completeMemory/);
  });

  it('ignores an unrelated (non-GPU) panic', () => {
    writePanic('panic-wdog.panic', UNRELATED_PANIC_BODY, 60 * 60 * 1000);
    expect(findRecentGpuPanics({ dirs: [dir] })).toEqual([]);
  });

  it('ignores a GPU panic older than the window', () => {
    writePanic('panic-old.panic', GPU_PANIC_BODY, 48 * 60 * 60 * 1000); // 2 days ago
    expect(findRecentGpuPanics({ dirs: [dir], withinMs: 24 * 60 * 60 * 1000 })).toEqual([]);
  });

  it('sorts newest first', () => {
    writePanic('panic-a.panic', GPU_PANIC_BODY, 5 * 60 * 60 * 1000);
    writePanic('panic-b.panic', GPU_PANIC_BODY, 1 * 60 * 60 * 1000);
    const found = findRecentGpuPanics({ dirs: [dir] });
    expect(found).toHaveLength(2);
    expect(found[0]?.when.getTime()).toBeGreaterThan(found[1]!.when.getTime());
  });

  describe('checkGpuPanicGate', () => {
    it('blocks an MLX sweep when a recent GPU panic exists', () => {
      writePanic('panic-full-1.panic', GPU_PANIC_BODY, 30 * 60 * 1000);
      const res = checkGpuPanicGate({ engine: 'mlx', dirs: [dir] });
      expect(res.block).toBe(true);
      expect(res.message).toMatch(/GPU KERNEL PANIC/);
    });

    it('does NOT block a non-MLX engine', () => {
      writePanic('panic-full-1.panic', GPU_PANIC_BODY, 30 * 60 * 1000);
      expect(checkGpuPanicGate({ engine: 'llama-cpp', dirs: [dir] }).block).toBe(false);
    });

    it('does NOT block when overridden', () => {
      writePanic('panic-full-1.panic', GPU_PANIC_BODY, 30 * 60 * 1000);
      const res = checkGpuPanicGate({ engine: 'mlx', dirs: [dir], ignore: true });
      expect(res.block).toBe(false);
      expect(res.panics).toHaveLength(1); // still reported, just not blocking
    });

    it('does NOT block when there is no recent panic', () => {
      expect(checkGpuPanicGate({ engine: 'mlx', dirs: [dir] }).block).toBe(false);
    });

    it('does NOT block when the panic is older than the one-hour default', () => {
      writePanic('panic-full-1.panic', GPU_PANIC_BODY, 61 * 60 * 1000);
      expect(checkGpuPanicGate({ engine: 'mlx', dirs: [dir] }).block).toBe(false);
    });
  });

  it('formats an operator warning', () => {
    writePanic('panic-full-1.panic', GPU_PANIC_BODY, 30 * 60 * 1000);
    const msg = formatGpuPanicWarning(findRecentGpuPanics({ dirs: [dir] }));
    expect(msg).toMatch(/--ignore-gpu-panic/);
    expect(msg).toMatch(/update macOS/);
  });
});
