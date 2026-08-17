/**
 * Reconciling a `config.defaultModel` pin against the weights actually on disk.
 *
 * The pin and the inventory are produced by different actors, and in a
 * machine-service install they live in two different homes: first-run pins the
 * hardware-recommended tier into the user's `config.json` before any weights
 * exist, while the weights land under the shared machine asset root. Nothing in
 * that handshake guarantees the pinned id ever finishes downloading, and a pin
 * naming weights that never landed breaks every session built from it.
 *
 * Wild-caught on a machine-service install whose first-run pinned
 * `qwen3.6-27b-q8` on a 122 GB host: the download stalled at 257 MB, the user
 * installed `gemma4-e4b-q4` instead, and chat stayed broken for hours because
 * three separate layers each declined to repair the pin — the first-run
 * re-eval only acts when the tier resolver picks a *different* model (on stable
 * hardware it re-picks the same unavailable one), the Home banner reads a
 * missing pin as "needs download" and waits for a click, and the Settings
 * default-model picker is deliberately hidden while fewer than two models are
 * installed. Every session then stamped the phantom id, and the machine engine
 * answered each admission with `model_not_loaded`.
 *
 * So the pin has to reconcile itself against inventory. This module owns that
 * decision and nothing else; callers supply the inventory and apply the result.
 */

/**
 * The fields this decision reads from an installed on-device model. Satisfied
 * structurally by both `InstalledLlamaCppModel` and `InstalledMlxModel` so the
 * llama.cpp, ds4, and MLX stores can all be reconciled by one function.
 */
export interface InstalledModelSummary {
  id: string;
  approxSizeBytes: number;
  installedAt: string;
}

export type DefaultModelReconciliation =
  /** The pin names an installed model — leave it alone. */
  | { kind: 'ok' }
  /** The pin is unusable and this installed model should stand in for it. */
  | { kind: 'substitute'; modelId: string }
  /** The pin is unusable and there is nothing to fall back to. */
  | { kind: 'nothing-installed' };

function installedAtMs(model: InstalledModelSummary): number {
  const parsed = Date.parse(model.installedAt);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Choose the model that should stand in for an unusable pin.
 *
 * The case that matters in practice is a single installed model, where every
 * conceivable rule agrees. When several are installed, the most recent install
 * is the best available evidence of what the user actually reached for — the
 * abandoned pin is by definition older than the model they went and fetched
 * afterwards. The remaining tie-breaks exist purely so the answer is stable
 * across calls: a fallback that alternated between two models would spool a
 * second engine replica and split the prompt cache for no benefit.
 */
export function pickDefaultModelFallback(
  installed: readonly InstalledModelSummary[],
): string | undefined {
  const ranked = [...installed].sort(
    (a, b) =>
      installedAtMs(b) - installedAtMs(a) ||
      b.approxSizeBytes - a.approxSizeBytes ||
      a.id.localeCompare(b.id),
  );
  return ranked[0]?.id;
}

/**
 * Decide what to do about `pinned` given the current inventory. An absent pin
 * is treated the same as a dead one: both leave sessions with no servable
 * model, and both are repaired by naming something that exists.
 */
export function reconcileDefaultModel(args: {
  pinned?: string;
  installed: readonly InstalledModelSummary[];
}): DefaultModelReconciliation {
  if (args.pinned && args.installed.some((m) => m.id === args.pinned)) return { kind: 'ok' };
  const fallback = pickDefaultModelFallback(args.installed);
  return fallback ? { kind: 'substitute', modelId: fallback } : { kind: 'nothing-installed' };
}
