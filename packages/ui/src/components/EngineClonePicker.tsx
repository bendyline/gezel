import type { ConfigResponse } from '@bendyline/gezel-client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';

interface Props {
  provider: 'llama-cpp' | 'mlx';
  /** The model id this picker controls clones for. Typically the default. */
  modelId: string | null;
  config: ConfigResponse | null;
  onConfigChanged: (cfg: ConfigResponse) => void;
}

/**
 * Compact clone-count picker for one model. Updates `config.localEngineReplicas[modelId]`
 * and triggers `POST /api/engines/reconcile` so the warm pool converges to the new
 * count without restart.
 *
 * Bounded by `config.localEngineReplicasMax` (default 4). When the broker can't fit
 * the requested clones the snapshot polled by {@link EngineBudgetStrip} surfaces the
 * actual resident count — the picker doesn't second-guess; the broker is the truth.
 */
export function EngineClonePicker({ provider, modelId, config, onConfigChanged }: Props) {
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

  if (!modelId) {
    return (
      <div style={{ fontSize: 12, color: 'var(--gz-color-muted, #888)' }}>
        Pick a default model to enable clone control.
      </div>
    );
  }

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '0.5rem',
        padding: '0.5rem 0',
        fontSize: 13,
      }}
    >
      <span style={{ minWidth: 220 }}>
        Clones of <b>{modelId}</b> kept resident:
      </span>
      <button
        type="button"
        onClick={() => void apply(value - 1)}
        disabled={busy === 'saving' || value <= 1}
        style={{ width: 28 }}
      >
        −
      </button>
      <span style={{ minWidth: 28, textAlign: 'center', fontVariantNumeric: 'tabular-nums' }}>
        {value}
      </span>
      <button
        type="button"
        onClick={() => void apply(value + 1)}
        disabled={busy === 'saving' || value >= max}
        style={{ width: 28 }}
      >
        +
      </button>
      <span style={{ fontSize: 12, color: 'var(--gz-color-muted, #888)' }}>(max {max})</span>
      {busy === 'saved' ? <span style={{ fontSize: 12 }}>saved ✓</span> : null}
    </div>
  );
}
