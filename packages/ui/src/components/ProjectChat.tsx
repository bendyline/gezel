import type { GezelSummary, ProjectDetail, Task } from '@bendyline/gezel';
import { displayName, isCodingProject, pronounFormsForGender } from '@bendyline/gezel';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { NewTaskDialog } from '../views/tasks/NewTaskDialog.js';
import { ChatComposer } from './ChatComposer.js';
import { ChatPillRow } from './ChatPillRow.js';
import { ChatReferences } from './ChatReferences.js';
import { FolderTreeSwitcher } from './FolderTreeSwitcher.js';
import { ProjectChatPlaceholder } from './ProjectChatPlaceholder.js';
import { ProjectTimeline } from './ProjectTimeline.js';
import { SessionSwitcher } from './SessionSwitcher.js';
import { TerminalComposer } from './TerminalComposer.js';
import { pickChatPlaceholder } from './chat-placeholder.js';
import { isFreshThreadAt } from './chat-thread-freshness.js';
import {
  projectRecipientKey,
  projectThreadKey,
  readChatThreadSelection,
  writeChatThreadSelection,
} from './chat-thread-memory.js';
import { useRoleBasedNameOnlyMode } from './useRoleBasedNameOnlyMode.js';
import { useShowAdvancedFeatures } from './useShowAdvancedFeatures.js';

/**
 * Is this thread one the user is still in the middle of? Past the shared
 * freshness window the conversation is not one the user is still having,
 * so the default reverts to the voorman on a blank thread; the older thread
 * stays one click away in the switcher.
 *
 * Freshness is measured from the last HUMAN turn, not `lastActivityAt`: a
 * meester nudge or a gezel's own follow-up bumps the session hours after the
 * user stopped reading it, and a thread nobody ever spoke in (a machine-
 * started reaction thread) is not a conversation to resume at all.
 */
function isResumableThread(thread: LastThread | null | undefined, now: number): boolean {
  return isFreshThreadAt(thread?.lastHumanActivityAt, now);
}

interface LastThread {
  gezelId: string;
  lastHumanActivityAt?: string;
}

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
  // Has the roster ever come back? Distinguishes "this project has nobody"
  // from "we haven't asked yet" — without it the empty state renders on the
  // first frame of every project switch. Monotonic on purpose: the refetch
  // below also fires on roster/voorman changes, and blanking the pane for
  // those would trade one flash for another.
  const [gezelsLoaded, setGezelsLoaded] = useState(false);
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
      .then((r) => {
        setGezels(r.gezels);
        setGezelsLoaded(true);
      })
      .catch(() => setGezelsLoaded(true));
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
    setStartFreshFor(null);
  }, [project.id]);

  // Whose conversation was live most recently in this project. A FRESH one
  // takes the default recipient so every surface agrees on arrival: the
  // timeline's most recent thread, the thread picker, the To line, and the
  // composer placeholder all point at the same gezel. A stale one — or no
  // threads at all — falls back to the voorman, the natural first
  // conversation.
  // `undefined` = probe in flight (hold the default), `null` = no threads.
  const [lastThread, setLastThread] = useState<LastThread | null | undefined>(undefined);
  useEffect(() => {
    setLastThread(undefined);
    let cancelled = false;
    api
      .listChatSessions({ projectId: project.id })
      .then((r) => {
        if (cancelled) return;
        // Task/craftbook runs have their own task surfaces. They must not
        // steer the ordinary project composer toward whichever gezel most
        // recently worked a night-shift step.
        const live = r.sessions.filter((s) => !s.archived && !s.taskRef);
        const newest = live[0];
        setLastThread(
          newest
            ? {
                gezelId: newest.gezelId,
                ...(newest.lastHumanActivityAt
                  ? { lastHumanActivityAt: newest.lastHumanActivityAt }
                  : {}),
              }
            : null,
        );
      })
      .catch(() => {
        if (!cancelled) setLastThread(null);
      });
    return () => {
      cancelled = true;
    };
  }, [project.id]);

  // The gezel whose initial thread selection must stay blank, because
  // nothing fresh was there to resume. Cleared the moment the user picks a
  // recipient themselves — an explicit choice gets the ordinary
  // newest-thread behavior.
  const [startFreshFor, setStartFreshFor] = useState<string | null>(null);
  const selectGezel = useCallback((gezelId: string) => {
    setStartFreshFor(null);
    setSelectedId(gezelId);
  }, []);

  // Pick only the initial To-line target here. After that, the To-line picker
  // owns every recipient change. Prefer a conversation the user is still in
  // the middle of, then the project lead, then the first explicitly assigned
  // gezel, and finally the first available gezel.
  useEffect(() => {
    if (selectedId) return;
    // A recipient this session already addressed in this project outranks the
    // ranking below — the user picked them, and coming back from another area
    // is not a retraction of that pick.
    const remembered = readChatThreadSelection(projectRecipientKey(project.id))?.gezelId;
    if (remembered && gezels.some((gezel) => gezel.id === remembered)) {
      setSelectedId(remembered);
      setStartFreshFor(null);
      return;
    }
    if (lastThread === undefined) return;
    const resumable =
      isResumableThread(lastThread, Date.now()) &&
      lastThread &&
      gezels.some((g) => g.id === lastThread.gezelId)
        ? lastThread.gezelId
        : '';
    const lead = gezels.find((gezel) => gezel.id === project.voormanGezelId)?.id ?? '';
    const assigned =
      (project.gezelIds ?? [])
        .map((id) => gezels.find((gezel) => gezel.id === id)?.id)
        .find(Boolean) ?? '';
    const next = resumable || lead || assigned || gezels[0]?.id || '';
    if (!next) return;
    setSelectedId(next);
    // Nothing fresh to resume: open on a blank thread instead of reviving
    // whatever this gezel last talked about days ago. Their older threads
    // stay in the switcher.
    setStartFreshFor(resumable ? null : next);
  }, [selectedId, lastThread, gezels, project.id, project.voormanGezelId, project.gezelIds]);

  useEffect(() => {
    if (!selectedId) return;
    writeChatThreadSelection(projectRecipientKey(project.id), { gezelId: selectedId });
  }, [project.id, selectedId]);

  const selected = gezels.find((g) => g.id === selectedId);

  // Everything before the body can mount — the roster fetch, the last-thread
  // probe that picks the default recipient — is a stand-in, not an answer.
  // The empty state is the one claim we can only make once the roster is in.
  if (!gezelsLoaded || (gezels.length > 0 && !selected)) {
    return <ProjectChatPlaceholder />;
  }

  if (gezels.length === 0) {
    return (
      <p className="muted project-chat-empty">
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
          startFreshThread={selected.id === startFreshFor}
          onSelectGezel={selectGezel}
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
  startFreshThread,
  onSelectGezel,
  compact,
}: {
  project: ProjectDetail;
  selectedGezel: GezelSummary;
  recipientGezels: GezelSummary[];
  isVoorman: boolean;
  /** Open on a blank thread: the parent found nothing fresh to resume. */
  startFreshThread: boolean;
  onSelectGezel: (gezelId: string) => void;
  compact: boolean;
}) {
  // The composer's session id is owned here. SessionSwitcher reads/writes
  // it for the (selectedGezel, project) pair; the timeline highlights it
  // as the active session; the composer posts into it.
  const [sessionId, setSessionId] = useState<string>('');
  // The prompt draft the composer has open. Tracked here because both the
  // composer and the thread picker act on it, and a draft with no thread
  // yet has nothing else to hang off.
  const [draftId, setDraftId] = useState<string>('');
  // The task the pill row (or the rail) last focused. It scopes BOTH the
  // SessionSwitcher's thread list and the composer's next send: without it
  // the switcher lists only non-task threads, decides the focused task
  // thread is out of scope, and auto-picks the gezel's lobby thread over
  // it — silently posting the user's next message to the wrong place.
  const [activeTask, setActiveTask] = useState<{ ref: string; stepId?: string } | null>(null);
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  // Bumped after a write the pill row should re-read (a created task).
  const [pillRefreshKey, setPillRefreshKey] = useState(0);
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
  // The terminal is a developer surface: the switch (and every other way
  // into terminal mode — the `> ` draft escape, terminal pills) only exists
  // on coding-typed projects, and only when "Show advanced features" is on.
  // Everyone else just gets the chat composer, no mode concept at all.
  const showAdvancedFeatures = useShowAdvancedFeatures();
  const showComposeModeTabs = showAdvancedFeatures && isCodingProject(project);
  // If the gate closes while terminal mode is up (settings toggle flipped
  // live, or a project's detected type changed), land back on chat rather
  // than stranding the user on a surface with no switch to leave it.
  useEffect(() => {
    if (!showComposeModeTabs && composeMode === 'terminal') switchToChat();
  }, [showComposeModeTabs, composeMode, switchToChat]);
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
  const [activeTerminalThreadId, setActiveTerminalThreadId] = useState<string>('');
  const pickTerminalFolder = useCallback((next: string) => {
    setActiveTerminalThreadId('');
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

  // Reconcile the persisted terminal row after each acknowledged POST.
  // Live SSE normally paints it first; this key closes the narrow gap where
  // a stream frame is lost while the command itself was safely stored.
  const [terminalRefreshKey, setTerminalRefreshKey] = useState(0);
  const [terminalFocusRequest, setTerminalFocusRequest] = useState<{
    threadId: string;
    requestKey: number;
  } | null>(null);
  const [terminalSubmission, setTerminalSubmission] = useState<{
    runId: string;
    threadId: string;
    input: string;
  } | null>(null);

  // A session the timeline asked us to focus while ALSO switching gezel
  // (clicking a session divider, or the sidebar's failed-turn indicator
  // landing on another gezel's chat). The reset effect below fires right
  // after the parent swaps the chip and would otherwise wipe the session
  // we were just asked to open, quietly starting a fresh conversation
  // instead of resuming the one the user navigated to.
  const focusedSessionRef = useRef<string | null>(null);
  // Companion to `focusedSessionRef` for the task scope: a task pill whose
  // thread belongs to another gezel must carry its ref through the same
  // reset, or the switcher loses the scope one tick after gaining it.
  const focusedTaskRef = useRef<{ ref: string; stepId?: string } | null>(null);

  /**
   * Point the composer at `sessionId`, switching gezel first when the
   * thread belongs to someone else. `task` rides along so a task-scoped
   * thread keeps its scope across the gezel-switch reset.
   */
  const focusThread = useCallback(
    (nextSessionId: string, gezelId: string, task: { ref: string; stepId?: string } | null) => {
      if (gezelId !== selectedGezel.id) {
        focusedSessionRef.current = nextSessionId || null;
        focusedTaskRef.current = task;
        onSelectGezel(gezelId);
      } else {
        setActiveTask(task);
      }
      setSessionId(nextSessionId);
    },
    [selectedGezel.id, onSelectGezel],
  );

  /**
   * Task-bar chip clicks move the composer AND the viewport. Pointing the
   * composer at a thread does not scroll the timeline on its own — the
   * timeline is project-wide and interleaved, so the clicked thread is
   * usually somewhere above the fold. `requestKey` makes a second click on
   * the same chip (after the user scrolled away again) a fresh request.
   */
  const [sessionFocusRequest, setSessionFocusRequest] = useState<{
    sessionId: string;
    requestKey: number;
  } | null>(null);
  const requestSessionFocus = useCallback((nextSessionId: string) => {
    if (!nextSessionId) return;
    setSessionFocusRequest((current) => ({
      sessionId: nextSessionId,
      requestKey: (current?.requestKey ?? 0) + 1,
    }));
  }, []);

  /**
   * A task pill was clicked. Two things happen: the rail opens that task's
   * card, and the composer moves to the task's own thread. When the task
   * has no thread yet we deliberately do NOT mint one — we point the
   * composer at the assignee with the scope set and let `ChatComposer`
   * lazy-create on first send, so a glance-click doesn't litter the
   * session list with empty threads.
   */
  const focusTask = useCallback(
    async (task: Task) => {
      const scope = { ref: task.ref, ...(task.activeStepId ? { stepId: task.activeStepId } : {}) };
      try {
        const { sessions } = await api.listTaskSessions(task.projectId, task.num);
        const target = sessions.find((s) => !s.archived);
        if (target) {
          focusThread(target.id, target.gezelId, scope);
          requestSessionFocus(target.id);
          return;
        }
      } catch {
        // Fall through to the no-thread path — the rail card still opened.
      }
      if (task.assignee.kind === 'gezel' && task.assignee.gezelId) {
        focusThread('', task.assignee.gezelId, scope);
      } else {
        setActiveTask(scope);
      }
    },
    [focusThread, requestSessionFocus],
  );

  const handleTaskChanged = useCallback((updated: Task) => {
    // The rail can close a task without leaving the project chat. Re-read the
    // active-task strip immediately instead of waiting for its debounced SSE
    // reconciliation, and leave the closed task's composer scope behind.
    setPillRefreshKey((key) => key + 1);
    if (updated.status === 'complete' || updated.status === 'canceled') {
      setActiveTask((current) => (current?.ref === updated.ref ? null : current));
    }
  }, []);

  // Reset session selection when the user switches gezel OR project. The
  // session id is scoped to a (gezel, project) pair; keeping it stable
  // across a project switch would send the next message to whichever
  // project the user just left — the bug that made "sends aren't showing
  // up in this chat" look like a timeline issue.
  useEffect(() => {
    const focused = focusedSessionRef.current;
    focusedSessionRef.current = null;
    // Nothing was explicitly focused, so this is either a fresh mount or a
    // recipient switch. Resume the thread this session last had open with
    // that gezel here rather than falling back on the newest one.
    setSessionId(
      focused ??
        readChatThreadSelection(projectThreadKey(project.id, selectedGezel.id))?.sessionId ??
        '',
    );
    // The task scope belongs to the thread we're leaving. A pill click that
    // switches gezel re-sets it right after, via `focusedTaskRef`.
    setActiveTask(focusedTaskRef.current);
    focusedTaskRef.current = null;
  }, [selectedGezel.id, project.id]);

  useEffect(() => {
    writeChatThreadSelection(projectThreadKey(project.id, selectedGezel.id), { sessionId });
  }, [project.id, selectedGezel.id, sessionId]);

  // Pick a role-aware empty-composer prompt once per (gezel, project)
  // pairing. `isVoorman` is passed from the outer roster derivation —
  // voormen get project-scoped hints, everyone else gets a generic
  // worker nudge.
  const placeholder = useMemo(
    () =>
      pickChatPlaceholder({
        role: isVoorman ? 'voorman' : 'other',
        gezelName: selectedName,
        gezelGender: selectedGezel.gender,
        projectName: project.name,
        fixedFunctionTool: selectedGezel.fixedFunction?.tool,
      }),
    [
      isVoorman,
      selectedName,
      selectedGezel.gender,
      project.name,
      selectedGezel.fixedFunction?.tool,
    ],
  );

  const selectedGezelPronouns = pronounFormsForGender(selectedGezel.gender);

  // The compose-surface switch, rendered into the top row of whichever
  // composer is mounted — the chat composer's "To:" line, the terminal
  // composer's toolbar. Those two rows sit at the same height (the terminal
  // has no recipient band), so the tabs land under the cursor that just
  // clicked them instead of jumping a row down. Each tab hangs off the bottom
  // of its host row and the selected one opens into the band beneath it, so
  // the thread picker and draft area read as the panel that tab fronts. The
  // glyphs mirror the escape syntax users can type (`@florian …` → chat,
  // `> ls` → terminal).
  const composeModeTabs = !showComposeModeTabs ? null : (
    <div className="compose-mode-tabs" role="tablist" aria-label="Compose surface">
      <button
        type="button"
        role="tab"
        aria-selected={composeMode === 'chat'}
        // The project tab bar already owns a tab named "Chat", so this one
        // carries a distinguishing accessible name. It still contains the
        // visible label, which is what WCAG's label-in-name rule asks for.
        aria-label="AI chat"
        className="compose-mode-tab"
        onClick={switchToChat}
        title="AI chat (@-mention to talk to a gezel)"
      >
        <span className="compose-mode-tab-glyph" aria-hidden="true">
          @
        </span>
        Chat
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={composeMode === 'terminal'}
        className="compose-mode-tab"
        onClick={() => setComposeMode('terminal')}
        title="Terminal (run shell commands in this project's workspace)"
      >
        <span className="compose-mode-tab-glyph" aria-hidden="true">
          &gt;
        </span>
        Terminal
      </button>
    </div>
  );

  return (
    <ChatReferences
      projectId={project.id}
      // Compact mode turns Skills into a full-width peer of Chat rather
      // than removing it, so keep the project scope available at every size.
      skillsProjectId={project.id}
      compact={compact}
      chatKey={`${project.id}:timeline`}
      onTaskChanged={handleTaskChanged}
      // The pill row is the status band for the whole conversation, not just
      // the message column, so it spans the context pane as well.
      banner={({ onTaskReference }) => (
        <ChatPillRow
          projectId={project.id}
          gezels={recipientGezels}
          activeSessionId={composeMode === 'chat' ? sessionId || undefined : undefined}
          activeTaskRef={composeMode === 'chat' ? (activeTask?.ref ?? null) : null}
          activeTerminalThreadId={composeMode === 'terminal' ? activeTerminalThreadId : null}
          refreshKey={pillRefreshKey}
          terminalRefreshKey={terminalRefreshKey}
          onFocusThread={(pill) => {
            focusThread(pill.sessionId, pill.gezelId, pill.taskRef ? { ref: pill.taskRef } : null);
            requestSessionFocus(pill.sessionId);
          }}
          onFocusTask={(task) => {
            onTaskReference(task.ref, { focus: true });
            void focusTask(task);
          }}
          // Omitting the handler hides terminal pills entirely — a pill
          // would drop the user into terminal mode with no switch to leave.
          onFocusTerminal={
            showComposeModeTabs
              ? (thread) => {
                  pickTerminalFolder(thread.workingDir);
                  setActiveTerminalThreadId(thread.id);
                  setComposeMode('terminal');
                  setTerminalFocusRequest((current) => ({
                    threadId: thread.id,
                    requestKey: (current?.requestKey ?? 0) + 1,
                  }));
                  // The thread anchor identifies the persistent shell, while
                  // its latest message records where that shell actually cd'd.
                  void api
                    .getTerminalThread(project.id, thread.id)
                    .then((detail) => {
                      const cwd = [...detail.messages]
                        .reverse()
                        .find((message) => message.cwd !== undefined)?.cwd;
                      if (cwd !== undefined) setTerminalPickerDisplay(cwd);
                    })
                    .catch(() => {});
                }
              : undefined
          }
          onNewTask={() => setNewTaskOpen(true)}
        />
      )}
    >
      {({
        onToolActivity,
        onArtifactReference,
        onArtifactSeen,
        onWorkspaceReference,
        onWorkspaceSeen,
        recentReferences,
        onOpenReference,
        onTaskReference,
      }) => (
        <>
          <ProjectTimeline
            projectId={project.id}
            activeSessionId={sessionId || undefined}
            onFocusSession={(sid, gid) => focusThread(sid, gid, null)}
            onToolActivity={onToolActivity}
            onArtifactReference={onArtifactReference}
            onArtifactSeen={onArtifactSeen}
            onWorkspaceReference={onWorkspaceReference}
            onWorkspaceSeen={onWorkspaceSeen}
            onOpenReference={onOpenReference}
            onTaskReference={onTaskReference}
            onTerminalWorkingDirChanged={(_threadId, next) => {
              // Display-only: keep the routing anchor stable so the
              // persistent shell stays alive across `cd` commands.
              // The thread anchor only moves on explicit picker clicks.
              setTerminalPickerDisplay(next);
            }}
            terminalRefreshKey={terminalRefreshKey}
            {...(terminalSubmission ? { terminalSubmission } : {})}
            {...(terminalFocusRequest ? { terminalFocusRequest } : {})}
            {...(sessionFocusRequest ? { sessionFocusRequest } : {})}
            emptyPlaceholder={
              isVoorman
                ? `Talk to ${selectedName} about running "${project.name}" — planning tasks, delegating, or checking progress.`
                : `Chat with ${selectedName} about what ${selectedGezelPronouns.subject} ${selectedGezelPronouns.presentBe} working on in "${project.name}".`
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
                  gezelRoleBasedName={selectedGezel.roleBasedName}
                  gezelRole={selectedGezel.role}
                  gezelIcon={selectedGezel.icon ?? null}
                  gezelPoppetje={selectedGezel.poppetje}
                  gezelIconOverride={selectedGezel.iconOverride}
                  recipientGezels={recipientGezels}
                  onPrimaryRecipientChange={onSelectGezel}
                  focusRequestKey={chatFocusRequestKey}
                  projectId={project.id}
                  sessionId={sessionId || undefined}
                  {...(activeTask ? { taskRef: activeTask.ref } : {})}
                  {...(activeTask?.stepId ? { stepId: activeTask.stepId } : {})}
                  onSessionCreated={(sid) => {
                    setSessionId(sid);
                    setSessionRefreshKey((k) => k + 1);
                  }}
                  onToolActivity={onToolActivity}
                  recentReferences={recentReferences}
                  onOpenReference={onOpenReference}
                  placeholder={placeholder}
                  draftScope="project"
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
                  onTerminalEscape={
                    showComposeModeTabs
                      ? (seed) => {
                          setTerminalInitialInput(seed);
                          setComposeMode('terminal');
                        }
                      : undefined
                  }
                  addressLineTrailing={composeModeTabs}
                  draftId={draftId || undefined}
                  onDraftIdChange={(next) => setDraftId(next ?? '')}
                  belowAddressLine={
                    <SessionSwitcher
                      gezelId={selectedGezel.id}
                      projectId={project.id}
                      sessionId={sessionId || undefined}
                      gezelName={selectedName}
                      {...(activeTask ? { taskRef: activeTask.ref } : {})}
                      {...(activeTask?.stepId ? { stepId: activeTask.stepId } : {})}
                      onSessionIdChange={(next) => setSessionId(next ?? '')}
                      onNewSessionCreated={() => setChatFocusRequestKey((key) => key + 1)}
                      refreshKey={sessionRefreshKey}
                      activeDraftId={draftId || undefined}
                      onDraftSelect={(next) => setDraftId(next ?? '')}
                      // A task scope is always an explicit navigation, so it
                      // keeps the ordinary newest-thread pick.
                      autoPickNewest={!startFreshThread || Boolean(activeTask)}
                    />
                  }
                />
              ) : (
                <TerminalComposer
                  key={`terminal:${project.id}`}
                  projectId={project.id}
                  workingDir={terminalThreadDir}
                  contextRow={
                    <FolderTreeSwitcher
                      projectId={project.id}
                      workingDir={terminalPickerDisplay}
                      onChangeWorkingDir={pickTerminalFolder}
                    />
                  }
                  toolbarTrailing={composeModeTabs}
                  initialInput={terminalInitialInput}
                  onSent={(input, result) => {
                    setActiveTerminalThreadId(result.threadId);
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
          </div>
          {/* Portals, so its position in the tree is cosmetic. `projects` is
              only read when the project picker shows, which `projectLocked`
              suppresses — we're scoped to one project by construction. */}
          <NewTaskDialog
            open={newTaskOpen}
            defaultProjectId={project.id}
            projects={[project]}
            gezels={recipientGezels}
            projectLocked
            onClose={() => setNewTaskOpen(false)}
            onCreated={() => {
              setNewTaskOpen(false);
              setPillRefreshKey((k) => k + 1);
            }}
          />
        </>
      )}
    </ChatReferences>
  );
}
