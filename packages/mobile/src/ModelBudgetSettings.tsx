import {
  type MobileProvider,
  resolveMobileInferenceBudget,
} from '@bendyline/gezel/mobile-providers';
import type { PortableProductService } from '@bendyline/gezel/runtime';
import { useEffect, useState } from 'react';

/** Uses the desktop engine context and model tuning fields; no mobile config fork. */
export function ModelBudgetSettings({
  service,
  provider,
  modelId,
  disabled,
  refresh,
  onError,
}: {
  service: PortableProductService;
  provider: MobileProvider;
  modelId: string;
  disabled: boolean;
  refresh(): Promise<void>;
  onError(error: unknown): void;
}) {
  const [contextSize, setContextSize] = useState('4096');
  const [maxTokens, setMaxTokens] = useState('1024');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const key = `${provider.id}:${modelId}`;
  useEffect(() => {
    let live = true;
    setSaved(false);
    void service.store
      .readConfig()
      .then((config) => {
        if (!live) return;
        // Show an out-of-range saved choice so it can be corrected explicitly.
        const defaults = resolveMobileInferenceBudget({
          contextTokens: provider.contextTokens,
          maxOutputTokens: provider.maxOutputTokens,
        });
        setContextSize(String(config.modelContextOverrides?.[key] ?? defaults.contextSize));
        setMaxTokens(
          String(config.modelTuning?.[modelId]?.sampling?.maxTokens ?? defaults.maxTokens),
        );
      })
      .catch(onError);
    return () => {
      live = false;
    };
  }, [service, key, modelId, provider.contextTokens, provider.maxOutputTokens, onError]);
  return (
    <form
      className="mobile-model-library"
      onSubmit={(event) => {
        event.preventDefault();
        if (disabled || saving) return;
        setSaving(true);
        setSaved(false);
        void service
          .withModelChange(async () => {
            const budget = resolveMobileInferenceBudget(provider, {
              contextSize: Number(contextSize),
              maxTokens: Number(maxTokens),
            });
            const config = await service.store.readConfig();
            const tuning = config.modelTuning?.[modelId];
            await service.store.writeConfig({
              modelContextOverrides: { ...config.modelContextOverrides, [key]: budget.contextSize },
              modelTuning: {
                ...config.modelTuning,
                [modelId]: {
                  ...tuning,
                  sampling: { ...tuning?.sampling, maxTokens: budget.maxTokens },
                },
              },
            });
          })
          .then(async () => {
            setSaved(true);
            await refresh();
          })
          .catch(onError)
          .finally(() => setSaving(false));
      }}
    >
      <h3>Conversation limits</h3>
      <p>
        These limits apply to this model. Larger conversations use more memory; longer replies take
        more time. Changes apply to the next message, including existing conversations.
      </p>
      <label className="mobile-model-label">
        Conversation capacity (tokens)
        <input
          type="number"
          min={512}
          max={provider.contextTokens}
          step={1}
          value={contextSize}
          disabled={disabled || saving}
          onChange={(event) => {
            setSaved(false);
            setContextSize(event.target.value);
          }}
          required
        />
      </label>
      <label className="mobile-model-label">
        Maximum reply (tokens)
        <input
          type="number"
          min={1}
          max={provider.maxOutputTokens}
          step={1}
          value={maxTokens}
          disabled={disabled || saving}
          onChange={(event) => {
            setSaved(false);
            setMaxTokens(event.target.value);
          }}
          required
        />
      </label>
      <p>
        The model must also fit its own trained context window and this device’s available memory.
      </p>
      <button className="gz-key" type="submit" disabled={disabled || saving}>
        {saving ? 'Saving…' : 'Save conversation limits'}
      </button>
      {saved && <output>Conversation limits saved.</output>}
    </form>
  );
}
