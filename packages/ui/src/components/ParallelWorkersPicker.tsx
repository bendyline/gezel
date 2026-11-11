import type { ConfigResponse } from '@bendyline/gezel-client';
import { apiErrorMessage } from '@bendyline/gezel-client';
import { useState } from 'react';
import { api } from '../api.js';
import { formatMemoryBytes } from './model-memory-copy.js';

/** The installed-model row fields this control prices workers from. */
export interface WorkerPricedModel {
  name: string;
  /** The model alone, with runtime overhead. */
  weightsResidentBytes?: number;
  /** The model plus `plannedSlots` chats at full length: what the launch reserves. */
  reservedResidentBytes?: number;
  /** Chats the launch runs at once under the current setting. */
  plannedSlots?: number;
}

/** Highest worker count the control offers; the CLI accepts more. */
const MAX_WORKERS = 16;

/**
 * Settings → llama.cpp / MLX: how many chats one loaded model answers at
 * once (`config.providerConcurrency[engine]`, the engine's slot count).
 * Unset is Automatic: as many as fit at full length in the memory budget.
 * A change releases idle engines, so the next chat starts with it.
 *
 * Priced from the default model's row, whose reservation is the model plus
 * one full-length chat per worker, so the figures add up with the budget
 * bar beside them.
 */
export function ParallelWorkersPicker({
  provider,
  model,
  config,
  onConfigChanged,
  onSaved,
}: {
  provider: 'llama-cpp' | 'mlx';
  model?: WorkerPricedModel;
  config: ConfigResponse | null;
  onConfigChanged: (cfg: ConfigResponse) => void;
  /** Re-read the installed rows so the planned count and figures follow. */
  onSaved?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  const chosen = config?.providerConcurrency?.[provider];
  const automatic = chosen === undefined;
  const shown = chosen ?? model?.plannedSlots;
  const pricing = workerPricing(model);

  const save = async (next: number | undefined) => {
    setBusy(true);
    setMessage(null);
    try {
      const record = { ...(config?.providerConcurrency ?? {}) };
      if (next === undefined) delete record[provider];
      else record[provider] = next;
      const cfg = await api.updateConfig({ providerConcurrency: record });
      onConfigChanged(cfg);
      onSaved?.();
      setMessage({ text: 'Saved. It applies from the next chat.', error: false });
    } catch (err) {
      setMessage({ text: apiErrorMessage(err), error: true });
    } finally {
      setBusy(false);
    }
  };

  const step = (delta: number) => {
    const base = shown ?? 1;
    const next = Math.max(1, Math.min(MAX_WORKERS, base + delta));
    if (next !== chosen) void save(next);
  };

  return (
    <div className="engine-workers">
      <h4>Parallel workers</h4>
      <p className="muted small">{workersSentence(model?.name, pricing)}</p>
      <div className="engine-workers-row">
        <button
          type="button"
          className="secondary"
          aria-label="One fewer worker"
          disabled={busy || (shown ?? 1) <= 1}
          onClick={() => step(-1)}
        >
          −
        </button>
        <output className="engine-workers-count" aria-label="Parallel workers">
          {shown ?? '—'}
        </output>
        <button
          type="button"
          className="secondary"
          aria-label="One more worker"
          disabled={busy || (shown ?? 1) >= MAX_WORKERS}
          onClick={() => step(1)}
        >
          +
        </button>
        {automatic ? (
          <span className="gz-budget-tag">Automatic</span>
        ) : (
          <button
            type="button"
            className="gz-link-button"
            disabled={busy}
            onClick={() => void save(undefined)}
          >
            Use automatic
          </button>
        )}
        {pricing && shown !== undefined && (
          <span className="engine-workers-total">
            About {formatMemoryBytes(pricing.modelBytes + pricing.perWorkerBytes * shown)} in all
          </span>
        )}
      </div>
      <p className="engine-workers-hint">Automatic runs as many as fit in the memory above.</p>
      {message && (
        <output
          className={message.error ? 'engine-workers-message error' : 'engine-workers-message'}
        >
          {message.text}
        </output>
      )}
    </div>
  );
}

/**
 * The model alone and what one more worker adds. Absent when the row lacks
 * a priced plan (an older daemon, unreadable weights).
 */
export function workerPricing(
  model: WorkerPricedModel | undefined,
): { modelBytes: number; perWorkerBytes: number } | undefined {
  const weights = model?.weightsResidentBytes;
  const reserved = model?.reservedResidentBytes;
  const slots = model?.plannedSlots;
  if (!weights || !reserved || !slots || slots < 1 || reserved <= weights) return undefined;
  return { modelBytes: weights, perWorkerBytes: (reserved - weights) / slots };
}

export function workersSentence(
  modelName: string | undefined,
  pricing: { modelBytes: number; perWorkerBytes: number } | undefined,
): string {
  const lead = 'How many chats run at the same time.';
  if (!pricing) return `${lead} Each worker needs extra memory for its chat.`;
  const subject = modelName ?? 'This model';
  return `${lead} ${subject} uses ${formatMemoryBytes(pricing.modelBytes)} by itself, and each worker adds about ${formatMemoryBytes(pricing.perWorkerBytes)}.`;
}
