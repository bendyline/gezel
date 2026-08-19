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
 * So the line stays at 0.6.6 until there is a reason that survives
 * measurement. The real cause of the re-prefill is still open — the leading
 * suspect is qwen3.8's hybrid stack, whose `linear_attention` layers hold
 * recurrent state and cannot be rewound, failing `trim_layers`'
 * all-or-nothing check regardless of what the batched cache supports. See
 * docs/kv-prompt-caching-strategy.md §12b.
 *
 * Keep upgrades explicit and re-sweep the MLX catalog whenever this pin
 * moves. */
export const MLX_DEFAULT_PACKAGE_SPEC = 'mlx-vlm==0.6.6';

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
  return [packageSpec ?? MLX_DEFAULT_PACKAGE_SPEC, 'torch', 'torchvision', 'llguidance'];
}
