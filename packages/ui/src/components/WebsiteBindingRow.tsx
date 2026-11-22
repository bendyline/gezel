import { useCallback, useEffect, useState } from 'react';
import { apiErrorMessage } from '../api-error.js';
import { api } from '../api.js';
import { formatAbsoluteTime, formatRelativeTime } from '../relative-time.js';
import {
  ConnectorConfigFields,
  type ConnectorConfigValue,
  type ConnectorFormManifest,
} from './ConnectorConfigFields.js';
import { connectorWaitingLine } from './connector-items.js';

interface WebsiteBinding {
  id: string;
  type: string;
  displayName?: string;
  lastSyncedAt?: string;
  lastError?: string;
  unreachable?: { since: string; offline: boolean; host?: string };
  summary?: string;
  config?: Record<string, unknown>;
}

/** A config value as the form holds it: arrays as comma-separated text. */
function toForm(config: Record<string, unknown>): Record<string, ConnectorConfigValue> {
  const out: Record<string, ConnectorConfigValue> = {};
  for (const [k, v] of Object.entries(config)) {
    if (typeof v === 'boolean') out[k] = v;
    else if (Array.isArray(v)) out[k] = v.map(String).join(', ');
    else if (typeof v === 'number' || typeof v === 'string') out[k] = String(v);
  }
  return out;
}

/** The form back into config, by the manifest's field types; keys the form does not show are kept. */
function fromForm(
  manifest: ConnectorFormManifest,
  form: Record<string, ConnectorConfigValue>,
  before: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...before };
  for (const [key, prop] of Object.entries(manifest.configSchema?.properties ?? {})) {
    const raw = form[key];
    delete out[key];
    if (prop.type === 'boolean') {
      if (typeof raw === 'boolean') out[key] = raw;
    } else if (typeof raw === 'string' && raw.trim()) {
      if (prop.type === 'array') {
        out[key] = raw
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
      } else if (prop.type === 'integer' || prop.type === 'number') {
        out[key] = Number(raw);
      } else {
        out[key] = raw.trim();
      }
    }
  }
  return out;
}

/**
 * A website connection on the Connections tab: what it has saved, Sync now,
 * Edit in place, signing in to the site, and Remove. Signing in opens a
 * browser window on this computer; the person signs in there and comes back
 * to press Done. Gezel never sees the password.
 */
export function WebsiteBindingRow({
  projectId,
  binding,
  onChanged,
  onRemove,
  onNotice,
}: {
  projectId: string;
  binding: WebsiteBinding;
  onChanged: () => void;
  onRemove: (id: string) => void;
  onNotice: (text: string, error?: boolean) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [manifest, setManifest] = useState<ConnectorFormManifest | null>(null);
  const [form, setForm] = useState<Record<string, ConnectorConfigValue>>({});
  const [name, setName] = useState(binding.displayName ?? '');
  const [askFirst, setAskFirst] = useState(binding.config?.gezelRequests === 'ask');
  const [session, setSession] = useState<{
    signedIn: boolean;
    lastVerifiedAt?: string;
    unverifiable?: boolean;
  } | null>(null);
  const [signIn, setSignIn] = useState<{ signInId: string; host: string } | null>(null);

  const loadSession = useCallback(() => {
    void api
      .getSiteSession(projectId, binding.id)
      .then(setSession)
      .catch(() => setSession(null));
  }, [projectId, binding.id]);

  useEffect(() => loadSession(), [loadSession]);

  const act = async (key: string, work: () => Promise<void>) => {
    setBusy(key);
    try {
      await work();
    } catch (err) {
      onNotice(apiErrorMessage(err), true);
    } finally {
      setBusy(null);
    }
  };

  const sync = () =>
    act('sync', async () => {
      const res = await api.syncConnector(projectId, binding.id);
      const r = res.result as {
        written?: number;
        quarantined?: number;
        error?: string;
        deferred?: boolean;
      };
      const n = (r.written ?? 0) + (r.quarantined ?? 0);
      onNotice(
        r.error
          ? `Couldn’t refresh: ${r.error}`
          : `${n === 1 ? '1 page' : `${n} pages`} saved or updated.${r.deferred ? ' Saving more in the background.' : ''}`,
      );
      onChanged();
    });

  const openEdit = () =>
    act('edit', async () => {
      const res = await api.listConnectorTypes();
      const item = res.items.find((i) => (i.manifest as { id?: string }).id === binding.type);
      if (!item) throw new Error('The website connection type is not in the catalog.');
      setManifest(item.manifest as unknown as ConnectorFormManifest);
      setForm(toForm(binding.config ?? {}));
      setName(binding.displayName ?? '');
      setAskFirst(binding.config?.gezelRequests === 'ask');
      setEditing(true);
    });

  const saveEdit = () =>
    act('save', async () => {
      if (!manifest) return;
      const config = fromForm(manifest, form, binding.config ?? {});
      if (askFirst) config.gezelRequests = 'ask';
      else delete config.gezelRequests;
      await api.patchConnector(projectId, binding.id, { config, displayName: name });
      setEditing(false);
      onNotice('Saved. The next refresh uses the new settings.');
      onChanged();
    });

  const startSignIn = () =>
    act('sign-in', async () => {
      setSignIn(await api.startSiteSignIn(projectId, binding.id));
    });

  const finishSignIn = () =>
    act('sign-in', async () => {
      if (!signIn) return;
      const res = await api.finishSiteSignIn(projectId, binding.id, signIn.signInId);
      setSignIn(null);
      onNotice(res.message, !res.ok);
      loadSession();
      if (res.ok) onChanged();
    });

  const cancelSignIn = () =>
    act('sign-in', async () => {
      if (signIn) await api.cancelSiteSignIn(projectId, binding.id, signIn.signInId);
      setSignIn(null);
    });

  const forget = () =>
    act('forget', async () => {
      await api.forgetSiteSession(projectId, binding.id);
      onNotice('Signed out. Refreshes now see what anyone sees.');
      loadSession();
    });

  const label = binding.displayName || 'Website';
  return (
    <li className="connected-app-row website-binding-row">
      <div>
        <strong>{label}</strong>
        <span className="muted small"> · Websites</span>
        <div className="small">
          {binding.unreachable ? (
            <span className="muted">
              {binding.summary ? `${binding.summary} · ` : ''}
              {connectorWaitingLine(binding.unreachable)}
            </span>
          ) : binding.lastError ? (
            <span className="error">{binding.lastError}</span>
          ) : binding.lastSyncedAt ? (
            <span className="muted" title={formatAbsoluteTime(binding.lastSyncedAt)}>
              {binding.summary ? `${binding.summary} · ` : ''}checked{' '}
              {formatRelativeTime(binding.lastSyncedAt)}
            </span>
          ) : (
            <span className="muted">Not visited yet</span>
          )}
        </div>
        {session?.signedIn ? (
          <div className="small muted">
            Signed in
            {session.lastVerifiedAt
              ? `, last worked ${formatRelativeTime(session.lastVerifiedAt)}`
              : ''}
            {session.unverifiable ? ' (Gezel cannot tell when it expires)' : ''}
          </div>
        ) : null}
        {signIn ? (
          <div className="website-sign-in">
            <p className="small">
              <output>
                A browser window opened for <strong>{signIn.host}</strong>. Sign in there, check
                that the address bar shows {signIn.host} or its sign-in service, then come back and
                press Done.
              </output>
            </p>
            <div className="gz-tray" role="toolbar" aria-label={`Sign in to ${signIn.host}`}>
              <button
                type="button"
                className="gz-key"
                disabled={busy !== null}
                onClick={() => void finishSignIn()}
              >
                {busy === 'sign-in' ? 'Checking…' : 'Done'}
              </button>
              <button
                type="button"
                className="gz-key"
                disabled={busy !== null}
                onClick={() => void cancelSignIn()}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : null}
        {editing && manifest ? (
          <div className="website-edit">
            <ConnectorConfigFields
              connector={manifest}
              config={form}
              onConfigChange={(k, v) => setForm((f) => ({ ...f, [k]: v }))}
              displayName={name}
              onDisplayNameChange={setName}
              credential=""
              onCredentialChange={() => {}}
              imapHost=""
              onImapHostChange={() => {}}
              imapPort=""
              onImapPortChange={() => {}}
              imapSecure
              onImapSecureChange={() => {}}
            />
            <label className="small">
              <input
                type="checkbox"
                checked={askFirst}
                onChange={(e) => setAskFirst(e.target.checked)}
              />{' '}
              Ask me before Gezel saves a page it wants to read
            </label>
            <div className="gz-tray" role="toolbar" aria-label={`Edit ${label}`}>
              <button
                type="button"
                className="gz-key"
                disabled={busy !== null}
                onClick={() => void saveEdit()}
              >
                {busy === 'save' ? 'Saving…' : 'Save'}
              </button>
              <button
                type="button"
                className="gz-key"
                disabled={busy !== null}
                onClick={() => setEditing(false)}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : null}
      </div>
      <div className="gz-mail-link-actions">
        <button type="button" onClick={() => void sync()} disabled={busy !== null}>
          {busy === 'sync' ? 'Working…' : 'Sync now'}
        </button>
        <button type="button" onClick={() => void openEdit()} disabled={busy !== null || editing}>
          Edit
        </button>
        {session?.signedIn ? (
          <button type="button" onClick={() => void forget()} disabled={busy !== null}>
            Sign out
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void startSignIn()}
            disabled={busy !== null || signIn !== null}
          >
            Sign in…
          </button>
        )}
        <button
          type="button"
          className="danger"
          onClick={() => onRemove(binding.id)}
          disabled={busy !== null}
        >
          Remove
        </button>
      </div>
    </li>
  );
}
