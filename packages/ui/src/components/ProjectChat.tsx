import type { GezelSummary, ProjectDetail } from '@bendyline/gezel';
import { displayName, pronounFormsForGender } from '@bendyline/gezel';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { ChatComposer } from './ChatComposer.js';
import { ChatReferences } from './ChatReferences.js';
import { FolderTreeSwitcher } from './FolderTreeSwitcher.js';
import { ProjectTimeline } from './ProjectTimeline.js';
import { SessionSwitcher } from './SessionSwitcher.js';
import { TerminalComposer, queueTerminalCommand } from './TerminalComposer.js';
import { pickChatPlaceholder } from './chat-placeholder.js';
import { useRoleBasedNameOnlyMode } from './useRoleBasedNameOnlyMode.js';

/**
 * Per-project chat with the people doing the work. The selected gezel scopes
 * the composer; the timeline shows ALL chats in the project interleaved.
 * Project membership is summarized in Project Settings, while the To-line
 * picker owns recipient changes and multi-gezel fan-out here.
 *
 * `compact` enables narrow-form-factor mode (VS Code chat sidebar, mobile).
 * Suppresses the right-rail commands / references panel — see
 * {@link ChatReferences} for the implementation. The chat surface gets
 * the full pane width.
 */
export function ProjectChat({
  project,
  compact = false,
}: {
  project: ProjectDetail;
  compact?: boolean;
}) {
  const [gezels, setGezels] = useState<GezelSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string>('');

  // Refetch the global gezel list whenever the project — or its
  // lead/roster — changes. `ProjectChat` stays MOUNTED across project
  // switches (only the `project` prop changes), so a mount-only (`[]`)
  // fetch goes stale: a game you just created mints a fresh opponent that
  // never appears here, and `soloLead` can't find the project's real
  // voorman (it falls back to `gezels[0]` — the wrong character in the
  // chip). Keying on the voorman/roster also catches a gezel created for
  // THIS project moments ago.
  // biome-ignore lint/correctness/useExhaustiveDependencies: project identity and roster fields are deliberate refetch triggers.
  useEffect(() => {
    api
      .listGezels()
      .then((r) => setGezels(r.gezels))
      .catch(() => {});
  }, [project.id, project.voormanGezelId, (project.gezelIds ?? []).join(',')]);

  // Reset the composer selection when the project changes. Without this,
  // the gezel selected in a PRIOR project (e.g. a voorman named Owen in
  // "Ikari Warriors") leaks into the next project's chat pane — the board
  // shows checkers while the chat is still addressed to Owen, with his
  // project's placeholder. Clearing lets the default-selection effect
  // below pick THIS project's lead.
  // biome-ignore lint/correctness/useExhaustiveDependencies: project.id is the deliberate reset trigger.
  useEffect(() => {
    setSelectedId('');
  }, [project.id]);

  // Whose conversation was live most recently in this project. The default
  // recipient lands there so every surface agrees on arrival: the timeline's
  // most recent thread, the thread picker, the To line, and the composer
  // placeholder all point at the same gezel. A project with no threads yet
  // falls back to the voorman — the natural first conversation.
  // `undefined` = probe in flight (hold the default), `null` = no threads.
  const [lastActiveGezelId, setLastActiveGezelId] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    setLastActiveGezelId(undefined);
    let cancelled = false;
    api
      .listChatSessions({ projectId: project.id })
      .then((r) => {
        if (cancelled) return;
        const live = r.sessions.filter((s) => !s.archived);
        setLastActiveGezelId(live[0]?.gezelId ?? null);
      })
      .catch(() => {
        if (!cancelled) setLastActiveGezelId(null);
      });
    return () => {
      cancelled = true;
    };
  }, [project.id]);

  // Pick only the initial To-line target here. After that, the To-line picker
  // owns every recipient change. Prefer the most recent live conversation,
  // then the project lead, then the first explicitly assigned gezel, and
  // finally the first available gezel.
  useEffect(() => {
    if (selectedId) return;
    if (lastActiveGezelId === undefined) return;
    const lastActive =
      lastActiveGezelId && gezels.some((g) => g.id === lastActiveGezelId) ? lastActiveGezelId : '';
    const lead = gezels.find((gezel) => gezel.id === project.voormanGezelId)?.id ?? '';
    const assigned =
      (project.gezelIds ?? [])
        .map((id) => gezels.find((gezel) => gezel.id === id)?.id)
        .find(Boolean) ?? '';
    const next = lastActive || lead || assigned || gezels[0]?.id || '';
    if (next) setSelectedId(next);
  }, [selectedId, lastActiveGezelId, gezels, project.voormanGezelId, project.gezelIds]);

  const selected = gezels.find((g) => g.id === selectedId);

  if (gezels.length === 0) {
    return (
      <p className="muted">
        No gezellen available to chat with yet. Create one from the Gezellen tab.
      </p>
    );
  }

  return (
    <div className="project-chat">
      {selectedId && selected && (
        <ProjectChatBody
          project={project}
          selectedGezel={selected}
          recipientGezels={gezels}
          isVoorman={selected.id === project.voormanGezelId}
          onSelectGezel={setSelectedId}
          compact={compact}
        />
      )}
    </div>
  );
}

function ProjectChatBody({
  project,
  selectedGezel,
  recipientGezels,
  isVoorman,
  onSelectGezel,
  compact,
}: {
  project: ProjectDetail;
  selectedGezel: GezelSummary;
  recipientGezels: GezelSummary[];
  isVoorman: boolean;
  onSelectGezel: (gezelId: string) => void;
  compact: boolean;
}) {
  // The composer's session id is owned here. SessionSwitcher reads/writes
  // it for the (selectedGezel, project) pair; the timeline highlights it
  // as the active session; the composer posts into it.
  const [sessionId, setSessionId] = useState<string>('');
  const roleBasedNameOnlyMode = useRoleBasedNameOnlyMode();
  const selectedName = displayName(
    { name: selectedGezel.name, roleBasedName: selectedGezel.roleBasedName },
    roleBasedNameOnlyMode,
  );
  const [sessionRefreshKey, setSessionRefreshKey] = useState(0);
  // Passive CC bundle for the next send. Populated by the @-mention
  // pivot below — when the user pivots from gezel A to gezel B, we
  // capture A's id so the next send carries a one-shot
  // `passiveCcGezelIds: [A]` that drops a transcript ghost on A's
  // session without engaging them. Cleared after the composer fires
  // `onPassiveCcConsumed` so a follow-up message that doesn't pivot
  // doesn't accidentally re-CC.
  const [pendingPassiveCcIds, setPendingPassiveCcIds] = useState<string[]>([]);
  // Compose mode for the per-project chat surface. AI mode = the
  // Squisq-based ChatComposer + SessionSwitcher. Terminal mode = the
  // in-chat terminal composer + folder picker. Output of both
  // modes flows into the same ProjectTimeline, interleaved by `at`.
  // Per the design: this toggle ONLY lives on per-project chat —
  // Meester (HomeView) and per-gezel (GezelChatTab) do not get it.
  const [composeMode, setComposeMode] = useState<'chat' | 'terminal'>('chat');
  const [chatFocusRequestKey, setChatFocusRequestKey] = useState(0);
  const switchToChat = useCallback(() => {
    setChatFocusRequestKey((key) => key + 1);
    setComposeMode('chat');
  }, []);
  // Two pieces of state for the terminal pane, separated on purpose:
  //
  //   - `terminalThreadDir` — the folder used for routing. Sent on
  //     every command POST; together with projectId it picks the
  //     server-side TerminalThread + its persistent shell. Only
  //     changes when the user EXPLICITLY picks a different folder
  //     via FolderTreeSwitcher.
  //   - `terminalPickerDisplay` — what the picker SHOWS. Tracks the
  //     thread anchor on user clicks, AND tracks the shell's cwd as
  //     it drifts via `cd` (delivered through SSE
  //     `workingDirChanged` events).
  //
  // The split is what keeps the persistent shell useful: if `cd
  // inner` re-anchored routing, the next command would land on a
  // fresh `inner`-keyed thread and spawn a brand-new shell — losing
  // every env var / alias / pushd state the user just built up. With
  // the anchor stable, the shell stays alive and the picker is
  // purely informational. The explicit folder click is the only
  // routing-change action.
  const [terminalThreadDir, setTerminalThreadDir] = useState<string>('');
  const [terminalPickerDisplay, setTerminalPickerDisplay] = useState<string>('');
  const pickTerminalFolder = useCallback((next: string) => {
    setTerminalThreadDir(next);
    setTerminalPickerDisplay(next);
  }, []);
  // Pending terminal prefill, set by ChatComposer's `onTerminalEscape`
  // callback when the user starts a chat draft with `> ` (the
  // markdown blockquote / shell prompt sigil). Captured at the
  // moment TerminalComposer mounts via its `initialInput` prop, then
  // cleared by the effect below whenever the user flips back out of
  // terminal mode — so toggling chat→terminal via the tab later
  // doesn't re-seed a stale value.
  const [terminalInitialInput, setTerminalInitialInput] = useState<string>('');
  useEffect(() => {
    if (composeMode !== 'terminal' && terminalInitialInput !== '') {
      setTerminalInitialInput('');
    }
  }, [composeMode, terminalInitialInput]);

  // Bumping this key remounts the TerminalComposer, which re-reads its
  // initial input from the module-level command queue. Lets the command
  // launcher stage a command even when terminal mode is ALREADY active
  // (the `initialInput` prop is read only at mount, so a prop change
  // wouldn't reach a live composer).
  const [terminalMountKey, setTerminalMountKey] = useState(0);
  // Reconcile the persisted terminal row after each acknowledged POST.
  // Live SSE normally paints it first; this key closes the narrow gap where
  // a stream frame is lost while the command itself was safely stored.
  const [terminalRefreshKey, setTerminalRefreshKey] = useState(0);
  const [terminalSubmission, setTerminalSubmission] = useState<{
    runId: string;
    threadId: string;
    input: string;
  } | null>(null);

  // Stage a command into the terminal for the user to review + run.
  // Called by the CommandsPanel craftbook launcher (threaded through
  // ChatReferences). Switches to terminal mode if needed, then remounts
  // the composer so the queued command becomes its input. Does NOT
  // auto-submit — the user presses Enter to run it.
  const stageTerminalCommand = useCallback(
    (command: string) => {
      queueTerminalCommand(project.id, command);
      setComposeMode('terminal');
      setTerminalMountKey((k) => k + 1);
    },
    [project.id],
  );

  // A session the timeline asked us to focus while ALSO switching gezel
  // (clicking a session divider, or the sidebar's failed-turn indicator
  // landing on another gezel's chat). The reset effect below fires right
  // after the parent swaps the chip and would otherwise wipe the session
  // we were just asked to open, quietly starting a fresh conversation
  // instead of resuming the one the user navigated to.
  const focusedSessionRef = useRef<string | null>(null);

  // Reset session selection when the user switches gezel OR project. The
  // session id is scoped to a (gezel, project) pair; keeping it stable
  // across a project switch would send the next message to whichever
  // project the user just left — the bug that made "sends aren't showing
  // up in this chat" look like a timeline issue.
  // biome-ignore lint/correctness/useExhaustiveDependencies: (selectedGezel.id, project.id) is the reset trigger.
  useEffect(() => {
    const focused = focusedSessionRef.current;
    focusedSessionRef.current = null;
    setSessionId(focused ?? '');
  }, [selectedGezel.id, project.id]);

  // Pick a role-aware empty-composer prompt once per (gezel, project)
  // pairing. `isVoorman` is passed from the outer roster derivation —
  // voormen get project-scoped hints, everyone else gets a generic
  // worker nudge.
  const placeholder = useMemo(
    () =>
      pickChatPlaceholder({
        role: isVoorman ? 'voorman' : 'other',
        gezelName: selectedGezel.name,
        gezelGender: selectedGezel.gender,
        projectName: project.name,
        fixedFunctionTool: selectedGezel.fixedFunction?.tool,
      }),
    [
      isVoorman,
      selectedGezel.name,
      selectedGezel.gender,
      project.name,
      selectedGezel.fixedFunction?.tool,
    ],
  );

  const selectedGezelPronouns = pronounFormsForGender(selectedGezel.gender);

  return (
    <ChatReferences
      projectId={project.id}
      // Compact mode (narrow VS Code chat panel, mobile, …) suppresses
      // the right-rail commands listing AND the reference-preview UI
      // — there isn't horizontal room for either. Skipping
      // `commandsProjectId` here is the belt to ChatReferences'
      // `compact` braces: belt suppresses the fetch loop; braces hide
      // the rail layout.
      {...(compact ? {} : { commandsProjectId: project.id })}
      compact={compact}
      chatKey={`${project.id}:timeline`}
      onStageTerminalCommand={stageTerminalCommand}
    >
      {({ onToolActivity, onArtifactReference, onWorkspaceReference, onTaskReference }) => (
        <>
          <ProjectTimeline
            projectId={project.id}
            activeSessionId={sessionId || undefined}
            onFocusSession={(sid, gid) => {
              if (gid !== selectedGezel.id) {
                focusedSessionRef.current = sid;
                onSelectGezel(gid);
              }
              setSessionId(sid);
            }}
            onToolActivity={onToolActivity}
            onArtifactReference={onArtifactReference}
            onWorkspaceReference={onWorkspaceReference}
            onTaskReference={onTaskReference}
            onTerminalWorkingDirChanged={(_threadId, next) => {
              // Display-only: keep the routing anchor stable so the
              // persistent shell stays alive across `cd` commands.
              // The thread anchor only moves on explicit picker clicks.
              setTerminalPickerDisplay(next);
            }}
            terminalRefreshKey={terminalRefreshKey}
            {...(terminalSubmission ? { terminalSubmission } : {})}
            emptyPlaceholder={
              isVoorman
                ? `Talk to ${selectedGezel.name} about running "${project.name}" — planning tasks, delegating, or checking progress.`
                : `Chat with ${selectedGezel.name} about what ${selectedGezelPronouns.subject} ${selectedGezelPronouns.presentBe} working on in "${project.name}".`
            }
          />
          <div className="project-chat-compose-shell">
            <div
              className={`project-chat-compose-main${
                composeMode === 'terminal' ? ' project-chat-compose-main-terminal' : ''
              }`}
            >
              {composeMode === 'chat' ? (
                <ChatComposer
                  gezelId={selectedGezel.id}
                  gezelName={selectedGezel.name}
                  gezelIcon={selectedGezel.icon ?? null}
                  gezelPoppetje={selectedGezel.poppetje}
                  gezelIconOverride={selectedGezel.iconOverride}
                  recipientGezels={recipientGezels}
                  onPrimaryRecipientChange={onSelectGezel}
                  focusRequestKey={chatFocusRequestKey}
                  projectId={project.id}
                  sessionId={sessionId || undefined}
                  onSessionCreated={(sid) => {
                    setSessionId(sid);
                    setSessionRefreshKey((k) => k + 1);
                  }}
                  onToolActivity={onToolActivity}
                  placeholder={placeholder}
                  onPivotToMention={(mentionedGezelId) => {
                    // Project-chat pivot: when the user @-mentions another
                    // gezel from inside the active chat, switch the focus
                    // chip to that gezel and let the SessionSwitcher reload
                    // their sessions. This makes "@Ada can you finish X?"
                    // feel like a conversation pivot instead of a fan-out
                    // message routed elsewhere — the user can immediately
                    // see Ada's session list and start fresh if Ada's
                    // current session is poisoned. The session-id reset
                    // already runs via the existing `selectedGezel.id`
                    // useEffect above, so a tab-mention pivots into a
                    // clean SessionSwitcher.
                    if (mentionedGezelId === selectedGezel.id) return;
                    // Capture the gezel we're pivoting AWAY from as the
                    // passive CC for the next send. Typically the voorman:
                    // they stay aware of the project chat without being
                    // engaged ("the voorman is mostly kept out of the
                    // loop"). Keep distinct entries deduped so a multi-
                    // pivot draft doesn't accumulate phantom CCs.
                    setPendingPassiveCcIds((prev) =>
                      prev.includes(selectedGezel.id) ? prev : [...prev, selectedGezel.id],
                    );
                    onSelectGezel(mentionedGezelId);
                  }}
                  passiveCcGezelIds={pendingPassiveCcIds}
                  onPassiveCcConsumed={() => setPendingPassiveCcIds([])}
                  onTerminalEscape={(seed) => {
                    setTerminalInitialInput(seed);
                    setComposeMode('terminal');
                  }}
                  belowAddressLine={
                    <SessionSwitcher
                      gezelId={selectedGezel.id}
                      projectId={project.id}
                      sessionId={sessionId || undefined}
                      gezelName={selectedName}
                      onSessionIdChange={(next) => setSessionId(next ?? '')}
                      refreshKey={sessionRefreshKey}
                    />
                  }
                />
              ) : (
                <TerminalComposer
                  key={`terminal:${project.id}:${terminalMountKey}`}
                  projectId={project.id}
                  workingDir={terminalThreadDir}
                  contextRow={
                    <FolderTreeSwitcher
                      projectId={project.id}
                      workingDir={terminalPickerDisplay}
                      onChangeWorkingDir={pickTerminalFolder}
                    />
                  }
                  initialInput={terminalInitialInput}
                  onSent={(input, result) => {
                    setTerminalSubmission({
                      runId: result.runId,
                      threadId: result.threadId,
                      input,
                    });
                    setTerminalRefreshKey((key) => key + 1);
                  }}
                  onChatEscape={switchToChat}
                />
              )}
            </div>
            <div className="project-chat-compose-mode-bar">
              <div className="project-chat-compose-toggle" role="tablist">
                <button
                  type="button"
                  role="tab"
                  aria-selected={composeMode === 'chat'}
                  aria-label="AI chat"
                  className={composeMode === 'chat' ? 'active' : ''}
                  onClick={switchToChat}
                  title="AI chat (@-mention to talk to a gezel)"
                >
                  @
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={composeMode === 'terminal'}
                  aria-label="Terminal"
                  className={composeMode === 'terminal' ? 'active' : ''}
                  onClick={() => setComposeMode('terminal')}
                  title="Terminal (run shell commands in this project's workspace)"
                >
                  &gt;
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </ChatReferences>
  );
}
