import type { MobileProvider, MobileProviderId } from '@bendyline/gezel/mobile-providers';
import type { PortableCatalogModel, PortableProductService } from '@bendyline/gezel/runtime';
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { ModelBudgetSettings } from './ModelBudgetSettings.js';
import { ModelDownloads } from './ModelDownloads.js';
import { ProviderPanel } from './ProviderPanel.js';
import type { MobileHost, ModelInventory } from './native.js';

/** Native model acquisition is a host control inside the ordinary Settings view. */
export function ProductModelSettings({
  host,
  service,
  models = [],
  setup = false,
}: {
  host: MobileHost;
  service: PortableProductService;
  models?: PortableCatalogModel[];
  setup?: boolean;
}) {
  const status = useSyncExternalStore(
    service.subscribeStatus,
    service.getStatus,
    service.getStatus,
  );
  const guardedHost = useMemo<MobileHost>(
    () => ({
      ...host,
      startModelDownload: (source, name) =>
        service.withModelChange(() => host.startModelDownload(source, name)),
      resumeModelDownload: (id) => service.withModelChange(() => host.resumeModelDownload(id)),
      importModel: () => service.withModelChange(() => host.importModel()),
      selectModel: (id) => service.withModelChange(() => host.selectModel(id)),
      removeModel: (id) => service.withModelChange(() => host.removeModel(id)),
      prepareProvider: (id) => service.withModelChange(() => host.prepareProvider(id)),
      // Cancelling preparation must remain available while its admission is held.
      cancelProviderPreparation: (id) => host.cancelProviderPreparation(id),
    }),
    [host, service],
  );
  const [saving, setSaving] = useState(false);
  const [providers, setProviders] = useState<MobileProvider[]>([]);
  const [inventory, setInventory] = useState<ModelInventory>({ models: [] });
  const [provider, setProvider] = useState<MobileProviderId>('llama-cpp');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const onError = useCallback(
    (value: unknown) => setError(value instanceof Error ? value.message : String(value)),
    [],
  );
  const load = useCallback(async () => {
    const [nextProviders, nextInventory, config] = await Promise.all([
      host.inference.providers(),
      host.listModels(),
      service.store.readConfig(),
    ]);
    setProviders(nextProviders);
    setInventory(nextInventory);
    if (
      config.provider === 'llama-cpp' ||
      config.provider === 'apple-foundation-models' ||
      config.provider === 'android-mlkit'
    )
      setProvider(config.provider);
  }, [host, service]);
  const refresh = useCallback(async () => {
    await load();
    window.dispatchEvent(new CustomEvent('gezel:config-updated'));
  }, [load]);
  // Mounting is not a settings change. The shell reads `gezel:config-updated`
  // as "the user saved", which ends first-run's return to Home, so announcing
  // on mount let a reload into Settings keep or lose setup depending on which
  // of this read and the first-run estimate finished first.
  useEffect(() => {
    void load().catch(onError);
  }, [load, onError]);
  const selected = providers.find(({ id }) => id === provider);
  const modelId = provider === 'llama-cpp' ? inventory.selectedModelId : provider;
  const downloads = (
    <ModelDownloads
      host={guardedHost}
      service={service}
      models={models}
      disabled={busy || saving || status.busy || status.pendingSave || status.changingModel}
      onInstalled={refresh}
      setup={setup}
    />
  );
  return (
    <section aria-label="On-device models">
      <p>
        Your projects, crew, documents, and conversations are saved on this device. A model runs
        while the app is open.
      </p>
      {error && <p role="alert">{error}</p>}
      {setup && downloads}
      <ProviderPanel
        host={guardedHost}
        providers={providers}
        selectedProviderId={provider}
        inventory={inventory}
        busy={busy || saving || status.busy || status.pendingSave || status.changingModel}
        onProvider={async (id) => {
          await service.setProvider(id);
          setProvider(id);
        }}
        refresh={refresh}
        onError={onError}
        onBusyChange={(value) => {
          if (value) setError(null);
          setBusy(value);
        }}
      />
      {!setup && downloads}
      {selected?.availability === 'available' && modelId && (
        <ModelBudgetSettings
          service={service}
          provider={selected}
          modelId={modelId}
          disabled={busy || saving || status.busy || status.pendingSave || status.changingModel}
          refresh={refresh}
          onError={onError}
        />
      )}
      {status.pendingSave && (
        <div>
          <p aria-live="polite">
            A conversation is waiting to be saved. Save it before changing models.
          </p>
          <button
            type="button"
            className="gz-key"
            disabled={saving || busy || status.busy || status.changingModel}
            onClick={() => {
              setSaving(true);
              void service
                .retrySave()
                .then(() => {
                  setError(null);
                  return refresh();
                })
                .catch(onError)
                .finally(() => setSaving(false));
            }}
          >
            {saving ? 'Saving…' : 'Retry saving'}
          </button>
        </div>
      )}
    </section>
  );
}
