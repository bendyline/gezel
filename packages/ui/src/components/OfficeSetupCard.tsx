import type { OfficeSetupStatusResponse } from '@bendyline/gezel';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { harnessStateLabel } from './harness-setup/useHarnessSetupCard.js';

type OfficeApp = 'word' | 'excel' | 'powerpoint';
type Confirmation = 'enable' | 'remove';

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
 * Settings → Connected Apps: add a Gezel button to Word, Excel and
 * PowerPoint. The desktop app does the per-user steps (trust Gezel's local
 * certificate, register the add-in with each app); the daemon owns the
 * certificate, the connection, and the add-in files. Outside the desktop app
 * this card only shows status.
 */
export function OfficeSetupCard({ onChanged }: { onChanged?: () => void | Promise<void> }) {
  const bridge = window.__GEZEL__?.officeHost;
  const localDesktop = isLocalDesktopMode() && Boolean(bridge);
  const remoteMode = window.__GEZEL__?.mode === 'remote';
  const [status, setStatus] = useState<OfficeSetupStatusResponse | null>(null);
  const [selected, setSelected] = useState<Set<OfficeApp>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);

  const apply = useCallback((next: OfficeSetupStatusResponse) => {
    setStatus(next);
    const configured = next.apps.filter((a) => a.selected).map((a) => a.app as OfficeApp);
    const initial =
      configured.length > 0
        ? configured
        : next.apps.filter((a) => a.detected).map((a) => a.app as OfficeApp);
    setSelected(new Set(initial));
  }, []);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      if (localDesktop && bridge) {
        const result = await bridge.verify();
        if (!result.ok) throw new Error(result.error);
        apply(result.status);
      } else {
        apply(await api.officeIntegrations.getOfficeSetupStatus());
      }
    } catch (err) {
      setError(`Could not read the Office setup: ${errorText(err)}`);
    }
  }, [apply, bridge, localDesktop]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = async (
    action: () => Promise<
      { ok: true; status: OfficeSetupStatusResponse } | { ok: false; error: string }
    >,
    prefix: string,
  ) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await action();
      if (!result.ok) throw new Error(result.error);
      apply(result.status);
      if (result.status.message) setNotice(result.status.message);
      await onChanged?.();
    } catch (err) {
      setError(`${prefix}: ${errorText(err)}`);
    } finally {
      setBusy(false);
      setConfirmation(null);
    }
  };

  const configuredApps = status?.apps.filter((a) => a.selected).map((a) => a.app) ?? [];
  const selectionChanged =
    configuredApps.length !== selected.size ||
    configuredApps.some((a) => !selected.has(a as OfficeApp));
  const notConfigured = status?.state === 'not-configured';
  const configured = status?.state === 'configured' || status?.state === 'update-needed';
  const canAct = localDesktop && Boolean(status?.canConfigure) && !busy;

  const toggle = (app: OfficeApp, on: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(app);
      else next.delete(app);
      return next;
    });

  return (
    <section
      className="settings-subsection provider-card harness-setup-card"
      aria-labelledby="office-setup-heading"
    >
      <div className="settings-card-header">
        <h3 id="office-setup-heading">Use Gezel in Word, Excel, and PowerPoint</h3>
        <span
          className={`harness-setup-state harness-setup-state--${status?.state ?? 'checking'}`}
          aria-live="polite"
        >
          {status ? harnessStateLabel(status.state) : 'Checking…'}
        </span>
      </div>

      <p className="muted small harness-setup-intro">
        Adds a Gezel button to the Home tab. It opens a pane where your gezels chat with you about
        the document you have open, and can read it and make the edits you ask for. Everything stays
        on this computer.
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
          {notice && <p className="muted small">{notice}</p>}
          {remoteMode && (
            <p className="harness-setup-caution small">
              Office setup is unavailable while this app is connected to a remote Gezel service. Set
              it up on the computer where you use Office.
            </p>
          )}
          {!remoteMode && !localDesktop && status.state !== 'unavailable' && (
            <p className="harness-setup-caution small">
              Office setup is done from the Gezel desktop app on the computer where you use Office.
            </p>
          )}
          {status.hostSupported && !status.officeInstalled && status.state !== 'unavailable' && (
            <p className="muted small">
              Word, Excel, and PowerPoint were not found on this computer. You can set this up now
              and it will work once Office is installed.
            </p>
          )}

          {status.state !== 'unavailable' && (
            <fieldset className="office-setup-apps" disabled={!canAct}>
              <legend className="small">Add Gezel to</legend>
              {status.apps.map((app) => (
                <label key={app.app} className="debug-toggle">
                  <input
                    type="checkbox"
                    checked={selected.has(app.app as OfficeApp)}
                    onChange={(e) => toggle(app.app as OfficeApp, e.target.checked)}
                  />
                  <span>
                    {app.label}
                    {!app.detected && <span className="muted"> (not found)</span>}
                  </span>
                </label>
              ))}
            </fieldset>
          )}

          {status.state === 'update-needed' && status.reasons.length > 0 && (
            <div className="harness-setup-reasons">
              <span className="small">Setup is not finished:</span>
              <ul className="muted small">
                {status.reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            </div>
          )}

          {configured && (
            <p className="muted small">
              Restart Word, Excel, or PowerPoint if it was open, then choose <strong>Gezel</strong>{' '}
              on the Home tab. The first time, the pane shows a connection code; approve it here
              under Connected Apps. If the button does not appear, turn on{' '}
              <strong>optional connected experiences</strong> in Office&apos;s privacy settings.
            </p>
          )}
        </>
      )}

      {error && (
        <p className="error small harness-setup-error" role="alert">
          {error}
        </p>
      )}

      <div className="harness-setup-actions">
        {status && status.state !== 'unavailable' && (notConfigured || selectionChanged) && (
          <button
            type="button"
            className="primary"
            disabled={!canAct || selected.size === 0}
            onClick={() => setConfirmation('enable')}
          >
            {notConfigured ? 'Set up Office…' : 'Update Office setup…'}
          </button>
        )}
        {status?.state === 'update-needed' && !selectionChanged && (
          <button
            type="button"
            className="primary"
            disabled={!canAct || !bridge}
            onClick={() => void run(() => bridge!.repair(), 'Could not finish the Office setup')}
          >
            Finish setup
          </button>
        )}
        {configured && (
          <button
            type="button"
            disabled={busy || !localDesktop || !bridge}
            onClick={async () => {
              setBusy(true);
              setError(null);
              const result = await bridge!.clearCache();
              setBusy(false);
              if (result.ok) setNotice('Office will reload Gezel the next time it starts.');
              else setError(`Could not clear the Office cache: ${result.error}`);
            }}
          >
            Clear Office cache
          </button>
        )}
        {status?.canRemove && (
          <button
            type="button"
            disabled={busy || !localDesktop}
            onClick={() => setConfirmation('remove')}
          >
            Remove from Office…
          </button>
        )}
        {error && (
          <button type="button" disabled={busy} onClick={() => void refresh()}>
            Try again
          </button>
        )}
      </div>

      <ConfirmDialog
        open={confirmation === 'enable'}
        title={notConfigured ? 'Add Gezel to Office?' : 'Update the Office setup?'}
        message={
          <>
            Gezel will add its button to{' '}
            {[...selected].map((a) => status?.apps.find((x) => x.app === a)?.label).join(', ')}.
            <br />
            <br />
            Office only opens add-ins from a secure connection, so Gezel creates its own security
            certificate for this computer and asks your system to trust it. The certificate is
            limited to this computer (localhost), is trusted for your account only, and is removed
            when you remove this setup. Your system will ask you to confirm
            {navigator.userAgent.includes('Mac') ? ' with your password' : ''}.
            {navigator.userAgent.includes('Mac') && (
              <>
                {' '}
                macOS may also ask whether Gezel may access data from other apps; allow it so Gezel
                can add itself to Office.
              </>
            )}
          </>
        }
        confirmLabel={notConfigured ? 'Set up Office' : 'Update'}
        onConfirm={() => void run(() => bridge!.enable([...selected]), 'Could not set up Office')}
        onCancel={() => setConfirmation(null)}
      />

      <ConfirmDialog
        open={confirmation === 'remove'}
        title="Remove Gezel from Office?"
        message="Gezel's button leaves Word, Excel, and PowerPoint after they restart, and Gezel's certificate is removed from your account. Your projects and chats are not affected."
        confirmLabel="Remove"
        danger
        onConfirm={() => void run(() => bridge!.disable(), 'Could not remove the Office setup')}
        onCancel={() => setConfirmation(null)}
      />
    </section>
  );
}
