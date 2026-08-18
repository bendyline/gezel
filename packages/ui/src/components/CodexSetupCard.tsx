import type { CodexSetupStatusResponse } from '@bendyline/gezel';
import { useCallback } from 'react';
import { api } from '../api.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { HarnessSetupShell } from './harness-setup/HarnessSetupShell.js';
import { isGezelOption, useHarnessSetupCard } from './harness-setup/useHarnessSetupCard.js';

type Confirmation = 'configure' | 'repair' | 'remove';

export function CodexSetupCard({
  endpointsEnabled,
  onChanged,
}: {
  endpointsEnabled: boolean;
  onChanged?: () => void | Promise<void>;
}) {
  const runAction = useCallback(
    (confirmation: Confirmation, model: string): Promise<CodexSetupStatusResponse> =>
      confirmation === 'remove'
        ? api.removeCodexSetup()
        : api.configureCodex({
            model,
            ...(confirmation === 'repair' ? { backupConflictingProfile: true } : {}),
          }),
    [],
  );

  const card = useHarnessSetupCard<CodexSetupStatusResponse, Confirmation>({
    label: 'Codex',
    endpointsEnabled,
    fetchStatus: () => api.getCodexSetupStatus(),
    runAction,
    errorPrefix: actionErrorPrefix,
    backupNotice: (next) =>
      next.profileBackupPath ? `The previous file was saved as ${next.profileBackupPath}.` : null,
    ...(onChanged ? { onChanged } : {}),
  });

  const { status, confirmation, setConfirmation, setError, busy, copied } = card;
  const selectedOption = status?.models.find((candidate) => candidate.id === card.model);
  const configuredOption = status?.models.find(
    (candidate) => candidate.id === status.configuredModel,
  );
  const configureLabel = card.repairable
    ? 'Repair Codex setup…'
    : status?.state === 'not-configured'
      ? 'Set up Codex…'
      : 'Update Codex…';

  return (
    <HarnessSetupShell
      headingId="codex-setup-heading"
      title="Use Gezel in Codex"
      status={status}
      remoteMode={card.remoteMode}
      localDesktopMode={card.localDesktopMode}
      endpointsEnabled={endpointsEnabled}
      repairable={Boolean(card.repairable)}
      notice={card.notice}
      error={card.error}
      reasonsIntro="The managed setup needs an update:"
      emptyModelsNote="No gezels or inference models compatible with the Codex tool loop are available yet."
      intro={
        <>
          Codex keeps its coding tools, sandbox, approvals, and conversation loop while a gezel
          supplies the character, model, and tuning. Your whole eligible crew is offered to Codex —
          the gezel you pick here is the one it starts with, and you can switch to any other from
          Codex's own model picker. Raw local models remain available when you want inference
          without a gezel persona.
        </>
      }
      {...(status
        ? {
            repairExplainer: (
              <>
                Repair writes a fresh <code>{status.profileName}</code> profile for this Gezel and
                keeps a copy of the existing file next to it.
              </>
            ),
          }
        : {})}
      {...(status && !status.codexInstalled
        ? {
            notInstalledNote:
              'Codex was not found on this computer. You can prepare the setup now and use it after installing Codex.',
          }
        : {})}
      {...(card.configured && configuredOption && !card.modelChanged
        ? {
            configuredNote: (
              <>
                Codex starts with <strong>{configuredOption.label}</strong>.
                {status?.codexVersion ? ` Codex ${status.codexVersion} was found.` : ''}
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
                  {copied ? 'Codex launch command copied.' : ''}
                </output>
                <span className="muted small">Keep Gezel running while you use Codex.</span>
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
        title={
          status?.state === 'not-configured' ? 'Set up Codex with Gezel?' : 'Update Codex setup?'
        }
        message={
          <>
            Gezel will {status?.state === 'not-configured' ? 'create' : 'update'} its managed Codex
            profile for <strong>{selectedOption?.label ?? card.model}</strong>.{' '}
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
        onConfirm={card.runConfirmedAction}
        onCancel={() => setConfirmation(null)}
      />

      <ConfirmDialog
        open={confirmation === 'repair'}
        title="Repair the Codex setup?"
        message={
          <>
            Gezel will write a working <code>{status?.profileName}</code> profile for{' '}
            <strong>{selectedOption?.label ?? card.model}</strong>, connected to this copy of Gezel.
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
        onConfirm={card.runConfirmedAction}
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
        onConfirm={card.runConfirmedAction}
        onCancel={() => setConfirmation(null)}
      />
    </HarnessSetupShell>
  );
}

function actionErrorPrefix(confirmation: Confirmation, state: string | undefined): string {
  switch (confirmation) {
    case 'remove':
      return 'Could not remove the Codex setup';
    case 'repair':
      return 'Could not repair the Codex setup';
    default:
      return state === 'not-configured'
        ? 'Could not set up the Codex setup'
        : 'Could not update the Codex setup';
  }
}
