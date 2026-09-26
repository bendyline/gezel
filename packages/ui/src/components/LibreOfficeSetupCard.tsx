import type { LibreOfficeSetupStatusResponse } from '@bendyline/gezel';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { harnessStateLabel } from './harness-setup/useHarnessSetupCard.js';

function isLocalDesktopMode(): boolean {
  const mode = window.__GEZEL__?.mode;
  return (
    mode === 'local-adopt' ||
    mode === 'local-spawn-packaged' ||
    mode === 'local-spawn-dev' ||
    mode === 'embedded'
  );
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Settings → Connected Apps: install Gezel's extension into LibreOffice
 * Writer, Calc, and Impress for this account. The desktop app runs
 * LibreOffice's own installer; the extension asks for a connection code the
 * first time it connects.
 */
export function LibreOfficeSetupCard({ onChanged }: { onChanged?: () => void | Promise<void> }) {
  const bridge = window.__GEZEL__?.libreoffice;
  const localDesktop = isLocalDesktopMode() && Boolean(bridge);
  const [status, setStatus] = useState<LibreOfficeSetupStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      if (localDesktop && bridge) {
        const result = await bridge.verify();
        if (!result.ok) throw new Error(result.error);
        setStatus(result.status);
      } else {
        setStatus(await api.officeIntegrations.getLibreOfficeSetupStatus());
      }
    } catch (err) {
      setError(`Could not read the LibreOffice setup: ${errorText(err)}`);
    }
  }, [bridge, localDesktop]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = async (
    action: () => Promise<
      { ok: true; status: LibreOfficeSetupStatusResponse } | { ok: false; error: string }
    >,
    prefix: string,
  ) => {
    setBusy(true);
    setError(null);
    try {
      const result = await action();
      if (!result.ok) throw new Error(result.error);
      setStatus(result.status);
      await onChanged?.();
    } catch (err) {
      setError(`${prefix}: ${errorText(err)}`);
    } finally {
      setBusy(false);
      setConfirmRemove(false);
    }
  };

  const installLabel =
    status?.state === 'not-configured'
      ? 'Install in LibreOffice'
      : status?.state === 'update-needed'
        ? 'Install again'
        : null;

  return (
    <section
      className="settings-subsection provider-card harness-setup-card"
      aria-labelledby="libreoffice-setup-heading"
    >
      <div className="settings-card-header">
        <h3 id="libreoffice-setup-heading">Use Gezel in LibreOffice</h3>
        <span
          className={`harness-setup-state harness-setup-state--${status?.state ?? 'checking'}`}
          aria-live="polite"
        >
          {status ? harnessStateLabel(status.state) : 'Checking…'}
        </span>
      </div>

      <p className="muted small harness-setup-intro">
        Adds a Gezel panel to Writer, Calc, and Impress, where your gezels chat with you about the
        open document and can read and edit it. It is installed for your account only.
      </p>

      {!status && !error && <p className="muted small">Checking the setup…</p>}

      {status && (
        <>
          {status.message && (
            <p
              className={
                status.state === 'unavailable' || status.state === 'conflict'
                  ? 'harness-setup-caution small'
                  : 'muted small'
              }
            >
              {status.message}
            </p>
          )}
          {status.version && <p className="muted small">LibreOffice {status.version} was found.</p>}
          {!localDesktop && status.state !== 'unavailable' && (
            <p className="harness-setup-caution small">
              LibreOffice setup is done from the Gezel desktop app on the computer where you use
              LibreOffice.
            </p>
          )}
          {status.state === 'update-needed' && status.reasons.length > 0 && (
            <ul className="muted small">
              {status.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          )}
          {status.state === 'configured' && (
            <p className="muted small">
              In Writer, Calc, or Impress, choose <strong>Tools &gt; Gezel</strong> or open the
              Gezel panel in the sidebar. The first time, it shows a connection code; approve it
              here under Connected Apps.
            </p>
          )}
          {installLabel && <p className="muted small">Close LibreOffice before installing.</p>}
        </>
      )}

      {error && (
        <p className="error small harness-setup-error" role="alert">
          {error}
        </p>
      )}

      <div className="harness-setup-actions">
        {installLabel && (
          <button
            type="button"
            className="primary"
            disabled={busy || !localDesktop || !status?.canConfigure}
            onClick={() => void run(() => bridge!.enable(), 'Could not install the extension')}
          >
            {installLabel}
          </button>
        )}
        {status?.canRemove && (
          <button
            type="button"
            disabled={busy || !localDesktop}
            onClick={() => setConfirmRemove(true)}
          >
            Remove from LibreOffice…
          </button>
        )}
        {error && (
          <button type="button" disabled={busy} onClick={() => void refresh()}>
            Try again
          </button>
        )}
      </div>

      <ConfirmDialog
        open={confirmRemove}
        title="Remove Gezel from LibreOffice?"
        message="Close LibreOffice first. The Gezel panel is removed from Writer, Calc, and Impress. Your projects and chats are not affected."
        confirmLabel="Remove"
        danger
        onConfirm={() => void run(() => bridge!.disable(), 'Could not remove the extension')}
        onCancel={() => setConfirmRemove(false)}
      />
    </section>
  );
}
