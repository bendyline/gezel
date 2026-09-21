import { resolveSecurityPolicy } from '@bendyline/gezel';
import type { MobileModelDownload } from '@bendyline/gezel/mobile-providers';
import type { PortableCatalogModel, PortableProductService } from '@bendyline/gezel/runtime';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { MobileHost } from './native.js';

const size = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
export function ModelDownloads({
  host,
  service,
  models,
  disabled,
  onInstalled,
}: {
  host: MobileHost;
  service: PortableProductService;
  models: PortableCatalogModel[];
  disabled: boolean;
  onInstalled(): Promise<void>;
}) {
  const resolutionEpoch = useRef(0);
  const resolvingRef = useRef(false);
  const [resolving, setResolving] = useState(false);
  useEffect(
    () => () => {
      resolutionEpoch.current++;
      if (resolvingRef.current) void host.cancelModelSourceResolution().catch(() => {});
    },
    [host],
  );
  const [selected, setSelected] = useState('');
  const [downloads, setDownloads] = useState<MobileModelDownload[]>([]);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => setDownloads(await host.listModelDownloads()), [host]);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await host.listModelDownloads();
        if (!disposed) setDownloads(next);
      } catch (reason) {
        if (!disposed) setError(String(reason));
      } finally {
        if (!disposed) timer = setTimeout(() => void poll(), 2000);
      }
    };
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [host]);
  const completed = downloads
    .filter((d) => d.state === 'complete')
    .map((d) => d.id)
    .sort()
    .join(',');
  useEffect(() => {
    if (completed) void onInstalled().catch((reason) => setError(String(reason)));
  }, [completed, onInstalled]);
  const active = downloads.some((d) => ['queued', 'downloading', 'verifying'].includes(d.state));
  const change = async (action: () => Promise<unknown>, network = false) => {
    setWorking(true);
    setError(null);
    try {
      if (network && !resolveSecurityPolicy(await service.store.readConfig()).allowAppNetwork)
        throw new Error('Network access is off in Settings. Enable it to download a model.');
      await action();
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setWorking(false);
    }
  };
  if (!host.native || !models.length) return null;
  const chosen = models.find(
    (model) => `${model.source.catalogId}:${model.source.catalogVersion}` === selected,
  );
  return (
    <details className="mobile-models">
      <summary>Download a model</summary>
      <p>
        Choose from the same catalog as desktop. Downloads need internet; verified models work
        offline. Keep Gezel open during a download. Larger models need more memory to run.
      </p>
      {error && <p role="alert">{error}</p>}
      <label htmlFor="mobile-catalog-model">Model</label>
      <select
        id="mobile-catalog-model"
        value={selected}
        disabled={working}
        onChange={(event) => setSelected(event.target.value)}
      >
        <option value="">Choose a model</option>
        {models.map((model) => (
          <option
            key={`${model.source.catalogId}:${model.source.catalogVersion}`}
            value={`${model.source.catalogId}:${model.source.catalogVersion}`}
          >
            {model.name} · about {size(model.approxSizeBytes)}
          </option>
        ))}
      </select>
      {chosen && (
        <p>
          {chosen.description}
          {chosen.license ? ` License: ${chosen.license}.` : ''}
        </p>
      )}
      <button
        type="button"
        className="gz-key"
        disabled={!chosen || disabled || working || active}
        onClick={() =>
          void change(async () => {
            if (!chosen) return;
            const epoch = ++resolutionEpoch.current;
            resolvingRef.current = true;
            setResolving(true);
            try {
              const source = await host.resolveModelSource(chosen.source);
              if (epoch !== resolutionEpoch.current) return;
              if (!resolveSecurityPolicy(await service.store.readConfig()).allowAppNetwork)
                throw new Error('Network access was turned off. The download has not started.');
              await host.startModelDownload(source, chosen.name);
            } finally {
              resolvingRef.current = false;
              setResolving(false);
            }
          }, true)
        }
      >
        {working ? 'Working…' : 'Download'}
      </button>
      {resolving && (
        <button
          type="button"
          className="gz-key"
          onClick={() => {
            resolutionEpoch.current++;
            void host.cancelModelSourceResolution().catch((reason) => setError(String(reason)));
          }}
        >
          Cancel
        </button>
      )}
      {downloads.map((download) => (
        <div key={download.id} className="mobile-model-download">
          <p>
            <strong>{download.name}</strong> ·{' '}
            {download.state === 'complete' ? 'Ready to choose above' : download.state}
          </p>
          <progress
            aria-label={`${download.name} download progress`}
            value={download.downloadedBytes}
            max={download.source.sizeBytes}
          />
          <p>
            {size(download.downloadedBytes)} of {size(download.source.sizeBytes)}
            {download.error ? ` · ${download.error}` : ''}
          </p>
          {['queued', 'downloading', 'verifying'].includes(download.state) && (
            <button
              type="button"
              className="gz-key"
              disabled={working}
              onClick={() => void change(() => host.cancelModelDownload(download.id))}
            >
              Pause
            </button>
          )}
          {['paused', 'failed'].includes(download.state) && (
            <button
              type="button"
              className="gz-key"
              disabled={disabled || working || active}
              onClick={() => void change(() => host.resumeModelDownload(download.id), true)}
            >
              Resume
            </button>
          )}
          {!['queued', 'downloading', 'verifying'].includes(download.state) && (
            <button
              type="button"
              className="gz-key"
              disabled={working}
              onClick={() => void change(() => host.removeModelDownload(download.id))}
            >
              {download.state === 'complete' ? 'Dismiss download' : 'Remove partial download'}
            </button>
          )}
        </div>
      ))}
    </details>
  );
}
