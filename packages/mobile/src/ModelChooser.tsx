import { resolveSecurityPolicy } from '@bendyline/gezel';
import type {
  MobileModelDownload,
  MobileProvider,
  MobileProviderId,
} from '@bendyline/gezel/mobile-providers';
import type { PortableCatalogModel, PortableProductService } from '@bendyline/gezel/runtime';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import * as Select from '../../ui/src/primitives/Select.js';
import type { MobileHost, ModelInventory } from './native.js';

const gigabytes = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;

/** Shown when starting or resuming a download would reach the network with it off. */
const NETWORK_OFF_MESSAGE = 'Network access is off in Settings. Turn it on to download a model.';

/** Room a model needs beyond its file to load at the smallest window. */
const LOAD_HEADROOM_BYTES = 512 * 1024 * 1024;

/**
 * Whether a catalog download can run here. Only a model that clearly cannot
 * is left out: Gemma 4 E4B's 4.2 GB against the ~3 GB a 6 GB iPhone lets one
 * app use. With no budget from the host, everything is offered.
 */
export function catalogModelFits(model: { approxSizeBytes: number }, budgetBytes?: number) {
  return budgetBytes === undefined || model.approxSizeBytes + LOAD_HEADROOM_BYTES <= budgetBytes;
}

/** A model's name as a person reads it, without the file extension a sideloaded file carries. */
export function modelDisplayName(name: string) {
  return name.replace(/\.gguf$/i, '');
}

const catalogKey = (model: PortableCatalogModel) =>
  `${model.source.catalogId}:${model.source.catalogVersion}`;
const running = (download: MobileModelDownload) =>
  ['queued', 'downloading', 'verifying'].includes(download.state);

export interface ModelChoice {
  /** `model:<id>`, `provider:<id>`, or `catalog:<catalogId>:<version>`. */
  value: string;
  label: string;
  /** Shown beside the name in the list, never in the closed control. */
  size?: string;
  disabled?: boolean;
}

/**
 * The list's contents: what is on this device, then what can be downloaded
 * and would fit. A group with nothing in it is left out.
 */
export function modelChoices({
  providers,
  selectedProviderId,
  inventory,
  catalog,
  native,
}: {
  providers: MobileProvider[];
  selectedProviderId: MobileProviderId;
  inventory: ModelInventory;
  catalog: PortableCatalogModel[];
  native: boolean;
}) {
  const system = providers.filter(({ id }) => id !== 'llama-cpp');
  const ready = system.filter(({ availability }) => availability === 'available');
  const toPrepare = system.filter(
    ({ availability }) => availability === 'download-required' || availability === 'downloading',
  );
  const installed = new Set(
    inventory.models.map(({ source }) => source?.catalogId).filter(Boolean),
  );
  const downloadable = native
    ? catalog.filter(
        (model) =>
          !installed.has(model.source.catalogId) &&
          catalogModelFits(model, inventory.memoryBudgetBytes),
      )
    : [];
  const savedProviderGone =
    selectedProviderId !== 'llama-cpp' && !ready.some(({ id }) => id === selectedProviderId);
  const onDevice: ModelChoice[] = [
    ...(savedProviderGone
      ? [
          {
            value: `provider:${selectedProviderId}`,
            label: `${system.find(({ id }) => id === selectedProviderId)?.name ?? 'Your earlier choice'} (not available)`,
            disabled: true,
          },
        ]
      : []),
    ...ready.map((provider) => ({ value: `provider:${provider.id}`, label: provider.name })),
    ...inventory.models.map((model) => ({
      value: `model:${model.id}`,
      label: modelDisplayName(model.name),
      size: gigabytes(model.sizeBytes),
    })),
  ];
  const toDownload: ModelChoice[] = [
    ...toPrepare.map((provider) => ({ value: `provider:${provider.id}`, label: provider.name })),
    ...downloadable.map((model) => ({
      value: `catalog:${catalogKey(model)}`,
      label: model.name,
      size: gigabytes(model.approxSizeBytes),
    })),
  ];
  return {
    system,
    downloadable,
    groups: [
      { label: 'On this device', choices: onDevice },
      { label: 'Download', choices: toDownload },
    ].filter(({ choices }) => choices.length > 0),
  };
}

/**
 * One list of models: what is on this device (downloaded models and the
 * phone's own AI), then what can be downloaded and would fit. Choosing a
 * download starts it and selects the model when it lands. Replaced a provider
 * dropdown, an "imported model" dropdown, and a separate download panel.
 *
 * The list is the app's own Select, not a native one. Android's picker for a
 * web select is a system dialog at the system text size with its radio
 * column on the right, so at phone width every model name wrapped and the
 * list matched none of the app's other dropdowns.
 */
export function ModelChooser({
  host,
  service,
  providers,
  selectedProviderId,
  inventory,
  catalog,
  busy,
  onProvider,
  refresh,
  reload,
  onError,
  onBusyChange,
}: {
  host: MobileHost;
  service: PortableProductService;
  providers: MobileProvider[];
  selectedProviderId: MobileProviderId;
  inventory: ModelInventory;
  catalog: PortableCatalogModel[];
  busy: boolean;
  onProvider(id: MobileProviderId): Promise<void>;
  /** Loads and announces a settings change; after the person changed something. */
  refresh(): Promise<void>;
  /** Loads without announcing: opening the list is not a change, and the shell
   * reads an announcement as "saved", which can end first-run setup. */
  reload(): Promise<void>;
  onError(error: unknown): void;
  onBusyChange(busy: boolean): void;
}) {
  const [working, setWorking] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [preparing, setPreparing] = useState<MobileProviderId | null>(null);
  const [stoppingPreparation, setStoppingPreparation] = useState(false);
  const [downloads, setDownloads] = useState<MobileModelDownload[]>([]);
  const [pending, setPending] = useState<{ downloadId: string; key: string } | null>(null);
  /** The model whose exact download is being looked up, before it can start. */
  const [resolving, setResolving] = useState<string | null>(null);
  const labelId = useId();
  const resolution = useRef(0);
  const handled = useRef(new Set<string>());
  const disabled = busy || working;
  const selectedModel = inventory.models.find(({ id }) => id === inventory.selectedModelId);
  const {
    system: systemProviders,
    downloadable,
    groups,
  } = modelChoices({ providers, selectedProviderId, inventory, catalog, native: host.native });

  const change = useCallback(
    async (action: () => Promise<unknown>) => {
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
    },
    [onBusyChange, onError, refresh],
  );

  useEffect(() => {
    if (!host.native) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await host.listModelDownloads();
        if (!disposed) setDownloads(next);
      } catch (error) {
        if (!disposed) onError(error);
      } finally {
        if (!disposed) timer = setTimeout(() => void poll(), 2000);
      }
    };
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [host, onError]);
  useEffect(
    () => () => {
      resolution.current++;
    },
    [],
  );

  // A finished download is a model on this device now. The one chosen here
  // becomes the selection; every finished record is cleared, since the model
  // list already shows the model it made.
  useEffect(() => {
    const finished = downloads.filter(
      ({ id, state }) => state === 'complete' && !handled.current.has(id),
    );
    if (!finished.length) return;
    for (const { id } of finished) handled.current.add(id);
    void (async () => {
      for (const download of finished) {
        if (pending?.downloadId === download.id && download.modelId) {
          setPending(null);
          await host.selectModel(download.modelId);
          await onProvider('llama-cpp');
        }
        await host.removeModelDownload(download.id);
      }
      await refresh();
    })().catch(onError);
  }, [downloads, pending, host, onProvider, refresh, onError]);

  const value = pending
    ? `catalog:${pending.key}`
    : selectedProviderId === 'llama-cpp'
      ? selectedModel
        ? `model:${selectedModel.id}`
        : ''
      : `provider:${selectedProviderId}`;

  /**
   * Every host call here that reaches the network checks the setting first.
   * Resume once skipped it: the rewrite that merged the download panel into
   * this list dropped the per-button flag that gated it.
   */
  async function requireNetwork(message = NETWORK_OFF_MESSAGE) {
    if (!resolveSecurityPolicy(await service.store.readConfig()).allowAppNetwork)
      throw new Error(message);
  }

  async function download(model: PortableCatalogModel) {
    await requireNetwork();
    const epoch = ++resolution.current;
    setResolving(model.name);
    let source: Awaited<ReturnType<MobileHost['resolveModelSource']>>;
    try {
      source = await host.resolveModelSource(model.source);
    } finally {
      if (epoch === resolution.current) setResolving(null);
    }
    // Cancelled while the lookup ran: a late answer must not start anything.
    if (epoch !== resolution.current) return;
    // The lookup itself goes to the network; the setting may have changed
    // while it ran.
    await requireNetwork('Network access was turned off. Turn it on in Settings to download.');
    const started = await host.startModelDownload(source, model.name);
    setPending({ downloadId: started.id, key: catalogKey(model) });
  }

  async function resume(id: string) {
    await requireNetwork();
    await host.resumeModelDownload(id);
  }

  function choose(next: string) {
    const [kind, ...rest] = next.split(':');
    const id = rest.join(':');
    if (kind === 'model')
      return void change(async () => {
        await host.selectModel(id);
        await onProvider('llama-cpp');
      });
    if (kind === 'provider') {
      const provider = systemProviders.find((item) => item.id === id);
      if (!provider) return;
      return void change(async () => {
        if (provider.availability !== 'available') {
          setPreparing(provider.id);
          try {
            await host.prepareProvider(provider.id);
          } finally {
            setPreparing(null);
          }
        }
        await onProvider(provider.id);
      });
    }
    const model = downloadable.find((item) => catalogKey(item) === id);
    if (model) void change(() => download(model));
  }

  const inProgress = downloads.filter((item) => item.state !== 'complete');
  return (
    <div className="mobile-model-chooser">
      <div className="mobile-model-label">
        <span id={labelId}>Model</span>
        <Select.Root
          value={value}
          disabled={disabled}
          onOpenChange={(open) => open && void reload().catch(onError)}
          onValueChange={choose}
        >
          <Select.Trigger className="mobile-model-trigger" aria-labelledby={labelId}>
            <Select.Value placeholder="Choose a model" />
          </Select.Trigger>
          <Select.Content className="mobile-model-menu">
            {groups.map((group) => (
              <Select.Group key={group.label}>
                <Select.Label>{group.label}</Select.Label>
                {group.choices.map((choice) => (
                  <Select.Item
                    key={choice.value}
                    value={choice.value}
                    disabled={choice.disabled}
                    textValue={choice.label}
                    trailing={
                      choice.size && <span className="mobile-model-size">{choice.size}</span>
                    }
                  >
                    <span data-model-choice={choice.value}>{choice.label}</span>
                  </Select.Item>
                ))}
              </Select.Group>
            ))}
          </Select.Content>
        </Select.Root>
      </div>
      {resolving && (
        <div className="mobile-confirm">
          <p>Getting {resolving} ready to download…</p>
          <div className="mobile-actions">
            <button
              type="button"
              className="gz-key"
              onClick={() => {
                resolution.current++;
                setResolving(null);
                void host.cancelModelSourceResolution().catch(onError);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      <p className="muted small">
        {pending
          ? 'Downloading. Keep Gezel open; the model is chosen when it finishes.'
          : value === ''
            ? 'Pick one already on this device, or one to download. Downloads need internet and finish while Gezel is open.'
            : 'Runs on this device. New conversations use your selected model; existing conversations keep their model and history.'}
      </p>
      {inProgress.map((item) => (
        <div key={item.id} className="mobile-model-download">
          <p>
            <strong>{item.name}</strong> · {item.state}
          </p>
          <progress
            aria-label={`${item.name} download progress`}
            value={item.downloadedBytes}
            max={item.source.sizeBytes}
          />
          <p className="muted small">
            {gigabytes(item.downloadedBytes)} of {gigabytes(item.source.sizeBytes)}
            {item.error ? ` · ${item.error}` : ''}
          </p>
          <div className="mobile-actions">
            {running(item) ? (
              <button
                type="button"
                className="gz-key"
                disabled={working}
                onClick={() => void change(() => host.cancelModelDownload(item.id))}
              >
                Pause
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className="gz-key"
                  disabled={disabled || downloads.some(running)}
                  onClick={() => void change(() => resume(item.id))}
                >
                  Resume
                </button>
                <button
                  type="button"
                  className="gz-key"
                  disabled={working}
                  onClick={() =>
                    void change(async () => {
                      if (pending?.downloadId === item.id) setPending(null);
                      await host.removeModelDownload(item.id);
                    })
                  }
                >
                  Remove partial download
                </button>
              </>
            )}
          </div>
        </div>
      ))}
      {preparing && (
        <div className="mobile-confirm">
          <p>
            The phone is preparing its on-device model. Your conversations are not sent with this
            download.
          </p>
          <button
            type="button"
            className="gz-key"
            disabled={stoppingPreparation}
            onClick={() => {
              setStoppingPreparation(true);
              void host
                .cancelProviderPreparation(preparing)
                .catch(onError)
                .finally(() => setStoppingPreparation(false));
            }}
          >
            {stoppingPreparation ? 'Stopping download…' : 'Cancel download'}
          </button>
        </div>
      )}
      {host.native && (
        <div className="mobile-actions">
          <button
            type="button"
            className="gz-key"
            disabled={disabled}
            onClick={() =>
              void change(async () => {
                const added = await host.importModel();
                if (added.model) {
                  await host.selectModel(added.model.id);
                  await onProvider('llama-cpp');
                }
              })
            }
          >
            Add a model from Files
          </button>
          {selectedProviderId === 'llama-cpp' && selectedModel && (
            <button
              type="button"
              className="gz-key"
              disabled={disabled}
              onClick={() => setRemoving(selectedModel.id)}
            >
              Remove model
            </button>
          )}
        </div>
      )}
      {removing && (
        <div className="mobile-confirm">
          <p>
            Remove{' '}
            {modelDisplayName(
              inventory.models.find(({ id }) => id === removing)?.name ?? 'this model',
            )}{' '}
            from this device? Your conversations stay.
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
  );
}
