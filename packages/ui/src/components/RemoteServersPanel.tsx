import type {
  MachineServingConfig,
  MachineServingDevice,
  MachineServingGrant,
  MachineServingState,
  PairedRemoteInfo,
} from '@bendyline/gezel-client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { ConfirmDialog } from './ConfirmDialog.js';

/**
 * Settings → Remote Servers. Two halves of remote model execution:
 *
 *  1. "This device as a server" — opt-in toggle for serving this device's
 *     models to paired clients over the LAN (off by default), the identity
 *     code to check out-of-band when another device pairs, and the
 *     server settings (port, bind interface, allowed models, per-device
 *     limits, queue priority) behind an explicit Apply — a port/bind change
 *     rebinds the live listener, so edits never save keystroke-by-keystroke.
 *     On machine installs the listener is owned by the machine service (it
 *     holds the engines and serves even while nobody is logged in), so the
 *     toggle, settings, identity code, pending pairings, and paired devices
 *     are all backed by /api/machine-serving; otherwise they manage this
 *     user daemon's own config, with pairing approvals in Connected Apps.
 *  2. "Paired servers" — the servers THIS device has paired with as a client;
 *     pair a new one by URL, see each one's pinned identity, unpair.
 */

interface DeviceIdentity {
  deviceId: string;
  fingerprint: string;
}

/**
 * The human-comparable form of an identity fingerprint: the first 16 hex
 * characters, in groups of four, so two people can actually read it to each
 * other. The full 64-char value is what gets pinned and compared in code —
 * this is only the out-of-band check.
 *
 * 16 characters (64 bits) is a floor, not a style choice. The check has to
 * survive an attacker who grinds Ed25519 keypairs offline looking for one
 * whose SPKI SHA-256 shares the displayed prefix; a 10-character (40-bit)
 * code is within reach of a few GPU-days, 64 bits is not. Don't shorten it
 * further to make the line prettier.
 */
function deviceCode(fp: string): string {
  return (fp.slice(0, 16).match(/.{1,4}/g) ?? []).join(' ');
}

function formatRelative(ms?: number): string {
  if (!ms) return 'never';
  const delta = Date.now() - ms;
  if (delta < 60_000) return 'just now';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return `${Math.floor(delta / 86_400_000)}d ago`;
}

/**
 * Editable server-settings form state, kept as strings so partially-typed
 * values never round-trip through the config. Applied only on an explicit
 * Apply (a port/bind change rebinds the live listener), and re-seeded from
 * server truth only while the user has no pending edits.
 */
interface ServingDraft {
  port: string;
  bindAddress: string;
  priority: 'equal' | 'below-local' | 'above-local';
  allowModels: string;
  maxConcurrentPerDevice: string;
  maxChatPerDevice: string;
  requestsPerMinute: string;
}

const EMPTY_DRAFT: ServingDraft = {
  port: '',
  bindAddress: '',
  priority: 'equal',
  allowModels: '',
  maxConcurrentPerDevice: '',
  maxChatPerDevice: '',
  requestsPerMinute: '',
};

const PRIORITY_CHOICES: Array<{ id: ServingDraft['priority']; label: string; title: string }> = [
  { id: 'equal', label: 'Equal', title: 'Remote turns queue like local work' },
  { id: 'below-local', label: 'Local first', title: "This machine's own work always drains first" },
  {
    id: 'above-local',
    label: 'Remote first',
    title: 'Paired devices get priority over local work',
  },
];

function configToDraft(config: MachineServingConfig | undefined): ServingDraft {
  return {
    port: config?.port !== undefined ? String(config.port) : '',
    bindAddress: config?.bindAddress ?? '',
    priority: config?.priority ?? 'equal',
    allowModels: (config?.allowModels ?? []).join(', '),
    maxConcurrentPerDevice:
      config?.limits?.maxConcurrentPerDevice !== undefined
        ? String(config.limits.maxConcurrentPerDevice)
        : '',
    maxChatPerDevice:
      config?.limits?.maxChatPerDevice !== undefined ? String(config.limits.maxChatPerDevice) : '',
    requestsPerMinute:
      config?.limits?.requestsPerMinute !== undefined
        ? String(config.limits.requestsPerMinute)
        : '',
  };
}

function draftToConfig(
  draft: ServingDraft,
  enabled: boolean,
): MachineServingConfig & { enabled: boolean } {
  const positiveInt = (value: string): number | undefined => {
    const n = Number.parseInt(value.trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  const port = positiveInt(draft.port);
  const bindAddress = draft.bindAddress.trim();
  const allowModels = draft.allowModels
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const limits: NonNullable<MachineServingConfig['limits']> = {};
  const maxConcurrent = positiveInt(draft.maxConcurrentPerDevice);
  const maxChat = positiveInt(draft.maxChatPerDevice);
  const rpm = positiveInt(draft.requestsPerMinute);
  if (maxConcurrent !== undefined) limits.maxConcurrentPerDevice = maxConcurrent;
  if (maxChat !== undefined) limits.maxChatPerDevice = maxChat;
  if (rpm !== undefined) limits.requestsPerMinute = rpm;
  // Cleared fields are omitted, not sent empty: both PUT surfaces replace
  // the whole remoteServing key, so omission resets a field to its default.
  return {
    enabled,
    ...(bindAddress ? { bindAddress } : {}),
    ...(port !== undefined ? { port } : {}),
    ...(draft.priority !== 'equal' ? { priority: draft.priority } : {}),
    ...(allowModels.length > 0 ? { allowModels } : {}),
    ...(Object.keys(limits).length > 0 ? { limits } : {}),
  };
}

export function RemoteServersPanel() {
  const [remotes, setRemotes] = useState<PairedRemoteInfo[]>([]);
  const [identity, setIdentity] = useState<DeviceIdentity | null>(null);
  const [serving, setServing] = useState(false);
  const [servingPort, setServingPort] = useState<number | undefined>(undefined);
  const [machineServing, setMachineServing] = useState<MachineServingState | null>(null);
  const [machineGrants, setMachineGrants] = useState<MachineServingGrant[]>([]);
  const [machineDevices, setMachineDevices] = useState<MachineServingDevice[]>([]);
  const [staleUserPairings, setStaleUserPairings] = useState(false);
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
  const [revokeTarget, setRevokeTarget] = useState<MachineServingDevice | null>(null);
  const [draft, setDraft] = useState<ServingDraft>(EMPTY_DRAFT);
  const [draftDirty, setDraftDirty] = useState(false);
  // refresh polls every 5s with stable identity; the ref lets it skip
  // re-seeding the form while the user has unapplied edits.
  const draftDirtyRef = useRef(false);

  const markDirty = useCallback((value: boolean) => {
    draftDirtyRef.current = value;
    setDraftDirty(value);
  }, []);

  const editDraft = useCallback(
    (patch: Partial<ServingDraft>) => {
      setDraft((prev) => ({ ...prev, ...patch }));
      markDirty(true);
    },
    [markDirty],
  );

  const refresh = useCallback(async () => {
    try {
      const [list, cfg] = await Promise.all([api.listRemotes(), api.getConfig()]);
      setRemotes(list.remotes);
      setServing(Boolean(cfg.remoteServing?.enabled));
      setServingPort(cfg.remoteServing?.port);
      if (!draftDirtyRef.current) setDraft(configToDraft(cfg.remoteServing));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    // Machine-broker serving: present only on machine installs (503 without
    // an adopted broker → this device manages its own listener instead).
    try {
      const state = await api.getMachineServing();
      setMachineServing(state);
      setServing(Boolean(state.config.enabled));
      setServingPort(state.status.port ?? state.config.port);
      if (!draftDirtyRef.current) setDraft(configToDraft(state.config));
      const [grants, devices] = await Promise.all([
        api.listMachineServingGrants(),
        api.listMachineServingDevices(),
      ]);
      setMachineGrants(grants.grants.filter((g) => g.status === 'pending'));
      setMachineDevices(devices.devices);
    } catch {
      setMachineServing(null);
      setMachineGrants([]);
      setMachineDevices([]);
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

  // Re-pair hint: device tokens issued by THIS user daemon are stranded once
  // the broker owns the listener — peers hold the user daemon's identity and
  // port, which no longer serves.
  useEffect(() => {
    if (!machineServing) {
      setStaleUserPairings(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`${api.getBaseUrl()}/v1/apps`, { headers: api.authHeader() });
        if (!res.ok) return;
        const body = (await res.json()) as { apps?: Array<{ kind?: string }> };
        if (!cancelled) {
          setStaleUserPairings((body.apps ?? []).some((a) => a.kind === 'device'));
        }
      } catch {
        /* best-effort */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [machineServing]);

  useEffect(() => {
    void refresh();
    const t = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(t);
  }, [refresh]);

  // One writer for the toggle AND the Apply button: both send the full draft
  // (the PUT surfaces replace the whole remoteServing key), so flipping the
  // toggle also commits pending field edits in the same rebind.
  const applyServing = useCallback(
    async (enabled: boolean) => {
      setBusy('serving');
      try {
        const config = draftToConfig(draft, enabled);
        if (machineServing) {
          const updated = await api.updateMachineServing(config);
          setMachineServing(updated);
          setServing(Boolean(updated.config.enabled));
          setServingPort(updated.status.port ?? updated.config.port);
          setDraft(configToDraft(updated.config));
        } else {
          const updated = await api.updateConfig({ remoteServing: config });
          setServing(Boolean(updated.remoteServing?.enabled));
          setServingPort(updated.remoteServing?.port);
          setDraft(configToDraft(updated.remoteServing));
        }
        markDirty(false);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(null);
      }
    },
    [machineServing, draft, markDirty],
  );

  const discardDraft = useCallback(() => {
    markDirty(false);
    void refresh();
  }, [markDirty, refresh]);

  const decideGrant = useCallback(
    async (grant: MachineServingGrant, approve: boolean) => {
      setBusy(`grant:${grant.id}`);
      try {
        if (approve) await api.approveMachineServingGrant(grant.id);
        else await api.denyMachineServingGrant(grant.id);
        setError(null);
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(null);
      }
    },
    [refresh],
  );

  const revokeDevice = useCallback(async () => {
    if (!revokeTarget) return;
    setBusy('revoke');
    try {
      await api.revokeMachineServingDevice(revokeTarget.appId);
      setRevokeTarget(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [revokeTarget, refresh]);

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

  const ownFingerprint = machineServing
    ? machineServing.identity.fingerprint
    : (identity?.fingerprint ?? null);

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
        <h3>{machineServing ? 'This machine as a server' : 'This device as a server'}</h3>
        <label className="settings-toggle">
          <input
            type="checkbox"
            checked={serving}
            disabled={busy === 'serving'}
            onChange={(e) => void applyServing(e.target.checked)}
          />
          <span>Serve my models to paired devices over the LAN</span>
        </label>
        {serving ? (
          <p className="muted small">
            Other devices on your network can request inference here once you approve their pairing
            {machineServing ? ' below' : ' (Connected Apps → Paired devices)'}. They reach only
            inference — never your projects or files.
            {machineServing
              ? ' Served by the machine service, so it keeps working while nobody is logged in.'
              : ''}{' '}
            Listening on port {servingPort ?? 6229}.
          </p>
        ) : (
          <p className="muted small">Off — no other device can run models here.</p>
        )}
        {ownFingerprint && (
          <div className="device-code-block">
            <span className="muted small">
              {machineServing ? "This machine's identity code" : "This device's identity code"} —
              when you pair from another device, check that it shows the same code:
            </span>
            <code className="device-code">{deviceCode(ownFingerprint)}</code>
            <details className="device-code-full">
              <summary className="muted small">Show the full fingerprint</summary>
              <code style={{ wordBreak: 'break-all' }}>{ownFingerprint}</code>
            </details>
          </div>
        )}
        {machineServing && staleUserPairings && (
          <p className="muted small">
            Some devices paired with this account's daemon before the machine service took over
            serving. Those pairings no longer work — ask them to unpair and pair again against this
            machine's identity code above.
          </p>
        )}

        <div className="remote-serving-fields">
          <div className="remote-serving-field">
            <span className="muted small">Port</span>
            <input
              type="number"
              min={1}
              max={65535}
              placeholder="6229"
              value={draft.port}
              onChange={(e) => editDraft({ port: e.target.value })}
            />
          </div>
          <div className="remote-serving-field">
            <span className="muted small">Network interface (IP)</span>
            <input
              type="text"
              placeholder="all networks (0.0.0.0)"
              value={draft.bindAddress}
              onChange={(e) => editDraft({ bindAddress: e.target.value })}
            />
          </div>
          <div className="remote-serving-field">
            <span className="muted small">Max concurrent per device</span>
            <input
              type="number"
              min={1}
              placeholder="4"
              value={draft.maxConcurrentPerDevice}
              onChange={(e) => editDraft({ maxConcurrentPerDevice: e.target.value })}
            />
          </div>
          <div className="remote-serving-field">
            <span className="muted small">Max chat per device</span>
            <input
              type="number"
              min={1}
              placeholder="same as concurrent"
              value={draft.maxChatPerDevice}
              onChange={(e) => editDraft({ maxChatPerDevice: e.target.value })}
            />
          </div>
          <div className="remote-serving-field">
            <span className="muted small">Requests per minute per device</span>
            <input
              type="number"
              min={1}
              placeholder="unlimited"
              value={draft.requestsPerMinute}
              onChange={(e) => editDraft({ requestsPerMinute: e.target.value })}
            />
          </div>
          <div className="remote-serving-field remote-serving-field-wide">
            <span className="muted small">
              Allowed models — comma-separated ids like <code>llama-cpp:gemma4-e4b-q4</code>; empty
              serves every installed model
            </span>
            <input
              type="text"
              placeholder="all installed models"
              value={draft.allowModels}
              onChange={(e) => editDraft({ allowModels: e.target.value })}
            />
          </div>
          <div className="remote-serving-field remote-serving-field-wide">
            <span className="muted small">When remote and local work compete</span>
            <div className="gz-tray" role="radiogroup" aria-label="Remote work priority">
              {PRIORITY_CHOICES.map((choice) => (
                <button
                  key={choice.id}
                  type="button"
                  // biome-ignore lint/a11y/useSemanticElements: WAI-ARIA radiogroup of key buttons; a native radio cannot carry the keys-in-trays treatment.
                  role="radio"
                  aria-checked={draft.priority === choice.id}
                  className={`gz-key${draft.priority === choice.id ? ' gz-key-active' : ''}`}
                  title={choice.title}
                  onClick={() => editDraft({ priority: choice.id })}
                >
                  {choice.label}
                </button>
              ))}
            </div>
          </div>
        </div>
        {draftDirty && (
          <div className="remote-serving-actions">
            <button
              type="button"
              className="primary"
              disabled={busy !== null}
              onClick={() => void applyServing(serving)}
            >
              {busy === 'serving' ? 'Applying…' : 'Apply server settings'}
            </button>
            <button type="button" disabled={busy !== null} onClick={discardDraft}>
              Discard changes
            </button>
          </div>
        )}
      </div>

      {machineServing && machineGrants.length > 0 && (
        <div className="settings-subsection">
          <h3>Pending pairing requests</h3>
          <ul className="settings-list">
            {machineGrants.map((g) => (
              <li key={g.id} className="connected-app-row">
                <div className="connected-app-meta">
                  <div className="connected-app-name">{g.appName}</div>
                  <div className="muted small">
                    requested {formatRelative(g.createdAt)} — scopes: {g.scopes.join(', ')}
                  </div>
                </div>
                <div className="connected-app-actions">
                  <button
                    type="button"
                    className="primary"
                    onClick={() => void decideGrant(g, true)}
                    disabled={busy !== null}
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    onClick={() => void decideGrant(g, false)}
                    disabled={busy !== null}
                  >
                    Deny
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {machineServing && machineDevices.length > 0 && (
        <div className="settings-subsection">
          <h3>Devices paired with this machine</h3>
          <ul className="settings-list">
            {machineDevices.map((d) => (
              <li key={d.appId} className="connected-app-row">
                <div className="connected-app-meta">
                  <div className="connected-app-name">{d.appName}</div>
                  <div className="muted small">
                    paired {formatRelative(d.createdAt)} — last used {formatRelative(d.lastUsedAt)}
                  </div>
                </div>
                <div className="connected-app-actions">
                  <button
                    type="button"
                    className="danger"
                    onClick={() => setRevokeTarget(d)}
                    disabled={busy !== null}
                  >
                    Revoke
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="settings-subsection">
        <h3>Paired servers</h3>
        <div className="remote-pair-form">
          <input
            type="text"
            placeholder="https://192.168.1.50:6229"
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
                    {r.baseUrl} — identity code{' '}
                    <code>{deviceCode(r.pinnedIdentityFingerprint)}</code> — last seen{' '}
                    {formatRelative(r.lastSeenAt)}
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
          pairInspection?.identityChanged ? 'Server identity changed' : 'Check the identity code'
        }
        message={
          pairInspection ? (
            <>
              On the server device, open Settings → Remote Servers and check that it shows this same
              identity code:
              <div className="device-code-block">
                <code className="device-code">{deviceCode(pairInspection.fingerprint)}</code>
                <details className="device-code-full">
                  <summary className="muted small">Show the full fingerprint</summary>
                  <code style={{ wordBreak: 'break-all' }}>{pairInspection.fingerprint}</code>
                </details>
              </div>
              {pairInspection.identityChanged && pairInspection.existingFingerprint && (
                <>
                  This is not the code you trusted before. Continue only if you know why it changed
                  — a reinstall or a wiped keychain does this, and so does someone impersonating the
                  server. Previously trusted:{' '}
                  <code>{deviceCode(pairInspection.existingFingerprint)}</code>
                </>
              )}
            </>
          ) : null
        }
        confirmLabel={pairInspection?.identityChanged ? 'Trust new identity' : 'The code matches'}
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

      <ConfirmDialog
        open={revokeTarget !== null}
        title={revokeTarget ? `Revoke ${revokeTarget.appName}?` : 'Revoke device'}
        message={
          revokeTarget ? (
            <>
              <strong>{revokeTarget.appName}</strong> will immediately lose access to this machine's
              models. It can pair again later, which you would approve here.
            </>
          ) : null
        }
        confirmLabel="Revoke"
        danger
        onConfirm={revokeDevice}
        onCancel={() => setRevokeTarget(null)}
      />
    </section>
  );
}
