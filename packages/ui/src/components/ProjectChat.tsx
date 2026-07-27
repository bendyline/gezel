import type { GezelSummary, ProjectDetail, Task } from '@bendyline/gezel';
import { displayName } from '@bendyline/gezel';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { crewLeadLabelLower } from '../labels.js';
import { Popover } from '../primitives/index.js';
import { ChatComposer, queueComposerPrefill } from './ChatComposer.js';
import { ChatReferences } from './ChatReferences.js';
import { FolderTreeSwitcher } from './FolderTreeSwitcher.js';
import { GezelIcon } from './GezelIcon.js';
import { ProjectTimeline } from './ProjectTimeline.js';
import { SessionSwitcher } from './SessionSwitcher.js';
import { TerminalComposer, queueTerminalCommand } from './TerminalComposer.js';
import { pickChatPlaceholder } from './chat-placeholder.js';
import { useRoleBasedNameOnlyMode } from './useRoleBasedNameOnlyMode.js';

/**
 * Per-project chat with the people doing the work. The roster is assembled
 * live: voorman first (⭐), then everyone on the project's explicit
 * `gezelIds` roster (auto-populated as gezels open sessions, are messaged,
 * or are assigned to tasks), then — for back-compat with projects on disk
 * before the explicit roster existed — task/step assignees. Everyone else
 * is reachable via the "More gezels…" dropdown so the user can still pull
 * an outsider in on an ad-hoc basis. The selected gezel scopes the
 * composer; the timeline shows ALL chats in the project interleaved.
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
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selectedId, setSelectedId] = useState<string>('');
  const roleBasedNameOnlyMode = useRoleBasedNameOnlyMode();

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

  useEffect(() => {
    api
      .listProjectTasks(project.id)
      .then((r) => setTasks(r.tasks))
      .catch(() => setTasks([]));
  }, [project.id]);

  // Collect gezel IDs that appear as task-level or step-level assignees.
  // Strictly redundant with `project.gezelIds` for new projects (the
  // auto-add hooks fold task assignees into the roster), but kept as a
  // fallback so projects written before the explicit roster existed
  // still show their team without waiting for the next session/message
  // to repopulate `gezelIds`.
  const taskAssigneeIds = useMemo(() => {
    const ids = new Set<string>();
    for (const t of tasks) {
      if (t.assignee.kind === 'gezel') ids.add(t.assignee.gezelId);
      for (const s of t.craftbook?.steps ?? []) {
        if (s.assignee?.kind === 'gezel') ids.add(s.assignee.gezelId);
      }
    }
    return ids;
  }, [tasks]);

  // Primary roster = voorman + project.gezelIds + task/step assignees,
  // in that order (deduped). Voorman keeps the ⭐ tag; everyone else
  // renders as a plain chip — the explicit roster doesn't distinguish
  // "joined via task" from "joined via session", and surfacing that
  // detail in the chip is more noise than signal.
  const primaryRoster = useMemo(() => {
    const seen = new Set<string>();
    const out: Array<{ gezel: GezelSummary; tag: 'voorman' | 'member' }> = [];
    if (project.voormanGezelId) {
      const voorman = gezels.find((g) => g.id === project.voormanGezelId);
      if (voorman) {
        out.push({ gezel: voorman, tag: 'voorman' });
        seen.add(voorman.id);
      }
    }
    for (const id of project.gezelIds ?? []) {
      if (seen.has(id)) continue;
      const g = gezels.find((gg) => gg.id === id);
      if (g) {
        out.push({ gezel: g, tag: 'member' });
        seen.add(id);
      }
    }
    for (const id of taskAssigneeIds) {
      if (seen.has(id)) continue;
      const g = gezels.find((gg) => gg.id === id);
      if (g) {
        out.push({ gezel: g, tag: 'member' });
        seen.add(id);
      }
    }
    return out;
  }, [gezels, project.voormanGezelId, project.gezelIds, taskAssigneeIds]);

  // Everyone else — shown in a secondary dropdown so the user can still
  // pull in the Meester or any other gezel on an ad-hoc basis.
  const otherGezels = useMemo(() => {
    const primaryIds = new Set(primaryRoster.map((r) => r.gezel.id));
    return gezels.filter((g) => !primaryIds.has(g.id));
  }, [gezels, primaryRoster]);

  // Solo projects (games, the chat room) run ONE gezel — the ambachtsman/
  // lead does everything. Collapse the crew picker to that single lead:
  // the voorman if set, else the first roster member, else the first
  // available gezel. No chip row, no "More gezels…" dropdown.
  const isSolo = project.mode === 'solo';
  const soloLead = useMemo(() => {
    if (!isSolo) return null;
    return (
      gezels.find((g) => g.id === project.voormanGezelId) ??
      primaryRoster[0]?.gezel ??
      gezels[0] ??
      null
    );
  }, [isSolo, gezels, project.voormanGezelId, primaryRoster]);
  const soloLeadName = soloLead
    ? displayName(
        { name: soloLead.name, roleBasedName: soloLead.roleBasedName },
        roleBasedNameOnlyMode,
      )
    : '';

  // Default selection: solo → the single lead; crew → voorman → first
  // assignee → first gezel overall.
  useEffect(() => {
    if (selectedId) return;
    const next = isSolo
      ? (soloLead?.id ?? '')
      : (primaryRoster[0]?.gezel.id ?? otherGezels[0]?.id ?? '');
    if (next) setSelectedId(next);
  }, [isSolo, soloLead, primaryRoster, otherGezels, selectedId]);

  const selected = gezels.find((g) => g.id === selectedId);

  if (gezels.length === 0) {
    return (
      <p className="muted">No gezels available to chat with yet. Create one from the Gezels tab.</p>
    );
  }

  return (
    <div className="project-chat">
      <div className="project-chat-roster">
        {isSolo ? (
          soloLead ? (
            <button
              type="button"
              className="project-chat-chip project-chat-chip-active"
              onClick={() => setSelectedId(soloLead.id)}
              title={`${soloLeadName} — the ${crewLeadLabelLower(project)}`}
            >
              <GezelIcon
                svg={soloLead.icon ?? null}
                poppetje={soloLead.poppetje}
                iconOverride={soloLead.iconOverride}
                name={soloLeadName}
                size={26}
              />
              <span className="project-chat-chip-text">
                <span className="project-chat-chip-name">{soloLeadName}</span>
                <span className="project-chat-chip-tag">{`⭐ ${crewLeadLabelLower(project)}`}</span>
              </span>
            </button>
          ) : (
            <p className="muted small" style={{ margin: 0 }}>
              {`No ${crewLeadLabelLower(project)} yet — create one from the Gezels tab.`}
            </p>
          )
        ) : (
          <>
            {primaryRoster.length === 0 ? (
              <p className="muted small" style={{ margin: 0 }}>
                {`No ${crewLeadLabelLower(project)} set and no task assignees yet — pick anyone to start a conversation.`}
              </p>
            ) : (
              primaryRoster.map(({ gezel, tag }) => {
                const active = gezel.id === selectedId;
                const leadLabel = crewLeadLabelLower(project);
                const rendered = displayName(
                  { name: gezel.name, roleBasedName: gezel.roleBasedName },
                  roleBasedNameOnlyMode,
                );
                // Second line of the chip. The lead's standing in the project
                // outranks their job title — a voorman who is also a Developer
                // reads as the voorman here, and their role is one hover away
                // in the title attribute.
                const subtitle = tag === 'voorman' ? `⭐ ${leadLabel}` : gezel.role;
                return (
                  <button
                    key={gezel.id}
                    type="button"
                    className={`project-chat-chip${active ? ' project-chat-chip-active' : ''}`}
                    onClick={() => setSelectedId(gezel.id)}
                    title={
                      tag === 'voorman'
                        ? `${rendered} — ${leadLabel} of this ${project.mode === 'solo' ? 'job' : 'project'}${gezel.role ? ` · ${gezel.role}` : ''}`
                        : `${rendered} — on this ${project.mode === 'solo' ? 'job' : 'project'}'s team`
                    }
                  >
                    <GezelIcon
                      svg={gezel.icon ?? null}
                      poppetje={gezel.poppetje}
                      iconOverride={gezel.iconOverride}
                      name={rendered}
                      size={26}
                    />
                    <span className="project-chat-chip-text">
                      <span className="project-chat-chip-name">{rendered}</span>
                      {subtitle && <span className="project-chat-chip-tag">{subtitle}</span>}
                    </span>
                  </button>
                );
              })
            )}

            {otherGezels.length > 0 && (
              <MoreGezels
                gezels={otherGezels}
                selectedId={selectedId}
                roleBasedNameOnlyMode={roleBasedNameOnlyMode}
                onSelect={setSelectedId}
              />
            )}
          </>
        )}
      </div>

      {selectedId && selected && (
        <ProjectChatBody
          project={project}
          selectedGezel={selected}
          isVoorman={selected.id === project.voormanGezelId}
          onSelectGezel={setSelectedId}
          compact={compact}
        />
      )}
    </div>
  );
}

/**
 * The "More gezels…" key — everyone not on the project's roster, reachable
 * ad hoc. A popover of the same face-bearing chips the roster row uses, not
 * a text `Select`: the old dropdown had to carry its own trigger label as a
 * sentinel option ("More gezels…" listed alongside real people), which read
 * as a selectable gezel. A popover has a trigger that is not an option, so
 * the list is people and nothing else.
 */
function MoreGezels({
  gezels,
  selectedId,
  roleBasedNameOnlyMode,
  onSelect,
}: {
  gezels: GezelSummary[];
  selectedId: string;
  roleBasedNameOnlyMode: boolean;
  onSelect: (gezelId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const named = useMemo(
    () =>
      gezels.map((g) => ({
        gezel: g,
        rendered: displayName(
          { name: g.name, roleBasedName: g.roleBasedName },
          roleBasedNameOnlyMode,
        ),
      })),
    [gezels, roleBasedNameOnlyMode],
  );

  const active = named.find((n) => n.gezel.id === selectedId) ?? null;

  // Search only earns its space once the list stops being scannable at a
  // glance; below that it's a box between the user and four faces.
  const searchable = named.length > 8;
  const q = query.trim().toLowerCase();
  const shown =
    searchable && q
      ? named.filter(
          (n) =>
            n.rendered.toLowerCase().includes(q) || (n.gezel.role ?? '').toLowerCase().includes(q),
        )
      : named;

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery('');
      }}
    >
      <Popover.Trigger asChild>
        <button
          type="button"
          className={
            active
              ? 'project-chat-chip project-chat-chip-active project-chat-more-active'
              : 'project-chat-more'
          }
          title={
            active
              ? `${active.rendered} — pulled in from outside this project's team`
              : 'Bring in a gezel from outside this team'
          }
        >
          {active ? (
            <>
              <GezelIcon
                svg={active.gezel.icon ?? null}
                poppetje={active.gezel.poppetje}
                iconOverride={active.gezel.iconOverride}
                name={active.rendered}
                size={26}
              />
              <span className="project-chat-chip-text">
                <span className="project-chat-chip-name">{active.rendered}</span>
                {active.gezel.role && (
                  <span className="project-chat-chip-tag">{active.gezel.role}</span>
                )}
              </span>
            </>
          ) : (
            <span>More gezels…</span>
          )}
          <span className="project-chat-more-caret" aria-hidden>
            ▾
          </span>
        </button>
      </Popover.Trigger>
      <Popover.Content className="project-chat-more-popover" align="start">
        <span className="project-chat-more-label">Bring someone else in</span>
        {searchable && (
          <input
            className="project-chat-more-search"
            type="search"
            value={query}
            placeholder="Search by name or role"
            onChange={(e) => setQuery(e.target.value)}
          />
        )}
        <div className="project-chat-more-list">
          {shown.map(({ gezel, rendered }) => (
            <button
              key={gezel.id}
              type="button"
              className={`project-chat-chip${gezel.id === selectedId ? ' project-chat-chip-active' : ''}`}
              onClick={() => {
                onSelect(gezel.id);
                setOpen(false);
              }}
            >
              <GezelIcon
                svg={gezel.icon ?? null}
                poppetje={gezel.poppetje}
                iconOverride={gezel.iconOverride}
                name={rendered}
                size={26}
              />
              <span className="project-chat-chip-text">
                <span className="project-chat-chip-name">{rendered}</span>
                {gezel.role && <span className="project-chat-chip-tag">{gezel.role}</span>}
              </span>
            </button>
          ))}
          {shown.length === 0 && <p className="muted small project-chat-more-empty">No matches.</p>}
        </div>
      </Popover.Content>
    </Popover.Root>
  );
}

function ProjectChatBody({
  project,
  selectedGezel,
  isVoorman,
  onSelectGezel,
  compact,
}: {
  project: ProjectDetail;
  selectedGezel: GezelSummary;
  isVoorman: boolean;
  onSelectGezel: (gezelId: string) => void;
  compact: boolean;
}) {
  // The composer's session id is owned here. SessionSwitcher reads/writes
  // it for the (selectedGezel, project) pair; the timeline highlights it
  // as the active session; the composer posts into it.
  const [sessionId, setSessionId] = useState<string>('');
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
        projectName: project.name,
        fixedFunctionTool: selectedGezel.fixedFunction?.tool,
      }),
    [isVoorman, selectedGezel.name, project.name, selectedGezel.fixedFunction?.tool],
  );

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
      {({ onToolActivity, onArtifactReference, onTaskReference }) => (
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
            onTaskReference={onTaskReference}
            onTerminalWorkingDirChanged={(_threadId, next) => {
              // Display-only: keep the routing anchor stable so the
              // persistent shell stays alive across `cd` commands.
              // The thread anchor only moves on explicit picker clicks.
              setTerminalPickerDisplay(next);
            }}
            terminalRefreshKey={terminalRefreshKey}
            emptyPlaceholder={
              isVoorman
                ? `Talk to ${selectedGezel.name} about running "${project.name}" — planning tasks, delegating, or checking progress.`
                : `Chat with ${selectedGezel.name} about what they're working on in "${project.name}".`
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
                      onSessionIdChange={(next) => setSessionId(next ?? '')}
                      refreshKey={sessionRefreshKey}
                    />
                  }
                />
              ) : (
                <>
                  <FolderTreeSwitcher
                    projectId={project.id}
                    workingDir={terminalPickerDisplay}
                    onChangeWorkingDir={pickTerminalFolder}
                  />
                  <TerminalComposer
                    key={`terminal:${project.id}:${terminalMountKey}`}
                    projectId={project.id}
                    workingDir={terminalThreadDir}
                    initialInput={terminalInitialInput}
                    onSent={() => setTerminalRefreshKey((key) => key + 1)}
                    onChatEscape={(seed) => {
                      // Queue the seed for the ChatComposer that's
                      // about to mount, then flip mode. The composer's
                      // mount-time effect reads `pendingPrefills` for
                      // this project, populates its editor, and clears
                      // the entry.
                      queueComposerPrefill(project.id, seed);
                      setComposeMode('chat');
                    }}
                  />
                </>
              )}
            </div>
            <div
              className={`project-chat-compose-mode-bar${composeMode === 'terminal' ? ' project-chat-compose-mode-bar-terminal' : ''}`}
            >
              <div className="project-chat-compose-toggle" role="tablist">
                <button
                  type="button"
                  role="tab"
                  aria-selected={composeMode === 'chat'}
                  aria-label="AI chat"
                  className={composeMode === 'chat' ? 'active' : ''}
                  onClick={() => setComposeMode('chat')}
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
