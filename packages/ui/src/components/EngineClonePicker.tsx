import type { ConfigResponse } from '@bendyline/gezel-client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { formatMemoryBytes } from './model-memory-copy.js';

interface Props {
  provider: 'llama-cpp' | 'mlx';
  /** The model id this picker controls copies for. Typically the default. */
  modelId: string | null;
  /** Display name for `modelId`, when the installed list knows it. */
  modelName?: string;
  /** The model alone, which every extra copy loads again. */
  modelBytes?: number;
  config: ConfigResponse | null;
  onConfigChanged: (cfg: ConfigResponse) => void;
}

/**
 * Advanced → "Copies of the model" on the llama.cpp and MLX pages: how many
 * times one model is loaded (`config.localEngineReplicas[modelId]`). A
 * change triggers `POST /api/engines/reconcile` so the pool converges
 * without a restart. Each copy runs its own parallel workers, sized from
 * whatever memory is left, so the only fixed cost is the model itself.
 * Parallel workers are the everyday control; this one is rarely needed.
 *
 * Bounded by `config.localEngineReplicasMax` (default 4). When the broker
 * can't fit the requested copies, the budget bar shows what actually
 * loaded; the broker is the truth, so this picker doesn't second-guess it.
 */
export function EngineClonePicker({
  provider,
  modelId,
  modelName,
  modelBytes,
  config,
  onConfigChanged,
}: Props) {
  const max = config?.localEngineReplicasMax ?? 4;
  const replicasMap = config?.localEngineReplicas ?? {};
  const initial = modelId ? (replicasMap[modelId] ?? 1) : 1;
  const [value, setValue] = useState<number>(initial);
  const [busy, setBusy] = useState<'idle' | 'saving' | 'saved'>('idle');

  useEffect(() => {
    setValue(initial);
  }, [initial]);

  const apply = useCallback(
    async (next: number) => {
      if (!modelId) return;
      const bounded = Math.max(1, Math.min(max, next));
      setValue(bounded);
      setBusy('saving');
      try {
        const updatedReplicas: Record<string, number> = { ...replicasMap, [modelId]: bounded };
        const cfg = await api.updateConfig({ localEngineReplicas: updatedReplicas });
        onConfigChanged(cfg);
        // Push the runtime reconcile right after config persists so
        // the pool spawns/evicts to match without waiting for the
        // next chat turn to lazy-build.
        await api.reconcileEnginePool({ provider, clones: { [modelId]: bounded } });
        setBusy('saved');
        setTimeout(() => setBusy('idle'), 1200);
      } catch {
        setBusy('idle');
      }
    },
    [modelId, max, provider, replicasMap, onConfigChanged],
  );

  return (
    <div className="engine-copies">
      <h4>Copies of the model</h4>
      <p className="muted small">{copiesSentence(modelBytes)}</p>
      {modelId ? (
        <div className="engine-workers-row">
          <span>
            Copies of <b>{modelName ?? modelId}</b>
          </span>
          <button
            type="button"
            className="secondary"
            onClick={() => void apply(value - 1)}
            disabled={busy === 'saving' || value <= 1}
            aria-label="One fewer copy"
          >
            −
          </button>
          <output className="engine-workers-count" aria-label="Copies of the model">
            {value}
          </output>
          <button
            type="button"
            className="secondary"
            onClick={() => void apply(value + 1)}
            disabled={busy === 'saving' || value >= max}
            aria-label="One more copy"
          >
            +
          </button>
          <span className="engine-workers-total">{max} at most</span>
          {busy === 'saved' ? <output className="engine-workers-message">Saved</output> : null}
        </div>
      ) : (
        <p className="engine-workers-hint">
          Pick a default model to choose how many copies it gets.
        </p>
      )}
    </div>
  );
}

export function copiesSentence(modelBytes: number | undefined): string {
  const cost =
    modelBytes && modelBytes > 0
      ? `Each extra copy needs at least ${formatMemoryBytes(modelBytes)} more, plus room for its own workers.`
      : 'Each extra copy loads the model again, plus room for its own workers.';
  return `Load the model more than once. ${cost} Rarely needed: more parallel workers usually do the job.`;
}
