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
 * 0.6.6 is selected deliberately: it contains the Laguna text architecture
 * required by the Laguna S 2.1 MLX catalog entries and is newer than the
 * problematic 0.6.3/0.6.4 line. It was compatibility-checked against Gezel's
 * wrapper imports, Laguna tool templating, Qwen byte-BPE streaming, and a real
 * Gemma 4 generation. Keep upgrades explicit and re-sweep the MLX catalog
 * whenever this pin moves. */
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
