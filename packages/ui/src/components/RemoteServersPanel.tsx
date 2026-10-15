import type {
  DiscoveredRemoteServer,
  LanAddressInfo,
  MachineServingConfig,
  MachineServingState,
  PairedRemoteInfo,
  PairingCodeState,
} from '@bendyline/gezel-client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiErrorMessage } from '../api-error.js';
import { api } from '../api.js';
import { Dialog } from '../primitives/index.js';
import { onRadioKeyDown } from '../primitives/radio-keyboard.js';
import { formatAbsoluteTime, formatRelativeTime } from '../relative-time.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { invalidateRemoteServers } from './ModelPicker.js';
import { approvalErrorMessage } from './grant-verification.js';

/**
 * Settings → Remote Servers, shaped like a game's LAN lobby:
 *
 *  1. "Share this device's models" — the opt-in toggle (off by default), the
 *     address other devices can type, and "Add a device", which shows an
 *     8-digit connect code for a few minutes. The other device types it and
 *     is connected: the code runs SPAKE2 on both daemons, so it both proves
 *     the person is at this screen and binds the two device identities, with
 *     no identity-code comparison and no Approve click. Below that, the
 *     devices using this one, requests from gezel versions that predate
 *     connect codes (approved here), and the server settings behind an
 *     explicit Apply — a port/bind change rebinds the live listener. On
 *     machine installs the listener belongs to the machine service, so all
 *     of this is backed by /api/machine-serving; otherwise it is this
 *     daemon's own config and its `kind: 'device'` grants from /v1/apps.
 *  2. "Connect to another device" — gezel devices announcing themselves on
 *     the network (mDNS), connect by IP address, and the servers this device
 *     remembers, marked when they are on the network right now.
 */

interface DeviceIdentity {
  deviceId: string;
  fingerprint: string;
}

/** A pairing request waiting on this device, from either host. */
interface PendingDevice {
  id: string;
  appName: string;
  createdAt: number;
}

/** A device paired with this one as its server, from either host. */
interface PairedDevice {
  appId: string;
  appName: string;
  createdAt: number;
  lastUsedAt?: number;
}

interface UserAppsResponse {
  apps?: Array<{
    appId: string;
    appName: string;
    createdAt: number;
    lastUsedAt?: number;
    kind?: string;
  }>;
  grants?: Array<{
    id: string;
    appName: string;
    createdAt: number;
    status: string;
    kind?: string;
  }>;
}

/** A server picked to connect to, before its code has been entered. */
interface ConnectTarget {
  baseUrl: string;
  name: string;
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
 * further to make the line prettier. (A connect code can be 8 digits only
 * because SPAKE2 allows one online guess per attempt, not an offline grind.)
 */
function deviceCode(fp: string): string {
  return (fp.slice(0, 16).match(/.{1,4}/g) ?? []).join(' ');
}

function formatRelative(ms?: number): string {
  if (!ms) return 'never';
  return formatRelativeTime(ms);
}

/**
 * One line on whether a remembered server can be used right now. Unreachable
 * isn't an error to fix: work meant for it runs on this install's own
 * provider until it's back, and the line says so.
 */
function remoteStatusText(remote: PairedRemoteInfo, seenOnNetwork: boolean): string {
  if (remote.status === 'offline' && !seenOnNetwork) {
    const since = remote.lastSeenAt ? ` (last reached ${formatRelative(remote.lastSeenAt)})` : '';
    return `not reachable${since} — gezellen answer without it until it's back`;
  }
  if (seenOnNetwork) return 'on your network now';
  if (remote.status === 'online') return 'reachable';
  return remote.lastSeenAt
    ? `last reached ${formatRelative(remote.lastSeenAt)}`
    : `connected ${formatRelative(remote.pairedAt)}`;
}

/** `48210937` → `4821 0937`, keeping only digits, at most eight. */
function formatConnectCode(value: string): string {
  const digits = value.replace(/\D/g, '').slice(0, 8);
  return digits.length > 4 ? `${digits.slice(0, 4)} ${digits.slice(4)}` : digits;
}

function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

const DEFAULT_SERVING_PORT = 6229;

/**
 * What a person types into "Connect by IP address" — `192.168.1.50`,
 * `192.168.1.50:7000`, or a full `https://` origin — as the origin pairing
 * expects. The daemon still decides whether it is acceptable.
 */
function serverOrigin(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`);
    if (!url.port) url.port = String(DEFAULT_SERVING_PORT);
    return url.origin;
  } catch {
    return null;
  }
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
  advertise: boolean;
}

const EMPTY_DRAFT: ServingDraft = {
  port: '',
  bindAddress: '',
  priority: 'equal',
  allowModels: '',
  maxConcurrentPerDevice: '',
  maxChatPerDevice: '',
  requestsPerMinute: '',
  advertise: true,
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
    advertise: config?.advertise !== false,
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
    ...(draft.advertise ? {} : { advertise: false }),
    ...(draft.priority !== 'equal' ? { priority: draft.priority } : {}),
    ...(allowModels.length > 0 ? { allowModels } : {}),
    ...(Object.keys(limits).length > 0 ? { limits } : {}),
  };
}

/**
 * Where another device should point: a listener bound to one interface is
 * reachable only there; a wildcard bind on every LAN address, best first.
 */
function shareAddresses(bindAddress: string | undefined, lan: LanAddressInfo[]): string[] {
  const bind = bindAddress?.trim();
  if (bind && bind !== '0.0.0.0' && bind !== '::') return [bind];
  return lan.map((a) => a.address);
}

async function readUserDeviceApps(): Promise<UserAppsResponse | null> {
  try {
    const res = await fetch(`${api.getBaseUrl()}/v1/apps`, { headers: api.authHeader() });
    return res.ok ? ((await res.json()) as UserAppsResponse) : null;
  } catch {
    return null;
  }
}

/** "Enter the code shown on Werkbank." One field, eight digits. */
function ConnectCodeDialog({
  target,
  error,
  busy,
  onSubmit,
  onCancel,
}: {
  target: ConnectTarget | null;
  error: string | null;
  busy: boolean;
  onSubmit: (code: string) => void;
  onCancel: () => void;
}) {
  const [code, setCode] = useState('');
  useEffect(() => {
    if (target) setCode('');
  }, [target]);
  const ready = code.replace(/\D/g, '').length === 8;

  return (
    <Dialog.Root
      open={target !== null}
      onOpenChange={(next) => {
        if (!next && !busy) onCancel();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay />
        <Dialog.Content>
          <Dialog.Title asChild>
            <h3>Connect to {target?.name}</h3>
          </Dialog.Title>
          <Dialog.Description className="muted small">
            Enter the code shown on {target?.name}. To see one, open Settings → Remote Servers there
            and choose <strong>Add a device</strong>.
          </Dialog.Description>
          <form
            className="remote-connect-code-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (ready && !busy) onSubmit(code);
            }}
          >
            <input
              className="remote-connect-code-input"
              value={code}
              onChange={(e) => setCode(formatConnectCode(e.target.value))}
              placeholder="0000 0000"
              inputMode="numeric"
              autoComplete="one-time-code"
              spellCheck={false}
              maxLength={9}
              aria-label="Connect code"
              // biome-ignore lint/a11y/noAutofocus: the dialog exists to take this one field.
              autoFocus
            />
            {error && (
              <p className="settings-error small" role="alert">
                {error}
              </p>
            )}
            <Dialog.Actions>
              <button type="button" onClick={onCancel} disabled={busy}>
                Cancel
              </button>
              <button type="submit" className="primary" disabled={!ready || busy}>
                {busy ? 'Connecting…' : 'Connect'}
              </button>
            </Dialog.Actions>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function RemoteServersPanel() {
  const [remotes, setRemotes] = useState<PairedRemoteInfo[]>([]);
  const [identity, setIdentity] = useState<DeviceIdentity | null>(null);
  const [serving, setServing] = useState(false);
  const [servingPort, setServingPort] = useState<number | undefined>(undefined);
  const [servingBind, setServingBind] = useState<string | undefined>(undefined);
  const [machineServing, setMachineServing] = useState<MachineServingState | null>(null);
  const [pendingDevices, setPendingDevices] = useState<PendingDevice[]>([]);
  const [pairedDevices, setPairedDevices] = useState<PairedDevice[]>([]);
  const [staleUserPairings, setStaleUserPairings] = useState(false);
  const [lanAddresses, setLanAddresses] = useState<LanAddressInfo[]>([]);
  // null until the first browse answers: "looking" rather than "none found".
  const [discovery, setDiscovery] = useState<{
    available: boolean;
    servers: DiscoveredRemoteServer[];
  } | null>(null);
  const [pairingCode, setPairingCode] = useState<PairingCodeState | null>(null);
  const [codeOpenedAt, setCodeOpenedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [directAddress, setDirectAddress] = useState('');
  const [connectingTo, setConnectingTo] = useState<string | null>(null);
  const [codeTarget, setCodeTarget] = useState<ConnectTarget | null>(null);
  const [codeError, setCodeError] = useState<string | null>(null);
  const [awaitingApprovalFrom, setAwaitingApprovalFrom] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // Servers from before connect codes: compare the identity code, then wait
  // for someone to approve on the server.
  const [pairInspection, setPairInspection] = useState<{
    baseUrl: string;
    displayName: string;
    fingerprint: string;
    existingFingerprint?: string;
    identityChanged: boolean;
  } | null>(null);
  const [forgetTarget, setForgetTarget] = useState<PairedRemoteInfo | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<PairedDevice | null>(null);
  const [draft, setDraft] = useState<ServingDraft>(EMPTY_DRAFT);
  const [draftDirty, setDraftDirty] = useState(false);
  // refresh polls every 5s with stable identity; the refs let it skip
  // re-seeding the form while the user has unapplied edits, and pick the
  // pairing-code surface for the host that owns the listener.
  const draftDirtyRef = useRef(false);
  const machineRef = useRef(false);

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

  const readPairingCode = useCallback(async () => {
    try {
      setPairingCode(
        machineRef.current ? await api.getMachineServingPairingCode() : await api.getPairingCode(),
      );
    } catch {
      setPairingCode(null);
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [list, cfg] = await Promise.all([api.listRemotes({ check: true }), api.getConfig()]);
      setRemotes(list.remotes);
      setServing(Boolean(cfg.remoteServing?.enabled));
      setServingPort(cfg.remoteServing?.port);
      setServingBind(cfg.remoteServing?.bindAddress);
      if (!draftDirtyRef.current) setDraft(configToDraft(cfg.remoteServing));
      setError(null);
    } catch (err) {
      setError(apiErrorMessage(err));
    }
    const userApps = await readUserDeviceApps();
    const userDeviceApps = (userApps?.apps ?? []).filter((a) => a.kind === 'device');
    // Machine-broker serving: present only on machine installs (503 without
    // an adopted broker → this device manages its own listener instead).
    try {
      const state = await api.getMachineServing();
      machineRef.current = true;
      setMachineServing(state);
      setServing(Boolean(state.config.enabled));
      setServingPort(state.status.port ?? state.config.port);
      setServingBind(state.config.bindAddress);
      if (!draftDirtyRef.current) setDraft(configToDraft(state.config));
      const [grants, devices] = await Promise.all([
        api.listMachineServingGrants(),
        api.listMachineServingDevices(),
      ]);
      setPendingDevices(grants.grants.filter((g) => g.status === 'pending'));
      setPairedDevices(devices.devices);
      // Device tokens THIS user daemon issued are stranded once the broker
      // owns the listener: peers hold the user daemon's identity and port.
      setStaleUserPairings(userDeviceApps.length > 0);
    } catch {
      machineRef.current = false;
      setMachineServing(null);
      setStaleUserPairings(false);
      setPendingDevices(
        (userApps?.grants ?? []).filter((g) => g.kind === 'device' && g.status === 'pending'),
      );
      setPairedDevices(userDeviceApps);
    }
    await readPairingCode();
    try {
      setLanAddresses((await api.listLanAddresses()).addresses);
    } catch {
      setLanAddresses([]);
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
  }, [readPairingCode]);

  useEffect(() => {
    void refresh();
    const t = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(t);
  }, [refresh]);

  // Discovery polls on its own clock: the first browse waits about a second
  // for answers, which must not hold up the rest of the panel.
  useEffect(() => {
    let cancelled = false;
    const browse = async () => {
      try {
        const result = await api.discoverRemotes();
        if (!cancelled) setDiscovery(result);
      } catch {
        if (!cancelled) setDiscovery({ available: false, servers: [] });
      }
    };
    void browse();
    const t = window.setInterval(() => void browse(), 5000);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, []);

  // While a code shows: tick the countdown, and look often enough that
  // "connected" appears soon after the other device uses it.
  const codeShowing = Boolean(pairingCode?.code);
  useEffect(() => {
    if (!codeShowing) return;
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    const poll = window.setInterval(() => void readPairingCode(), 2000);
    return () => {
      window.clearInterval(tick);
      window.clearInterval(poll);
    };
  }, [codeShowing, readPairingCode]);

  const pairedNote =
    codeOpenedAt !== null && !pairingCode?.code && pairingCode?.lastPaired
      ? pairingCode.lastPaired.at >= codeOpenedAt
        ? pairingCode.lastPaired.appName
        : null
      : null;

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
          setServingBind(updated.config.bindAddress);
          setDraft(configToDraft(updated.config));
        } else {
          const updated = await api.updateConfig({ remoteServing: config });
          setServing(Boolean(updated.remoteServing?.enabled));
          setServingPort(updated.remoteServing?.port);
          setServingBind(updated.remoteServing?.bindAddress);
          setDraft(configToDraft(updated.remoteServing));
        }
        markDirty(false);
        setError(null);
        await readPairingCode();
      } catch (err) {
        setError(apiErrorMessage(err));
      } finally {
        setBusy(null);
      }
    },
    [machineServing, draft, markDirty, readPairingCode],
  );

  const discardDraft = useCallback(() => {
    markDirty(false);
    void refresh();
  }, [markDirty, refresh]);

  const showCode = useCallback(async () => {
    setBusy('code');
    try {
      setPairingCode(
        machineServing ? await api.openMachineServingPairingCode() : await api.openPairingCode(),
      );
      setCodeOpenedAt(Date.now());
      setNow(Date.now());
      setError(null);
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setBusy(null);
    }
  }, [machineServing]);

  const hideCode = useCallback(async () => {
    setCodeOpenedAt(null);
    try {
      setPairingCode(
        machineServing ? await api.closeMachineServingPairingCode() : await api.closePairingCode(),
      );
    } catch (err) {
      setError(apiErrorMessage(err));
    }
  }, [machineServing]);

  const decideDevice = useCallback(
    async (request: PendingDevice, approve: boolean) => {
      setBusy(`grant:${request.id}`);
      try {
        if (machineServing) {
          if (approve) await api.approveMachineServingGrant(request.id);
          else await api.denyMachineServingGrant(request.id);
        } else {
          const action = approve ? 'approve' : 'deny';
          const res = await fetch(
            `${api.getBaseUrl()}/v1/apps/grant/${encodeURIComponent(request.id)}/${action}`,
            { method: 'POST', headers: api.authHeader() },
          );
          if (!res.ok) throw new Error(await approvalErrorMessage(res, `Could not ${action}`));
        }
        setError(null);
        await refresh();
      } catch (err) {
        setError(apiErrorMessage(err));
      } finally {
        setBusy(null);
      }
    },
    [machineServing, refresh],
  );

  const revokeDevice = useCallback(async () => {
    if (!revokeTarget) return;
    setBusy('revoke');
    try {
      if (machineServing) {
        await api.revokeMachineServingDevice(revokeTarget.appId);
      } else {
        const res = await fetch(
          `${api.getBaseUrl()}/v1/apps/${encodeURIComponent(revokeTarget.appId)}/token`,
          { method: 'DELETE', headers: api.authHeader() },
        );
        if (!res.ok) {
          throw new Error(`Could not disconnect ${revokeTarget.appName}: HTTP ${res.status}`);
        }
      }
      setRevokeTarget(null);
      await refresh();
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setBusy(null);
    }
  }, [machineServing, revokeTarget, refresh]);

  /** Starts connecting: servers that take codes ask for one, older ones fall back. */
  const connect = useCallback(
    async (target: ConnectTarget) => {
      if (busy) return;
      setBusy('connect');
      setConnectingTo(target.baseUrl);
      setConnectError(null);
      setNotice(null);
      try {
        const inspected = await api.inspectRemote({ baseUrl: target.baseUrl });
        if (inspected.pairingMethods.includes('code')) {
          setCodeError(null);
          setCodeTarget(target);
        } else {
          setPairInspection({ baseUrl: target.baseUrl, displayName: target.name, ...inspected });
        }
      } catch (err) {
        setConnectError(apiErrorMessage(err));
      } finally {
        setConnectingTo(null);
        setBusy(null);
      }
    },
    [busy],
  );

  const connectByAddress = useCallback(() => {
    const origin = serverOrigin(directAddress);
    if (!origin) {
      setConnectError('Enter an IP address, like 192.168.1.50.');
      return;
    }
    void connect({ baseUrl: origin, name: new URL(origin).hostname });
  }, [connect, directAddress]);

  const submitCode = useCallback(
    async (code: string) => {
      if (!codeTarget) return;
      setBusy('code-connect');
      try {
        const { remote } = await api.pairRemoteWithCode({ baseUrl: codeTarget.baseUrl, code });
        invalidateRemoteServers();
        setCodeTarget(null);
        setDirectAddress('');
        setNotice(`Connected to ${remote.displayName}. Its models are in your model picker.`);
        await refresh();
      } catch (err) {
        setCodeError(apiErrorMessage(err));
      } finally {
        setBusy(null);
      }
    },
    [codeTarget, refresh],
  );

  const confirmLegacyPair = useCallback(async () => {
    if (!pairInspection) return;
    const inspection = pairInspection;
    setPairInspection(null);
    setBusy('connect');
    setAwaitingApprovalFrom(inspection.displayName);
    try {
      const { remote } = await api.pairRemote({
        baseUrl: inspection.baseUrl,
        displayName: inspection.displayName,
        expectedIdentityFingerprint: inspection.fingerprint,
        ...(inspection.identityChanged ? { acceptIdentityChange: true } : {}),
      });
      invalidateRemoteServers();
      setDirectAddress('');
      setNotice(`Connected to ${remote.displayName}. Its models are in your model picker.`);
      await refresh();
    } catch (err) {
      setConnectError(apiErrorMessage(err));
    } finally {
      setAwaitingApprovalFrom(null);
      setBusy(null);
    }
  }, [pairInspection, refresh]);

  const forget = useCallback(async () => {
    if (!forgetTarget) return;
    setBusy('forget');
    try {
      await api.unpairRemote(forgetTarget.remoteId);
      invalidateRemoteServers();
      setForgetTarget(null);
      setNotice(null);
      await refresh();
    } catch (err) {
      setConnectError(apiErrorMessage(err));
    } finally {
      setBusy(null);
    }
  }, [forgetTarget, refresh]);

  const ownFingerprint = machineServing
    ? machineServing.identity.fingerprint
    : (identity?.fingerprint ?? null);
  const listenPort = servingPort ?? DEFAULT_SERVING_PORT;
  const reachableAt = shareAddresses(servingBind, lanAddresses);
  const shareUrl = reachableAt[0] ? `https://${reachableAt[0]}:${listenPort}` : null;
  const otherAddresses = reachableAt.slice(1, 4);
  const discovered = (discovery?.servers ?? []).filter(
    (s) => s.fingerprint !== ownFingerprint && s.fingerprint !== identity?.fingerprint,
  );
  const onNetwork = new Set(discovered.map((s) => s.fingerprint));

  const copyShareUrl = useCallback(async () => {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* the address stays selectable */
    }
  }, [shareUrl]);

  const deviceWord = machineServing ? 'machine' : 'device';
  const codeLeftMs = pairingCode?.expiresAt ? pairingCode.expiresAt - now : 0;

  return (
    <section className="settings-section remote-servers">
      <h2>Remote Servers</h2>
      <p className="muted small">
        Use the models on another gezel device on your network as if they were installed here, or
        share this device's models with your other devices. Only the model runs on the other device:
        your files and projects stay here, and it sees just the requests sent to its models.
      </p>

      {error && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}

      <div className="settings-subsection">
        <h3>Share this {deviceWord}'s models</h3>
        <label className="settings-toggle">
          <input
            type="checkbox"
            checked={serving}
            disabled={busy === 'serving'}
            onChange={(e) => void applyServing(e.target.checked)}
          />
          <span>Let other devices on my network use this {deviceWord}'s models</span>
        </label>
        {serving ? (
          <p className="muted small">
            Other devices on your network can find this one and connect with a code you show them.
            They can only run models here — never see your projects or files.
            {machineServing
              ? ' Served by the machine service, so it keeps working while nobody is logged in.'
              : ''}
          </p>
        ) : (
          <p className="muted small">Off — no other device can use this {deviceWord}'s models.</p>
        )}

        {serving && (
          <>
            {shareUrl && (
              <div className="remote-share-address">
                <span className="muted small">This {deviceWord}'s address on your network:</span>
                <div className="remote-share-address-row">
                  <code className="remote-share-url">{shareUrl}</code>
                  <button type="button" onClick={() => void copyShareUrl()}>
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                </div>
                {otherAddresses.length > 0 && (
                  <span className="muted small">
                    Other addresses on this {deviceWord}:{' '}
                    {otherAddresses.map((address, i) => (
                      <span key={address}>
                        {i > 0 ? ', ' : ''}
                        <span className="remote-address gz-selectable-text">{address}</span>
                      </span>
                    ))}
                  </span>
                )}
              </div>
            )}

            {pairingCode?.code ? (
              <div className="remote-pairing-code">
                <span className="muted small">Enter this code on the other device:</span>
                <code className="device-code remote-pairing-code-value">
                  {formatConnectCode(pairingCode.code)}
                </code>
                <span className="muted small">
                  It connects one device and expires in {formatCountdown(codeLeftMs)}.
                </span>
                <div className="remote-serving-actions">
                  <button type="button" onClick={() => void hideCode()}>
                    Done
                  </button>
                </div>
              </div>
            ) : (
              <div className="remote-add-device">
                <button
                  type="button"
                  className="primary"
                  disabled={busy !== null}
                  onClick={() => void showCode()}
                >
                  {busy === 'code' ? 'Getting a code…' : 'Add a device'}
                </button>
                {pairedNote && (
                  <output className="small">
                    <strong>{pairedNote}</strong> is connected.
                  </output>
                )}
              </div>
            )}
          </>
        )}
        {machineServing && staleUserPairings && (
          <p className="muted small">
            Some devices connected to this account's daemon before the machine service took over
            sharing. Those connections no longer work — connect them again with a new code.
          </p>
        )}

        {pairedDevices.length > 0 && (
          <>
            <h4>Devices using this {deviceWord}</h4>
            <ul className="settings-list">
              {pairedDevices.map((d) => (
                <li key={d.appId} className="connected-app-row">
                  <div className="connected-app-meta">
                    <div className="connected-app-name">{d.appName}</div>
                    <div className="muted small" title={formatAbsoluteTime(d.lastUsedAt)}>
                      connected {formatRelative(d.createdAt)} —{' '}
                      {d.lastUsedAt ? `last used ${formatRelative(d.lastUsedAt)}` : 'not used yet'}
                    </div>
                  </div>
                  <div className="connected-app-actions">
                    <button
                      type="button"
                      className="danger"
                      onClick={() => setRevokeTarget(d)}
                      disabled={busy !== null}
                    >
                      Disconnect
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}

        {pendingDevices.length > 0 && (
          <>
            <h4>Waiting for your approval</h4>
            <p className="muted small">
              These devices run an older gezel that can't use a code. Approve only a device you
              recognize.
            </p>
            <ul className="settings-list">
              {pendingDevices.map((g) => (
                <li key={g.id} className="connected-app-row connected-app-row--pending">
                  <div className="connected-app-meta">
                    <div className="connected-app-name">{g.appName}</div>
                    <div className="muted small" title={formatAbsoluteTime(g.createdAt)}>
                      wants to use this {deviceWord}'s models — asked {formatRelative(g.createdAt)}
                    </div>
                  </div>
                  <div className="connected-app-actions">
                    <button
                      type="button"
                      onClick={() => void decideDevice(g, false)}
                      disabled={busy !== null}
                    >
                      Deny
                    </button>
                    <button
                      type="button"
                      className="primary"
                      onClick={() => void decideDevice(g, true)}
                      disabled={busy !== null}
                    >
                      {busy === `grant:${g.id}` ? 'Approving…' : 'Approve'}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}

        <div className="remote-serving-field remote-serving-priority">
          <span className="muted small">When other devices and this one want models at once</span>
          <div
            className="gz-tray"
            role="radiogroup"
            onKeyDown={onRadioKeyDown}
            aria-label="Remote work priority"
          >
            {PRIORITY_CHOICES.map((choice) => (
              <button
                key={choice.id}
                type="button"
                // biome-ignore lint/a11y/useSemanticElements: WAI-ARIA radiogroup of key buttons; a native radio cannot carry the keys-in-trays treatment.
                role="radio"
                aria-checked={draft.priority === choice.id}
                tabIndex={draft.priority === choice.id ? 0 : -1}
                className={`gz-key${draft.priority === choice.id ? ' gz-key-active' : ''}`}
                title={choice.title}
                onClick={() => editDraft({ priority: choice.id })}
              >
                {choice.label}
              </button>
            ))}
          </div>
        </div>

        <details className="remote-serving-advanced">
          <summary>Advanced</summary>
          <div className="remote-serving-fields">
            <div className="remote-serving-field">
              <span className="muted small">Port</span>
              <input
                type="number"
                min={1}
                max={65535}
                placeholder={String(DEFAULT_SERVING_PORT)}
                aria-label="Server port"
                value={draft.port}
                onChange={(e) => editDraft({ port: e.target.value })}
              />
            </div>
            <div className="remote-serving-field">
              <span className="muted small">Network interface (IP)</span>
              <input
                type="text"
                placeholder="all networks (0.0.0.0)"
                aria-label="Bind address"
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
                aria-label="Max concurrent per device"
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
                aria-label="Max chat per device"
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
                aria-label="Requests per minute per device"
                value={draft.requestsPerMinute}
                onChange={(e) => editDraft({ requestsPerMinute: e.target.value })}
              />
            </div>
            <div className="remote-serving-field remote-serving-field-wide">
              <span className="muted small">
                Allowed models — comma-separated ids like <code>llama-cpp:gemma4-e4b-q4</code>.
                Leave empty to share every installed model.
              </span>
              <input
                type="text"
                placeholder="all installed models"
                aria-label="Allowed models"
                value={draft.allowModels}
                onChange={(e) => editDraft({ allowModels: e.target.value })}
              />
            </div>
            <label className="settings-toggle remote-serving-field-wide">
              <input
                type="checkbox"
                checked={draft.advertise}
                onChange={(e) => editDraft({ advertise: e.target.checked })}
              />
              <span>
                Let devices on this network find this {deviceWord} (otherwise they need its address)
              </span>
            </label>
            {ownFingerprint && (
              <div className="device-code-block remote-serving-field-wide">
                <span className="muted small">
                  Identity code — devices with an older gezel ask you to check it matches when they
                  connect:
                </span>
                <code className="device-code">{deviceCode(ownFingerprint)}</code>
                <details className="device-code-full">
                  <summary className="muted small">Show the full fingerprint</summary>
                  <code style={{ wordBreak: 'break-all' }}>{ownFingerprint}</code>
                </details>
              </div>
            )}
          </div>
        </details>
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

      <div className="settings-subsection">
        <h3>Connect to another device</h3>

        {notice && <output className="remote-status small">{notice}</output>}
        {connectError && (
          <p className="settings-error" role="alert">
            {connectError}
          </p>
        )}
        {awaitingApprovalFrom && (
          <output className="remote-status muted small">
            Waiting for <strong>{awaitingApprovalFrom}</strong> to approve. On that device, open
            Settings → Remote Servers and approve this device's request.
          </output>
        )}

        {discovery?.available !== false && (
          <>
            <h4>On your network</h4>
            {discovery === null ? (
              <p className="muted small">Looking for gezel devices on your network…</p>
            ) : discovered.length === 0 ? (
              <p className="muted small">
                No other gezel devices found yet. On the device you want to use, turn on{' '}
                <strong>Let other devices on my network use this device's models</strong>; it shows
                up here.
              </p>
            ) : (
              <ul className="settings-list">
                {discovered.map((s) => (
                  <li key={s.fingerprint} className="connected-app-row">
                    <div className="connected-app-meta">
                      <div className="connected-app-name">{s.name}</div>
                      <div className="muted small">
                        <span className="remote-address gz-selectable-text">{s.address}</span>
                      </div>
                    </div>
                    <div className="connected-app-actions">
                      {s.pairedRemoteId ? (
                        <span className="muted small">Connected</span>
                      ) : (
                        <button
                          type="button"
                          className="primary"
                          onClick={() => void connect({ baseUrl: s.baseUrl, name: s.name })}
                          disabled={busy !== null}
                        >
                          {busy === 'connect' && connectingTo === s.baseUrl
                            ? 'Connecting…'
                            : 'Connect'}
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}

        <details
          className="remote-connect-direct"
          open={discovery?.available === false ? true : undefined}
        >
          <summary>Connect by IP address</summary>
          <p className="muted small">
            For a device that isn't listed. It shows its address under{' '}
            <strong>Share this device's models</strong>.
          </p>
          <form
            className="remote-pair-form"
            onSubmit={(e) => {
              e.preventDefault();
              connectByAddress();
            }}
          >
            <input
              type="text"
              placeholder="192.168.1.50"
              aria-label="Server IP address"
              inputMode="url"
              spellCheck={false}
              value={directAddress}
              onChange={(e) => setDirectAddress(e.target.value)}
            />
            <button
              type="submit"
              className="primary"
              disabled={busy !== null || !directAddress.trim()}
            >
              Connect
            </button>
          </form>
        </details>

        <h4>Connected servers</h4>
        {remotes.length === 0 ? (
          <p className="muted small">
            None yet. Servers you connect to are remembered, and their models stay in your model
            picker.
          </p>
        ) : (
          <ul className="settings-list">
            {remotes.map((r) => (
              <li key={r.remoteId} className="connected-app-row">
                <div className="connected-app-meta">
                  <div className="connected-app-name">{r.displayName}</div>
                  <div className="muted small" title={formatAbsoluteTime(r.lastSeenAt)}>
                    <span className="remote-address gz-selectable-text">
                      {new URL(r.baseUrl).hostname}
                    </span>{' '}
                    — {remoteStatusText(r, onNetwork.has(r.pinnedIdentityFingerprint))}
                  </div>
                </div>
                <div className="connected-app-actions">
                  <button
                    type="button"
                    className="danger"
                    onClick={() => setForgetTarget(r)}
                    disabled={busy !== null}
                  >
                    Forget
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <ConnectCodeDialog
        target={codeTarget}
        error={codeError}
        busy={busy === 'code-connect'}
        onSubmit={(code) => void submitCode(code)}
        onCancel={() => setCodeTarget(null)}
      />

      <ConfirmDialog
        open={pairInspection !== null}
        title={
          pairInspection?.identityChanged ? 'Server identity changed' : 'Check the identity code'
        }
        message={
          pairInspection ? (
            <>
              {pairInspection.displayName} runs an older gezel that can't use a connect code. On it,
              open Settings → Remote Servers and check that it shows this same identity code:
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
        onConfirm={confirmLegacyPair}
        onCancel={() => setPairInspection(null)}
      />

      <ConfirmDialog
        open={forgetTarget !== null}
        title={forgetTarget ? `Forget ${forgetTarget.displayName}?` : 'Forget server'}
        message={
          forgetTarget ? (
            <>
              This device disconnects from <strong>{forgetTarget.displayName}</strong>, and its
              models leave your model picker. To use it again, connect with a new code.
            </>
          ) : null
        }
        confirmLabel="Forget"
        danger
        onConfirm={forget}
        onCancel={() => setForgetTarget(null)}
      />

      <ConfirmDialog
        open={revokeTarget !== null}
        title={revokeTarget ? `Disconnect ${revokeTarget.appName}?` : 'Disconnect device'}
        message={
          revokeTarget ? (
            <>
              <strong>{revokeTarget.appName}</strong> immediately loses access to this {deviceWord}
              's models. It can connect again with a new code.
            </>
          ) : null
        }
        confirmLabel="Disconnect"
        danger
        onConfirm={revokeDevice}
        onCancel={() => setRevokeTarget(null)}
      />
    </section>
  );
}
