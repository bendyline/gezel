import type { MobileProvider, MobileProviderId } from '@bendyline/gezel/schemas';
import { useState } from 'react';
import type { MobileHost, ModelInventory } from './native.js';

export function ProviderPanel({
  host,
  providers,
  selectedProviderId,
  inventory,
  busy,
  onProvider,
  refresh,
  onError,
  onBusyChange,
}: {
  host: MobileHost;
  providers: MobileProvider[];
  selectedProviderId: MobileProviderId;
  inventory: ModelInventory;
  busy: boolean;
  onProvider(id: MobileProviderId): Promise<void>;
  refresh(): Promise<void>;
  onError(error: unknown): void;
  onBusyChange(busy: boolean): void;
}) {
  const [working, setWorking] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [preparing, setPreparing] = useState<MobileProviderId | null>(null);
  const [stoppingDownload, setStoppingDownload] = useState(false);
  const selected = providers.find(({ id }) => id === selectedProviderId);
  const model = inventory.models.find(({ id }) => id === inventory.selectedModelId);
  const disabled = busy || working;

  async function change(action: () => Promise<unknown>) {
    if (disabled) return;
    setWorking(true);
    onBusyChange(true);
    try {
      await action();
    } catch (error) {
      onError(error);
    } finally {
      await refresh().catch(onError);
      setWorking(false);
      onBusyChange(false);
    }
  }

  return (
    <details className="mobile-models" open={!selected || selected.availability !== 'available'}>
      <summary>
        {selectedProviderId === 'llama-cpp' && model
          ? model.name
          : (selected?.name ?? 'Choose a model')}
      </summary>
      <label className="mobile-model-label">
        Use a model
        <select
          value={selectedProviderId}
          disabled={disabled}
          onChange={(event) => {
            const id = event.target.value as MobileProviderId;
            void change(() => onProvider(id));
          }}
        >
          {!providers.some(({ id }) => id === selectedProviderId) && (
            <option value={selectedProviderId}>Saved provider unavailable</option>
          )}
          {providers.map((provider) => (
            <option
              key={provider.id}
              value={provider.id}
              disabled={provider.availability !== 'available' && provider.id !== selectedProviderId}
            >
              {provider.name}
              {provider.availability !== 'available' ? ' (not ready)' : ''}
            </option>
          ))}
        </select>
      </label>
      <p>
        {selected?.availability === 'available'
          ? 'Runs on this device. New conversations use your selected model; existing conversations keep their model and history.'
          : (selected?.reason ??
            'This provider is unavailable on this device. Choose an available model.')}
      </p>
      {providers
        .filter(
          (provider) => provider.id !== selectedProviderId && provider.availability !== 'available',
        )
        .map((provider) => (
          <p key={provider.id}>
            <strong>{provider.name}:</strong> {provider.reason || 'Not available on this device.'}
          </p>
        ))}
      {providers
        .filter(
          (provider) =>
            provider.availability === 'download-required' ||
            provider.availability === 'downloading',
        )
        .map((provider) => (
          <button
            type="button"
            className="gz-key"
            key={provider.id}
            disabled={disabled || provider.availability === 'downloading'}
            onClick={() =>
              void change(async () => {
                setPreparing(provider.id);
                try {
                  await host.prepareProvider(provider.id);
                } finally {
                  setPreparing(null);
                }
              })
            }
          >
            {provider.availability === 'downloading'
              ? `Preparing ${provider.name}…`
              : `Download ${provider.name}`}
          </button>
        ))}
      {preparing && (
        <div className="mobile-confirm">
          <p>
            Android is preparing its on-device model. Your conversations are not sent with this
            download.
          </p>
          <button
            type="button"
            className="gz-key"
            disabled={stoppingDownload}
            onClick={() => {
              setStoppingDownload(true);
              void host
                .cancelProviderPreparation(preparing)
                .catch(onError)
                .finally(() => setStoppingDownload(false));
            }}
          >
            {stoppingDownload ? 'Stopping download…' : 'Cancel download'}
          </button>
        </div>
      )}
      {host.native && (
        <div className="mobile-model-library">
          <label className="mobile-model-label">
            Imported model
            <select
              value={inventory.selectedModelId ?? ''}
              disabled={disabled}
              onChange={(event) =>
                void change(async () => {
                  await host.selectModel(event.target.value);
                  await onProvider('llama-cpp');
                })
              }
            >
              <option value="" disabled>
                Choose an imported model
              </option>
              {inventory.models.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} ({Math.ceil(item.sizeBytes / (1024 * 1024))} MB)
                </option>
              ))}
            </select>
          </label>
          <div className="mobile-actions">
            <button
              type="button"
              className="gz-key"
              disabled={disabled}
              onClick={() =>
                void change(async () => {
                  const result = await host.importModel();
                  if (result.model) {
                    await host.selectModel(result.model.id);
                    await onProvider('llama-cpp');
                  }
                })
              }
            >
              {working ? 'Preparing…' : 'Import a model'}
            </button>
            {model && (
              <button
                type="button"
                className="gz-key"
                disabled={disabled}
                onClick={() => setRemoving(model.id)}
              >
                Remove model
              </button>
            )}
            <button
              type="button"
              className="gz-key"
              disabled={disabled}
              onClick={() => void change(refresh)}
            >
              Check availability
            </button>
          </div>
          <p>
            Import a GGUF chat model from Files. Removing its copy here keeps your conversations.
          </p>
          {removing && (
            <div className="mobile-confirm">
              <p>
                Remove {inventory.models.find(({ id }) => id === removing)?.name ?? 'this model'}{' '}
                from this device?
              </p>
              <div className="mobile-actions">
                <button
                  type="button"
                  className="gz-key"
                  disabled={disabled}
                  onClick={() =>
                    void change(async () => {
                      await host.removeModel(removing);
                      setRemoving(null);
                    })
                  }
                >
                  Remove from device
                </button>
                <button
                  type="button"
                  className="gz-key"
                  disabled={disabled}
                  onClick={() => setRemoving(null)}
                >
                  Keep model
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </details>
  );
}
