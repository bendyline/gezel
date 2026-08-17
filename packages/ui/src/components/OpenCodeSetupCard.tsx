import type { OpenCodeSetupStatusResponse } from '@bendyline/gezel';
import { useCallback } from 'react';
import { api } from '../api.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { HarnessSetupShell } from './harness-setup/HarnessSetupShell.js';
import { isGezelOption, useHarnessSetupCard } from './harness-setup/useHarnessSetupCard.js';

type Confirmation =
  | 'configure'
  | 'repair'
  | 'remove'
  | 'install-plugin'
  | 'replace-plugin'
  | 'remove-plugin';

export function OpenCodeSetupCard({
  endpointsEnabled,
  onChanged,
}: {
  endpointsEnabled: boolean;
  onChanged?: () => void | Promise<void>;
}) {
  const runAction = useCallback(
    (confirmation: Confirmation, model: string): Promise<OpenCodeSetupStatusResponse> => {
      switch (confirmation) {
        case 'remove':
          return api.removeOpenCodeSetup();
        case 'install-plugin':
          return api.installOpenCodePlugin();
        case 'replace-plugin':
          return api.installOpenCodePlugin({ backupConflictingPlugin: true });
        case 'remove-plugin':
          return api.removeOpenCodePlugin();
        default:
          return api.configureOpenCode({
            model,
            ...(confirmation === 'repair' ? { backupConflictingConfig: true } : {}),
          });
      }
    },
    [],
  );

  const card = useHarnessSetupCard<OpenCodeSetupStatusResponse, Confirmation>({
    label: 'OpenCode',
    endpointsEnabled,
    fetchStatus: () => api.getOpenCodeSetupStatus(),
    runAction,
    errorPrefix: actionErrorPrefix,
    backupNotice: (next) =>
      next.pluginBackupPath
        ? `The previous plugin file was saved as ${next.pluginBackupPath}.`
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
  // Writing into OpenCode's own directory only makes sense once there is a
  // managed config for the plugin to read, an OpenCode to read it, and a
  // service running on this computer.
  const showPluginRow =
    card.configured &&
    card.localDesktopMode &&
    status?.state !== 'conflict' &&
    status?.plugin.state !== 'unsupported';
  const configureLabel = card.repairable
    ? 'Repair OpenCode setup…'
    : status?.state === 'not-configured'
      ? 'Set up OpenCode…'
      : 'Update OpenCode…';

  return (
    <HarnessSetupShell
      headingId="opencode-setup-heading"
      title="Use Gezel in OpenCode"
      status={status}
      remoteMode={card.remoteMode}
      localDesktopMode={card.localDesktopMode}
      endpointsEnabled={endpointsEnabled}
      repairable={Boolean(card.repairable)}
      notice={card.notice}
      error={card.error}
      reasonsIntro="The managed setup needs an update:"
      emptyModelsNote="No gezels or inference models compatible with the OpenCode tool loop are available yet."
      intro={
        <>
          OpenCode keeps its own tools, permissions, and conversation loop while a gezel supplies
          the character, model, and tuning. Gezel writes its own settings file and points OpenCode
          at it with one command. You can also let Gezel add a small plugin of its own to OpenCode,
          so the gezel provider is simply there in every session. Either way, your own OpenCode
          settings, conversations, and permissions are never edited. Your whole eligible crew is
          offered, so you can switch between them from OpenCode's model picker.
        </>
      }
      repairExplainer="Repair writes a fresh settings file for this Gezel and keeps a copy of the existing one next to it."
      {...(status && !status.opencodeInstalled
        ? {
            notInstalledNote:
              'OpenCode was not found on this computer. You can prepare the setup now and use it after installing OpenCode.',
          }
        : {})}
      {...(card.configured && configuredOption && !card.modelChanged
        ? {
            configuredNote: (
              <>
                OpenCode starts with <strong>{configuredOption.label}</strong>.
                {status?.opencodeVersion ? ` OpenCode ${status.opencodeVersion} was found.` : ''}
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
                  {copied ? 'OpenCode launch command copied.' : ''}
                </output>
                <span className="muted small">Keep Gezel running while you use OpenCode.</span>
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
      {...(showPluginRow && status
        ? {
            extraRows: (
              <p className="muted small">
                {status.plugin.state === 'installed' || status.plugin.state === 'stale' ? (
                  <>
                    Gezel is in OpenCode's provider list without the command, through{' '}
                    <code>{status.plugin.path}</code>.
                  </>
                ) : status.plugin.state === 'conflict' ? (
                  status.plugin.message
                ) : (
                  <>
                    Rather not use the command every time? Gezel can add its own plugin file to
                    OpenCode so the crew shows up in every session.
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
          {showPluginRow && status && (status.plugin.canInstall || status.plugin.canReplace) && (
            <button
              type="button"
              disabled={busy || !card.localDesktopMode}
              onClick={() => {
                setError(null);
                setConfirmation(status.plugin.canReplace ? 'replace-plugin' : 'install-plugin');
              }}
            >
              {status.plugin.canReplace ? 'Replace OpenCode plugin…' : 'Add to OpenCode…'}
            </button>
          )}
          {showPluginRow && status?.plugin.canRemove && (
            <button
              type="button"
              disabled={busy || !card.localDesktopMode}
              onClick={() => {
                setError(null);
                setConfirmation('remove-plugin');
              }}
            >
              Remove from OpenCode…
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
          status?.state === 'not-configured'
            ? 'Set up OpenCode with Gezel?'
            : 'Update OpenCode setup?'
        }
        message={
          <>
            Gezel will {status?.state === 'not-configured' ? 'create' : 'update'} its own OpenCode
            settings file for <strong>{selectedOption?.label ?? card.model}</strong>.{' '}
            {selectedOption && isGezelOption(selectedOption) ? (
              <>
                This gezel&apos;s character, {selectedOption.modelLabel ?? 'model'}, and tuning will
                guide OpenCode.{' '}
              </>
            ) : (
              <>OpenCode will use it as a raw inference model without a gezel persona. </>
            )}
            The file holds the local connection and app-scoped credential
            {status?.configPath ? (
              <>
                {' '}
                at <code>{status.configPath}</code>
              </>
            ) : null}
            . Your own OpenCode configuration, sessions, and permissions stay untouched.
          </>
        }
        confirmLabel={status?.state === 'not-configured' ? 'Set up OpenCode' : 'Update OpenCode'}
        onConfirm={card.runConfirmedAction}
        onCancel={() => setConfirmation(null)}
      />

      <ConfirmDialog
        open={confirmation === 'repair'}
        title="Repair the OpenCode setup?"
        message={
          <>
            Gezel will write a working settings file for{' '}
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
            Your own OpenCode configuration stays untouched.
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
            ? 'Clear Gezel setup for OpenCode?'
            : 'Remove Gezel setup from OpenCode?'
        }
        message={
          <>
            This removes only Gezel's own OpenCode settings file, state, and credential
            {status?.plugin.canRemove ? (
              <>
                , along with the plugin file Gezel added at <code>{status.plugin.path}</code>
              </>
            ) : null}
            . It does not uninstall OpenCode or touch your own configuration and sessions.
          </>
        }
        confirmLabel={status?.state === 'conflict' ? 'Clear Gezel setup' : 'Remove setup'}
        danger
        onConfirm={card.runConfirmedAction}
        onCancel={() => setConfirmation(null)}
      />

      <ConfirmDialog
        open={confirmation === 'install-plugin' || confirmation === 'replace-plugin'}
        title={
          confirmation === 'replace-plugin'
            ? 'Replace the plugin file in OpenCode?'
            : 'Add Gezel to OpenCode?'
        }
        message={
          <>
            Gezel will add one file of its own
            {status?.plugin.path ? (
              <>
                {' '}
                at <code>{status.plugin.path}</code>
              </>
            ) : null}
            , so every OpenCode session on this computer offers the <strong>gezel</strong> provider
            without the command above. It holds no password — it reads Gezel's own settings when
            OpenCode starts, and does nothing at all when Gezel is not running. It does not change
            which model OpenCode starts with; pick a gezel from OpenCode's own model picker. Your
            own OpenCode configuration, sessions, and permissions stay untouched, and{' '}
            <code>opencode --pure</code> always starts without it.
            {confirmation === 'replace-plugin' ? (
              <> The file it replaces is kept as a .backup copy beside it, so nothing is lost.</>
            ) : null}
          </>
        }
        confirmLabel={confirmation === 'replace-plugin' ? 'Replace plugin' : 'Add to OpenCode'}
        onConfirm={card.runConfirmedAction}
        onCancel={() => setConfirmation(null)}
      />

      <ConfirmDialog
        open={confirmation === 'remove-plugin'}
        title="Remove Gezel from OpenCode?"
        message={
          <>
            This deletes the plugin file Gezel added
            {status?.plugin.path ? (
              <>
                {' '}
                at <code>{status.plugin.path}</code>
              </>
            ) : null}
            . OpenCode stops offering the gezel provider unless you start it with the command on
            this card. The rest of the setup, and everything of your own, stays as it is.
          </>
        }
        confirmLabel="Remove from OpenCode"
        onConfirm={card.runConfirmedAction}
        onCancel={() => setConfirmation(null)}
      />
    </HarnessSetupShell>
  );
}

function actionErrorPrefix(confirmation: Confirmation, state: string | undefined): string {
  switch (confirmation) {
    case 'remove':
      return 'Could not remove the OpenCode setup';
    case 'repair':
      return 'Could not repair the OpenCode setup';
    case 'install-plugin':
    case 'replace-plugin':
      return 'Could not add Gezel to OpenCode';
    case 'remove-plugin':
      return 'Could not remove Gezel from OpenCode';
    default:
      return state === 'not-configured'
        ? 'Could not set up the OpenCode setup'
        : 'Could not update the OpenCode setup';
  }
}
