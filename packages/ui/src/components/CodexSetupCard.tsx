import type { CodexSetupState, CodexSetupStatusResponse } from '@bendyline/gezel';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { api } from '../api.js';
import { Select } from '../primitives/index.js';
import { ConfirmDialog } from './ConfirmDialog.js';

type Confirmation = 'configure' | 'remove' | null;

export function CodexSetupCard({
  endpointsEnabled,
  onChanged,
}: {
  endpointsEnabled: boolean;
  onChanged?: () => void | Promise<void>;
}) {
  const modelLabelId = useId();
  const copyTimerRef = useRef<number | null>(null);
  const [status, setStatus] = useState<CodexSetupStatusResponse | null>(null);
  const [model, setModel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const applyStatus = useCallback((next: CodexSetupStatusResponse) => {
    setStatus(next);
    setModel((current) => {
      const available = new Set(next.models.map((candidate) => candidate.id));
      if (current && available.has(current)) return current;
      if (next.configuredModel && available.has(next.configuredModel)) {
        return next.configuredModel;
      }
      if (next.recommendedModel && available.has(next.recommendedModel)) {
        return next.recommendedModel;
      }
      return next.models[0]?.id ?? '';
    });
  }, []);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      applyStatus(await api.getCodexSetupStatus());
    } catch (err) {
      setError(`Could not check the Codex setup — ${apiErrorMessage(err)}`);
    }
  }, [applyStatus]);

  useEffect(() => {
    void refresh();
    return () => {
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    };
  }, [refresh]);

  const desktopMode = window.__GEZEL__?.mode;
  const localDesktopMode =
    desktopMode === 'local-adopt' ||
    desktopMode === 'local-spawn-packaged' ||
    desktopMode === 'local-spawn-dev' ||
    desktopMode === 'embedded';
  const remoteMode = desktopMode === 'remote';
  const configured = status?.state === 'configured' || status?.state === 'update-needed';
  const canLaunch =
    status?.state === 'configured' &&
    status.bridge.listening &&
    endpointsEnabled &&
    localDesktopMode;
  const modelChanged = configured && model !== status?.configuredModel;
  const needsConfigure =
    status?.state === 'not-configured' || status?.state === 'update-needed' || modelChanged;
  const configureDisabled =
    busy ||
    !localDesktopMode ||
    !endpointsEnabled ||
    !status?.canConfigure ||
    !model ||
    status.state === 'conflict' ||
    status.state === 'unavailable';
  const selectionDisabled =
    busy ||
    !localDesktopMode ||
    !endpointsEnabled ||
    !status?.canConfigure ||
    status.state === 'conflict' ||
    status.state === 'unavailable';

  const runConfirmedAction = useCallback(async () => {
    if (!confirmation || busy) return;
    setBusy(true);
    setError(null);
    try {
      const next =
        confirmation === 'remove'
          ? await api.removeCodexSetup()
          : await api.configureCodex({ model });
      applyStatus(next);
      setConfirmation(null);
      void Promise.resolve(onChanged?.()).catch(() => {
        // The setup mutation succeeded. Roster refresh is best-effort and its
        // own four-second poll will recover without turning success into error.
      });
    } catch (err) {
      setConfirmation(null);
      setError(
        `${confirmation === 'remove' ? 'Could not remove' : status?.state === 'not-configured' ? 'Could not set up' : 'Could not update'} the Codex setup — ${apiErrorMessage(err)}`,
      );
    } finally {
      setBusy(false);
    }
  }, [applyStatus, busy, confirmation, model, onChanged, status?.state]);

  const copyLaunchCommand = useCallback(async () => {
    if (!status?.launchCommand) return;
    setError(null);
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard access is unavailable');
      await navigator.clipboard.writeText(status.launchCommand);
      setCopied(true);
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => {
        copyTimerRef.current = null;
        setCopied(false);
      }, 2_000);
    } catch (err) {
      setError(`Could not copy the Codex command — ${apiErrorMessage(err)}`);
    }
  }, [status?.launchCommand]);

  const stateLabel = status ? codexStateLabel(status.state) : 'Checking…';
  const configureLabel = status?.state === 'not-configured' ? 'Set up Codex…' : 'Update Codex…';
  const configuredOption = status?.models.find(
    (candidate) => candidate.id === status.configuredModel,
  );
  const selectedOption = status?.models.find((candidate) => candidate.id === model);

  return (
    <section
      className="settings-subsection provider-card codex-setup-card"
      aria-labelledby="codex-setup-heading"
    >
      <div className="settings-card-header">
        <h3 id="codex-setup-heading">Use Gezel models in Codex</h3>
        <span
          className={`codex-setup-state codex-setup-state--${status?.state ?? 'checking'}`}
          aria-live="polite"
        >
          {stateLabel}
        </span>
      </div>

      <p className="muted small codex-setup-intro">
        Codex keeps its coding tools, sandbox, approvals, and conversation loop while a model served
        by Gezel supplies the inference.
      </p>

      {!status && !error && <p className="muted small">Checking the Codex setup…</p>}

      {status && (
        <>
          {status.message && (
            <p
              className={
                status.state === 'conflict' || status.state === 'unavailable'
                  ? 'codex-setup-caution small'
                  : 'muted small'
              }
            >
              {status.message}
            </p>
          )}

          {!status.codexInstalled && status.state !== 'unavailable' && (
            <p className="muted small">
              Codex was not found on this computer. You can prepare the setup now and use it after
              installing Codex.
            </p>
          )}

          {remoteMode && (
            <p className="codex-setup-caution small">
              One-click setup is unavailable while this app is connected to a remote Gezel service.
              Configure Codex on the computer where you plan to run it.
            </p>
          )}

          {!remoteMode && !localDesktopMode && (
            <p className="codex-setup-caution small">
              One-click setup is available in the Gezel desktop app when it is connected to your
              user service on this computer.
            </p>
          )}

          {!endpointsEnabled && (
            <p className="codex-setup-caution small">
              Turn on <strong>Allow apps to connect</strong> above before setting up or updating
              Codex.
            </p>
          )}

          {status.state === 'update-needed' && status.reasons.length > 0 && (
            <div className="codex-setup-reasons">
              <span className="small">The managed setup needs an update:</span>
              <ul className="muted small">
                {status.reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            </div>
          )}

          {configured && configuredOption && !modelChanged && (
            <p className="muted small">
              Codex is configured to use <strong>{configuredOption.label}</strong>.
              {status.codexVersion ? ` Codex ${status.codexVersion} was found.` : ''}
            </p>
          )}

          {canLaunch && (
            <div className="codex-setup-command-row">
              <span className="muted small">Start it with</span>
              <code>{status.launchCommand}</code>
              <button type="button" onClick={() => void copyLaunchCommand()}>
                {copied ? 'Copied' : 'Copy command'}
              </button>
              <output className="sr-only" aria-live="polite">
                {copied ? 'Codex launch command copied.' : ''}
              </output>
              <span className="muted small">
                using the {status.profileName} profile. Keep Gezel running while you use Codex.
              </span>
            </div>
          )}

          {status.models.length > 0 && status.state !== 'conflict' && (
            <div className="codex-setup-model-row">
              <span id={modelLabelId}>Model</span>
              <Select.Root value={model} onValueChange={setModel} disabled={selectionDisabled}>
                <Select.Trigger aria-labelledby={modelLabelId}>
                  <Select.Value />
                </Select.Trigger>
                <Select.Content>
                  {status.models.map((candidate) => (
                    <Select.Item key={candidate.id} value={candidate.id}>
                      {candidate.label}
                      {candidate.description ? ` — ${candidate.description}` : ''}
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select.Root>
            </div>
          )}

          {status.models.length === 0 && status.state !== 'conflict' && (
            <p className="codex-setup-caution small">
              No inference models compatible with the Codex tool loop are available yet.
            </p>
          )}

          <div className="codex-setup-actions">
            {needsConfigure && (
              <button
                type="button"
                className="primary"
                disabled={configureDisabled}
                onClick={() => {
                  setError(null);
                  setConfirmation('configure');
                }}
              >
                {configureLabel}
              </button>
            )}
            {status.canRemove && (
              <button
                type="button"
                disabled={busy || !localDesktopMode}
                onClick={() => {
                  setError(null);
                  setConfirmation('remove');
                }}
              >
                {status.state === 'conflict' ? 'Clear Gezel setup…' : 'Remove setup…'}
              </button>
            )}
            {error && (
              <button type="button" onClick={() => void refresh()} disabled={busy}>
                Try again
              </button>
            )}
          </div>
        </>
      )}

      {error && (
        <p className="error small codex-setup-error" role="alert">
          {error}
        </p>
      )}
      {!status && error && (
        <div className="codex-setup-actions">
          <button type="button" onClick={() => void refresh()} disabled={busy}>
            Try again
          </button>
        </div>
      )}

      <ConfirmDialog
        open={confirmation === 'configure'}
        title={
          status?.state === 'not-configured' ? 'Set up Codex with Gezel?' : 'Update Codex setup?'
        }
        message={
          <>
            Gezel will {status?.state === 'not-configured' ? 'create' : 'update'} its managed Codex
            profile for <strong>{selectedOption?.label ?? model}</strong>, including the local
            connection and app-scoped credential
            {status?.profilePath ? (
              <>
                {' '}
                at <code>{status.profilePath}</code>
              </>
            ) : null}
            . Your other Codex settings and conversations stay untouched.
          </>
        }
        confirmLabel={status?.state === 'not-configured' ? 'Set up Codex' : 'Update Codex'}
        onConfirm={runConfirmedAction}
        onCancel={() => setConfirmation(null)}
      />

      <ConfirmDialog
        open={confirmation === 'remove'}
        title={
          status?.state === 'conflict'
            ? 'Clear Gezel setup for Codex?'
            : 'Remove Gezel setup from Codex?'
        }
        message={
          <>
            This removes only Gezel's managed Codex profile, catalog, state, and credential. It does
            not uninstall Codex or delete your other settings and conversations.
            {status?.state === 'conflict'
              ? ' Any Codex profile not managed by Gezel will be preserved.'
              : ''}
          </>
        }
        confirmLabel={status?.state === 'conflict' ? 'Clear Gezel setup' : 'Remove setup'}
        danger
        onConfirm={runConfirmedAction}
        onCancel={() => setConfirmation(null)}
      />
    </section>
  );
}

function codexStateLabel(state: CodexSetupState): string {
  switch (state) {
    case 'not-configured':
      return 'Not configured';
    case 'configured':
      return 'Configured';
    case 'update-needed':
      return 'Update needed';
    case 'conflict':
      return 'Needs attention';
    case 'unavailable':
      return 'Unavailable';
  }
}

function apiErrorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'details' in error) {
    const details = (error as { details?: unknown }).details;
    if (typeof details === 'string' && details) return details;
    if (details && typeof details === 'object') {
      const record = details as Record<string, unknown>;
      if (typeof record.message === 'string' && record.message) return record.message;
      if (typeof record.error === 'string' && record.error) return record.error;
    }
  }
  return error instanceof Error ? error.message : String(error);
}
