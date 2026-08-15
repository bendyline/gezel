import type {
  CodexSetupModelOption,
  CodexSetupState,
  CodexSetupStatusResponse,
} from '@bendyline/gezel';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { api } from '../api.js';
import { Select } from '../primitives/index.js';
import { ConfirmDialog } from './ConfirmDialog.js';

type Confirmation = 'configure' | 'repair' | 'remove' | null;

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
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const applyStatus = useCallback((next: CodexSetupStatusResponse) => {
    setStatus(next);
    if (next.profileBackupPath) {
      setNotice(`Your previous Codex profile was saved as ${next.profileBackupPath}.`);
    }
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
  const repairable = status?.state === 'conflict' && status.canRepair;
  const needsConfigure =
    status?.state === 'not-configured' ||
    status?.state === 'update-needed' ||
    modelChanged ||
    repairable;
  // `canConfigure` already refuses both conflict and unavailable; repair is the
  // one path that deliberately proceeds from a conflict.
  const canPublish =
    status?.state === 'conflict' ? status.canRepair : (status?.canConfigure ?? false);
  const configureDisabled = busy || !localDesktopMode || !endpointsEnabled || !canPublish || !model;
  const selectionDisabled = busy || !localDesktopMode || !endpointsEnabled || !canPublish;

  const runConfirmedAction = useCallback(async () => {
    if (!confirmation || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const next =
        confirmation === 'remove'
          ? await api.removeCodexSetup()
          : await api.configureCodex({
              model,
              ...(confirmation === 'repair' ? { backupConflictingProfile: true } : {}),
            });
      applyStatus(next);
      setConfirmation(null);
      void Promise.resolve(onChanged?.()).catch(() => {
        // The setup mutation succeeded. Roster refresh is best-effort and its
        // own four-second poll will recover without turning success into error.
      });
    } catch (err) {
      setConfirmation(null);
      setError(
        `${confirmation === 'remove' ? 'Could not remove' : confirmation === 'repair' ? 'Could not repair' : status?.state === 'not-configured' ? 'Could not set up' : 'Could not update'} the Codex setup — ${apiErrorMessage(err)}`,
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
  const configureLabel = repairable
    ? 'Repair Codex setup…'
    : status?.state === 'not-configured'
      ? 'Set up Codex…'
      : 'Update Codex…';
  const configuredOption = status?.models.find(
    (candidate) => candidate.id === status.configuredModel,
  );
  const selectedOption = status?.models.find((candidate) => candidate.id === model);
  const gezelOptions = status?.models.filter(isGezelOption) ?? [];
  const rawModelOptions = status?.models.filter((candidate) => !isGezelOption(candidate)) ?? [];

  return (
    <section
      className="settings-subsection provider-card harness-setup-card"
      aria-labelledby="codex-setup-heading"
    >
      <div className="settings-card-header">
        <h3 id="codex-setup-heading">Use Gezel in Codex</h3>
        <span
          className={`harness-setup-state harness-setup-state--${status?.state ?? 'checking'}`}
          aria-live="polite"
        >
          {stateLabel}
        </span>
      </div>

      <p className="muted small harness-setup-intro">
        Codex keeps its coding tools, sandbox, approvals, and conversation loop while a gezel
        supplies the character, model, and tuning. Your whole eligible crew is offered to Codex —
        the gezel you pick here is the one it starts with, and you can switch to any other from
        Codex's own model picker. Raw local models remain available when you want inference without
        a gezel persona.
      </p>

      {!status && !error && <p className="muted small">Checking the Codex setup…</p>}

      {status && (
        <>
          {status.message && (
            <p
              className={
                status.state === 'conflict' || status.state === 'unavailable'
                  ? 'harness-setup-caution small'
                  : 'muted small'
              }
            >
              {status.message}
            </p>
          )}

          {repairable && (
            <p className="muted small">
              Repair writes a fresh <code>{status.profileName}</code> profile for this Gezel and
              keeps a copy of the existing file next to it.
            </p>
          )}

          {notice && <p className="muted small">{notice}</p>}

          {!status.codexInstalled && status.state !== 'unavailable' && (
            <p className="muted small">
              Codex was not found on this computer. You can prepare the setup now and use it after
              installing Codex.
            </p>
          )}

          {remoteMode && (
            <p className="harness-setup-caution small">
              One-click setup is unavailable while this app is connected to a remote Gezel service.
              Configure Codex on the computer where you plan to run it.
            </p>
          )}

          {!remoteMode && !localDesktopMode && (
            <p className="harness-setup-caution small">
              One-click setup is available in the Gezel desktop app when it is connected to your
              user service on this computer.
            </p>
          )}

          {!endpointsEnabled && (
            <p className="harness-setup-caution small">
              Turn on <strong>Allow apps to connect</strong> above before setting up or updating
              Codex.
            </p>
          )}

          {status.state === 'update-needed' && status.reasons.length > 0 && (
            <div className="harness-setup-reasons">
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
              Codex starts with <strong>{configuredOption.label}</strong>.
              {status.codexVersion ? ` Codex ${status.codexVersion} was found.` : ''}
            </p>
          )}

          {canLaunch && (
            <div className="harness-setup-command-row">
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

          {status.models.length > 0 && (status.state !== 'conflict' || repairable) && (
            <div className="harness-setup-model-row">
              <span id={modelLabelId}>Default gezel</span>
              <Select.Root value={model} onValueChange={setModel} disabled={selectionDisabled}>
                <Select.Trigger aria-labelledby={modelLabelId}>
                  <Select.Value />
                </Select.Trigger>
                <Select.Content>
                  {gezelOptions.length > 0 && (
                    <Select.Group>
                      <Select.Label>Gezels</Select.Label>
                      {gezelOptions.map((candidate) => (
                        <Select.Item key={candidate.id} value={candidate.id}>
                          {candidate.label}
                          {candidate.description ? ` — ${candidate.description}` : ''}
                        </Select.Item>
                      ))}
                    </Select.Group>
                  )}
                  {gezelOptions.length > 0 && rawModelOptions.length > 0 && <Select.Separator />}
                  {rawModelOptions.length > 0 && (
                    <Select.Group>
                      <Select.Label>Raw models</Select.Label>
                      {rawModelOptions.map((candidate) => (
                        <Select.Item key={candidate.id} value={candidate.id}>
                          {candidate.label}
                          {candidate.description ? ` — ${candidate.description}` : ''}
                        </Select.Item>
                      ))}
                    </Select.Group>
                  )}
                </Select.Content>
              </Select.Root>
            </div>
          )}

          {status.models.length === 0 && status.state !== 'conflict' && (
            <p className="harness-setup-caution small">
              No gezels or inference models compatible with the Codex tool loop are available yet.
            </p>
          )}

          <div className="harness-setup-actions">
            {needsConfigure && (
              <button
                type="button"
                className="primary"
                disabled={configureDisabled}
                onClick={() => {
                  setError(null);
                  setConfirmation(repairable ? 'repair' : 'configure');
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
        <p className="error small harness-setup-error" role="alert">
          {error}
        </p>
      )}
      {!status && error && (
        <div className="harness-setup-actions">
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
            profile for <strong>{selectedOption?.label ?? model}</strong>.{' '}
            {selectedOption && isGezelOption(selectedOption) ? (
              <>
                This gezel&apos;s character, {selectedOption.modelLabel ?? 'model'}, and tuning will
                guide Codex.{' '}
              </>
            ) : (
              <>Codex will use it as a raw inference model without a gezel persona. </>
            )}
            The profile includes the local connection and app-scoped credential
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
        open={confirmation === 'repair'}
        title="Repair the Codex setup?"
        message={
          <>
            Gezel will write a working <code>{status?.profileName}</code> profile for{' '}
            <strong>{selectedOption?.label ?? model}</strong>, connected to this copy of Gezel.
            {status?.profilePath ? (
              <>
                {' '}
                The file now at <code>{status.profilePath}</code> is kept as a <code>.backup</code>{' '}
                copy beside it, so nothing is lost.
              </>
            ) : (
              <> The file it replaces is kept as a .backup copy beside it, so nothing is lost.</>
            )}{' '}
            Your other Codex settings and conversations stay untouched.
          </>
        }
        confirmLabel="Repair setup"
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

function isGezelOption(option: CodexSetupModelOption): boolean {
  return option.kind === 'gezel' || option.id.startsWith('gezel:');
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
