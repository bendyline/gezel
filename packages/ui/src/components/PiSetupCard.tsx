import type { PiSetupStatusResponse } from '@bendyline/gezel';
import { useCallback } from 'react';
import { api } from '../api.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { HarnessSetupShell } from './harness-setup/HarnessSetupShell.js';
import { isGezelOption, useHarnessSetupCard } from './harness-setup/useHarnessSetupCard.js';

type Confirmation =
  | 'configure'
  | 'repair'
  | 'remove'
  | 'install-extension'
  | 'replace-extension'
  | 'remove-extension';

export function PiSetupCard({
  endpointsEnabled,
  onChanged,
}: {
  endpointsEnabled: boolean;
  onChanged?: () => void | Promise<void>;
}) {
  const runAction = useCallback(
    (confirmation: Confirmation, model: string): Promise<PiSetupStatusResponse> => {
      switch (confirmation) {
        case 'remove':
          return api.removePiSetup();
        case 'install-extension':
          return api.installPiExtension();
        case 'replace-extension':
          return api.installPiExtension({ backupConflictingExtension: true });
        case 'remove-extension':
          return api.removePiExtension();
        default:
          return api.configurePi({
            model,
            ...(confirmation === 'repair' ? { backupConflictingConfig: true } : {}),
          });
      }
    },
    [],
  );

  const card = useHarnessSetupCard<PiSetupStatusResponse, Confirmation>({
    label: 'pi',
    endpointsEnabled,
    fetchStatus: () => api.getPiSetupStatus(),
    runAction,
    errorPrefix: actionErrorPrefix,
    backupNotice: (next) =>
      next.extensionBackupPath
        ? `The previous extension file was saved as ${next.extensionBackupPath}.`
        : next.configBackupPath
          ? `The previous file was saved as ${next.configBackupPath}.`
          : null,
    ...(onChanged ? { onChanged } : {}),
  });

  const { status, confirmation, setConfirmation, setError, busy, copied } = card;
  const selectedOption = status?.models.find((candidate) => candidate.id === card.model);
  const configuredOption = status?.models.find(
    (candidate) => candidate.id === status.configuredModel,
  );
  const showExtensionRow =
    card.configured &&
    card.localDesktopMode &&
    status?.state !== 'conflict' &&
    status?.extension.state !== 'unsupported';
  const configureLabel = card.repairable
    ? 'Repair pi setup…'
    : status?.state === 'not-configured'
      ? 'Set up pi…'
      : 'Update pi…';

  return (
    <HarnessSetupShell
      headingId="pi-setup-heading"
      title="Use Gezel in pi"
      status={status}
      remoteMode={card.remoteMode}
      localDesktopMode={card.localDesktopMode}
      endpointsEnabled={endpointsEnabled}
      repairable={Boolean(card.repairable)}
      notice={card.notice}
      error={card.error}
      reasonsIntro="The managed setup needs an update:"
      emptyModelsNote="No gezels or inference models compatible with the pi tool loop are available yet."
      intro={
        <>
          pi keeps its own tools, permissions, and conversation loop while a gezel supplies the
          character, model, and tuning. Gezel writes an extension of its own and hands you a command
          that loads it for that run. You can also let Gezel add that same file to pi, so the gezel
          provider is simply there in every session. Either way, your own pi settings, sessions, and
          models are never edited.
        </>
      }
      repairExplainer="Repair writes a fresh model list for this Gezel and keeps a copy of the existing one next to it."
      {...(status && !status.piInstalled
        ? {
            notInstalledNote:
              'pi was not found on this computer. You can prepare the setup now and use it after installing pi.',
          }
        : {})}
      {...(card.configured && configuredOption && !card.modelChanged
        ? {
            configuredNote: (
              <>
                pi starts with <strong>{configuredOption.label}</strong>, and offers the whole crew
                in its own model picker.
                {status?.piVersion ? ` pi ${status.piVersion} was found.` : ''}
              </>
            ),
          }
        : {})}
      {...(card.canLaunch && status
        ? {
            commandRow: (
              <div className="harness-setup-command-row">
                <span className="muted small">Start it with</span>
                <code>{status.launchCommand}</code>
                <button type="button" onClick={() => void card.copyLaunchCommand()}>
                  {copied ? 'Copied' : 'Copy command'}
                </button>
                <output className="sr-only" aria-live="polite">
                  {copied ? 'pi launch command copied.' : ''}
                </output>
                <span className="muted small">Keep Gezel running while you use pi.</span>
              </div>
            ),
          }
        : {})}
      modelRow={{
        label: 'Default gezel',
        value: card.model,
        onChange: card.setModel,
        disabled: card.selectionDisabled,
      }}
      {...(showExtensionRow && status
        ? {
            extraRows: (
              <p className="muted small">
                {status.extension.state === 'installed' || status.extension.state === 'stale' ? (
                  <>
                    Gezel is in pi's provider list without the command, through{' '}
                    <code>{status.extension.path}</code>.
                  </>
                ) : status.extension.state === 'conflict' ? (
                  status.extension.message
                ) : (
                  <>
                    Rather not use the command every time? Gezel can add the same extension to pi so
                    the crew shows up in every session.
                  </>
                )}
              </p>
            ),
          }
        : {})}
      actions={
        <>
          {card.needsConfigure && (
            <button
              type="button"
              className="primary"
              disabled={card.configureDisabled}
              onClick={() => {
                setError(null);
                setConfirmation(card.repairable ? 'repair' : 'configure');
              }}
            >
              {configureLabel}
            </button>
          )}
          {showExtensionRow &&
            status &&
            (status.extension.canInstall || status.extension.canReplace) && (
              <button
                type="button"
                disabled={busy || !card.localDesktopMode}
                onClick={() => {
                  setError(null);
                  setConfirmation(
                    status.extension.canReplace ? 'replace-extension' : 'install-extension',
                  );
                }}
              >
                {status.extension.canReplace ? 'Replace pi extension…' : 'Add to pi…'}
              </button>
            )}
          {showExtensionRow && status?.extension.canRemove && (
            <button
              type="button"
              disabled={busy || !card.localDesktopMode}
              onClick={() => {
                setError(null);
                setConfirmation('remove-extension');
              }}
            >
              Remove from pi…
            </button>
          )}
          {status?.canRemove && (
            <button
              type="button"
              disabled={busy || !card.localDesktopMode}
              onClick={() => {
                setError(null);
                setConfirmation('remove');
              }}
            >
              {status.state === 'conflict' ? 'Clear Gezel setup…' : 'Remove setup…'}
            </button>
          )}
          {card.error && (
            <button type="button" onClick={() => void card.refresh()} disabled={busy}>
              Try again
            </button>
          )}
        </>
      }
    >
      <ConfirmDialog
        open={confirmation === 'configure'}
        title={status?.state === 'not-configured' ? 'Set up pi with Gezel?' : 'Update pi setup?'}
        message={
          <>
            Gezel will {status?.state === 'not-configured' ? 'create' : 'update'} its own pi
            extension and model list for <strong>{selectedOption?.label ?? card.model}</strong>.{' '}
            {selectedOption && isGezelOption(selectedOption) ? (
              <>
                This gezel&apos;s character, {selectedOption.modelLabel ?? 'model'}, and tuning will
                guide pi.{' '}
              </>
            ) : (
              <>pi will use it as a raw inference model without a gezel persona. </>
            )}
            Both files live in Gezel&apos;s own folder
            {status?.extensionPath ? (
              <>
                , at <code>{status.extensionPath}</code>
              </>
            ) : null}
            , and the command above points pi at them for that run. Your own pi settings, sessions,
            and models stay untouched.
          </>
        }
        confirmLabel={status?.state === 'not-configured' ? 'Set up pi' : 'Update pi'}
        onConfirm={card.runConfirmedAction}
        onCancel={() => setConfirmation(null)}
      />

      <ConfirmDialog
        open={confirmation === 'repair'}
        title="Repair the pi setup?"
        message={
          <>
            Gezel will write a working model list for{' '}
            <strong>{selectedOption?.label ?? card.model}</strong>, connected to this copy of Gezel.
            {status?.configPath ? (
              <>
                {' '}
                The file now at <code>{status.configPath}</code> is kept as a <code>.backup</code>{' '}
                copy beside it, so nothing is lost.
              </>
            ) : (
              <> The file it replaces is kept as a .backup copy beside it, so nothing is lost.</>
            )}{' '}
            Your own pi configuration stays untouched.
          </>
        }
        confirmLabel="Repair setup"
        onConfirm={card.runConfirmedAction}
        onCancel={() => setConfirmation(null)}
      />

      <ConfirmDialog
        open={confirmation === 'remove'}
        title={
          status?.state === 'conflict' ? 'Clear Gezel setup for pi?' : 'Remove Gezel setup from pi?'
        }
        message={
          <>
            This removes only Gezel's own pi extension, model list, state, and credential
            {status?.extension.canRemove ? (
              <>
                , along with the copy Gezel added at <code>{status.extension.path}</code>
              </>
            ) : null}
            . It does not uninstall pi or touch your own settings and sessions.
          </>
        }
        confirmLabel={status?.state === 'conflict' ? 'Clear Gezel setup' : 'Remove setup'}
        danger
        onConfirm={card.runConfirmedAction}
        onCancel={() => setConfirmation(null)}
      />

      <ConfirmDialog
        open={confirmation === 'install-extension' || confirmation === 'replace-extension'}
        title={
          confirmation === 'replace-extension'
            ? 'Replace the extension file in pi?'
            : 'Add Gezel to pi?'
        }
        message={
          <>
            Gezel will add its extension
            {status?.extension.path ? (
              <>
                {' '}
                at <code>{status.extension.path}</code>
              </>
            ) : null}
            , so every pi session on this computer offers the <strong>gezel</strong> provider
            without the command above. It holds no password — it reads Gezel's own model list when
            pi starts, and does nothing at all when Gezel is not running. It does not change which
            model pi starts with; pick a gezel from pi's own model picker. Your own pi settings,
            sessions, and models stay untouched, and <code>pi -ne</code> always starts without it.
            {status?.extension.agentDirSource === 'default' ? (
              <>
                {' '}
                Gezel found pi's folder in its usual place. If you point pi elsewhere with{' '}
                <code>PI_CODING_AGENT_DIR</code> in your shell, it will not be picked up.
              </>
            ) : null}
            {confirmation === 'replace-extension' ? (
              <> The file it replaces is kept as a .backup copy beside it, so nothing is lost.</>
            ) : null}
          </>
        }
        confirmLabel={confirmation === 'replace-extension' ? 'Replace extension' : 'Add to pi'}
        onConfirm={card.runConfirmedAction}
        onCancel={() => setConfirmation(null)}
      />

      <ConfirmDialog
        open={confirmation === 'remove-extension'}
        title="Remove Gezel from pi?"
        message={
          <>
            This deletes the extension Gezel added
            {status?.extension.path ? (
              <>
                {' '}
                at <code>{status.extension.path}</code>
              </>
            ) : null}
            . pi stops offering the gezel provider unless you start it with the command on this
            card. The rest of the setup, and everything of your own, stays as it is.
          </>
        }
        confirmLabel="Remove from pi"
        onConfirm={card.runConfirmedAction}
        onCancel={() => setConfirmation(null)}
      />
    </HarnessSetupShell>
  );
}

function actionErrorPrefix(confirmation: Confirmation, state: string | undefined): string {
  switch (confirmation) {
    case 'remove':
      return 'Could not remove the pi setup';
    case 'repair':
      return 'Could not repair the pi setup';
    case 'install-extension':
    case 'replace-extension':
      return 'Could not add Gezel to pi';
    case 'remove-extension':
      return 'Could not remove Gezel from pi';
    default:
      return state === 'not-configured' ? 'Could not set up pi' : 'Could not update the pi setup';
  }
}
