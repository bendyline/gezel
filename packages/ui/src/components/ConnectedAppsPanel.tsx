import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { Select } from '../primitives/index.js';
import { UI_FALLBACK_PROVIDER } from '../provider-default.js';
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

interface GezelOption {
  id: string;
  name: string;
  role?: string;
  /** Frontmatter provider override; unset → the install default applies. */
  provider?: string;
}

const AUTOMATIC_FALLBACK_GEZEL = '__AUTOMATIC__';

/**
 * Backends that run their own tool loop (agent runtimes, not raw model
 * APIs) can't advertise-and-halt caller-supplied tools — `/v1` returns
 * `tools_not_supported_for_provider` for tool-bearing requests routed
 * to them. The panel warns at pick time so an editor's first tool call
 * isn't the moment the user finds out.
 */
const NO_APP_TOOLS_PROVIDERS = new Set(['copilot', 'anthropic-cli', 'codex-cli']);

export function ConnectedAppsPanel() {
  const [state, setState] = useState<ConnectedAppsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<ConnectedApp | null>(null);
  const [verificationCodes, setVerificationCodes] = useState<Record<string, string>>({});
  const [endpoints, setEndpoints] = useState<{
    enabled?: boolean;
    servingGezelId?: string;
    supportingBehaviors?: boolean;
    emulateOllama?: boolean;
  }>({});
  const [gezels, setGezels] = useState<GezelOption[]>([]);
  const [endpointsStatus, setEndpointsStatus] = useState<string | null>(null);
  const [defaultProvider, setDefaultProvider] = useState<string>('copilot');
  const [meesterGezelId, setMeesterGezelId] = useState<string | undefined>();

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

  useEffect(() => {
    api
      .getConfig()
      .then((cfg) => {
        setEndpoints(cfg.openaiEndpoints ?? {});
        setDefaultProvider(cfg.provider ?? UI_FALLBACK_PROVIDER);
        setMeesterGezelId(cfg.meesterGezelId);
      })
      .catch(() => {});
    api
      .listGezels()
      .then((res) =>
        setGezels(res.gezels.map(({ id, name, role, provider }) => ({ id, name, role, provider }))),
      )
      .catch(() => {});
  }, []);

  // The PUT replaces the whole `openaiEndpoints` object, so every save
  // sends both fields — a toggle flip must not drop the chosen gezel.
  const saveEndpoints = useCallback(
    async (next: {
      enabled?: boolean;
      servingGezelId?: string;
      supportingBehaviors?: boolean;
      emulateOllama?: boolean;
    }) => {
      const previous = endpoints;
      setEndpoints(next);
      setEndpointsStatus('saving…');
      try {
        const res = await api.updateConfig({ openaiEndpoints: next });
        setEndpoints(res.openaiEndpoints ?? {});
        setEndpointsStatus(null);
      } catch (err) {
        setEndpoints(previous);
        // GezelApiError carries the server's body under `details` — for
        // the Ollama-emulation 409 that's the actionable text ("Ollama
        // itself appears to be running there…"), so prefer it over the
        // generic "Gezel API error 409" envelope message.
        const detail =
          err && typeof err === 'object' && 'details' in err
            ? (err as { details?: { message?: string } }).details?.message
            : undefined;
        setEndpointsStatus(
          `save failed: ${detail ?? (err instanceof Error ? err.message : String(err))}`,
        );
      }
    },
    [endpoints],
  );

  const endpointsEnabled = endpoints.enabled !== false;
  const configuredFallbackGezel = gezels.find((g) => g.id === endpoints.servingGezelId);
  const automaticFallbackGezel = gezels.find((g) => g.id === meesterGezelId) ?? gezels[0];
  const fallbackGezel = configuredFallbackGezel ?? automaticFallbackGezel;
  const resolveProvider = (g: GezelOption) => g.provider ?? defaultProvider;
  const fallbackLacksAppTools =
    fallbackGezel !== undefined && NO_APP_TOOLS_PROVIDERS.has(resolveProvider(fallbackGezel));

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

      <div className="settings-subsection">
        <h3>OpenAI-compatible endpoints</h3>
        <p className="muted small">
          Other apps (editors, browser tools) can use your gezellen and models through standard
          OpenAI-style endpoints. Each app still needs your approval below before it gets access.
        </p>
        <label className="debug-toggle">
          <input
            type="checkbox"
            checked={endpointsEnabled}
            onChange={(e) =>
              void saveEndpoints({ ...endpoints, enabled: e.target.checked ? undefined : false })
            }
          />
          <span>Allow apps to connect</span>
        </label>
        {endpointsEnabled ? (
          <p className="muted small">
            Point apps at <code>{api.getBaseUrl()}/v1</code>
          </p>
        ) : (
          <p className="muted small">
            Turned off — connected apps are refused and new apps cannot ask for access until this is
            back on.
          </p>
        )}
        <div className="connected-apps-serving">
          <span id="serving-gezel-label">Fallback gezel</span>
          <Select.Root
            value={configuredFallbackGezel ? configuredFallbackGezel.id : AUTOMATIC_FALLBACK_GEZEL}
            onValueChange={(v) =>
              void saveEndpoints({
                ...endpoints,
                servingGezelId: v === AUTOMATIC_FALLBACK_GEZEL ? undefined : v,
              })
            }
            disabled={!endpointsEnabled}
          >
            <Select.Trigger aria-labelledby="serving-gezel-label">
              <Select.Value />
            </Select.Trigger>
            <Select.Content>
              <Select.Item value={AUTOMATIC_FALLBACK_GEZEL}>
                Automatic
                {automaticFallbackGezel ? ` — ${automaticFallbackGezel.name}` : ''}
              </Select.Item>
              {gezels.map((g) => (
                <Select.Item key={g.id} value={g.id}>
                  {g.name}
                  {g.role ? ` — ${g.role}` : ''}
                  {` (${resolveProvider(g)})`}
                </Select.Item>
              ))}
            </Select.Content>
          </Select.Root>
        </div>
        <p className="muted small">
          Apps receive your gezellen as model choices, including their names and roles. If an app
          asks for something else, {fallbackGezel?.name ?? 'your default gezel'} answers with their
          character and model settings.
        </p>
        {fallbackGezel && fallbackLacksAppTools && (
          <p className="small connected-apps-caution">
            {fallbackGezel.name} runs on {resolveProvider(fallbackGezel)}, which can't accept tools
            sent by apps — editors that use tools will get an error. For full compatibility, pick a
            gezel on a local model or a direct API provider.
          </p>
        )}
        <label className="debug-toggle">
          <input
            type="checkbox"
            checked={endpoints.supportingBehaviors !== false}
            onChange={(e) =>
              void saveEndpoints({
                ...endpoints,
                supportingBehaviors: e.target.checked ? undefined : false,
              })
            }
            disabled={!endpointsEnabled}
          />
          <span>Supporting behaviors</span>
        </label>
        <p className="muted small">
          Gezel knows how to get the best out of each model — catching runaway rambling, folding
          leaked reasoning, and applying model-specific fixes. Turn this off for plain serving: apps
          still get the gezel's character and each model's tuned settings (sampling, thinking mode),
          but no runtime interventions.
        </p>
        <label className="debug-toggle">
          <input
            type="checkbox"
            checked={endpoints.emulateOllama === true}
            onChange={(e) =>
              void saveEndpoints({
                ...endpoints,
                emulateOllama: e.target.checked ? true : undefined,
              })
            }
            disabled={!endpointsEnabled}
          />
          <span>Emulate Ollama (port 11434)</span>
        </label>
        <p className="muted small">
          Apps that auto-discover Ollama will find gezel instead — no setup needed in each app.
          Security note: Ollama's convention is no password, so while this is on, any program on
          this computer can use your models without asking first. Gezel refuses to take the port if
          Ollama itself is already running.
        </p>
        {endpointsStatus && <output className="muted small">{endpointsStatus}</output>}
      </div>

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
