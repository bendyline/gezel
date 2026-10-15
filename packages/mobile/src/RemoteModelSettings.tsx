import type {
  DiscoveredServer,
  PortableProductService,
  RemoteServerInfo,
  RemoteServerModel,
  RemoteServerStatus,
} from '@bendyline/gezel/runtime';
import { useCallback, useEffect, useId, useState } from 'react';

const REFRESH_MS = 10_000;

function statusText(status: RemoteServerStatus): string {
  if (status === 'online') return 'Connected';
  if (status === 'offline') return "Not reachable — this phone's own model answers until it's back";
  return 'Checking…';
}

/** `48210937` shown as `4821 0937`, the way the server shows it. */
function formatCode(value: string): string {
  const digits = value.replace(/\D/g, '').slice(0, 8);
  return digits.length > 4 ? `${digits.slice(0, 4)} ${digits.slice(4)}` : digits;
}

/**
 * Another device's models: a computer running Gezel on the same network. A
 * phone only connects; it never shares its own models. Connecting takes the
 * code the computer shows under Settings → Remote Servers → Add a device, and
 * is remembered. A conversation on a computer's model runs on this phone's own
 * model while the computer can't be reached, and says so.
 */
export function RemoteModelSettings({
  service,
  disabled,
  inUse,
  onChanged,
  useLocal,
  onError,
}: {
  service: PortableProductService;
  disabled: boolean;
  /** The `remote:<id>/<model>` new conversations use, when one is in use. */
  inUse?: string;
  onChanged: () => Promise<void>;
  /** Go back to this phone's own model for new conversations. */
  useLocal: () => Promise<void>;
  onError: (error: unknown) => void;
}) {
  const [servers, setServers] = useState<RemoteServerInfo[]>([]);
  const [nearby, setNearby] = useState<DiscoveredServer[]>([]);
  const [canLook, setCanLook] = useState(true);
  const [models, setModels] = useState<Record<string, RemoteServerModel[]>>({});
  const [connecting, setConnecting] = useState<{ baseUrl: string; name: string } | null>(null);
  const [code, setCode] = useState('');
  const [address, setAddress] = useState('');
  const [working, setWorking] = useState(false);
  const codeId = useId();
  const addressId = useId();

  const refresh = useCallback(async () => {
    const [list, found] = await Promise.all([service.remotes.list(), service.remotes.discover()]);
    setServers(list);
    setCanLook(found.available);
    setNearby(found.servers.filter((server) => !server.pairedRemoteId));
    const lists = await Promise.all(
      list.map(
        async (server) => [server.remoteId, await service.remotes.models(server.remoteId)] as const,
      ),
    );
    setModels(Object.fromEntries(lists.map(([id, result]) => [id, result.models])));
    // `models` probes each server, so the list read before it may be stale.
    setServers(await service.remotes.list());
  }, [service]);

  useEffect(() => {
    if (!service.remotes.available) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        await refresh();
      } catch (error) {
        if (!disposed) onError(error);
      } finally {
        if (!disposed) timer = setTimeout(() => void poll(), REFRESH_MS);
      }
    };
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [service, refresh, onError]);

  if (!service.remotes.available) return null;

  const act = (action: () => Promise<unknown>) => {
    setWorking(true);
    void action()
      .catch(onError)
      .finally(() => setWorking(false));
  };
  const busy = disabled || working;

  return (
    <section className="mobile-model-library" aria-label="Another device">
      <h3>Another device</h3>
      <p>
        Use the models on a computer running Gezel on the same network. This phone's own model
        answers while you're away from it.
      </p>

      {servers.map((server) => {
        const list = models[server.remoteId] ?? [];
        return (
          <div key={server.remoteId} className="mobile-model-download">
            <p>
              <strong>{server.displayName}</strong>
            </p>
            <p className="muted small" aria-live="polite">
              {statusText(server.status)}
            </p>
            {list.length > 0 ? (
              <div className="mobile-actions">
                {list.map((model) =>
                  model.id === inUse ? (
                    <span key={model.id} className="muted small">
                      {model.name} · in use
                    </span>
                  ) : (
                    <button
                      key={model.id}
                      type="button"
                      className="gz-key"
                      disabled={busy}
                      onClick={() =>
                        act(async () => {
                          await service.setRemoteModel(model.id);
                          await onChanged();
                        })
                      }
                    >
                      Use {model.name}
                    </button>
                  ),
                )}
              </div>
            ) : (
              server.status === 'online' && (
                <p className="muted small">{server.displayName} has no chat models ready.</p>
              )
            )}
            <div className="mobile-actions">
              <button
                type="button"
                className="gz-key"
                disabled={busy}
                onClick={() =>
                  act(async () => {
                    await service.remotes.forget(server.remoteId);
                    if (inUse?.startsWith(`remote:${server.remoteId}/`)) await useLocal();
                    await refresh();
                  })
                }
              >
                Forget
              </button>
            </div>
          </div>
        );
      })}

      {connecting ? (
        <form
          className="mobile-model-download"
          onSubmit={(event) => {
            event.preventDefault();
            act(async () => {
              await service.remotes.pair({ baseUrl: connecting.baseUrl, code });
              setConnecting(null);
              setCode('');
              await refresh();
            });
          }}
        >
          <label htmlFor={codeId}>Code shown on {connecting.name}</label>
          <p className="muted small">
            On {connecting.name}, open Settings → Remote Servers and choose Add a device.
          </p>
          <input
            id={codeId}
            value={formatCode(code)}
            onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 8))}
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="0000 0000"
          />
          <div className="mobile-actions">
            <button type="submit" className="gz-key" disabled={busy || code.length !== 8}>
              {working ? 'Connecting…' : 'Connect'}
            </button>
            <button
              type="button"
              className="gz-key"
              disabled={working}
              onClick={() => {
                setConnecting(null);
                setCode('');
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <>
          {nearby.map((server) => (
            <div key={server.baseUrl} className="mobile-model-download">
              <p>
                <strong>{server.name}</strong>
              </p>
              <p className="muted small">On this network at {server.address}</p>
              <div className="mobile-actions">
                <button
                  type="button"
                  className="gz-key"
                  disabled={busy}
                  onClick={() => setConnecting({ baseUrl: server.baseUrl, name: server.name })}
                >
                  Connect
                </button>
              </div>
            </div>
          ))}
          {canLook && nearby.length === 0 && servers.length === 0 && (
            <p className="muted small">
              No computers found yet. On one, turn on Settings → Remote Servers → Share this
              device's models.
            </p>
          )}
          <details>
            <summary>Connect by address</summary>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                act(async () => {
                  const inspected = await service.remotes.inspect(address);
                  if (!inspected.pairingMethods.includes('code'))
                    throw new Error(
                      'That computer runs an older Gezel. Update it to connect with a code.',
                    );
                  setConnecting({ baseUrl: address, name: address.trim() });
                });
              }}
            >
              <label htmlFor={addressId}>Address shown on the computer</label>
              <input
                id={addressId}
                value={address}
                onChange={(event) => setAddress(event.target.value)}
                inputMode="url"
                autoCapitalize="off"
                autoCorrect="off"
                placeholder="192.168.1.50"
              />
              <div className="mobile-actions">
                <button type="submit" className="gz-key" disabled={busy || !address.trim()}>
                  Continue
                </button>
              </div>
            </form>
          </details>
        </>
      )}
    </section>
  );
}
