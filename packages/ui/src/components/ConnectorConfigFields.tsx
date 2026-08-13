import type { ReactNode } from 'react';

export type ConnectorConfigValue = string | boolean;

interface ConnectorConfigProperty {
  type?: string;
  title?: string;
  description?: string;
  const?: unknown;
  default?: unknown;
  minimum?: number;
  maximum?: number;
  /** Catalog annotation: important fields appear before routine settings. */
  'x-gezel-priority'?: 'primary' | 'secondary';
}

export interface ConnectorFormManifest {
  id: string;
  name: string;
  configSchema?: {
    properties?: Record<string, ConnectorConfigProperty>;
    required?: string[];
  };
  secretShape?: {
    kind?: string;
    label?: string;
    description?: string;
    helpUrl?: string;
    helpLabel?: string;
    required?: boolean;
    'x-gezel-priority'?: 'primary' | 'secondary';
  };
  setupInstructions?: {
    title: string;
    description?: string;
    steps?: string[];
    url?: string;
    urlLabel?: string;
  };
}

function safeFieldId(connectorId: string, field: string): string {
  return `connector-${connectorId}-${field}`.replace(/[^a-zA-Z0-9_-]/g, '-');
}

function httpsUrl(value: string | undefined): string | undefined {
  return value && /^https:\/\//i.test(value) ? value : undefined;
}

function Requirement({ required }: { required: boolean }) {
  return required ? (
    <span className="gz-connector-field-requirement" aria-hidden="true">
      Required
    </span>
  ) : null;
}

function FieldHelp({
  id,
  description,
  helpUrl,
  helpLabel,
}: {
  id: string;
  description?: string;
  helpUrl?: string;
  helpLabel?: string;
}) {
  const safeHelpUrl = httpsUrl(helpUrl);
  if (!description && !safeHelpUrl) return null;
  return (
    <span id={id} className="gz-connector-field-help">
      {description}
      {description && safeHelpUrl ? ' ' : ''}
      {safeHelpUrl && (
        <a href={safeHelpUrl} target="_blank" rel="noreferrer">
          {helpLabel ?? 'Learn more'}
        </a>
      )}
    </span>
  );
}

function ConfigField({
  connectorId,
  fieldKey,
  property,
  required,
  value,
  onChange,
}: {
  connectorId: string;
  fieldKey: string;
  property: ConnectorConfigProperty;
  required: boolean;
  value: ConnectorConfigValue | undefined;
  onChange: (value: ConnectorConfigValue) => void;
}) {
  const inputId = safeFieldId(connectorId, fieldKey);
  const labelId = `${inputId}-label`;
  const helpId = `${inputId}-help`;
  const title = property.title ?? fieldKey;
  const describedBy = property.description ? helpId : undefined;

  return (
    <div className="gz-connector-field">
      <label id={labelId} className="gz-connector-field-label" htmlFor={inputId}>
        <span>{title}</span>
        <Requirement required={required} />
      </label>
      <span className="gz-connector-field-control">
        {property.type === 'boolean' ? (
          <input
            id={inputId}
            type="checkbox"
            aria-label={title}
            checked={value === true}
            onChange={(event) => onChange(event.target.checked)}
            aria-describedby={describedBy}
          />
        ) : (
          <input
            id={inputId}
            type={property.type === 'integer' || property.type === 'number' ? 'number' : 'text'}
            value={typeof value === 'string' ? value : ''}
            onChange={(event) => onChange(event.target.value)}
            placeholder={property.type === 'array' ? 'comma,separated' : ''}
            min={property.minimum}
            max={property.maximum}
            step={property.type === 'integer' ? 1 : undefined}
            required={required}
            aria-label={title}
            aria-describedby={describedBy}
          />
        )}
        <FieldHelp id={helpId} description={property.description} />
      </span>
    </div>
  );
}

function TextField({
  connectorId,
  fieldKey,
  label,
  value,
  onChange,
  required = false,
  secret = false,
  description,
  helpUrl,
  helpLabel,
  placeholder,
}: {
  connectorId: string;
  fieldKey: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  secret?: boolean;
  description?: string;
  helpUrl?: string;
  helpLabel?: string;
  placeholder?: string;
}) {
  const inputId = safeFieldId(connectorId, fieldKey);
  const helpId = `${inputId}-help`;
  const hasHelp = Boolean(description || httpsUrl(helpUrl));
  return (
    <div className="gz-connector-field">
      <label className="gz-connector-field-label" htmlFor={inputId}>
        <span>{label}</span>
        <Requirement required={required} />
      </label>
      <span className="gz-connector-field-control">
        <input
          id={inputId}
          type={secret ? 'password' : 'text'}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          required={required}
          autoComplete={secret ? 'off' : undefined}
          placeholder={placeholder}
          aria-label={label}
          aria-describedby={hasHelp ? helpId : undefined}
        />
        <FieldHelp id={helpId} description={description} helpUrl={helpUrl} helpLabel={helpLabel} />
      </span>
    </div>
  );
}

function BooleanField({
  connectorId,
  fieldKey,
  label,
  checked,
  onChange,
}: {
  connectorId: string;
  fieldKey: string;
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  const inputId = safeFieldId(connectorId, fieldKey);
  return (
    <div className="gz-connector-field">
      <label className="gz-connector-field-label" htmlFor={inputId}>
        <span>{label}</span>
      </label>
      <span className="gz-connector-field-control gz-connector-checkbox-control">
        <input
          id={inputId}
          type="checkbox"
          aria-label={label}
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
        />
      </span>
    </div>
  );
}

function FieldGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="gz-connector-field-group" aria-label={title}>
      <div className="gz-connector-field-group-heading">{title}</div>
      {children}
    </section>
  );
}

export function initialConnectorConfig(
  connector: ConnectorFormManifest,
): Record<string, ConnectorConfigValue> {
  const initial: Record<string, ConnectorConfigValue> = {};
  for (const [key, property] of Object.entries(connector.configSchema?.properties ?? {})) {
    if (property.default === undefined) continue;
    initial[key] =
      property.type === 'boolean' ? property.default === true : String(property.default);
  }
  return initial;
}

/**
 * One aligned name → control form. Required and catalog-prioritized fields
 * lead; defaults, tuning knobs, and the optional display name follow.
 */
export function ConnectorConfigFields({
  connector,
  config,
  onConfigChange,
  displayName,
  onDisplayNameChange,
  credential,
  onCredentialChange,
  imapHost,
  onImapHostChange,
  imapPort,
  onImapPortChange,
  imapSecure,
  onImapSecureChange,
}: {
  connector: ConnectorFormManifest;
  config: Record<string, ConnectorConfigValue>;
  onConfigChange: (key: string, value: ConnectorConfigValue) => void;
  displayName: string;
  onDisplayNameChange: (value: string) => void;
  credential: string;
  onCredentialChange: (value: string) => void;
  imapHost: string;
  onImapHostChange: (value: string) => void;
  imapPort: string;
  onImapPortChange: (value: string) => void;
  imapSecure: boolean;
  onImapSecureChange: (value: boolean) => void;
}) {
  const kind = connector.secretShape?.kind;
  const requiredKeys = new Set(connector.configSchema?.required ?? []);
  const entries = Object.entries(connector.configSchema?.properties ?? {}).filter(
    ([, property]) => property.const === undefined,
  );
  const isPrimary = ([key, property]: (typeof entries)[number]) =>
    requiredKeys.has(key) || property['x-gezel-priority'] === 'primary';
  const primaryEntries = entries.filter(isPrimary);
  const secondaryEntries = entries.filter((entry) => !isPrimary(entry));
  const credentialIsPrimary =
    connector.secretShape?.required === true ||
    connector.secretShape?.['x-gezel-priority'] === 'primary';

  const configField = ([key, property]: (typeof entries)[number]) => (
    <ConfigField
      key={key}
      connectorId={connector.id}
      fieldKey={key}
      property={property}
      required={requiredKeys.has(key)}
      value={config[key]}
      onChange={(value) => onConfigChange(key, value)}
    />
  );

  const credentialField = kind !== 'oauth2' && kind !== 'imap' && (
    <TextField
      key="credential"
      connectorId={connector.id}
      fieldKey="credential"
      label={connector.secretShape?.label ?? 'API key / token'}
      value={credential}
      onChange={onCredentialChange}
      required={connector.secretShape?.required === true}
      secret
      description={connector.secretShape?.description}
      helpUrl={connector.secretShape?.helpUrl}
      helpLabel={connector.secretShape?.helpLabel}
    />
  );

  const imapPrimaryFields = kind === 'imap' && (
    <>
      <TextField
        connectorId={connector.id}
        fieldKey="imap-host"
        label="IMAP host"
        value={imapHost}
        onChange={onImapHostChange}
        required
        placeholder="imap.example.com"
      />
      <TextField
        connectorId={connector.id}
        fieldKey="credential"
        label="Password / app password"
        value={credential}
        onChange={onCredentialChange}
        required
        secret
        description={connector.secretShape?.description}
        helpUrl={connector.secretShape?.helpUrl}
        helpLabel={connector.secretShape?.helpLabel}
      />
    </>
  );

  const hasPrimary =
    primaryEntries.length > 0 || credentialIsPrimary || kind === 'imap' || kind === 'oauth2';

  return (
    <>
      {connector.setupInstructions && (
        <aside className="gz-connector-setup-instructions">
          <strong>{connector.setupInstructions.title}</strong>
          {connector.setupInstructions.description && (
            <p>{connector.setupInstructions.description}</p>
          )}
          {connector.setupInstructions.steps && connector.setupInstructions.steps.length > 0 && (
            <ol>
              {connector.setupInstructions.steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          )}
          {httpsUrl(connector.setupInstructions.url) && (
            <a href={connector.setupInstructions.url} target="_blank" rel="noreferrer">
              {connector.setupInstructions.urlLabel ?? 'Open setup instructions'}
            </a>
          )}
        </aside>
      )}

      <div className="gz-connector-config-fields">
        {hasPrimary && (
          <FieldGroup title="Connection details">
            {primaryEntries.map(configField)}
            {kind === 'oauth2' ? (
              <p className="muted small gz-connector-oauth-note">
                You'll authorize this connector in your browser after you click Connect.
              </p>
            ) : kind === 'imap' ? (
              imapPrimaryFields
            ) : credentialIsPrimary ? (
              credentialField
            ) : null}
          </FieldGroup>
        )}

        <FieldGroup title="Additional settings">
          {secondaryEntries.map(configField)}
          {kind === 'imap' && (
            <>
              <TextField
                connectorId={connector.id}
                fieldKey="imap-port"
                label="Port"
                value={imapPort}
                onChange={onImapPortChange}
                placeholder="993"
              />
              <BooleanField
                connectorId={connector.id}
                fieldKey="imap-tls"
                label="Use TLS"
                checked={imapSecure}
                onChange={onImapSecureChange}
              />
            </>
          )}
          {!credentialIsPrimary && credentialField}
          <TextField
            connectorId={connector.id}
            fieldKey="display-name"
            label="Display name"
            value={displayName}
            onChange={onDisplayNameChange}
          />
        </FieldGroup>
      </div>
    </>
  );
}
