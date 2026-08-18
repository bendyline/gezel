import type { VSCodeSetupStatusResponse } from '@bendyline/gezel';
import { useCallback, useEffect, useId, useState } from 'react';
import { api } from '../api.js';
import { Select } from '../primitives/index.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { HarnessSetupShell } from './harness-setup/HarnessSetupShell.js';
import { useHarnessSetupCard } from './harness-setup/useHarnessSetupCard.js';

type Confirmation = 'configure' | 'repair' | 'remove';

export function VSCodeSetupCard({
  endpointsEnabled,
  onChanged,
}: {
  endpointsEnabled: boolean;
  onChanged?: () => void | Promise<void>;
}) {
  const [profileId, setProfileId] = useState('');
  const profileLabelId = useId();
  const runAction = useCallback(
    (confirmation: Confirmation): Promise<VSCodeSetupStatusResponse> =>
      confirmation === 'remove'
        ? api.removeVSCodeSetup()
        : api.configureVSCode({
            profileId,
            ...(confirmation === 'repair' ? { backupConflictingConfig: true } : {}),
          }),
    [profileId],
  );
  const card = useHarnessSetupCard<VSCodeSetupStatusResponse, Confirmation>({
    label: 'VS Code',
    endpointsEnabled,
    fetchStatus: () => api.getVSCodeSetupStatus(),
    runAction,
    modelSelection: false,
    errorPrefix: actionErrorPrefix,
    backupNotice: (next) =>
      next.configBackupPath ? `The previous file was saved as ${next.configBackupPath}.` : null,
    ...(onChanged ? { onChanged } : {}),
  });

  const { status, confirmation, setConfirmation, setError, busy } = card;
  useEffect(() => {
    if (!status) return;
    setProfileId((current) =>
      status.profiles.some((profile) => profile.id === current)
        ? current
        : (status.configuredProfileId ?? status.profiles[0]?.id ?? ''),
    );
  }, [status]);
  const selectedProfile = status?.profiles.find((profile) => profile.id === profileId);
  const hasManagedProfile = Boolean(status?.configuredProfileId);
  const configureLabel = card.repairable
    ? 'Repair VS Code setup…'
    : status?.state === 'not-configured'
      ? 'Set up VS Code…'
      : 'Update VS Code…';

  return (
    <HarnessSetupShell
      headingId="vscode-setup-heading"
      title="Use Gezel in VS Code"
      status={status}
      remoteMode={card.remoteMode}
      localDesktopMode={card.localDesktopMode}
      endpointsEnabled={endpointsEnabled}
      repairable={Boolean(card.repairable)}
      notice={card.notice}
      error={card.error}
      reasonsIntro="The managed setup needs an update:"
      emptyModelsNote="No gezels or inference models compatible with VS Code's agent tool loop are available yet."
      intro={
        <>
          VS Code keeps its native agent tools, permissions, and conversation loop. Gezel adds your
          eligible crew and raw local models through VS Code&apos;s built-in custom endpoint — no
          extension is installed. Setup edits only the Gezel provider in the selected profile.
        </>
      }
      repairExplainer={
        <>
          Repair keeps a copy of <code>{status?.configPath}</code>, then replaces only the
          conflicting Gezel provider entry. Other providers stay in place.
        </>
      }
      {...(status && !status.vscodeInstalled
        ? {
            notInstalledNote:
              'VS Code was not found on PATH. You can prepare its conventional profile now and use it after installing VS Code.',
          }
        : {})}
      {...(card.configured && selectedProfile
        ? {
            configuredNote: (
              <>
                Gezel is available in <strong>{selectedProfile.label}</strong>.
                {status?.vscodeVersion ? ` VS Code ${status.vscodeVersion} was found.` : ''} Keep
                Gezel running while you use the models.
              </>
            ),
          }
        : {})}
      extraRows={
        status && (status.state !== 'conflict' || card.repairable) ? (
          <>
            <div className="harness-setup-model-row">
              <span id={profileLabelId}>VS Code profile</span>
              <Select.Root
                value={profileId}
                onValueChange={setProfileId}
                disabled={busy || !card.localDesktopMode || !endpointsEnabled || hasManagedProfile}
              >
                <Select.Trigger aria-labelledby={profileLabelId}>
                  <Select.Value />
                </Select.Trigger>
                <Select.Content>
                  {status.profiles.map((profile) => (
                    <Select.Item key={profile.id} value={profile.id}>
                      {profile.label}
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select.Root>
            </div>
            {hasManagedProfile && (
              <p className="muted small">Clear this setup before choosing a different profile.</p>
            )}
          </>
        ) : null
      }
      actions={
        <>
          {card.needsConfigure && (
            <button
              type="button"
              className="primary"
              disabled={card.configureDisabled || !profileId}
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
          status?.state === 'not-configured'
            ? 'Set up VS Code with Gezel?'
            : 'Update VS Code setup?'
        }
        message={
          <>
            Gezel will add or update one provider in <code>{selectedProfile?.configPath}</code>. VS
            Code will show every eligible gezel and raw local model in its native model picker and
            keep control of agent tools and permissions. Other custom endpoint providers are
            preserved.
            <br />
            <br />
            Because no extension is involved, the dedicated inference-only credential is stored as
            plain text in this profile file. It works only through Gezel&apos;s loopback inference
            bridge and can be revoked by clearing this setup.
          </>
        }
        confirmLabel={status?.state === 'not-configured' ? 'Set up VS Code' : 'Update VS Code'}
        onConfirm={card.runConfirmedAction}
        onCancel={() => setConfirmation(null)}
      />

      <ConfirmDialog
        open={confirmation === 'repair'}
        title="Repair the VS Code setup?"
        message={
          <>
            Gezel will save the current <code>{status?.configPath}</code> beside it as a backup,
            then publish a working Gezel provider for this installation. Providers that are not
            named Gezel remain untouched. The replacement contains a new plain-text, inference-only
            loopback credential.
          </>
        }
        confirmLabel="Repair setup"
        onConfirm={card.runConfirmedAction}
        onCancel={() => setConfirmation(null)}
      />

      <ConfirmDialog
        open={confirmation === 'remove'}
        title="Remove Gezel setup from VS Code?"
        message={
          <>
            This removes only the Gezel provider entry, setup state, and dedicated credential. It
            does not uninstall VS Code, touch other endpoint providers, or delete conversations. A
            Gezel entry changed outside this setup is preserved, but its credential is revoked.
          </>
        }
        confirmLabel="Remove setup"
        danger
        onConfirm={card.runConfirmedAction}
        onCancel={() => setConfirmation(null)}
      />
    </HarnessSetupShell>
  );
}

function actionErrorPrefix(confirmation: Confirmation, state: string | undefined): string {
  if (confirmation === 'remove') return 'Could not remove the VS Code setup';
  if (confirmation === 'repair') return 'Could not repair the VS Code setup';
  return state === 'not-configured'
    ? 'Could not set up the VS Code setup'
    : 'Could not update the VS Code setup';
}
