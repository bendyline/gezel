import { CONNECTOR_FAMILIES, type ConnectorFamily, connectorTypeFamily } from '@bendyline/gezel';
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { Dialog } from '../primitives/index.js';
import { ProjectGlyph, type ProjectGlyphId } from '../views/projects/new-project-meta.js';
import {
  ConnectorConfigFields,
  type ConnectorConfigValue,
  type ConnectorFormManifest,
  initialConnectorConfig,
} from './ConnectorConfigFields.js';
import { ConnectorMark } from './ConnectorMark.js';
import { GallerySearch } from './GallerySearch.js';
import { OAuthAppSetup, type RegisteredOAuthClient } from './OAuthAppSetup.js';
import {
  type CameraForm,
  CameraSetupPanel,
  DEFAULT_CAMERA_FORM,
  cameraConfigFromForm,
} from './cameras/CameraSetupPanel.js';
import { OAuthCancelledError, connectOAuth } from './connector-link.js';
import { isOAuthNotConfiguredError, parseOAuthAppRequirement } from './oauth-app-setup.js';

interface ConnManifest extends ConnectorFormManifest {
  id: string;
  name: string;
  description: string;
  secretShape?: {
    kind?: string;
    label?: string;
    description?: string;
    helpUrl?: string;
    helpLabel?: string;
    required?: boolean;
    clientIdEnv?: string;
    clientSecretEnv?: string;
    clientSetup?: unknown;
    'x-gezel-priority'?: 'primary' | 'secondary';
  };
  completeness?: string;
  tags?: string[];
  /** `device` for connectors that drive local hardware (cameras). */
  driver?: string;
}

interface ConnectorOption extends ConnManifest {
  iconSvg?: string;
  logoUrl?: string;
}

/** What the tab does once a connection exists: refresh, and a first sync. */
export interface AddedConnection {
  bindingId?: string;
  type: string;
  /** A camera starts watching on its own; there is nothing to sync. */
  device: boolean;
}

const FAMILY_META: Record<
  ConnectorFamily,
  { label: string; tagline: string; glyph: ProjectGlyphId }
> = {
  mail: { label: 'Mail', tagline: 'Mailboxes, kept searchable', glyph: 'envelope' },
  calendars: { label: 'Calendars', tagline: 'Events and meetings', glyph: 'calendar' },
  files: { label: 'Files', tagline: 'Folders on a cloud drive', glyph: 'folder' },
  web: { label: 'Web', tagline: 'Sites and feeds you follow', glyph: 'globe' },
  social: { label: 'Social', tagline: 'Your posts and videos', glyph: 'bubbles' },
  code: { label: 'Code', tagline: 'Issues, pull requests and releases', glyph: 'branch' },
  data: { label: 'Data', tagline: 'Tables, records and logs', glyph: 'chart' },
  devices: { label: 'Devices', tagline: 'Hardware on this computer', glyph: 'camera' },
  other: { label: 'Other', tagline: 'Everything else', glyph: 'dots' },
};

type Rail = 'all' | ConnectorFamily;

function connectorCredentialLabel(connector: ConnManifest): string {
  if (connector.driver === 'device') return 'On this computer';
  const kind = connector.secretShape?.kind;
  if (kind === 'oauth2') return 'OAuth';
  if (kind === 'imap') return 'Mail login';
  if (!connector.secretShape) return 'No sign-in';
  if (!connector.secretShape.required) return 'Optional token';
  return connector.secretShape?.label ?? 'API token';
}

function connectorCoverageLabel(connector: ConnManifest): string {
  if (connector.driver === 'device') return 'Live';
  return connector.completeness === 'window' ? 'Recent window' : 'Full mirror';
}

function familyOf(connector: ConnManifest): ConnectorFamily {
  return connectorTypeFamily({ id: connector.id, tags: connector.tags ?? [] });
}

function matchesQuery(connector: ConnManifest, query: string): boolean {
  const haystack = [
    connector.name,
    connector.description,
    connector.id,
    ...(connector.tags ?? []),
    FAMILY_META[familyOf(connector)].label,
  ]
    .join(' ')
    .toLowerCase();
  return haystack.includes(query);
}

/**
 * Add connection, as a gallery dialog (docs/ux.md "A gallery dialog is a
 * two-step wizard"). Step 1 is the connector catalog: a rail of families and
 * the cards. Choosing a card opens step 2, that connector's setup, with one
 * back key to the gallery and the card still lit. Nothing is bound until the
 * second screen's Add or Connect.
 *
 * Mount it only while it is open: every visit starts from a fresh catalog
 * listing and an empty form.
 */
export function AddConnectionDialog({
  projectId,
  onClose,
  onAdded,
}: {
  projectId: string;
  onClose: () => void;
  /** Called once the connection exists. The tab closes this dialog in it. */
  onAdded: (added: AddedConnection) => void;
}) {
  const [step, setStep] = useState<'pick' | 'configure'>('pick');
  const [loadingTypes, setLoadingTypes] = useState(true);
  const [types, setTypes] = useState<ConnectorOption[]>([]);
  const [query, setQuery] = useState('');
  const [activeRail, setActiveRail] = useState<Rail>('all');
  const [selected, setSelected] = useState<ConnectorOption | null>(null);
  // `signin` is the wait on the browser, the one step the person can cancel.
  const [busy, setBusy] = useState<'add' | 'signin' | 'oauth-app' | null>(null);
  const signInRef = useRef<AbortController | null>(null);
  const [error, setError] = useState('');
  // A type that runs a published component downloads it when connected; the
  // form says so, or says why this build or security level cannot.
  const [readiness, setReadiness] = useState<Awaited<
    ReturnType<typeof api.connectorReadiness>
  > | null>(null);
  const [config, setConfig] = useState<Record<string, ConnectorConfigValue>>({});
  const [displayName, setDisplayName] = useState('');
  const [credential, setCredential] = useState('');
  const [imapHost, setImapHost] = useState('');
  const [imapPort, setImapPort] = useState('');
  const [imapSecure, setImapSecure] = useState(true);
  const [cameraForm, setCameraForm] = useState<CameraForm>(DEFAULT_CAMERA_FORM);
  // OAuth apps this install connects through, keyed by the manifest's
  // `clientIdEnv` name: saved ones and ones the daemon's environment sets. An
  // older daemon lists saved ones only, so an absent key never blocks Connect;
  // it only drives the proactive "use your own app" affordance.
  const [oauthClients, setOauthClients] = useState<Record<string, RegisteredOAuthClient>>({});
  // Counts failed "OAuth is not configured" connects; each bump pops the
  // setup panel open as the error-driven fallback.
  const [oauthSetupNudge, setOauthSetupNudge] = useState(0);
  const galleryRef = useRef<HTMLDivElement>(null);
  const setupRef = useRef<HTMLElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);

  const refreshOAuthClients = useCallback(async () => {
    const res = await api.listOAuthClients();
    setOauthClients(
      Object.fromEntries(
        (res.clients ?? []).map((c) => [
          c.key,
          {
            clientId: c.clientId,
            hasSecret: c.hasSecret,
            ...(c.source ? { source: c.source } : {}),
          },
        ]),
      ),
    );
  }, []);

  // Leaving mid sign-in frees the shell's listener rather than its timeout.
  useEffect(() => () => signInRef.current?.abort(), []);

  const cancelSignIn = useCallback(() => {
    signInRef.current?.abort();
    signInRef.current = null;
    setBusy(null);
    setError('');
  }, []);

  useEffect(() => {
    let live = true;
    // Best-effort: an older daemon without the route just means no proactive
    // affordance — the error-driven fallback still works.
    void refreshOAuthClients().catch(() => {});
    api
      .listConnectorTypes()
      .then((res) => {
        if (!live) return;
        setTypes(
          res.items.map((item) => ({
            ...(item.manifest as unknown as ConnManifest),
            ...(item.iconSvg ? { iconSvg: item.iconSvg } : {}),
            ...(item.logoUrl ? { logoUrl: item.logoUrl } : {}),
          })),
        );
      })
      .catch((err: unknown) => {
        if (live) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (live) setLoadingTypes(false);
      });
    return () => {
      live = false;
    };
  }, [refreshOAuthClients]);

  useEffect(() => {
    setReadiness(null);
    if (!selected) return;
    let live = true;
    // Best effort: an older daemon has no readiness route, and Connect still
    // reports a refusal itself.
    Promise.resolve()
      .then(() => api.connectorReadiness(projectId, selected.id))
      .then((r) => {
        if (live) setReadiness(r);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [projectId, selected]);
  const cannotDownload =
    readiness?.needed === true && !readiness.installed && !readiness.downloadable;

  // Each step lands focus where the next move is: the first field of the
  // setup, or back on the card that was chosen.
  useEffect(() => {
    if (step === 'configure') {
      const field = setupRef.current?.querySelector<HTMLElement>(
        'input:not([type="hidden"]):not([type="checkbox"]), button',
      );
      (field ?? backRef.current)?.focus();
    } else {
      galleryRef.current
        ?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]')
        ?.focus();
    }
  }, [step]);

  const families = useMemo(() => {
    const counts = new Map<ConnectorFamily, number>();
    for (const connector of types) {
      const family = familyOf(connector);
      counts.set(family, (counts.get(family) ?? 0) + 1);
    }
    return CONNECTOR_FAMILIES.filter((family) => counts.has(family)).map((family) => ({
      family,
      count: counts.get(family) ?? 0,
    }));
  }, [types]);

  const normalizedQuery = query.trim().toLowerCase();
  const searching = normalizedQuery.length > 0;
  const sections = useMemo(() => {
    if (searching) {
      return [
        {
          id: 'search',
          title: 'Connectors',
          tagline: `matching "${query.trim()}"`,
          connectors: types.filter((c) => matchesQuery(c, normalizedQuery)),
        },
      ];
    }
    const shelves = activeRail === 'all' ? families.map((f) => f.family) : [activeRail];
    return shelves.map((family) => ({
      id: family,
      title: FAMILY_META[family].label,
      tagline: FAMILY_META[family].tagline,
      connectors: types.filter((c) => familyOf(c) === family),
    }));
  }, [searching, query, normalizedQuery, types, activeRail, families]);

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
    // A camera has its own panel and starts watching on its own: there is
    // nothing to sync.
    if (selected.driver === 'device') {
      if (!cameraForm.device) {
        setError('Pick a camera first.');
        return;
      }
      setBusy('add');
      try {
        await api.bindConnector(projectId, {
          type: selected.id,
          ...(cameraForm.displayName.trim()
            ? { displayName: cameraForm.displayName.trim() }
            : cameraForm.deviceName
              ? { displayName: cameraForm.deviceName }
              : {}),
          config: cameraConfigFromForm(cameraForm),
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setBusy(null);
        return;
      }
      setBusy(null);
      onAdded({ type: selected.id, device: true });
      return;
    }
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
    let added: { id: string } | undefined;
    try {
      if (kind === 'oauth2') {
        const signIn = new AbortController();
        signInRef.current = signIn;
        setBusy('signin');
        try {
          added = await connectOAuth(
            projectId,
            selected.id,
            built,
            displayName.trim() || undefined,
            {
              ...(oauthRequirement?.redirectPort !== undefined
                ? { redirectPort: oauthRequirement.redirectPort }
                : {}),
              signal: signIn.signal,
            },
          );
        } finally {
          if (signInRef.current === signIn) signInRef.current = null;
        }
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
        const bound = await api.bindConnector(projectId, {
          type: selected.id,
          ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
          config: built,
          ...(cred !== undefined ? { credential: cred } : {}),
        });
        added = bound?.binding;
      }
    } catch (err) {
      // Cancel already put the form back.
      if (err instanceof OAuthCancelledError) return;
      const message = err instanceof Error ? err.message : String(err);
      // The service ships no OAuth client of its own; this rejection means
      // the install hasn't registered an app yet — open the setup panel
      // rather than leaving the user with a bare error line.
      if (isOAuthNotConfiguredError(message)) setOauthSetupNudge((n) => n + 1);
      setError(message);
      setBusy(null);
      return;
    }
    setBusy(null);
    onAdded({ ...(added?.id ? { bindingId: added.id } : {}), type: selected.id, device: false });
  }, [
    selected,
    projectId,
    buildConfig,
    displayName,
    credential,
    imapHost,
    imapPort,
    imapSecure,
    oauthRequirement,
    cameraForm,
    onAdded,
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

  /** Choosing a card opens its setup. The same card again keeps what was typed. */
  const chooseConnector = (connector: ConnectorOption) => {
    if (connector.id !== selected?.id) {
      setSelected(connector);
      setConfig(initialConnectorConfig(connector));
      setDisplayName('');
      setCredential('');
      setImapHost('');
      setImapPort('');
      setImapSecure(true);
      setCameraForm(DEFAULT_CAMERA_FORM);
      setOauthSetupNudge(0);
    }
    setError('');
    setStep('configure');
  };

  const backToGallery = () => {
    setStep('pick');
    setError('');
  };

  const kind = selected?.secretShape?.kind;
  const submitLabel = kind === 'oauth2' ? 'Connect' : 'Add';
  const working = busy !== null;
  const signingIn = busy === 'signin';
  const providerLabel = oauthRequirement?.providerLabel ?? selected?.name ?? 'the service';
  const readinessNote =
    readiness?.needed && !readiness.installed
      ? readiness.downloadable
        ? `Connecting downloads ${readiness.package.name} ${readiness.package.version}, a component this connection runs in a sandbox.`
        : (readiness.reason ?? 'This build cannot download the component this connection needs.')
      : null;

  return (
    <Dialog.Root
      open
      onOpenChange={(next) => {
        if (next) return;
        if (signingIn) cancelSignIn();
        else if (!working) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay />
        <Dialog.Content className={`gz-npd gz-acd gz-npd-step-${step}`}>
          {step === 'pick' || !selected ? (
            <>
              <header className="gz-npd-header">
                <div className="gz-npd-header-copy">
                  <Dialog.Title asChild>
                    <h3>Add a connection</h3>
                  </Dialog.Title>
                  <Dialog.Description asChild>
                    <p className="gz-npd-header-sub">
                      Pick a source to mirror into this project's searchable files.
                    </p>
                  </Dialog.Description>
                </div>
                <GallerySearch
                  label="Search connectors"
                  placeholder="Search connectors…"
                  value={query}
                  onChange={setQuery}
                />
              </header>
              <div className="gz-npd-body">
                <nav className="gz-npd-rail" aria-label="Connector families">
                  <button
                    type="button"
                    className={`gz-npd-rail-item${!searching && activeRail === 'all' ? ' active' : ''}`}
                    onClick={() => setActiveRail('all')}
                  >
                    <ProjectGlyph glyph="sheet" size={16} />
                    <span className="gz-npd-rail-label">All connectors</span>
                    <span className="gz-npd-rail-count">{loadingTypes ? null : types.length}</span>
                  </button>
                  {families.map(({ family, count }) => (
                    <button
                      key={family}
                      type="button"
                      className={`gz-npd-rail-item${!searching && activeRail === family ? ' active' : ''}`}
                      onClick={() => setActiveRail(family)}
                    >
                      <ProjectGlyph glyph={FAMILY_META[family].glyph} size={16} />
                      <span className="gz-npd-rail-label">{FAMILY_META[family].label}</span>
                      <span className="gz-npd-rail-count">{count}</span>
                    </button>
                  ))}
                </nav>
                <div
                  ref={galleryRef}
                  className="gz-npd-gallery"
                  role="radiogroup"
                  aria-label="Connector type"
                >
                  {loadingTypes ? (
                    <p className="gz-npd-empty">Gathering connectors…</p>
                  ) : types.length === 0 ? (
                    <p className="gz-npd-empty">
                      {error
                        ? 'The connector list could not be loaded.'
                        : 'No connector types are available.'}
                    </p>
                  ) : (
                    sections.map((section) => (
                      <section key={section.id} className="gz-npd-section">
                        <div className="gz-npd-section-head">
                          <span className="gz-npd-section-title">{section.title}</span>
                          <span className="gz-npd-section-tagline">{section.tagline}</span>
                        </div>
                        {section.connectors.length > 0 ? (
                          <div className="gz-npd-grid">
                            {section.connectors.map((connector, index) => (
                              <ConnectorCard
                                key={connector.id}
                                connector={connector}
                                index={index}
                                active={selected?.id === connector.id}
                                onSelect={() => chooseConnector(connector)}
                              />
                            ))}
                          </div>
                        ) : (
                          <p className="gz-npd-empty">No connectors match your search.</p>
                        )}
                      </section>
                    ))
                  )}
                </div>
              </div>
              <div className="gz-npd-pane-footer gz-npd-pick-footer">
                {error ? (
                  <p className="error small gz-npd-submit-error" role="alert">
                    {error}
                  </p>
                ) : (
                  <p className="gz-npd-footnote">
                    Pick one to set it up — nothing connects until the next screen.
                  </p>
                )}
                <Dialog.Actions>
                  <button type="button" onClick={onClose}>
                    Cancel
                  </button>
                </Dialog.Actions>
              </div>
            </>
          ) : (
            <>
              <header className="gz-npd-header gz-npd-detail-header">
                <button
                  ref={backRef}
                  type="button"
                  className="gz-npd-back"
                  onClick={backToGallery}
                  disabled={working}
                >
                  <span aria-hidden="true">‹</span>
                  Connectors
                </button>
                <div className="gz-npd-detail-id">
                  <ConnectorMark
                    className="gz-npd-detail-art gz-acd-detail-art"
                    connectorType={selected.id}
                    tags={selected.tags ?? []}
                    iconSvg={selected.iconSvg}
                    logoUrl={selected.logoUrl}
                    size={22}
                    svgClassName="gz-npd-card-mark-svg"
                  />
                  <div className="gz-npd-header-copy">
                    <p className="gz-npd-hero-eyebrow">{FAMILY_META[familyOf(selected)].label}</p>
                    <Dialog.Title asChild>
                      <h3 className="gz-npd-hero-name">{selected.name}</h3>
                    </Dialog.Title>
                  </div>
                </div>
              </header>
              <div className="gz-npd-detail gz-acd-detail" data-lean="true" key={selected.id}>
                <div className="gz-npd-brief">
                  <Dialog.Description asChild>
                    <p className="gz-npd-brief-lede">{selected.description}</p>
                  </Dialog.Description>
                  <span className="gz-connector-card-meta gz-acd-facts">
                    <span>{connectorCredentialLabel(selected)}</span>
                    <span>{connectorCoverageLabel(selected)}</span>
                  </span>
                </div>
                <section
                  ref={setupRef}
                  className="gz-npd-setup gz-acd-setup"
                  aria-label={`${selected.name} setup`}
                >
                  {selected.driver === 'device' ? (
                    <>
                      {selected.setupInstructions ? (
                        <aside className="gz-connector-setup-instructions">
                          <strong>{selected.setupInstructions.title}</strong>
                          {selected.setupInstructions.description ? (
                            <p>{selected.setupInstructions.description}</p>
                          ) : null}
                        </aside>
                      ) : null}
                      <CameraSetupPanel form={cameraForm} onChange={setCameraForm} />
                    </>
                  ) : (
                    <ConnectorConfigFields
                      connector={selected}
                      config={config}
                      onConfigChange={(key, value) =>
                        setConfig((current) => ({ ...current, [key]: value }))
                      }
                      displayName={displayName}
                      onDisplayNameChange={setDisplayName}
                      credential={credential}
                      onCredentialChange={setCredential}
                      imapHost={imapHost}
                      onImapHostChange={setImapHost}
                      imapPort={imapPort}
                      onImapPortChange={setImapPort}
                      imapSecure={imapSecure}
                      onImapSecureChange={setImapSecure}
                    />
                  )}
                  {oauthRequirement && (
                    <OAuthAppSetup
                      key={selected.id}
                      requirement={oauthRequirement}
                      registered={oauthClients[oauthRequirement.clientKey] ?? null}
                      forceOpenNonce={oauthSetupNudge}
                      busy={working}
                      onSave={handleOAuthAppSave}
                    />
                  )}
                </section>
              </div>
              {/* Every failure renders in the fixed footer beside the key,
                  never in the scrolling body, where it can land below the
                  fold and the key reads as dead. */}
              <div className="gz-npd-pane-footer gz-npd-detail-footer">
                {signingIn ? (
                  <p className="gz-npd-footnote" aria-live="polite">
                    Finish signing in to {providerLabel} in your browser. If the browser shows an
                    error instead, press Cancel.
                  </p>
                ) : error ? (
                  <p className="error small gz-npd-submit-error" role="alert">
                    {error}
                  </p>
                ) : readinessNote ? (
                  <p className="gz-npd-footnote">{readinessNote}</p>
                ) : (
                  <p className="gz-npd-footnote">
                    {selected.driver === 'device'
                      ? 'Nothing is saved until you press Add.'
                      : `Nothing is saved until you press ${submitLabel}. The first sync starts right after.`}
                  </p>
                )}
                <Dialog.Actions>
                  <button
                    type="button"
                    onClick={signingIn ? cancelSignIn : onClose}
                    disabled={working && !signingIn}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="primary"
                    onClick={() => void handleBind()}
                    disabled={working || cannotDownload}
                  >
                    {signingIn ? 'Waiting…' : busy === 'add' ? 'Working…' : submitLabel}
                  </button>
                </Dialog.Actions>
              </div>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ConnectorCard({
  connector,
  index,
  active,
  onSelect,
}: {
  connector: ConnectorOption;
  index: number;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      // biome-ignore lint/a11y/useSemanticElements: cards form one visual radio group; native inputs would duplicate the interactive surface.
      role="radio"
      aria-checked={active}
      aria-label={connector.name}
      className={`gz-npd-card gz-connector-card${active ? ' active' : ''}`}
      onClick={onSelect}
      style={{ '--card-i': Math.min(index, 11) } as CSSProperties}
    >
      <ConnectorMark
        className="gz-npd-card-mark"
        connectorType={connector.id}
        tags={connector.tags ?? []}
        iconSvg={connector.iconSvg}
        logoUrl={connector.logoUrl}
        size={19}
        svgClassName="gz-npd-card-mark-svg"
      />
      <span className="gz-npd-card-name">{connector.name}</span>
      <span className="gz-npd-card-description">{connector.description}</span>
      <span className="gz-connector-card-meta" aria-hidden="true">
        <span>{connectorCredentialLabel(connector)}</span>
        <span>{connectorCoverageLabel(connector)}</span>
      </span>
    </button>
  );
}
