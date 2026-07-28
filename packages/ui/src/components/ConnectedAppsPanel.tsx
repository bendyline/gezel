import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import {
  approvalErrorMessage,
  formatVerificationCode,
  isVerificationCodeReady,
} from './grant-verification.js';

/**
 * Settings → Connected Apps tab. Lists every third-party app that's
 * been granted a per-app token via `/v1/apps/register` and any pending
 * grant requests waiting on user consent.
 *
 * Pending grants get inline approve / deny buttons so the user can
 * decide without leaving the page. The global `<GrantConsentDialog />`
 * mounted in App.tsx surfaces the SAME pending grants as a modal — the
 * two surfaces show the same underlying state from `GET /v1/apps`.
 *
 * Connected apps get a revoke button. Revocation hits `DELETE
 * /v1/apps/:appId/token` which invalidates the token immediately;
 * the app sees its next call fail with 401.
 */
interface ConnectedApp {
  appId: string;
  appName: string;
  scopes: string[];
  createdAt: number;
  lastUsedAt: number;
  /** `'device'` = a paired gezel device (remote model execution). */
  kind?: 'app' | 'device';
}

interface PendingGrant {
  id: string;
  appId: string;
  appName: string;
  scopes: string[];
  iconUrl?: string;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  createdAt: number;
  decidedAt?: number;
  kind?: 'app' | 'device';
  verificationRequired?: boolean;
}

interface ConnectedAppsResponse {
  apps: ConnectedApp[];
  grants: PendingGrant[];
}

function formatRelative(ms: number): string {
  if (!ms) return 'never';
  const delta = Date.now() - ms;
  if (delta < 60_000) return 'just now';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return `${Math.floor(delta / 86_400_000)}d ago`;
}

export function ConnectedAppsPanel() {
  const [state, setState] = useState<ConnectedAppsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<ConnectedApp | null>(null);
  const [verificationCodes, setVerificationCodes] = useState<Record<string, string>>({});

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`${api.getBaseUrl()}/v1/apps`, {
        headers: api.authHeader(),
      });
      if (!res.ok) {
        setError(`Failed to load apps: HTTP ${res.status}`);
        return;
      }
      setError(null);
      setState((await res.json()) as ConnectedAppsResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
    // Poll every 4 seconds so pending grants surface promptly even
    // when an app registers while the user is already on this tab.
    const t = window.setInterval(() => void refresh(), 4000);
    return () => window.clearInterval(t);
  }, [refresh]);

  const decide = useCallback(
    async (grantId: string, action: 'approve' | 'deny') => {
      if (busy) return;
      const grant = state?.grants.find((candidate) => candidate.id === grantId);
      const verificationCode = verificationCodes[grantId] ?? '';
      setBusy(`${action}:${grantId}`);
      try {
        const res = await fetch(
          `${api.getBaseUrl()}/v1/apps/grant/${encodeURIComponent(grantId)}/${action}`,
          {
            method: 'POST',
            headers: {
              ...api.authHeader(),
              ...(action === 'approve' && grant?.verificationRequired
                ? { 'Content-Type': 'application/json' }
                : {}),
            },
            ...(action === 'approve' && grant?.verificationRequired
              ? { body: JSON.stringify({ verificationCode }) }
              : {}),
          },
        );
        if (!res.ok) {
          setError(await approvalErrorMessage(res, `Failed to ${action} grant`));
          return;
        }
        setVerificationCodes((current) => {
          const next = { ...current };
          delete next[grantId];
          return next;
        });
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(null);
      }
    },
    [busy, refresh, state?.grants, verificationCodes],
  );

  const revoke = useCallback(async () => {
    if (!revokeTarget) return;
    setBusy(`revoke:${revokeTarget.appId}`);
    try {
      const res = await fetch(
        `${api.getBaseUrl()}/v1/apps/${encodeURIComponent(revokeTarget.appId)}/token`,
        { method: 'DELETE', headers: api.authHeader() },
      );
      if (!res.ok) {
        setError(`Failed to revoke ${revokeTarget.appId}: HTTP ${res.status}`);
        return;
      }
      setRevokeTarget(null);
      await refresh();
    } finally {
      setBusy(null);
    }
  }, [revokeTarget, refresh]);

  const pending = (state?.grants ?? []).filter((g) => g.status === 'pending');
  const connected = state?.apps ?? [];

  return (
    <section className="settings-section">
      <h2>Connected Apps</h2>
      <p className="muted small">
        Apps and command-line clients that have asked for access to your Gezel service. Each client
        is granted only the scopes it requested. Revoke any time.
      </p>

      {error && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}

      {pending.length > 0 && (
        <div className="settings-subsection">
          <h3>Pending requests</h3>
          <ul className="settings-list">
            {pending.map((g) => (
              <li key={g.id} className="connected-app-row connected-app-row--pending">
                <div className="connected-app-meta">
                  <div className="connected-app-name">
                    {g.appName}
                    {g.kind === 'device' && <span className="badge"> device</span>}
                  </div>
                  <div className="muted small">
                    {g.kind === 'device'
                      ? 'wants to run models on this device'
                      : g.scopes.includes('cli')
                        ? `${g.appId} — wants command-line control of this Gezel service`
                        : g.scopes.includes('product')
                          ? `${g.appId} — wants access to Gezel features and data`
                          : `${g.appId} — wants: ${g.scopes.join(', ')}`}
                  </div>
                </div>
                <div className="connected-app-actions">
                  {g.verificationRequired && (
                    <label className="connected-app-code">
                      <span>Connection code</span>
                      <input
                        value={verificationCodes[g.id] ?? ''}
                        onChange={(event) => {
                          const code = formatVerificationCode(event.currentTarget.value);
                          setVerificationCodes((current) => ({ ...current, [g.id]: code }));
                        }}
                        placeholder="___-___"
                        maxLength={7}
                        autoComplete="off"
                        autoCapitalize="characters"
                        spellCheck={false}
                        aria-label={`Connection code for ${g.appName}`}
                      />
                    </label>
                  )}
                  <button
                    type="button"
                    onClick={() => void decide(g.id, 'deny')}
                    disabled={busy !== null}
                  >
                    Deny
                  </button>
                  <button
                    type="button"
                    className="primary"
                    onClick={() => void decide(g.id, 'approve')}
                    disabled={
                      busy !== null ||
                      (g.verificationRequired &&
                        !isVerificationCodeReady(verificationCodes[g.id] ?? ''))
                    }
                  >
                    {busy === `approve:${g.id}` ? 'Approving…' : 'Approve'}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="settings-subsection">
        <h3>Connected</h3>
        {connected.length === 0 ? (
          <p className="muted small">
            No apps connected. Apps that use the gezel SDK appear here after you approve them.
          </p>
        ) : (
          <div className="connected-apps-table-wrap">
            <table className="connected-apps-table" aria-label="Connected apps">
              <thead>
                <tr>
                  <th scope="col">App</th>
                  <th scope="col">Scopes</th>
                  <th scope="col">Last used</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {connected.map((app) => (
                  <tr key={app.appId}>
                    <td data-label="App">
                      <div className="connected-apps-identity">
                        <span className="connected-apps-name">{app.appName}</span>
                        {app.kind === 'device' && (
                          <span className="connected-apps-kind">Device</span>
                        )}
                      </div>
                      <span className="connected-apps-id">{app.appId}</span>
                    </td>
                    <td data-label="Scopes">
                      {app.scopes.length > 0 ? (
                        <ul className="connected-apps-scopes">
                          {app.scopes.map((scope) => (
                            <li key={scope}>{scope}</li>
                          ))}
                        </ul>
                      ) : (
                        <span className="connected-apps-empty">None</span>
                      )}
                    </td>
                    <td data-label="Last used">
                      <span
                        className="connected-apps-last-used"
                        title={
                          app.lastUsedAt ? new Date(app.lastUsedAt).toLocaleString() : undefined
                        }
                      >
                        {formatRelative(app.lastUsedAt)}
                      </span>
                    </td>
                    <td className="connected-apps-action">
                      <button
                        type="button"
                        className="connected-apps-revoke"
                        aria-label={`Revoke ${app.appName}`}
                        onClick={() => setRevokeTarget(app)}
                        disabled={busy !== null}
                      >
                        Revoke
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={revokeTarget !== null}
        title={revokeTarget ? `Revoke ${revokeTarget.appName}?` : 'Revoke app'}
        message={
          revokeTarget ? (
            <>
              The next time <strong>{revokeTarget.appName}</strong> tries to use gezel it will be
              denied. The app can reconnect later by going through the consent flow again.
            </>
          ) : null
        }
        confirmLabel="Revoke"
        danger
        onConfirm={revoke}
        onCancel={() => setRevokeTarget(null)}
      />
    </section>
  );
}
