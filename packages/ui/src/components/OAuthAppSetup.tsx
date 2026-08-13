import { useEffect, useRef, useState } from 'react';
import { type OAuthAppRequirement, fixedRedirectUri } from './oauth-app-setup.js';

export interface RegisteredOAuthClient {
  clientId: string;
  hasSecret: boolean;
}

/**
 * Bring-your-own OAuth app panel for the connector bind flow. Gezel ships no
 * OAuth client of its own, so before an oauth2 connector can link, the
 * install needs the user's own developer app registered (client ID →
 * config, secret → OS keychain via the SecretStore).
 *
 * Collapsed by default: a one-line summary of the registered app (with Edit)
 * or a quiet "use your own app" affordance when none is registered — the
 * daemon may still have an env-var override the UI can't see, so Connect is
 * always worth attempting first. `forceOpenNonce` increments when that
 * attempt fails with the service's "OAuth is not configured" error and pops
 * the form open as the fallback.
 */
export function OAuthAppSetup({
  requirement,
  registered,
  forceOpenNonce,
  busy,
  onSave,
}: {
  requirement: OAuthAppRequirement;
  registered: RegisteredOAuthClient | null;
  /** Increment to force the form open (failed connect); 0 = never forced. */
  forceOpenNonce?: number;
  busy?: boolean;
  /** Persist the app, then continue into the OAuth flow. Throws on save failure. */
  onSave: (body: { clientId: string; clientSecret?: string }) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [fieldError, setFieldError] = useState('');
  const [copied, setCopied] = useState(false);
  const registeredRef = useRef(registered);
  registeredRef.current = registered;

  const openForm = () => {
    setClientId(registeredRef.current?.clientId ?? '');
    setClientSecret('');
    setFieldError('');
    setOpen(true);
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: only the nonce transition may open the form — re-running on `registered` refreshes would pop it back open after a deliberate Cancel.
  useEffect(() => {
    if (forceOpenNonce) openForm();
  }, [forceOpenNonce]);

  const redirectUri =
    requirement.redirectPort !== undefined ? fixedRedirectUri(requirement.redirectPort) : null;

  const copyRedirect = async () => {
    if (!redirectUri) return;
    try {
      await navigator.clipboard.writeText(redirectUri);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — the URI is still visible to copy by hand */
    }
  };

  const save = async () => {
    const id = clientId.trim();
    const secret = clientSecret.trim();
    if (!id) {
      setFieldError('Client ID is required.');
      return;
    }
    if (requirement.secretRequired && !secret && !registered?.hasSecret) {
      setFieldError(`${requirement.providerLabel} requires a client secret.`);
      return;
    }
    setFieldError('');
    try {
      // Omitting the secret leaves any saved one unchanged.
      await onSave({ clientId: id, ...(secret ? { clientSecret: secret } : {}) });
    } catch {
      return; // the parent surfaced the error; keep the form open to retry
    }
    setClientSecret('');
    setOpen(false);
  };

  if (!open) {
    return (
      <div className="gz-oauth-app gz-oauth-app-summary">
        <div className="gz-oauth-app-summary-text">
          {registered ? (
            <>
              <span>Connects through your {requirement.providerLabel} app</span>
              <code title={registered.clientId}>{registered.clientId}</code>
              {registered.hasSecret && <span>· secret saved</span>}
            </>
          ) : (
            <span>
              Gezel ships no built-in {requirement.providerLabel} client — connecting uses an app
              you register once on this machine.
            </span>
          )}
        </div>
        <button type="button" onClick={openForm} disabled={busy}>
          {registered ? 'Edit' : `Use your own ${requirement.providerLabel} app`}
        </button>
      </div>
    );
  }

  return (
    <div className="gz-oauth-app" aria-label={`${requirement.providerLabel} OAuth app setup`}>
      <strong className="gz-oauth-app-heading">Your {requirement.providerLabel} app</strong>
      <p className="muted small">
        {requirement.appTypeNote ??
          `Create an OAuth app in your ${requirement.providerLabel} developer settings and paste its client ID here. It is stored on this machine only.`}
      </p>
      {requirement.steps && (
        <ol className="gz-oauth-app-steps">
          {requirement.steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      )}
      {requirement.docsUrl && (
        <a
          className="gz-oauth-app-docs"
          href={requirement.docsUrl}
          target="_blank"
          rel="noreferrer"
        >
          Open the {requirement.providerLabel} developer console
        </a>
      )}
      <div className="gz-oauth-app-redirect">
        <span>Redirect URI to register</span>
        {redirectUri ? (
          <>
            <span className="gz-oauth-app-redirect-row">
              <code>{redirectUri}</code>
              <button
                type="button"
                onClick={() => void copyRedirect()}
                title="Copy the redirect URI"
              >
                {copied ? 'Copied' : 'Copy'}
              </button>
            </span>
            {requirement.redirectNote && (
              <span className="muted small">{requirement.redirectNote}</span>
            )}
          </>
        ) : (
          <span className="muted small">
            {requirement.redirectNote ??
              `${requirement.providerLabel} accepts any 127.0.0.1 port, so there is no fixed URI to register — Gezel picks a free port when you connect.`}
          </span>
        )}
      </div>
      <div className="gz-oauth-app-fields">
        <label>
          Client ID
          <input
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        {requirement.hasSecretField && (
          <label>
            Client secret{' '}
            {!requirement.secretRequired && (
              <span className="muted">(optional — PKCE public clients don't need one)</span>
            )}
            <input
              type="password"
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              autoComplete="off"
              placeholder={registered?.hasSecret ? 'leave blank to keep the saved secret' : ''}
            />
          </label>
        )}
      </div>
      {fieldError && <p className="error small">{fieldError}</p>}
      <div className="gz-oauth-app-actions">
        <button type="button" onClick={() => setOpen(false)} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="primary" onClick={() => void save()} disabled={busy}>
          {busy ? 'Working…' : 'Save & connect'}
        </button>
      </div>
    </div>
  );
}
