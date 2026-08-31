/**
 * Single source of truth for the MLX Python venv spec — the venv name
 * and the package list `UvRuntime.ensureVenv` provisions.
 *
 * Two code paths provision this venv and they MUST request the
 * identical (name, packages):
 *
 *   1. The lazy first-chat path — `buildMlxProvider` awaits
 *      `ensureVenv` before spawning the engine.
 *   2. The parallel warm kicked off by `MlxModelManager` at install time,
 *      which
 *      overlaps the multi-minute uv/torch install with the model-
 *      weight download instead of paying it serially on the first turn.
 *
 * `ensureVenv` keys its idempotent fast-path on the (sorted) package
 * set, so any divergence between the two callers makes the second one
 * reinstall from scratch instead of hitting the warmed venv — which
 * defeats the entire point of warming. Funnel both through here.
 *
 * `torch` + `torchvision` are pinned on by default even though we never
 * compute in torch — `mlx-vlm` does inference in MLX directly. But many
 * catalog models (Qwen 3.5/3.6, future Gemma vision variants) ship a
 * `video_preprocessor_config.json`, which drives
 * `transformers.AutoProcessor.from_pretrained` to construct the model's
 * `*VideoProcessor` class — and those classes have hard
 * `requires_backends('torch', 'torchvision')` guards even when no video
 * is ever fed in. Without these two packages `mlx_vlm.utils.load()`
 * dies with `ImportError: <Class> requires the PyTorch library...`
 * before the engine reports ready. The Apple Silicon wheels are small
 * (~500 MB combined), so paying the disk cost universally is cheaper
 * than per-model gating.
 */

/** Default pin for the MLX backend. Advanced users override via
 * `config.mlxPackageSpec` (Settings → This Mac → Advanced).
 *
 * PINNED, not a floor. A floating `>=` spec previously pulled mlx-vlm 0.6.4
 * onto fresh machines and exposed a byte-fallback detokenizer regression in
 * ordinary Qwen output, killing the engine mid-turn and breaking tool calls.
 * The 0.6.6 line that replaced it carried the Laguna text architecture and was
 * compatibility-checked against Gezel's wrapper imports, Laguna tool
 * templating, Qwen byte-BPE streaming, and a real Gemma 4 generation.
 *
 * 0.6.14 was TRIED and REVERTED on 2026-08-18. The theory was that its
 * rewritten `BatchKVCache` would restore prompt-cache reuse — MLX was
 * re-prefilling every turn (23.5% hit rate, median 0 cached tokens). That
 * theory was wrong twice over: 0.6.6's `mlx_vlm.models.cache.BatchKVCache`
 * already implements `is_trimmable()`/`trim()` (an earlier check misread the
 * `mlx_lm` copy), and on 0.6.14 the cache did not improve — 20.8% hit rate,
 * still median 0 cached. Meanwhile a paired A/B on qwen3.8-27b-q4 measured a
 * large slowdown at unchanged 10/10 task success:
 *
 *     tictactoe   8.4 min -> 15.9 min      tankcombat  12.7 min -> 23.3 min
 *     probe throughput 55.8 -> 40.7 gen tok/s
 *
 * The re-prefill cause that bump chased was later found and fixed
 * gezel-side (roster-shaped cache identity + the §12b snapshot machinery
 * — docs/kv-prompt-caching-strategy.md).
 *
 * 0.6.17 (2026-08-28): bumped for MTP speculative decoding, and the bump
 * is correctness-forced — 0.6.6's MTP verify is measured-INEXACT (greedy
 * spec diverged from greedy no-spec; reports/mlx-mtp-rig-20260828.md),
 * and spec_decode.py refuses to arm speculation below 0.6.17. The line
 * also carries 0.6.15's batch-row isolation fix and 0.6.16's ArraysCache
 * per-token Metal buffer leak fix (measured: that leak fix does NOT cure
 * the vlm-tower decode slope under mlx_lm's BatchGenerator — 1.01 → 0.83
 * ms/tok per 10k ctx — so the text-tower split stays). Exactness and the
 * ~1.4x speedup are verified on-device for this list's resolved set
 * (mlx-lm 0.31.3 with mlx 0.32.0; the rig also verified mlx 0.32.2).
 *
 * Keep upgrades explicit and re-sweep the MLX catalog whenever this pin
 * moves. */
export const MLX_DEFAULT_PACKAGE_SPEC = 'mlx-vlm==0.6.17';

/** Venv name passed to `UvRuntime.ensureVenv` (and its dir basename). */
export const MLX_VENV_NAME = 'mlx';

/**
 * The package list to install into the MLX venv. `packageSpec` is the
 * user's optional `config.mlxPackageSpec` override; when unset we pin
 * {@link MLX_DEFAULT_PACKAGE_SPEC}.
 */
export function mlxVenvPackages(packageSpec?: string): string[] {
  // `llguidance` backs decode-time tool-call grammars (see
  // providers/mlx/python/tool_grammar.py). It ships today as a transitive
  // mlx-vlm dependency, but pin it explicitly so the grammar safety net
  // can't silently vanish under a future mlx-vlm that drops it.
  //
  // `mlx-lm` is load-bearing twice over — the sidecar's batch engine
  // (`from mlx_lm.generate import BatchGenerator`) and the qwen3_5 text
  // tower both live there — and mlx-vlm 0.6.17 no longer declares it as
  // a dependency (0.6.6 did, which is the only reason the old list
  // worked). Dropping this pin kills the batch engine at import time.
  // 0.31.3 is the combination every 2026-08-28 measurement ran on.
  return [
    packageSpec ?? MLX_DEFAULT_PACKAGE_SPEC,
    'mlx-lm==0.31.3',
    'torch',
    'torchvision',
    'llguidance',
  ];
}
