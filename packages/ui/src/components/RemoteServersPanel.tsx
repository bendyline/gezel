import type { PairedRemoteInfo } from '@bendyline/gezel-client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { ConfirmDialog } from './ConfirmDialog.js';

/**
 * Settings → Remote Servers. Two halves of remote model execution:
 *
 *  1. "This device as a server" — opt-in toggle for serving THIS device's
 *     models to paired clients over the LAN (off by default), plus the device
 *     identity fingerprint to verify out-of-band when another device pairs.
 *  2. "Paired servers" — the servers THIS device has paired with as a client;
 *     pair a new one by URL, see each one's pinned identity, unpair.
 */

interface DeviceIdentity {
  deviceId: string;
  fingerprint: string;
}

function shortFp(fp: string): string {
  return `${fp.slice(0, 16)}…`;
}

function formatRelative(ms?: number): string {
  if (!ms) return 'never';
  const delta = Date.now() - ms;
  if (delta < 60_000) return 'just now';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return `${Math.floor(delta / 86_400_000)}d ago`;
}

export function RemoteServersPanel() {
  const [remotes, setRemotes] = useState<PairedRemoteInfo[]>([]);
  const [identity, setIdentity] = useState<DeviceIdentity | null>(null);
  const [serving, setServing] = useState(false);
  const [servingPort, setServingPort] = useState<number | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [pairUrl, setPairUrl] = useState('');
  const [pairName, setPairName] = useState('');
  const [pairInspection, setPairInspection] = useState<{
    baseUrl: string;
    displayName?: string;
    fingerprint: string;
    existingFingerprint?: string;
    identityChanged: boolean;
  } | null>(null);
  const [unpairTarget, setUnpairTarget] = useState<PairedRemoteInfo | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [list, cfg] = await Promise.all([api.listRemotes(), api.getConfig()]);
      setRemotes(list.remotes);
      setServing(Boolean(cfg.remoteServing?.enabled));
      setServingPort(cfg.remoteServing?.port);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    try {
      const res = await fetch(`${api.getBaseUrl()}/v1/identity`, { headers: api.authHeader() });
      if (res.ok) {
        const j = (await res.json()) as DeviceIdentity;
        setIdentity({ deviceId: j.deviceId, fingerprint: j.fingerprint });
      }
    } catch {
      /* identity is best-effort */
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(t);
  }, [refresh]);

  const toggleServing = useCallback(async (next: boolean) => {
    setBusy('serving');
    try {
      const cfg = await api.getConfig();
      const updated = await api.updateConfig({
        remoteServing: { ...(cfg.remoteServing ?? {}), enabled: next },
      });
      setServing(Boolean(updated.remoteServing?.enabled));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, []);

  const pair = useCallback(async () => {
    if (!pairUrl.trim() || busy) return;
    setBusy('pair');
    try {
      const baseUrl = pairUrl.trim();
      const inspected = await api.inspectRemote({ baseUrl });
      setPairInspection({
        baseUrl,
        ...(pairName.trim() ? { displayName: pairName.trim() } : {}),
        ...inspected,
      });
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [pairUrl, pairName, busy]);

  const confirmPair = useCallback(async () => {
    if (!pairInspection) return;
    setBusy('pair');
    try {
      await api.pairRemote({
        baseUrl: pairInspection.baseUrl,
        ...(pairInspection.displayName ? { displayName: pairInspection.displayName } : {}),
        expectedIdentityFingerprint: pairInspection.fingerprint,
        ...(pairInspection.identityChanged ? { acceptIdentityChange: true } : {}),
      });
      setPairInspection(null);
      setPairUrl('');
      setPairName('');
      setError(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [pairInspection, refresh]);

  const unpair = useCallback(async () => {
    if (!unpairTarget) return;
    setBusy('unpair');
    try {
      await api.unpairRemote(unpairTarget.remoteId);
      setUnpairTarget(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [unpairTarget, refresh]);

  return (
    <section className="settings-section">
      <h2>Remote Servers</h2>
      <p className="muted small">
        Run models on another gezel device over your LAN. Pair with a powerful machine to use its
        big models as if they were local — chat and image/video/audio generation. The agentic loop
        and your files stay on this device; only the model runs remotely.
      </p>

      {error && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}

      <div className="settings-subsection">
        <h3>This device as a server</h3>
        <label className="settings-toggle">
          <input
            type="checkbox"
            checked={serving}
            disabled={busy === 'serving'}
            onChange={(e) => void toggleServing(e.target.checked)}
          />
          <span>Serve my models to paired devices over the LAN</span>
        </label>
        {serving ? (
          <p className="muted small">
            ⚠️ Other devices on your network can request inference on this machine once you approve
            their pairing (Connected Apps → Paired devices). They reach only inference — never your
            projects or files. Listening on port {servingPort ?? 43936}.
          </p>
        ) : (
          <p className="muted small">Off — no other device can run models here.</p>
        )}
        {identity && (
          <p className="muted small">
            This device's identity fingerprint (read it across when pairing to verify):{' '}
            <code style={{ wordBreak: 'break-all' }}>{identity.fingerprint}</code>
          </p>
        )}
      </div>

      <div className="settings-subsection">
        <h3>Paired servers</h3>
        <div className="remote-pair-form">
          <input
            type="text"
            placeholder="https://192.168.1.50:43936"
            value={pairUrl}
            onChange={(e) => setPairUrl(e.target.value)}
          />
          <input
            type="text"
            placeholder="Name (optional)"
            value={pairName}
            onChange={(e) => setPairName(e.target.value)}
          />
          <button
            type="button"
            className="primary"
            onClick={() => void pair()}
            disabled={busy !== null || !pairUrl.trim()}
          >
            {busy === 'pair' ? 'Pairing…' : 'Pair'}
          </button>
        </div>
        {remotes.length === 0 ? (
          <p className="muted small">No servers paired yet.</p>
        ) : (
          <ul className="settings-list">
            {remotes.map((r) => (
              <li key={r.remoteId} className="connected-app-row">
                <div className="connected-app-meta">
                  <div className="connected-app-name">{r.displayName}</div>
                  <div className="muted small">
                    {r.baseUrl} — identity <code>{shortFp(r.pinnedIdentityFingerprint)}</code> —
                    last seen {formatRelative(r.lastSeenAt)}
                  </div>
                </div>
                <div className="connected-app-actions">
                  <button
                    type="button"
                    className="danger"
                    onClick={() => setUnpairTarget(r)}
                    disabled={busy !== null}
                  >
                    Unpair
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <ConfirmDialog
        open={pairInspection !== null}
        title={
          pairInspection?.identityChanged ? 'Server identity changed' : 'Verify server identity'
        }
        message={
          pairInspection ? (
            <>
              Compare this complete fingerprint with the one displayed on the server device before
              continuing:
              <br />
              <code style={{ wordBreak: 'break-all' }}>{pairInspection.fingerprint}</code>
              {pairInspection.identityChanged && pairInspection.existingFingerprint && (
                <>
                  <br />
                  Previously pinned: <code>{pairInspection.existingFingerprint}</code>
                </>
              )}
            </>
          ) : null
        }
        confirmLabel={
          pairInspection?.identityChanged ? 'Trust new identity' : 'Fingerprint matches'
        }
        danger={pairInspection?.identityChanged === true}
        onConfirm={confirmPair}
        onCancel={() => setPairInspection(null)}
      />

      <ConfirmDialog
        open={unpairTarget !== null}
        title={unpairTarget ? `Unpair ${unpairTarget.displayName}?` : 'Unpair server'}
        message={
          unpairTarget ? (
            <>
              This device will forget <strong>{unpairTarget.displayName}</strong> and its remote
              models will disappear from your model picker. You can pair again later.
            </>
          ) : null
        }
        confirmLabel="Unpair"
        danger
        onConfirm={unpair}
        onCancel={() => setUnpairTarget(null)}
      />
    </section>
  );
}
