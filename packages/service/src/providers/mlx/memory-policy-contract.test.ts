/**
 * Source-contract coverage for the MLX sidecar's process-wide memory policy.
 *
 * mlx_lm owns the BatchGenerator implementation, so an upstream constructor
 * can silently mutate process-global MLX settings underneath Gezel. These
 * tests pin our ordering and the turn-boundary wiring without importing MLX in
 * Node CI.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SERVER_SRC = readFileSync(
  fileURLToPath(new URL('./python/gezel_mlx_server.py', import.meta.url)),
  'utf8',
);

function sliceBlock(source: string, header: string): string {
  const start = source.indexOf(header);
  expect(start, `${header} not found in gezel_mlx_server.py`).toBeGreaterThan(-1);
  const rest = source.slice(start + header.length);
  const end = rest.search(/\n(?:def |class |@)/);
  return end === -1 ? rest : rest.slice(0, end);
}

describe('MLX sidecar memory policy', () => {
  it('sets separate wired and free-buffer limits', () => {
    const setup = sliceBlock(SERVER_SRC, 'def _setup_gpu_memory_ceiling(');
    const apply = sliceBlock(SERVER_SRC, 'def _apply_mlx_memory_policy(');
    expect(setup).toMatch(/_WIRED_LIMIT_BYTES/);
    expect(setup).toMatch(/_MLX_BUFFER_CACHE_LIMIT_BYTES/);
    expect(apply).toMatch(/set_wired_limit/);
    expect(apply).toMatch(/set_cache_limit/);
  });

  it('reapplies Gezel policy after BatchGenerator construction', () => {
    const batch = sliceBlock(SERVER_SRC, 'class BatchEngine:');
    const constructorAt = batch.indexOf('self._gen = BatchGenerator(');
    const policyAt = batch.indexOf('_apply_mlx_memory_policy("batch-init")');
    expect(constructorAt).toBeGreaterThan(-1);
    expect(policyAt).toBeGreaterThan(constructorAt);
  });

  it('checks pressure during long batched turns', () => {
    const run = sliceBlock(SERVER_SRC, 'async def _run(');
    expect(run).toMatch(/_memory_check_steps >= 32/);
    expect(run).toMatch(/_reclaim_mlx_buffer_cache\("batch-pressure"\)/);
  });

  it('keeps a fourth request queued when max concurrency is three', () => {
    const admit = sliceBlock(SERVER_SRC, 'def _admit_count(');
    expect(admit).toMatch(/capped = min\(pending, self\._max\)/);
    expect(admit).toMatch(/return capped {2}# can't read usage/);
    expect(admit).toMatch(/return 1 if active >= threshold else capped/);
    expect(admit).not.toMatch(/return 1 if active >= threshold else pending/);

    const run = sliceBlock(SERVER_SRC, 'async def _run(');
    expect(run).toMatch(/admit_n = self\._admit_count\(len\(self\._pending\)\)/);
    expect(run).toMatch(/self\._pending = self\._pending\[admit_n:\]/);
  });

  it('reclaims and logs at batched stream and warm boundaries', () => {
    const stream = sliceBlock(SERVER_SRC, 'async def _batched_stream_iter(');
    const warm = sliceBlock(SERVER_SRC, 'async def _await_batched_completion(');
    for (const block of [stream, warm]) {
      expect(block).toMatch(/_reclaim_mlx_buffer_cache\(/);
      expect(block).toMatch(/force=engine is None or engine\.is_idle\(\)/);
      expect(block).toMatch(/log=True/);
    }
  });

  it('also reclaims at serial agentic sub-turn boundaries', () => {
    const chat = sliceBlock(SERVER_SRC, 'async def chat_completions(');
    expect(chat).toMatch(/_reclaim_mlx_buffer_cache\("turn-end", force=True, log=True\)/);
  });

  it('reports active, cached, peak, and configured limits together', () => {
    const log = sliceBlock(SERVER_SRC, 'def _log_memory(');
    expect(log).toMatch(/_safe_active_memory\(\)/);
    expect(log).toMatch(/_safe_cache_memory\(\)/);
    expect(log).toMatch(/_safe_peak_memory\(\)/);
    expect(log).toMatch(/wired_limit=/);
    expect(log).toMatch(/cache_limit=/);
  });
});
