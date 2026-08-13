import type { ProjectDetail } from '@bendyline/gezel';
import { type CSSProperties, useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { ProjectGlyph, type ProjectGlyphId } from '../views/projects/new-project-meta.js';
import { CatalogArtwork } from './CatalogArtwork.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { OAuthAppSetup, type RegisteredOAuthClient } from './OAuthAppSetup.js';
import { connectOAuth } from './connector-link.js';
import { isOAuthNotConfiguredError, parseOAuthAppRequirement } from './oauth-app-setup.js';

type ConnStatus = Awaited<ReturnType<typeof api.listConnectors>>;

interface ConnManifest {
  id: string;
  name: string;
  description: string;
  configSchema?: {
    properties?: Record<
      string,
      {
        type?: string;
        title?: string;
        const?: unknown;
        default?: unknown;
        minimum?: number;
        maximum?: number;
      }
    >;
    required?: string[];
  };
  secretShape?: {
    kind?: string;
    label?: string;
    required?: boolean;
    clientIdEnv?: string;
    clientSecretEnv?: string;
    clientSetup?: unknown;
  };
  completeness?: string;
  tags?: string[];
}

interface ConnectorOption extends ConnManifest {
  iconSvg?: string;
  logoUrl?: string;
}

type ConnectorConfigValue = string | boolean;

function initialConnectorConfig(connector: ConnectorOption): Record<string, ConnectorConfigValue> {
  const initial: Record<string, ConnectorConfigValue> = {};
  for (const [key, property] of Object.entries(connector.configSchema?.properties ?? {})) {
    if (property.default === undefined) continue;
    initial[key] =
      property.type === 'boolean' ? property.default === true : String(property.default);
  }
  return initial;
}

function connectorGlyph(connector: ConnManifest): ProjectGlyphId {
  const identity = `${connector.id} ${(connector.tags ?? []).join(' ')}`.toLowerCase();
  if (identity.includes('wiki')) return 'sheet';
  if (identity.includes('calendar')) return 'calendar';
  if (/(mail|gmail|imap|email)/.test(identity)) return 'envelope';
  if (/(github|git)/.test(identity)) return 'branch';
  if (/(issue|linear)/.test(identity)) return 'bubbles';
  if (/(airtable|record|data)/.test(identity)) return 'chart';
  return 'dots';
}

function connectorCredentialLabel(connector: ConnManifest): string {
  const kind = connector.secretShape?.kind;
  if (kind === 'oauth2') return 'OAuth';
  if (kind === 'imap') return 'Mail login';
  if (!connector.secretShape?.required) return 'Optional token';
  return connector.secretShape?.label ?? 'API token';
}

function connectorCoverageLabel(connector: ConnManifest): string {
  return connector.completeness === 'window' ? 'Recent window' : 'Full mirror';
}

/**
 * Project Connections tab — browse connector types, bind one (config form +
 * credential / OAuth), and manage bound connectors (per-binding status, sync,
 * unbind). Modeled on ProjectMailTab + RemoteServersPanel; data-driven off the
 * connector-type catalog, so new driver types appear automatically.
 */
export function ProjectConnectionsTab({
  project,
  onProjectChange,
}: {
  project: ProjectDetail;
  onProjectChange?: (p: ProjectDetail) => void;
}) {
  const [status, setStatus] = useState<ConnStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirmUnbind, setConfirmUnbind] = useState<string | null>(null);
  const [pending, setPending] = useState<
    Awaited<ReturnType<typeof api.listConnectorActions>>['pending']
  >([]);

  const [adding, setAdding] = useState(false);
  const [loadingTypes, setLoadingTypes] = useState(false);
  const [types, setTypes] = useState<ConnectorOption[]>([]);
  const [selected, setSelected] = useState<ConnectorOption | null>(null);
  const [config, setConfig] = useState<Record<string, ConnectorConfigValue>>({});
  const [displayName, setDisplayName] = useState('');
  const [credential, setCredential] = useState('');
  const [imapHost, setImapHost] = useState('');
  const [imapPort, setImapPort] = useState('');
  const [imapSecure, setImapSecure] = useState(true);
  // Bring-your-own OAuth apps registered on this install, keyed by the
  // manifest's `clientIdEnv` name. The daemon may additionally hold env-var
  // overrides the UI can't see, so an absent key never blocks Connect —
  // it only drives the proactive "use your own app" affordance.
  const [oauthClients, setOauthClients] = useState<Record<string, RegisteredOAuthClient>>({});
  // Counts failed "OAuth is not configured" connects; each bump pops the
  // setup panel open as the error-driven fallback.
  const [oauthSetupNudge, setOauthSetupNudge] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const [s, a] = await Promise.all([
        api.listConnectors(project.id),
        api.listConnectorActions(project.id),
      ]);
      setStatus(s);
      setPending(a.pending);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [project.id]);

  const handleCommit = useCallback(
    async (draftId: string) => {
      setBusy(draftId);
      setError('');
      setNotice('');
      try {
        const r = await api.commitConnectorAction(project.id, draftId);
        setNotice(
          r.status === 'queued-night-shift'
            ? 'Held for daytime approval (night shift).'
            : 'Action committed.',
        );
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(null);
      }
    },
    [project.id, refresh],
  );

  const handleDiscardAction = useCallback(
    async (draftId: string) => {
      setBusy(draftId);
      try {
        await api.discardConnectorAction(project.id, draftId);
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(null);
      }
    },
    [project.id, refresh],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const closeAdd = useCallback(() => {
    setAdding(false);
    setSelected(null);
    setConfig({});
    setDisplayName('');
    setCredential('');
    setImapHost('');
    setImapPort('');
    setImapSecure(true);
    setOauthSetupNudge(0);
  }, []);

  const refreshOAuthClients = useCallback(async () => {
    const res = await api.listOAuthClients();
    setOauthClients(
      Object.fromEntries(
        (res.clients ?? []).map((c) => [c.key, { clientId: c.clientId, hasSecret: c.hasSecret }]),
      ),
    );
  }, []);

  const openAdd = useCallback(async () => {
    setAdding(true);
    setLoadingTypes(true);
    setTypes([]);
    setSelected(null);
    setError('');
    setNotice('');
    // Best-effort: an older daemon without the route just means no proactive
    // affordance — the error-driven fallback still works.
    void refreshOAuthClients().catch(() => {});
    try {
      const res = await api.listConnectorTypes();
      setTypes(
        res.items.map((item) => ({
          ...(item.manifest as unknown as ConnManifest),
          ...(item.iconSvg ? { iconSvg: item.iconSvg } : {}),
          ...(item.logoUrl ? { logoUrl: item.logoUrl } : {}),
        })),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingTypes(false);
    }
  }, [refreshOAuthClients]);

  const handleSync = useCallback(
    async (bindingId: string) => {
      setBusy(bindingId);
      setError('');
      setNotice('');
      try {
        const res = await api.syncConnector(project.id, bindingId);
        const r = res.result as { written?: number; quarantined?: number; error?: string };
        setNotice(
          r.error
            ? `Sync error: ${r.error}`
            : `Synced ${(r.written ?? 0) + (r.quarantined ?? 0)} new record(s).`,
        );
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(null);
      }
    },
    [project.id, refresh],
  );

  const handleUnbind = useCallback(
    async (bindingId: string) => {
      setBusy(bindingId);
      try {
        await api.unbindConnector(project.id, bindingId);
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(null);
        setConfirmUnbind(null);
      }
    },
    [project.id, refresh],
  );

  const buildConfig = useCallback((): Record<string, unknown> => {
    const props = selected?.configSchema?.properties ?? {};
    const out: Record<string, unknown> = {};
    for (const [key, prop] of Object.entries(props)) {
      if (prop.const !== undefined) {
        out[key] = prop.const;
      } else if (prop.type === 'array') {
        const raw = typeof config[key] === 'string' ? config[key].trim() : '';
        if (raw)
          out[key] = raw
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
      } else if (prop.type === 'boolean') {
        if (typeof config[key] === 'boolean') out[key] = config[key];
      } else if (prop.type === 'integer' || prop.type === 'number') {
        const raw = typeof config[key] === 'string' ? config[key].trim() : '';
        if (raw) out[key] = Number(raw);
      } else {
        const raw = typeof config[key] === 'string' ? config[key].trim() : '';
        if (raw) out[key] = raw;
      }
    }
    return out;
  }, [selected, config]);

  const oauthRequirement = useMemo(
    () =>
      selected?.secretShape?.kind === 'oauth2'
        ? parseOAuthAppRequirement(selected.name, selected.secretShape)
        : null,
    [selected],
  );

  const handleBind = useCallback(async () => {
    if (!selected) return;
    setError('');
    setNotice('');
    const built = buildConfig();
    const kind = selected.secretShape?.kind;
    const missingConfig = (selected.configSchema?.required ?? []).find((key) => {
      const value = built[key];
      return value === undefined || value === '' || (Array.isArray(value) && value.length === 0);
    });
    if (missingConfig) {
      const label = selected.configSchema?.properties?.[missingConfig]?.title ?? missingConfig;
      setError(`${label} is required.`);
      return;
    }
    if (
      kind !== 'oauth2' &&
      kind !== 'imap' &&
      selected.secretShape?.required &&
      !credential.trim()
    ) {
      setError(`${selected.secretShape.label ?? 'API key / token'} is required.`);
      return;
    }
    setBusy('add');
    try {
      if (kind === 'oauth2') {
        await connectOAuth(
          project.id,
          selected.id,
          built,
          displayName.trim() || undefined,
          oauthRequirement?.redirectPort !== undefined
            ? { redirectPort: oauthRequirement.redirectPort }
            : undefined,
        );
      } else {
        let cred: unknown;
        if (kind === 'imap') {
          cred = {
            host: imapHost.trim(),
            ...(imapPort.trim() ? { port: Number(imapPort.trim()) } : {}),
            secure: imapSecure,
            user: String(built.address ?? ''),
            pass: credential,
          };
        } else if (credential.trim()) {
          cred = credential.trim();
        }
        await api.bindConnector(project.id, {
          type: selected.id,
          ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
          config: built,
          ...(cred !== undefined ? { credential: cred } : {}),
        });
      }
      setNotice('Connector added.');
      closeAdd();
      await refresh();
      try {
        const fresh = await api.getProject(project.id);
        if (fresh) onProjectChange?.(fresh);
      } catch {
        /* best-effort project refetch */
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // The service ships no OAuth client of its own; this rejection means
      // the install hasn't registered an app yet — open the setup panel
      // inline rather than leaving the user with a bare error line.
      if (isOAuthNotConfiguredError(message)) setOauthSetupNudge((n) => n + 1);
      setError(message);
    } finally {
      setBusy(null);
    }
  }, [
    selected,
    project.id,
    buildConfig,
    displayName,
    credential,
    imapHost,
    imapPort,
    imapSecure,
    closeAdd,
    refresh,
    onProjectChange,
    oauthRequirement,
  ]);

  /**
   * Save the user's OAuth app (client ID → config, secret → SecretStore),
   * then proceed straight into the connect flow. Throws on save failure so
   * the panel keeps its form open.
   */
  const handleOAuthAppSave = useCallback(
    async (body: { clientId: string; clientSecret?: string }) => {
      if (!oauthRequirement) return;
      setError('');
      setBusy('oauth-app');
      try {
        await api.putOAuthClient(oauthRequirement.clientKey, body);
        await refreshOAuthClients().catch(() => {
          setOauthClients((current) => ({
            ...current,
            [oauthRequirement.clientKey]: {
              clientId: body.clientId,
              hasSecret:
                Boolean(body.clientSecret) ||
                (current[oauthRequirement.clientKey]?.hasSecret ?? false),
            },
          }));
        });
        setOauthSetupNudge(0);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        throw err;
      } finally {
        setBusy(null);
      }
      await handleBind();
    },
    [oauthRequirement, refreshOAuthClients, handleBind],
  );

  const bindings = status?.bindings ?? [];
  const kind = selected?.secretShape?.kind;
  const selectConnector = (connector: ConnectorOption) => {
    if (connector.id === selected?.id) return;
    setSelected(connector);
    setConfig(initialConnectorConfig(connector));
    setDisplayName('');
    setCredential('');
    setImapHost('');
    setImapPort('');
    setImapSecure(true);
    setError('');
    setOauthSetupNudge(0);
  };

  return (
    <div className="settings-section">
      <div className="gz-mail-header">
        <h3>Connections</h3>
        {!adding && (
          <button type="button" onClick={() => void openAdd()}>
            Add connection
          </button>
        )}
      </div>

      {bindings.length === 0 && !adding ? (
        <p className="muted">
          No connectors yet. Add one to mirror an external source (email, issues, a data source)
          into this project as searchable files.
        </p>
      ) : (
        <ul className="settings-list">
          {bindings.map((b) => (
            <li key={b.id}>
              <div>
                <strong>{b.displayName || b.type}</strong>
                <span className="muted small"> · {b.type}</span>
                <div className="small">
                  {b.lastError ? (
                    <span className="error">Error: {b.lastError}</span>
                  ) : b.lastSyncedAt ? (
                    <span className="muted">
                      Last synced {new Date(b.lastSyncedAt).toLocaleString()}
                    </span>
                  ) : (
                    <span className="muted">Not synced yet</span>
                  )}
                </div>
              </div>
              <div className="gz-mail-link-actions">
                <button
                  type="button"
                  onClick={() => void handleSync(b.id)}
                  disabled={busy === b.id}
                >
                  {busy === b.id ? 'Working…' : 'Sync now'}
                </button>
                <button
                  type="button"
                  className="danger"
                  onClick={() => setConfirmUnbind(b.id)}
                  disabled={busy === b.id}
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {pending.length > 0 && (
        <div className="settings-subsection">
          <h4>Pending actions</h4>
          <p className="muted small">
            Drafted by a gezel — review, then commit (the live write). You commit; the gezel can't.
          </p>
          <ul className="settings-list">
            {pending.map((a) => (
              <li key={a.draftId}>
                <div>
                  <strong>{a.action}</strong>
                  <span className="muted small"> · {a.connectorType}</span>
                  {a.status === 'queued' && <span className="badge"> held for daytime</span>}
                </div>
                <div className="gz-mail-link-actions">
                  <button
                    type="button"
                    className="primary"
                    onClick={() => void handleCommit(a.draftId)}
                    disabled={busy === a.draftId}
                  >
                    {busy === a.draftId ? 'Working…' : 'Commit'}
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleDiscardAction(a.draftId)}
                    disabled={busy === a.draftId}
                  >
                    Discard
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {adding && (
        <div className="gz-connector-picker">
          <div className="gz-connector-picker-heading">
            <div>
              <strong>Choose a connector</strong>
              <p className="muted small">
                Pick a source to mirror into this project's searchable files.
              </p>
            </div>
            <span className="gz-connector-picker-count">
              {loadingTypes ? 'Loading…' : `${types.length} available`}
            </span>
          </div>

          {loadingTypes ? (
            <div className="gz-connector-picker-empty muted small">Gathering connectors…</div>
          ) : types.length === 0 ? (
            <div className="gz-connector-picker-empty muted small">
              No connector types are available.
            </div>
          ) : (
            <div className="gz-connector-grid" role="radiogroup" aria-label="Connector type">
              {types.map((connector, index) => (
                <button
                  key={connector.id}
                  type="button"
                  // biome-ignore lint/a11y/useSemanticElements: cards form one visual radio group; native inputs would duplicate the interactive surface.
                  role="radio"
                  aria-checked={selected?.id === connector.id}
                  aria-label={connector.name}
                  className={`gz-npd-card gz-connector-card${
                    selected?.id === connector.id ? ' active' : ''
                  }`}
                  onClick={() => selectConnector(connector)}
                  style={{ '--card-i': Math.min(index, 11) } as CSSProperties}
                >
                  <span className="gz-npd-card-mark">
                    <CatalogArtwork
                      iconSvg={connector.iconSvg}
                      logoUrl={connector.logoUrl}
                      svgClassName="gz-npd-card-mark-svg"
                      fallback={<ProjectGlyph glyph={connectorGlyph(connector)} size={19} />}
                    />
                  </span>
                  <span className="gz-npd-card-name">{connector.name}</span>
                  <span className="gz-npd-card-description">{connector.description}</span>
                  <span className="gz-connector-card-meta" aria-hidden="true">
                    <span>{connectorCredentialLabel(connector)}</span>
                    <span>{connectorCoverageLabel(connector)}</span>
                  </span>
                </button>
              ))}
            </div>
          )}

          {selected && (
            <div
              className="gz-mail-link-form gz-connector-config"
              aria-label={`${selected.name} setup`}
            >
              <div className="gz-connector-config-heading">
                <span className="gz-connector-config-mark">
                  <CatalogArtwork
                    iconSvg={selected.iconSvg}
                    logoUrl={selected.logoUrl}
                    svgClassName="gz-npd-card-mark-svg"
                    fallback={<ProjectGlyph glyph={connectorGlyph(selected)} size={19} />}
                  />
                </span>
                <div>
                  <strong>Set up {selected.name}</strong>
                  <div className="small muted">
                    {connectorCredentialLabel(selected)} · {connectorCoverageLabel(selected)}
                  </div>
                </div>
              </div>

              <div className="gz-connector-config-fields">
                <label>
                  Display name <span className="muted">(optional)</span>
                  <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
                </label>
                {Object.entries(selected.configSchema?.properties ?? {})
                  .filter(([, prop]) => prop.const === undefined)
                  .map(([key, prop]) =>
                    prop.type === 'boolean' ? (
                      <label key={key} className="gz-connector-boolean-field">
                        <input
                          type="checkbox"
                          checked={config[key] === true}
                          onChange={(e) =>
                            setConfig((current) => ({ ...current, [key]: e.target.checked }))
                          }
                        />
                        {prop.title ?? key}
                      </label>
                    ) : (
                      <label key={key}>
                        {prop.title ?? key}
                        <input
                          type={
                            prop.type === 'integer' || prop.type === 'number' ? 'number' : 'text'
                          }
                          value={typeof config[key] === 'string' ? config[key] : ''}
                          onChange={(e) =>
                            setConfig((current) => ({ ...current, [key]: e.target.value }))
                          }
                          placeholder={prop.type === 'array' ? 'comma,separated' : ''}
                          min={prop.minimum}
                          max={prop.maximum}
                          step={prop.type === 'integer' ? 1 : undefined}
                        />
                      </label>
                    ),
                  )}

                {kind === 'oauth2' ? (
                  <p className="muted small gz-connector-oauth-note">
                    You'll authorize this connector in your browser — a window opens when you click
                    Connect.
                  </p>
                ) : kind === 'imap' ? (
                  <>
                    <label>
                      IMAP host
                      <input
                        value={imapHost}
                        onChange={(e) => setImapHost(e.target.value)}
                        placeholder="imap.example.com"
                      />
                    </label>
                    <div className="gz-imap-row">
                      <label className="gz-imap-port">
                        Port <span className="muted">(optional)</span>
                        <input
                          value={imapPort}
                          onChange={(e) => setImapPort(e.target.value)}
                          placeholder="993"
                        />
                      </label>
                      <label className="gz-imap-tls">
                        <input
                          type="checkbox"
                          checked={imapSecure}
                          onChange={(e) => setImapSecure(e.target.checked)}
                        />
                        Use TLS
                      </label>
                    </div>
                    <label>
                      Password / app password
                      <input
                        type="password"
                        value={credential}
                        onChange={(e) => setCredential(e.target.value)}
                        autoComplete="off"
                      />
                    </label>
                  </>
                ) : (
                  <label>
                    {selected.secretShape?.label ?? 'API key / token'}{' '}
                    {!selected.secretShape?.required && <span className="muted">(optional)</span>}
                    <input
                      type="password"
                      value={credential}
                      onChange={(e) => setCredential(e.target.value)}
                      autoComplete="off"
                    />
                  </label>
                )}
              </div>

              {oauthRequirement && (
                <OAuthAppSetup
                  key={selected.id}
                  requirement={oauthRequirement}
                  registered={oauthClients[oauthRequirement.clientKey] ?? null}
                  forceOpenNonce={oauthSetupNudge}
                  busy={busy === 'oauth-app' || busy === 'add'}
                  onSave={handleOAuthAppSave}
                />
              )}
            </div>
          )}

          <div className="gz-mail-link-actions gz-connector-picker-actions">
            <button type="button" onClick={closeAdd} disabled={busy === 'add'}>
              Cancel
            </button>
            {selected && (
              <button
                type="button"
                className="primary"
                onClick={() => void handleBind()}
                disabled={busy === 'add'}
              >
                {busy === 'add' ? 'Working…' : kind === 'oauth2' ? 'Connect' : 'Add'}
              </button>
            )}
          </div>
        </div>
      )}

      {error && <p className="error small">{error}</p>}
      {notice && <p className="muted small">{notice}</p>}

      <ConfirmDialog
        open={confirmUnbind !== null}
        title="Remove connector?"
        message="This removes the binding and its stored credential. Synced files stay on disk."
        confirmLabel="Remove"
        danger
        onConfirm={() => {
          if (confirmUnbind) void handleUnbind(confirmUnbind);
        }}
        onCancel={() => setConfirmUnbind(null)}
      />
    </div>
  );
}
