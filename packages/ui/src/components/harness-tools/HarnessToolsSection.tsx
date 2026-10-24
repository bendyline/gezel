import {
  HARNESS_AGENT_FILE,
  type HarnessClientId,
  type HarnessToolsClientStatus,
  harnessAgentFileLine,
  harnessPromptInvocation,
} from '@bendyline/gezel';
import { useEffect, useId, useRef, useState } from 'react';
import { api } from '../../api.js';
import { Select } from '../../primitives/index.js';
import { ConfirmDialog } from '../ConfirmDialog.js';
import { harnessDesktopMode, harnessStateLabel } from '../harness-setup/useHarnessSetupCard.js';
import type { HarnessTools } from './useHarnessTools.js';

/** What each app does with Gezel's tools, in its own words. */
const INTROS: Record<HarnessClientId, string> = {
  'claude-code':
    'Claude Code can search the folder you start it in, your shared library, your memories and knowledge through Gezel, read Word, PowerPoint, Excel and PDF files, describe and make images, and check the issues Gezel found overnight. Gezel adds itself to Claude Code for every folder.',
  'claude-desktop':
    'Claude Desktop can search your projects, shared library, memories and knowledge through Gezel, read Office files, describe and make images, and check the issues Gezel found overnight. It has no folder of its own, so it works in the project you pick here.',
  codex:
    'Codex can use Gezel to search the folder you run it in, your shared library, memories and knowledge, read Office files, describe and make images, and check the issues Gezel found overnight.',
  cursor:
    'Cursor can use Gezel to search the folder it has open, your shared library, memories and knowledge, read Office files, describe and make images, and check the issues Gezel found overnight.',
  vscode:
    "VS Code's agent mode can use Gezel to search the folder it has open, your shared library, memories and knowledge, read Office files, describe and make images, and check the issues Gezel found overnight. The Gezel extension for VS Code adds these tools to each workspace by itself, so set them up here only if you don't use it.",
};

/** Apps Gezel sets up through their own command line rather than by editing a file. */
const COMMAND_APPS: ReadonlySet<HarnessClientId> = new Set(['claude-code', 'codex']);
const NO_PROJECT = '__none__';

type Confirmation = 'configure' | 'replace' | 'remove';

export function HarnessToolsSection({
  client,
  tools,
}: {
  client: HarnessClientId;
  tools: HarnessTools;
}) {
  const headingId = useId();
  const projectLabelId = useId();
  const profileLabelId = useId();
  const status = tools.client(client);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [projectId, setProjectId] = useState<string>(NO_PROJECT);
  const [profileId, setProfileId] = useState<string>('');
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([]);
  const [copied, setCopied] = useState<'command' | 'line' | 'triage' | null>(null);
  const copyTimer = useRef<number | null>(null);
  const { localDesktopMode, remoteMode } = harnessDesktopMode();
  const label = status?.label ?? client;
  const busy = tools.busy?.endsWith(`:${client}`) === true;
  const agentLine = harnessAgentFileLine(client);
  const agentFile = HARNESS_AGENT_FILE[client];
  const triageCommand = harnessPromptInvocation(client, 'triage_issues');

  useEffect(() => {
    if (client !== 'claude-desktop') return;
    Promise.resolve()
      .then(() => api.listProjects())
      .then((res) => setProjects(res.projects.map(({ id, name }) => ({ id, name }))))
      .catch(() => {});
  }, [client]);

  useEffect(() => {
    if (status?.projectId) setProjectId(status.projectId);
  }, [status?.projectId]);

  useEffect(() => {
    if (status?.profileId && !profileId) setProfileId(status.profileId);
  }, [status?.profileId, profileId]);

  useEffect(
    () => () => {
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    },
    [],
  );

  const config = tools.status?.config;
  const disabledHere = !localDesktopMode;
  const state = status?.state;
  const chosenProject = projectId === NO_PROJECT ? undefined : projectId;
  const projectChanged =
    client === 'claude-desktop' && state === 'configured' && chosenProject !== status?.projectId;
  const showConfigure =
    status?.canConfigure &&
    (state === 'not-configured' ||
      state === 'update-needed' ||
      state === 'conflict' ||
      projectChanged);
  const configureLabel =
    state === 'update-needed'
      ? "Repair Gezel's tools…"
      : state === 'conflict'
        ? 'Replace it…'
        : projectChanged
          ? 'Change project…'
          : "Set up Gezel's tools…";

  const copyText = async (text: string, kind: 'command' | 'line' | 'triage') => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(kind);
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopied(null), 2_000);
    } catch {
      // The text stays selectable on screen.
    }
  };

  const confirm = async () => {
    const action = confirmation;
    setConfirmation(null);
    if (action === 'remove') {
      await tools.remove(client);
      return;
    }
    await tools.configure(client, {
      ...(chosenProject && client === 'claude-desktop' ? { projectId: chosenProject } : {}),
      ...(profileId && client === 'vscode' ? { profileId } : {}),
      ...(action === 'replace' ? { replaceExisting: true } : {}),
    });
  };

  return (
    <section
      className="settings-subsection provider-card harness-setup-card"
      aria-labelledby={headingId}
    >
      <div className="settings-card-header">
        <h3 id={headingId}>Gezel's tools in {label}</h3>
        <span
          className={`harness-setup-state harness-setup-state--${state ?? 'checking'}`}
          aria-live="polite"
        >
          {state ? harnessStateLabel(state) : 'Checking…'}
        </span>
      </div>

      <p className="muted small harness-setup-intro">{INTROS[client]}</p>

      {!status && !tools.error && <p className="muted small">Checking the setup…</p>}

      {status && (
        <>
          {config && !config.enabled && (
            <p className="harness-setup-caution small">
              Gezel's tools are turned off for other apps on the Overview tab, so {label} cannot use
              them until you turn them back on.
            </p>
          )}
          {tools.status?.unavailableReason && (
            <p className="harness-setup-caution small">{tools.status.unavailableReason}</p>
          )}
          {remoteMode && (
            <p className="harness-setup-caution small">
              One-click setup is unavailable while this app is connected to a remote Gezel service.
              Set it up on the computer where you use {label}.
            </p>
          )}
          {!remoteMode && disabledHere && (
            <p className="harness-setup-caution small">
              One-click setup is available in the Gezel desktop app when it is connected to your
              user service on this computer.
            </p>
          )}

          {status.reasons.length > 0 && (
            <ul
              className={
                state === 'conflict' || state === 'unavailable'
                  ? 'harness-setup-caution small'
                  : 'muted small'
              }
            >
              {status.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          )}

          {state === 'configured' && (
            <p className="muted small">
              {config?.newFolders === 'existing'
                ? `${label} searches folders that are already in Gezel. In any other folder it reaches your library, memories and knowledge.`
                : `A folder ${label} opens that is not in Gezel yet becomes a read-only project the first time ${label} uses Gezel's tools there. Gezel never writes into it.`}
            </p>
          )}

          {status.configPath && (
            <p className="muted small">
              Settings file: <code>{status.configPath}</code>
            </p>
          )}

          {client === 'claude-desktop' && state !== 'unavailable' && (
            <div className="harness-setup-model-row">
              <span id={projectLabelId}>Project</span>
              <Select.Root
                value={projectId}
                onValueChange={setProjectId}
                disabled={busy || disabledHere}
              >
                <Select.Trigger aria-labelledby={projectLabelId}>
                  <Select.Value />
                </Select.Trigger>
                <Select.Content>
                  <Select.Item value={NO_PROJECT}>
                    No project — library, memories and knowledge
                  </Select.Item>
                  {projects.map((p) => (
                    <Select.Item key={p.id} value={p.id}>
                      {p.name}
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select.Root>
            </div>
          )}

          {client === 'vscode' && (status.profiles?.length ?? 0) > 1 && (
            <div className="harness-setup-model-row">
              <span id={profileLabelId}>VS Code profile</span>
              <Select.Root
                value={profileId || status.profileId || ''}
                onValueChange={setProfileId}
                disabled={busy || disabledHere}
              >
                <Select.Trigger aria-labelledby={profileLabelId}>
                  <Select.Value />
                </Select.Trigger>
                <Select.Content>
                  {status.profiles?.map((p) => (
                    <Select.Item key={p.id} value={p.id}>
                      {p.label}
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select.Root>
            </div>
          )}

          {status.manualCommand && state !== 'configured' && (
            <div className="harness-setup-command-row">
              <span className="muted small">
                {state === 'unavailable' ? 'To set it up yourself, run' : 'Or run it yourself'}
              </span>
              <code>{status.manualCommand}</code>
              <button
                type="button"
                onClick={() =>
                  status.manualCommand && void copyText(status.manualCommand, 'command')
                }
              >
                {copied === 'command' ? 'Copied' : 'Copy command'}
              </button>
              <output className="sr-only" aria-live="polite">
                {copied === 'command' ? 'Command copied.' : ''}
              </output>
            </div>
          )}

          {client === 'claude-desktop' && state === 'configured' && (
            <p className="muted small">
              Restart Claude Desktop after a change so it starts Gezel's tools.
            </p>
          )}

          {agentLine && agentFile && state === 'configured' && (
            <div className="harness-setup-command-row">
              <span className="muted small">
                {label} reaches for its own search first. So it uses Gezel's, add this line near the
                top of the <code>{agentFile}</code> file in a folder you work in. At the end of a
                long file it gets overlooked.
              </span>
              <code>{agentLine}</code>
              <button type="button" onClick={() => void copyText(agentLine, 'line')}>
                {copied === 'line' ? 'Copied' : 'Copy line'}
              </button>
              <output className="sr-only" aria-live="polite">
                {copied === 'line' ? 'Line copied.' : ''}
              </output>
            </div>
          )}

          {triageCommand && state === 'configured' && config?.issues !== 'off' && (
            <div className="harness-setup-command-row">
              <span className="muted small">
                To have {label} check the suspected problems the night shift found, run this in a
                folder Gezel knows (add a number for how many, or use{' '}
                <code>{harnessPromptInvocation(client, 'fix_issues')}</code> to fix the real ones
                too):
              </span>
              <code>{triageCommand}</code>
              <button type="button" onClick={() => void copyText(triageCommand, 'triage')}>
                {copied === 'triage' ? 'Copied' : 'Copy command'}
              </button>
              <output className="sr-only" aria-live="polite">
                {copied === 'triage' ? 'Command copied.' : ''}
              </output>
            </div>
          )}

          <div className="harness-setup-actions">
            {showConfigure && (
              <button
                type="button"
                className="primary"
                disabled={busy || disabledHere}
                onClick={() => setConfirmation(state === 'conflict' ? 'replace' : 'configure')}
              >
                {busy && tools.busy?.startsWith('configure:') ? 'Setting up…' : configureLabel}
              </button>
            )}
            {status.canRemove && (
              <button
                type="button"
                disabled={busy || disabledHere}
                onClick={() => setConfirmation('remove')}
              >
                {busy && tools.busy?.startsWith('remove:') ? 'Removing…' : "Remove Gezel's tools…"}
              </button>
            )}
          </div>
        </>
      )}

      <ConfirmDialog
        open={confirmation !== null}
        title={
          confirmation === 'remove'
            ? `Remove Gezel's tools from ${label}?`
            : confirmation === 'replace'
              ? `Replace the gezel server in ${label}?`
              : `Set up Gezel's tools in ${label}?`
        }
        message={status ? confirmMessage(status, confirmation) : null}
        confirmLabel={
          confirmation === 'remove' ? 'Remove' : confirmation === 'replace' ? 'Replace' : 'Set up'
        }
        {...(confirmation === 'remove' || confirmation === 'replace' ? { danger: true } : {})}
        onConfirm={() => void confirm()}
        onCancel={() => setConfirmation(null)}
      />
    </section>
  );
}

function confirmMessage(status: HarnessToolsClientStatus, confirmation: Confirmation | null) {
  const viaCommand = COMMAND_APPS.has(status.client);
  const file = status.configPath ? <code>{status.configPath}</code> : 'its settings';
  if (confirmation === 'remove') {
    return viaCommand ? (
      <>
        Gezel asks {status.label} to remove its gezel server. Nothing else in {status.label}{' '}
        changes.
      </>
    ) : (
      <>Gezel removes its gezel entry from {file}. The rest of the file stays as it is.</>
    );
  }
  if (confirmation === 'replace') {
    return viaCommand ? (
      <>
        {status.label} already has a server called gezel that Gezel did not set up. Gezel replaces
        it with its own.
      </>
    ) : (
      <>
        {file} already has a server called gezel that Gezel did not set up. Gezel keeps a copy of
        the file next to it, ending in <code>.backup</code>, and replaces the entry.
      </>
    );
  }
  return viaCommand ? (
    <>
      Gezel asks {status.label} to add a server called gezel, so {status.label} starts Gezel's
      tools. Nothing else in {status.label} changes.
    </>
  ) : (
    <>Gezel adds a gezel entry to {file}. The rest of the file stays as it is.</>
  );
}
