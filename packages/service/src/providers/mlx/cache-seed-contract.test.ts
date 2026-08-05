/**
 * Source-contract test for the MLX sidecar's prompt-cache seeding.
 *
 * The regression this pins: the BatchGenerator path (`--max-concurrency >= 1`)
 * originally reused a session's cache only when the previous turn's
 * ENTIRE saved token sequence — prompt plus raw generated tokens — was
 * an exact prefix of the new prompt. Verbose families (Gemma) never
 * satisfy that: the TS side strips leaked reasoning / tool markup out
 * of the persisted assistant message, so the re-templated history
 * diverges from the raw tokens and every turn re-prefilled the whole
 * ~20K-token conversation (~2 minutes) while `[cache] hit` lines made
 * the cache look healthy. The fix routes seeding through cache_seed.py
 * (LCP + protocol trim) and, for windowed models whose wrapped rotating
 * caches can't trim at all, saves a KV snapshot captured at a
 * deliberate segment cut near the prompt's end — a stable boundary the
 * next turn extends without any trim.
 *
 * Behavior is proven by `python/cache_seed_test.py` (pure-python fakes)
 * and was validated live against gemma4-12b-q4 (turn-2 prefill 5216 →
 * 37 tokens). No python runs in CI, so vitest pins the *wiring* here —
 * same shape as prompt-tool-linkage.test.ts.
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
  // Next top-level `def`/`class` (or decorator) ends the block.
  const end = rest.search(/\n(?:def |class |@)/);
  return end === -1 ? rest : rest.slice(0, end);
}

describe('MLX sidecar cache seeding', () => {
  it('imports the cache_seed planner module', () => {
    expect(SERVER_SRC).toMatch(/^import cache_seed/m);
  });

  it('seeds the batched path from the LCP plan, not an exact-prefix check', () => {
    const seed = sliceBlock(SERVER_SRC, 'def _seed_args(');
    expect(seed).toMatch(/cache_seed\.seed_from_state\(/);
    // The all-or-nothing check this replaced must not come back.
    expect(seed).not.toMatch(/full\[:n\] == cached/);
    // Authoritative liveness/usage counts come from the plan.
    expect(seed).toMatch(/sub\.prefill_total = len\(plan\.segment\)/);
    expect(seed).toMatch(/sub\.reused_tokens = plan\.reused/);
    // The one-line grep for "is the cache actually being used?".
    expect(seed).toMatch(/\[batch\] seed cache_id=/);
    // This should be exceptional after prompt snapshots are established; make
    // any recurrence loud enough to diagnose from a debug bundle.
    expect(seed).toMatch(/WARNING full prefill/);
    expect(seed).toMatch(/plan\.mode == "fresh-untrimmable"/);
  });

  it('drives the engine per-step so segment edges are observable', () => {
    const run = sliceBlock(SERVER_SRC, 'async def _run(');
    // next() (not next_generated()) returns after every internal step —
    // prompt chunks included — which is what makes the mid-prompt
    // snapshot capturable and the prefill progress real.
    expect(run).toMatch(/self\._gen\.next\(\)/);
    expect(run).not.toMatch(/self\._gen\.next_generated\(\)/);
    expect(run).toMatch(/self\._capture_prompt_snapshot\(psub, boundary\)/);
  });

  it('plants a deliberate segment cut clear of the re-merging prompt tail', () => {
    const run = sliceBlock(SERVER_SRC, 'async def _run(');
    const segments = sliceBlock(SERVER_SRC, 'def _snapshot_segments(');
    expect(run).toMatch(/insert_segments\(/);
    expect(segments).toMatch(/cache_seed\.plan_snapshot_segments\(/);
    expect(segments).toMatch(/sub\.snapshot_target = plan\.target/);
    // The margin constant itself, with a sane value.
    expect(SERVER_SRC).toMatch(/_SNAPSHOT_BOUNDARY_MARGIN = \d+/);
    // Snapshot mode is probed per model, surfaced in the ready log.
    expect(SERVER_SRC).toMatch(/cache_seed\.probe_needs_prompt_snapshot\(/);
  });

  it('verifies the snapshot boundary at capture time', () => {
    const snap = sliceBlock(SERVER_SRC, 'def _capture_prompt_snapshot(');
    // Runtime proof of the per-sequence boundary invariant, including the
    // unpadded token list returned alongside the extracted layers.
    expect(snap).toMatch(/extracted_tokens = got\[1\]/);
    expect(snap).toMatch(/cache_seed\.snapshot_matches_prompt\(/);
  });

  it('captures one padding-aware snapshot for every sub in a wave', () => {
    const run = sliceBlock(SERVER_SRC, 'async def _run(');
    expect(run).toMatch(/getattr\(pr, "end_of_segment", False\)/);
    expect(run).toMatch(/boundary == psub\.snapshot_target/);
    expect(run).not.toMatch(/len\(self\._subs\) == 1/);
  });

  it('saves the snapshot when the post-generation cache cannot be trimmed', () => {
    const finish = sliceBlock(SERVER_SRC, 'def _finish(');
    expect(finish).toMatch(/cache_seed\.all_trimmable\(post_gen\)/);
    expect(finish).toMatch(/sub\.prompt_tokens\[:snap_count\]/);
    // A tiny turn with no stable snapshot keeps the prior entry rather
    // than overwriting it with un-trimmable full-length state.
    expect(finish).toMatch(/kept prior cache entry/);
    // Reuse parity log with the serial path, tagged for the batched route.
    expect(finish).toMatch(/\[cache\] reuse cache_id=/);
    expect(finish).toMatch(/\[batched\]/);
  });

  it('reports cached_tokens in the batched SSE usage frames', () => {
    const iter = sliceBlock(SERVER_SRC, 'async def _batched_stream_iter(');
    const matches = iter.match(/"cached_tokens": sub\.reused_tokens/g) ?? [];
    // Streaming frames and the terminal frame.
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it('uses the cache-safe BatchGenerator path for singleton queues', () => {
    const chat = sliceBlock(SERVER_SRC, 'async def chat_completions(');
    // Memory pressure commonly clamps large Qwen models to concurrency=1.
    // That must still use prompt snapshots; routing 1 through the legacy
    // serial path cold-prefills every divergent tool-loop iteration.
    expect(chat).toMatch(/max_concurrency[^\n]*or 0\) >= 1/);
    expect(chat).not.toMatch(/max_concurrency > 1/);
  });

  it('does not compute prefill_total from entry size in chat_completions', () => {
    const chat = sliceBlock(SERVER_SRC, 'async def chat_completions(');
    // The old arithmetic under-reported the liveness total by ~40× when
    // the seed was rejected, silencing Prefill markers during the very
    // re-prefills they exist to surface.
    expect(chat).not.toMatch(/len\(prompt_tokens\) - prior_tokens/);
  });

  it('guards only the explicit serial fallback against incoherent slice-trim', () => {
    const chat = sliceBlock(SERVER_SRC, 'async def chat_completions(');
    expect(chat).toMatch(/cache_seed\.serial_reset_needed\(/);
  });

  it('warms through the same snapshot-capable BatchEngine path', () => {
    const warm = sliceBlock(SERVER_SRC, 'async def cache_warm(');
    expect(warm).toMatch(/cache_seed\.stable_snapshot_boundary\(/);
    expect(warm).toMatch(/_get_batch_engine\(\)\.submit\(sub\)/);
    expect(warm).toMatch(/await _await_batched_completion\(sub\)/);
    expect(warm).not.toMatch(/stream_generate\(/);
    expect(warm).not.toMatch(/serial_reset_needed\(/);
  });
});
