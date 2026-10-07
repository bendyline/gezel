import { resolveSecurityPolicy } from '@bendyline/gezel';
import type { MobileModelDownload } from '@bendyline/gezel/mobile-providers';
import type { PortableProductService } from '@bendyline/gezel/runtime';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { MobileHost } from './native.js';
import { VISION_DESCRIBER } from './vision-model.js';

type Status = Awaited<ReturnType<NonNullable<MobileHost['visionStatus']>>>;

const megabytes = (bytes: number) => `${Math.round(bytes / 1024 ** 2)} MB`;
const isVisionDownload = (download: MobileModelDownload) =>
  download.source.sha256 === VISION_DESCRIBER.model.sha256 ||
  download.source.sha256 === VISION_DESCRIBER.projector.sha256;
const running = (download: MobileModelDownload) =>
  ['queued', 'downloading', 'verifying'].includes(download.state);

/**
 * How this phone reads the photos people attach. Labels and text always come
 * from the OS. A sentence about the picture comes from the OS's own describer
 * where it has one (Gemini Nano, Apple Intelligence on iOS 27), and otherwise
 * from a small vision model this section downloads: the model first, then the
 * projector, since the downloader runs one file at a time.
 */
export function PhotoReadingSettings({
  host,
  service,
  disabled,
  onError,
}: {
  host: MobileHost;
  service: PortableProductService;
  disabled: boolean;
  onError: (error: unknown) => void;
}) {
  const [status, setStatus] = useState<Status | null>(null);
  const [downloads, setDownloads] = useState<MobileModelDownload[]>([]);
  const [working, setWorking] = useState(false);
  /** Set by the Download key: keep starting the next missing part until both are in. */
  const installing = useRef(false);

  const startNextPart = useCallback(
    async (current: Status) => {
      if (!resolveSecurityPolicy(await service.store.readConfig()).allowAppNetwork)
        throw new Error(
          'Network access is off in Settings. Turn it on to download the vision model.',
        );
      const part =
        current.model.modelId === undefined
          ? { source: VISION_DESCRIBER.model, name: VISION_DESCRIBER.modelName }
          : { source: VISION_DESCRIBER.projector, name: VISION_DESCRIBER.projectorName };
      const source = await host.resolveModelSource(part.source);
      await service.withModelChange(() => host.startModelDownload(source, part.name));
    },
    [host, service],
  );

  useEffect(() => {
    if (!host.visionStatus) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const [next, active] = await Promise.all([host.visionStatus!(), host.listModelDownloads()]);
        if (disposed) return;
        const vision = active.filter(isVisionDownload);
        setStatus(next);
        setDownloads(vision);
        if (next.model.state === 'ready') installing.current = false;
        else if (
          installing.current &&
          next.model.state === 'not-installed' &&
          !active.some(running) &&
          !vision.some(({ state }) => state === 'failed' || state === 'paused')
        )
          await startNextPart(next);
      } catch (error) {
        installing.current = false;
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
  }, [host, onError, startNextPart]);

  if (!host.visionStatus || !status) return null;
  const { system, model } = status;
  const describes = system.describer.state === 'ready';
  const describerName =
    system.describer.model === 'gemini-nano' ? 'Gemini Nano' : 'Apple Intelligence';
  const inProgress = downloads.find((item) => item.state !== 'complete');
  const act = (action: () => Promise<unknown>) => {
    setWorking(true);
    void action()
      .catch(onError)
      .finally(() => setWorking(false));
  };

  return (
    <section className="mobile-model-library" aria-label="Photos">
      <h3>Photos</h3>
      <p>
        Photos you attach are read on this device: what is in them, and any text they show.
        {describes ? ` ${describerName} also describes each one.` : ''}
      </p>
      {system.describer.state === 'download-required' && (
        <div className="mobile-actions">
          <p className="muted small">
            {describerName} can describe photos once its image model downloads.
          </p>
          <button
            type="button"
            className="gz-key"
            disabled={disabled || working}
            onClick={() =>
              act(async () => {
                if (!resolveSecurityPolicy(await service.store.readConfig()).allowAppNetwork)
                  throw new Error('Network access is off in Settings. Turn it on to download.');
                await host.prepareSystemVision?.();
                setStatus(await host.visionStatus!());
              })
            }
          >
            {working ? 'Downloading…' : `Download for ${describerName}`}
          </button>
        </div>
      )}
      {(!describes || model.state === 'ready') && model.state !== 'unavailable' && (
        <div className="mobile-model-download">
          {model.state === 'ready' ? (
            <>
              <p className="muted small">
                {VISION_DESCRIBER.label} describes photos
                {describes ? ` when ${describerName} cannot` : ''}.
              </p>
              <div className="mobile-actions">
                <button
                  type="button"
                  className="gz-key"
                  disabled={disabled || working}
                  onClick={() =>
                    act(async () => {
                      // The model stays when it is also the chat model; its
                      // projector is only ever for photos.
                      const { selectedModelId } = await host.listModels();
                      for (const id of [model.projectorId, model.modelId])
                        if (id && id !== selectedModelId)
                          await service.withModelChange(() => host.removeModel(id));
                      setStatus(await host.visionStatus!());
                    })
                  }
                >
                  Remove vision model
                </button>
              </div>
            </>
          ) : inProgress ? (
            <>
              <p>
                <strong>{inProgress.name}</strong> · {inProgress.state}
              </p>
              <progress
                aria-label={`${inProgress.name} download progress`}
                value={inProgress.downloadedBytes}
                max={inProgress.source.sizeBytes}
              />
            </>
          ) : (
            <>
              <p className="muted small">
                Download {VISION_DESCRIBER.label} ({megabytes(model.missingBytes)}) so this phone
                can describe photos, not only label them.
              </p>
              <div className="mobile-actions">
                <button
                  type="button"
                  className="gz-key"
                  disabled={disabled || working}
                  onClick={() =>
                    act(async () => {
                      installing.current = true;
                      await startNextPart(status);
                    })
                  }
                >
                  Download vision model
                </button>
              </div>
            </>
          )}
        </div>
      )}
      {!describes && model.state === 'unavailable' && system.describer.reason && (
        <p className="muted small">{system.describer.reason}</p>
      )}
    </section>
  );
}
