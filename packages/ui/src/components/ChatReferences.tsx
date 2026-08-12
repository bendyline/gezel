import type { GezelSummary, Task, TaskNote } from '@bendyline/gezel';
import { hasReportActionFence } from '@bendyline/gezel';
import { GezelApiError } from '@bendyline/gezel-client';
import { EditorShell } from '@bendyline/squisq-editor-react';
import '@bendyline/squisq-editor-react/styles';
import { LinearDocView } from '@bendyline/squisq-react';
import { markdownToDoc } from '@bendyline/squisq/doc';
import { parseMarkdown } from '@bendyline/squisq/markdown';
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { api } from '../api.js';
import { DropdownChevron, DropdownMenu, Tabs } from '../primitives/index.js';
import { useEffectiveTheme } from '../theme.js';
import { CommandsPanel } from './CommandsPanel.js';
import { GezelIcon } from './GezelIcon.js';
import { HtmlPreviewFrame } from './HtmlPreviewFrame.js';
import type { ToolActivity } from './chat-bubbles.js';
import { gezelChatTheme } from './chat-theme.js';
import { makeReportActionFenceRenderers } from './report-actions/ReportActionFence.js';
import { useCompactLayout } from './useCompactLayout.js';

/**
 * `ChatReferences` wraps any chat-like surface with a right-hand rail
 * that collects the files a gezel touches via MCP tools during the
 * conversation and lets the user preview them inline. The reference
 * list + viewer logic lives here so both the project chat and the Home
 * Meester chat share one implementation.
 *
 * Usage:
 *
 *     <ChatReferences projectId={project.id} chatKey={`${project.id}:timeline`}>
 *       {(onToolActivity) => (
 *         <>
 *           <ProjectTimeline projectId={project.id} onToolActivity={onToolActivity} ... />
 *           <ChatComposer onToolActivity={onToolActivity} ... />
 *         </>
 *       )}
 *     </ChatReferences>
 *
 * The render prop receives callbacks that the caller threads into the
 * timeline + composer. Switching `chatKey` clears the reference list — callers
 * should key it to a stable scope (project id for project chat, "global" for
 * the Meester) so the list persists across gezel + session switches within
 * that scope.
 */

type RefKind = 'artifact' | 'document' | 'workspace';

// Reference-panel split — persisted as a fraction of the container
// width (0 → no side pane, 1 → no chat) so the ratio is stable across
// window resizes. Clamped at reasonable bounds so one side can never
// be squeezed to nothing.
const SIDE_FRACTION_STORAGE_KEY = 'gezel:chat-rail-side-fraction';
const MIN_SIDE_FRACTION = 0.18;
const MAX_SIDE_FRACTION = 0.65;
const DEFAULT_SIDE_FRACTION = 0.34;

/**
 * Minimum widths for the split chat/reference layout. Below
 * `CHAT_RAIL_MIN_SPLIT_PX` the rail becomes a single-pane tab surface
 * instead: Chat keeps the whole canvas, while Task, Skills, and
 * References remain one click away. This is measured on the rail itself
 * because an output pane can squeeze chat even while the surrounding project
 * view is still wide.
 *
 * The split's mechanical floor is 480 + 14 + 192 = 686 px. 840 sits a
 * comfortable step above it — a ~630 px chat column beside the 12 rem side
 * pane at its narrowest, ~555/285 at the default 0.34 fraction — without
 * demanding a width the project view can rarely hand over. The previous
 * 1100 was calibrated against a rail with nothing to its left; with the
 * output pane open, a 1512 px window leaves the rail only ~1035 px, so the
 * split could never appear on a laptop no matter how wide the window got.
 *
 * The hysteresis band is what makes dragging the output-pane grip bearable:
 * the layout collapses at 840 but doesn't rebuild until 900, so a grip
 * parked near the boundary can't tear the rail down and back up per pixel.
 */
export const CHAT_RAIL_MIN_CHAT_PX = 480;
const CHAT_RAIL_MIN_SIDE_PX = 192;
const CHAT_RAIL_GRIP_TRACK_PX = 14;
export const CHAT_RAIL_MIN_SPLIT_PX = 840;
export const CHAT_RAIL_SPLIT_HYSTERESIS_PX = 60;

// `'tasks'` here means task REFS — the TaskRailCard surface. It is
// unrelated to `CommandsPanelSection['tasks']`, which means craftbooks.
type RailSection = 'tasks' | 'references' | 'skills';
type CompactPane = 'chat' | RailSection;

function clampFraction(f: number): number {
  if (!Number.isFinite(f)) return DEFAULT_SIDE_FRACTION;
  return Math.max(MIN_SIDE_FRACTION, Math.min(MAX_SIDE_FRACTION, f));
}

function readStoredSideFraction(): number {
  if (typeof window === 'undefined') return DEFAULT_SIDE_FRACTION;
  try {
    const raw = window.localStorage.getItem(SIDE_FRACTION_STORAGE_KEY);
    if (!raw) return DEFAULT_SIDE_FRACTION;
    const parsed = Number.parseFloat(raw);
    return clampFraction(parsed);
  } catch {
    return DEFAULT_SIDE_FRACTION;
  }
}

// Key format used by both the tool-call path and the parser-driven
// chip/link path so the two never double-add the same file. Scope is
// the tool/message's originating project — empty string means "no
// project context, fall back to the ChatReferences `projectId` prop".
function referenceKey(kind: RefKind, scope: string | undefined, path: string): string {
  return `${kind}:${scope ?? ''}:${path}`;
}

function classifyTool(name: string): RefKind | null {
  switch (name) {
    case 'read_artifact':
    case 'write_artifact':
      return 'artifact';
    case 'read_document':
    case 'write_document':
      return 'document';
    case 'read_file':
    case 'read_files':
    case 'write_file':
      return 'workspace';
    default:
      return null;
  }
}

interface Reference {
  key: string;
  kind: RefKind;
  path: string;
  firstSeenAt: number;
  /**
   * Optional project override used when this reference comes from a
   * cross-project timeline (the Meester's global view). Falls back to
   * the ChatReferences' own `projectId` prop when not set. Both the
   * tool-activity path (via `ToolActivity.projectId` tagged at the SSE
   * envelope boundary) and the parser-driven chip/link path (via an
   * explicit message `projectId`) populate this.
   */
  projectId?: string;
}

function isMarkdown(path: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(path);
}

function isHtml(path: string): boolean {
  return /\.html?$/i.test(path);
}

export interface ChatReferencesApi {
  /** Fed by tool-call events from the timeline / composer. */
  onToolActivity: (tool: ToolActivity) => void;
  /**
   * Fed by the server-side reference parser (via MessageBubble chips
   * and in-body `#artifact:` link clicks). Adds the artifact to the
   * reference list if missing, and promotes it to the active viewer
   * so the click feels immediate. `projectId` is the project the
   * message originated from — required on cross-project surfaces
   * like the Meester's global timeline, optional elsewhere (falls
   * back to this ChatReferences' own `projectId` prop).
   */
  onArtifactReference: (path: string, projectId?: string) => void;
  /** Promote a workspace file into the References viewer. */
  onWorkspaceReference: (path: string, projectId?: string) => void;
  /**
   * Fed by the timeline as it loads/streams messages. Surfaces a task in
   * the right rail's "Task" tab so the gezel's current work context is
   * always one glance away — no need for the model to re-echo the ref.
   * Two sources flow through here: the session's OWN scoped task
   * (`scoped: true`, pinned to the top) which rides on every message's
   * `taskRef`, and any other task ref the parser recognized in a reply
   * body (`scoped: false`). Both dedupe on the ref.
   *
   * `focus: true` additionally pulls the rail onto this task — select it
   * and switch to the Task tab. Reserve it for a direct user action (the
   * pill row's task click); the passive timeline feeds must not yank the
   * rail off whatever the user is reading.
   */
  onTaskReference: (ref: string, opts?: { scoped?: boolean; focus?: boolean }) => void;
}

interface TaskRef {
  ref: string;
  /** The session's own task (vs. a ref merely mentioned in a reply). */
  scoped: boolean;
  firstSeenAt: number;
}

export function ChatReferences({
  projectId,
  chatKey,
  skillsProjectId,
  compact = false,
  banner,
  children,
}: {
  /** Project context used to resolve reference paths. Defaults to 'default'. */
  projectId?: string;
  /** Stable key for the current chat — changing it resets the reference list. */
  chatKey: string;
  /**
   * When set, the side rail gains a "Skills" tab listing this project's
   * workspace skills and any pending bash→JS import approvals. The tab is
   * omitted while both sources are empty. Omit for chats that aren't scoped
   * to a single project workspace (the global Meester timeline).
   *
   * Runnable commands and craftbooks deliberately do NOT appear here:
   * commands live in the terminal composer's toolbar galleries, and
   * craftbooks are launched from the chat pill row's "+", which creates a
   * real task instead of staging a terminal line.
   */
  skillsProjectId?: string;
  /**
   * Narrow-form-factor mode (VS Code chat panel, mobile, or an explicitly
   * compact host). The side-by-side rail and resize grip are suppressed;
   * Chat, Task, Skills, and References become full-width tabs instead.
   */
  compact?: boolean;
  /**
   * Optional full-width band above both panes (the project chat's pill
   * row). It gets the same reference API as `children` because focusing a
   * task pill also scopes the side rail. In compact mode it stays above the
   * pane tabs so thread and task context remains visible in every pane.
   */
  banner?: (api: ChatReferencesApi) => ReactNode;
  /**
   * Render prop: receives two callbacks the chat child threads into
   * the timeline and composer. `onToolActivity` is fed by MCP tool
   * events; `onArtifactReference` is fed by the new parser-driven
   * chip row + inline `#artifact:` links.
   */
  children: (api: ChatReferencesApi) => ReactNode;
}) {
  const resolvedProjectId = projectId ?? 'default';
  const [references, setReferences] = useState<Reference[]>([]);
  const [activeRef, setActiveRef] = useState<Reference | null>(null);
  const [taskRefs, setTaskRefs] = useState<TaskRef[]>([]);
  const [activeTaskRef, setActiveTaskRef] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<RailSection>('references');
  const [compactPane, setCompactPane] = useState<CompactPane>('chat');
  // Store the id, rather than a bare boolean, so switching projects cannot
  // briefly expose the previous project's Skills rail while the new probe is
  // still settling.
  const [skillsAvailableProjectId, setSkillsAvailableProjectId] = useState<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: chatKey is the reset trigger — the effect body doesn't read it, but changing it must re-fire.
  useEffect(() => {
    setReferences([]);
    setActiveRef(null);
    setTaskRefs([]);
    setActiveTaskRef(null);
    setCompactPane('chat');
  }, [chatKey]);

  // The Skills panel owns richer polling while it is visible, but it cannot
  // discover that it should mount in the first place. This lightweight probe
  // keeps empty project chats full-width and notices newly-added skills or
  // pending imports without requiring a reload.
  useEffect(() => {
    if (!skillsProjectId) {
      setSkillsAvailableProjectId(null);
      return;
    }
    let cancelled = false;
    const refresh = async () => {
      const [skillsResult, importsResult] = await Promise.allSettled([
        api.getProjectSkills(skillsProjectId),
        api.getProjectImportsPending(skillsProjectId),
      ]);
      if (
        cancelled ||
        skillsResult.status !== 'fulfilled' ||
        importsResult.status !== 'fulfilled'
      ) {
        return;
      }
      const available =
        skillsResult.value.skills.length > 0 || importsResult.value.items.length > 0;
      setSkillsAvailableProjectId(available ? skillsProjectId : null);
    };
    void refresh();
    const intervalId = window.setInterval(refresh, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [skillsProjectId]);

  const handleTaskReference = useCallback(
    (ref: string, opts?: { scoped?: boolean; focus?: boolean }) => {
      const scoped = opts?.scoped ?? false;
      setTaskRefs((prev) => {
        const hit = prev.find((t) => t.ref === ref);
        if (hit) {
          // A ref first seen as a mention can later be confirmed as the
          // session's scoped task — promote it so it pins to the top.
          if (scoped && !hit.scoped) {
            return prev.map((t) => (t.ref === ref ? { ...t, scoped: true } : t));
          }
          return prev;
        }
        return [...prev, { ref, scoped, firstSeenAt: Date.now() }];
      });
      // A deliberate click wins over the rising-edge effects below, which
      // deliberately hold back when a reference is already open.
      if (opts?.focus) {
        setActiveTaskRef(ref);
        setActiveTab('tasks');
        setCompactPane('tasks');
      }
    },
    [],
  );

  const handleToolActivity = useCallback((tool: ToolActivity) => {
    if (!tool.success) return;
    // Generated media (generate_video mp4, generate_image png) rides on
    // the tool call as artifact paths in `videos`/`images`, not `tool.path`.
    // Surface each in the rail so it's previewable to the right — videos
    // are auto-promoted to the viewer so a new clip shows immediately.
    const mediaPaths = [
      ...(tool.videos?.map((v) => ({ path: v.path, promote: true })) ?? []),
      ...(tool.images?.map((im) => ({ path: im.path, promote: false })) ?? []),
    ];
    if (mediaPaths.length > 0) {
      for (const m of mediaPaths) {
        const key = referenceKey('artifact', tool.projectId, m.path);
        let ref: Reference | null = null;
        setReferences((prev) => {
          const hit = prev.find((r) => r.key === key);
          if (hit) {
            ref = hit;
            return prev;
          }
          ref = {
            key,
            kind: 'artifact',
            path: m.path,
            firstSeenAt: Date.now(),
            ...(tool.projectId ? { projectId: tool.projectId } : {}),
          };
          return [...prev, ref];
        });
        if (m.promote && ref) setActiveRef(ref);
      }
    }
    const kind = classifyTool(tool.name);
    if (!kind) return;
    const paths = tool.paths && tool.paths.length > 0 ? tool.paths : tool.path ? [tool.path] : [];
    if (paths.length === 0) return;
    setReferences((prev) => {
      const next = [...prev];
      const known = new Set(prev.map((reference) => reference.key));
      for (const path of paths) {
        // Workspace HTML already gets a dedicated, larger live preview in the
        // left-hand Output pane (ProjectOutputPane). Surfacing it here too just
        // duplicates the running app, so skip it. Non-HTML workspace files
        // still belong in this rail.
        if (kind === 'workspace' && isHtml(path)) continue;
        const key = referenceKey(kind, tool.projectId, path);
        if (known.has(key)) continue;
        known.add(key);
        next.push({
          key,
          kind,
          path,
          firstSeenAt: Date.now(),
          ...(tool.projectId ? { projectId: tool.projectId } : {}),
        });
      }
      return next;
    });
  }, []);

  const handleArtifactReference = useCallback((path: string, messageProjectId?: string) => {
    const key = referenceKey('artifact', messageProjectId, path);
    let ref: Reference | null = null;
    setReferences((prev) => {
      const hit = prev.find((r) => r.key === key);
      if (hit) {
        ref = hit;
        return prev;
      }
      ref = {
        key,
        kind: 'artifact',
        path,
        firstSeenAt: Date.now(),
        ...(messageProjectId ? { projectId: messageProjectId } : {}),
      };
      return [...prev, ref];
    });
    // Promote the clicked artifact to the viewer. `ref` is assigned
    // synchronously inside the updater so it's defined by now.
    if (ref) {
      setActiveRef(ref);
      setCompactPane('references');
    }
  }, []);

  const handleWorkspaceReference = useCallback((path: string, messageProjectId?: string) => {
    const key = referenceKey('workspace', messageProjectId, path);
    let ref: Reference | null = null;
    setReferences((prev) => {
      const hit = prev.find((r) => r.key === key);
      if (hit) {
        ref = hit;
        return prev;
      }
      ref = {
        key,
        kind: 'workspace',
        path,
        firstSeenAt: Date.now(),
        ...(messageProjectId ? { projectId: messageProjectId } : {}),
      };
      return [...prev, ref];
    });
    if (ref) {
      setActiveRef(ref);
      setCompactPane('references');
    }
  }, []);

  const referenceApi = useMemo<ChatReferencesApi>(
    () => ({
      onToolActivity: handleToolActivity,
      onArtifactReference: handleArtifactReference,
      onWorkspaceReference: handleWorkspaceReference,
      onTaskReference: handleTaskReference,
    }),
    [handleToolActivity, handleArtifactReference, handleWorkspaceReference, handleTaskReference],
  );

  const handleResolved = useCallback((refKey: string, resolvedKind: RefKind) => {
    setReferences((prev) => prev.map((r) => (r.key === refKey ? { ...r, kind: resolvedKind } : r)));
    setActiveRef((prev) => (prev && prev.key === refKey ? { ...prev, kind: resolvedKind } : prev));
  }, []);

  const containerRef = useRef<HTMLDivElement | null>(null);
  // Drop the side rail once the chat rail itself gets too narrow to host a
  // 480 px chat column beside the 12 rem side pane. The `compact` prop is
  // driven by the project-view width, which can stay wide while only the
  // chat panel is squeezed (e.g. a wide game-output column on its left), so
  // we also measure this rail's own width here. The hysteresis band keeps
  // an output-pane grip drag from flipping the layout on every pixel.
  const narrow = useCompactLayout(
    containerRef,
    CHAT_RAIL_MIN_SPLIT_PX,
    CHAT_RAIL_SPLIT_HYSTERESIS_PX,
  );
  const isCompact = compact || narrow;

  const effectiveActive = activeRef ?? references[0] ?? null;
  const hasReferences = effectiveActive !== null;
  const hasSkills = Boolean(skillsProjectId && skillsAvailableProjectId === skillsProjectId);
  // Pinned-first ordering: the session's own task sits at the top, then
  // mentioned tasks in first-seen order.
  const orderedTasks = useMemo(
    () =>
      [...taskRefs].sort((a, b) => {
        if (a.scoped !== b.scoped) return a.scoped ? -1 : 1;
        return a.firstSeenAt - b.firstSeenAt;
      }),
    [taskRefs],
  );
  const hasTasks = orderedTasks.length > 0;
  const effectiveTaskRef =
    (activeTaskRef && orderedTasks.find((t) => t.ref === activeTaskRef)?.ref) ||
    orderedTasks[0]?.ref ||
    null;
  const hasSide = !isCompact && (hasTasks || hasReferences || hasSkills);

  // Auto-switch to References whenever a new ref arrives, but only on
  // the rising edge — don't fight the user if they've manually
  // selected Skills and then dismiss a viewer.
  useEffect(() => {
    if (hasReferences) setActiveTab('references');
  }, [hasReferences]);

  // A task-scoped session opens with its task front-and-centre: surface
  // the Task tab as soon as one appears, but only when the user hasn't
  // already pulled a file reference into view (don't yank them off a
  // file they're reading). Rising-edge only.
  useEffect(() => {
    if (hasTasks && !hasReferences) setActiveTab('tasks');
  }, [hasTasks, hasReferences]);

  // Skills arrive asynchronously from the availability probe. Select them
  // only when they are the sole side context; task/reference arrivals retain
  // their existing precedence and never get yanked away.
  useEffect(() => {
    if (hasSkills && !hasTasks && !hasReferences) setActiveTab('skills');
  }, [hasSkills, hasTasks, hasReferences]);

  // Approving the final pending import can empty the Skills panel while it is
  // open. Move to another meaningful pane (or back to Chat in compact mode)
  // instead of leaving a selected tab with no content.
  useEffect(() => {
    if (hasSkills) return;
    if (activeTab === 'skills') {
      setActiveTab(hasReferences ? 'references' : hasTasks ? 'tasks' : 'references');
    }
    if (compactPane === 'skills') {
      setCompactPane(hasReferences ? 'references' : hasTasks ? 'tasks' : 'chat');
    }
  }, [hasSkills, hasReferences, hasTasks, activeTab, compactPane]);

  const handleSkillsAvailabilityChange = useCallback(
    (available: boolean) => {
      if (!skillsProjectId) return;
      setSkillsAvailableProjectId(available ? skillsProjectId : null);
    },
    [skillsProjectId],
  );

  // Side width is stored as a fraction of the container width so the
  // split reflows sensibly when the window resizes. Persisted across
  // reloads via localStorage.
  const [sideFraction, setSideFraction] = useState<number>(() => readStoredSideFraction());
  const dragState = useRef<{
    startX: number;
    startFraction: number;
    containerWidth: number;
  } | null>(null);

  const commitSideFraction = useCallback((next: number) => {
    const clamped = clampFraction(next);
    setSideFraction(clamped);
    try {
      window.localStorage.setItem(SIDE_FRACTION_STORAGE_KEY, clamped.toFixed(4));
    } catch {
      /* quota / private mode — fall through, state still in memory */
    }
  }, []);

  const onGripMouseDown = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      e.preventDefault();
      const width = containerRef.current?.clientWidth ?? 1;
      dragState.current = {
        startX: e.clientX,
        startFraction: sideFraction,
        containerWidth: width,
      };
      // During a drag, the cursor may cross the reference iframe. An
      // iframe captures pointer events into its own browsing context,
      // so our `mousemove` / `mouseup` handlers stop firing and the
      // grip gets "stuck to" the cursor. The `chat-rail-resizing`
      // class on <body> disables pointer events on iframes for the
      // duration of the drag (CSS in styles.css), and blocks text
      // selection + sets the global cursor as a bonus.
      document.body.classList.add('chat-rail-resizing');
      document.body.style.cursor = 'col-resize';
      const onMove = (ev: MouseEvent) => {
        if (!dragState.current) return;
        const { startX, startFraction, containerWidth } = dragState.current;
        if (containerWidth <= 0) return;
        // Moving left grows the side pane, moving right shrinks it.
        const deltaPx = startX - ev.clientX;
        commitSideFraction(startFraction + deltaPx / containerWidth);
      };
      const onUp = () => {
        dragState.current = null;
        document.body.style.cursor = '';
        document.body.classList.remove('chat-rail-resizing');
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [sideFraction, commitSideFraction],
  );

  const onGripKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      // Keyboard a11y — arrow keys nudge by 2% (8% with Shift),
      // Home/End snap to the bounds.
      const step = e.shiftKey ? 0.08 : 0.02;
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        commitSideFraction(sideFraction + step);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        commitSideFraction(sideFraction - step);
      } else if (e.key === 'Home') {
        e.preventDefault();
        commitSideFraction(MAX_SIDE_FRACTION);
      } else if (e.key === 'End') {
        e.preventDefault();
        commitSideFraction(MIN_SIDE_FRACTION);
      }
    },
    [sideFraction, commitSideFraction],
  );

  // Compact short-circuit: replace the split rail with one full-width pane.
  // Keep Chat mounted while another tab is selected so streaming state,
  // session focus, and an in-progress draft survive the round trip.
  if (isCompact) {
    return (
      <div ref={containerRef} className="chat-rail-body chat-rail-body-compact">
        {banner && <div className="chat-rail-banner">{banner(referenceApi)}</div>}

        <Tabs.Root
          className="chat-rail-compact-root"
          value={compactPane}
          onValueChange={(value) => setCompactPane(value as CompactPane)}
        >
          <Tabs.List className="chat-rail-compact-tabs" aria-label="Conversation panels">
            <Tabs.Trigger className="chat-rail-compact-tab" value="chat">
              Chat
            </Tabs.Trigger>
            {hasTasks && (
              <Tabs.Trigger className="chat-rail-compact-tab" value="tasks">
                Task
              </Tabs.Trigger>
            )}
            {hasSkills && (
              <Tabs.Trigger className="chat-rail-compact-tab" value="skills">
                Skills
              </Tabs.Trigger>
            )}
            {hasReferences && (
              <Tabs.Trigger className="chat-rail-compact-tab" value="references">
                References
              </Tabs.Trigger>
            )}
          </Tabs.List>

          <Tabs.Content
            forceMount
            className="chat-rail-compact-panel chat-rail-compact-chat"
            value="chat"
          >
            <div className="chat-rail-main">{children(referenceApi)}</div>
          </Tabs.Content>

          {hasTasks && effectiveTaskRef && (
            <Tabs.Content className="chat-rail-compact-panel" value="tasks">
              {orderedTasks.length > 1 && (
                <div className="chat-rail-compact-picker-row">
                  <span className="muted small">Showing</span>
                  <TaskTabMenu
                    variant="picker"
                    tasks={orderedTasks}
                    activeRef={effectiveTaskRef}
                    selected
                    onSelect={setActiveTaskRef}
                  />
                </div>
              )}
              <TaskRailCard
                key={effectiveTaskRef}
                taskRef={effectiveTaskRef}
                onOpenTask={(ref) =>
                  window.dispatchEvent(
                    new CustomEvent('gezel:open-tab', { detail: { kind: 'task', ref } }),
                  )
                }
              />
            </Tabs.Content>
          )}

          {hasSkills && skillsProjectId && (
            <Tabs.Content className="chat-rail-compact-panel" value="skills">
              <CommandsPanel
                key={skillsProjectId}
                projectId={skillsProjectId}
                section="skills"
                onAvailabilityChange={handleSkillsAvailabilityChange}
              />
            </Tabs.Content>
          )}

          {hasReferences && effectiveActive && (
            <Tabs.Content className="chat-rail-compact-panel" value="references">
              {references.length > 1 && (
                <div className="chat-rail-compact-picker-row">
                  <span className="muted small">Showing</span>
                  <ReferenceTabMenu
                    variant="picker"
                    refs={references}
                    activeKey={effectiveActive.key}
                    selected
                    onSelect={setActiveRef}
                  />
                </div>
              )}
              <div className="chat-rail-viewer-wrap">
                <ReferenceViewer
                  key={effectiveActive.key}
                  projectId={effectiveActive.projectId ?? resolvedProjectId}
                  reference={effectiveActive}
                  onResolved={handleResolved}
                />
              </div>
            </Tabs.Content>
          )}
        </Tabs.Root>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={`chat-rail-body${hasSide ? ' chat-rail-body-split' : ''}`}
      style={{
        ['--chat-rail-side-fraction' as string]: sideFraction.toFixed(4),
        ['--chat-rail-min-main-width' as string]: `${CHAT_RAIL_MIN_CHAT_PX}px`,
        ['--chat-rail-min-side-width' as string]: `${CHAT_RAIL_MIN_SIDE_PX}px`,
        ['--chat-rail-grip-track-width' as string]: `${CHAT_RAIL_GRIP_TRACK_PX}px`,
      }}
    >
      {banner && <div className="chat-rail-banner">{banner(referenceApi)}</div>}

      <div className="chat-rail-main">{children(referenceApi)}</div>

      {hasSide && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize reference panel"
          tabIndex={0}
          className="chat-rail-grip"
          onMouseDown={onGripMouseDown}
          onKeyDown={onGripKeyDown}
        />
      )}

      {hasSide && (
        <aside className="chat-rail-side">
          <div className="chat-rail-side-inner">
            {([hasTasks, hasReferences, hasSkills].filter(Boolean).length > 1 ||
              orderedTasks.length > 1 ||
              references.length > 1) && (
              <div className="chat-rail-section-tabs" role="tablist">
                {hasTasks &&
                  (orderedTasks.length > 1 ? (
                    <TaskTabMenu
                      tasks={orderedTasks}
                      activeRef={effectiveTaskRef}
                      selected={activeTab === 'tasks'}
                      onOpen={() => setActiveTab('tasks')}
                      onSelect={(ref) => {
                        setActiveTaskRef(ref);
                        setActiveTab('tasks');
                      }}
                    />
                  ) : (
                    <button
                      type="button"
                      role="tab"
                      className={`chat-rail-section-tab${activeTab === 'tasks' ? ' is-active' : ''}`}
                      aria-selected={activeTab === 'tasks'}
                      onClick={() => setActiveTab('tasks')}
                    >
                      Task
                    </button>
                  ))}
                {hasSkills && (
                  <button
                    type="button"
                    role="tab"
                    className={`chat-rail-section-tab${activeTab === 'skills' ? ' is-active' : ''}`}
                    aria-selected={activeTab === 'skills'}
                    onClick={() => setActiveTab('skills')}
                  >
                    Skills
                  </button>
                )}
                {hasReferences &&
                  (references.length > 1 ? (
                    <ReferenceTabMenu
                      refs={references}
                      activeKey={effectiveActive.key}
                      selected={activeTab === 'references'}
                      onOpen={() => setActiveTab('references')}
                      onSelect={(reference) => {
                        setActiveRef(reference);
                        setActiveTab('references');
                      }}
                    />
                  ) : (
                    <button
                      type="button"
                      role="tab"
                      className={`chat-rail-section-tab${
                        activeTab === 'references' ? ' is-active' : ''
                      }`}
                      aria-selected={activeTab === 'references'}
                      onClick={() => setActiveTab('references')}
                    >
                      References
                    </button>
                  ))}
              </div>
            )}
            {activeTab === 'tasks' && hasTasks && effectiveTaskRef && (
              <div className="chat-rail-section-body">
                <div className="chat-rail-viewer-wrap">
                  <TaskRailCard
                    key={effectiveTaskRef}
                    taskRef={effectiveTaskRef}
                    onOpenTask={(ref) =>
                      window.dispatchEvent(
                        new CustomEvent('gezel:open-tab', { detail: { kind: 'task', ref } }),
                      )
                    }
                  />
                </div>
              </div>
            )}
            {activeTab === 'references' && effectiveActive && (
              <div className="chat-rail-section-body">
                <div className="chat-rail-viewer-wrap">
                  <ReferenceViewer
                    key={effectiveActive.key}
                    projectId={effectiveActive.projectId ?? resolvedProjectId}
                    reference={effectiveActive}
                    onResolved={handleResolved}
                  />
                </div>
              </div>
            )}
            {activeTab === 'skills' && skillsProjectId && (
              <div className="chat-rail-section-body">
                <CommandsPanel
                  key={skillsProjectId}
                  projectId={skillsProjectId}
                  section="skills"
                  onAvailabilityChange={handleSkillsAvailabilityChange}
                />
              </div>
            )}
          </div>
        </aside>
      )}
    </div>
  );
}

/**
 * Right-rail task summary. Fetches the task by ref and shows a compact
 * "what is this and where am I in it" card — ref, status, title, the
 * craftbook it came from, and the step arc with the active step marked.
 * The full editable task view stays one click away via "Open full task".
 */
function TaskRailCard({
  taskRef,
  onOpenTask,
}: {
  taskRef: string;
  onOpenTask?: (ref: string) => void;
}) {
  const [task, setTask] = useState<Task | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [notes, setNotes] = useState<TaskNote[]>([]);
  const [notesState, setNotesState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [gezels, setGezels] = useState<GezelSummary[]>([]);

  useEffect(() => {
    let cancelled = false;
    api
      .listGezels()
      .then((res) => {
        if (!cancelled) setGezels(res.gezels);
      })
      .catch(() => {
        if (!cancelled) setGezels([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    setTask(null);
    api
      .getTaskByRef(taskRef)
      .then((t) => {
        if (!cancelled) {
          setTask(t);
          setLoaded(true);
        }
      })
      .catch(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [taskRef]);

  useEffect(() => {
    if (!task) {
      setNotes([]);
      setNotesState('idle');
      return;
    }

    let cancelled = false;
    setNotesState('loading');
    api
      .listTaskNotes(task.projectId, task.num)
      .then((res) => {
        if (cancelled) return;
        // Keep the compact history deterministic even if a future API source
        // stops returning task notes in its current newest-first order.
        setNotes([...res.notes].sort((a, b) => b.at.localeCompare(a.at)));
        setNotesState('ready');
      })
      .catch(() => {
        if (cancelled) return;
        setNotes([]);
        setNotesState('error');
      });

    return () => {
      cancelled = true;
    };
  }, [task]);

  if (!loaded) return <p className="muted small chat-rail-task-empty">Loading task…</p>;
  if (!task)
    return (
      <p className="muted small chat-rail-task-empty">
        Task <code>{taskRef}</code> not found.
      </p>
    );

  const cb = task.craftbook;
  const legacyTitleMatch = /^(.*) — \d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.exec(task.title);
  const legacyGeneratedTitle = cb && legacyTitleMatch?.[1] === cb.id;
  const displayTitle = legacyGeneratedTitle ? cb.name : task.title;
  return (
    <div className="chat-rail-task">
      <div className="chat-rail-task-topbar">
        <header className="chat-rail-task-header">
          <code className="chat-rail-task-ref">{task.ref}</code>
          <span className={`chat-rail-task-status chat-rail-task-status-${task.status}`}>
            {task.status}
          </span>
        </header>
        <button
          type="button"
          className="chat-rail-task-open"
          onClick={() => onOpenTask?.(task.ref)}
        >
          Open full task
        </button>
      </div>
      <h4 className="chat-rail-task-title">{displayTitle}</h4>
      {task.description && <p className="chat-rail-task-desc">{task.description}</p>}
      {cb && (
        <>
          <div className="chat-rail-task-craftbook">
            <span className="muted small">From craftbook</span> {cb.name}
          </div>
          <ol className="chat-rail-task-steps">
            {cb.steps.map((s) => {
              const state =
                s.id === task.activeStepId ? 'is-active' : s.completedAt ? 'is-done' : '';
              return (
                <li key={s.id} className={`chat-rail-task-step ${state}`}>
                  {s.name}
                </li>
              );
            })}
          </ol>
        </>
      )}
      <section className="chat-rail-task-history" aria-label="History and notes">
        <h5>History &amp; notes</h5>
        {notesState === 'loading' && <p className="muted small">Loading notes…</p>}
        {notesState === 'error' && <p className="muted small">Notes unavailable.</p>}
        {notesState === 'ready' && notes.length === 0 && (
          <p className="muted small">No notes yet.</p>
        )}
        {notes.length > 0 && (
          <ol className="chat-rail-task-notes">
            {notes.map((note) => {
              const step = note.stepId
                ? task.craftbook.steps.find((candidate) => candidate.id === note.stepId)
                : undefined;
              const authorGezelId = note.author.kind === 'gezel' ? note.author.gezelId : undefined;
              const authorGezel = authorGezelId
                ? gezels.find((gezel) => gezel.id === authorGezelId)
                : undefined;
              return (
                <li key={note.id} className="chat-rail-task-note">
                  <header className="chat-rail-task-note-header">
                    <span className="task-note-author-identity">
                      {authorGezel && (
                        <GezelIcon
                          svg={authorGezel.icon ?? null}
                          poppetje={authorGezel.poppetje}
                          iconOverride={authorGezel.iconOverride}
                          name={authorGezel.name}
                          size={22}
                        />
                      )}
                      <span>{note.author.kind === 'user' ? 'You' : note.author.name}</span>
                    </span>
                    <time dateTime={note.at} title={note.at}>
                      {formatTaskNoteTime(note.at)}
                    </time>
                    {step && <span className="chat-rail-task-note-step">{step.name}</span>}
                  </header>
                  <RenderedMarkdownPreview
                    markdown={note.text}
                    projectId={task.projectId}
                    articleId={`task-note-${note.id}`}
                  />
                </li>
              );
            })}
          </ol>
        )}
      </section>
    </div>
  );
}

function formatTaskNoteTime(at: string): string {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? at : date.toLocaleString();
}

function TaskTabMenu({
  tasks,
  activeRef,
  selected,
  onOpen,
  onSelect,
  variant = 'tab',
}: {
  tasks: TaskRef[];
  activeRef: string | null;
  selected: boolean;
  onOpen?: () => void;
  onSelect: (ref: string) => void;
  variant?: 'tab' | 'picker';
}) {
  return (
    <DropdownMenu.Root
      onOpenChange={(open) => {
        if (open) onOpen?.();
      }}
    >
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          role={variant === 'tab' ? 'tab' : undefined}
          className={
            variant === 'tab'
              ? `chat-rail-section-tab chat-rail-section-tab-menu${selected ? ' is-active' : ''}`
              : 'chat-rail-compact-picker chat-rail-section-tab-menu'
          }
          aria-selected={variant === 'tab' ? selected : undefined}
        >
          <span>{variant === 'tab' ? 'Tasks' : (activeRef ?? 'Choose task')}</span>
          <DropdownChevron className="chat-rail-section-tab-chevron" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="app-nav-menu chat-rail-task-menu"
          sideOffset={4}
          align="start"
          aria-label="Choose task"
        >
          {tasks.map((task) => {
            const active = task.ref === activeRef;
            return (
              <DropdownMenu.Item
                key={task.ref}
                className={`app-nav-menu-item chat-rail-task-menu-item${active ? ' active' : ''}`}
                aria-current={active ? 'true' : undefined}
                onSelect={() => onSelect(task.ref)}
                title={task.scoped ? `${task.ref} (this thread's task)` : task.ref}
              >
                <span className="chat-rail-menu-check" aria-hidden="true">
                  {active && (
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                      <path
                        d="m2.25 6.25 2.25 2.25 5.25-5.25"
                        stroke="currentColor"
                        strokeWidth="1.6"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  )}
                </span>
                <code className="chat-rail-task-menu-ref">{task.ref}</code>
                {task.scoped && <span className="chat-rail-task-menu-scope">This thread</span>}
              </DropdownMenu.Item>
            );
          })}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function ReferenceTabMenu({
  refs,
  activeKey,
  selected,
  onOpen,
  onSelect,
  variant = 'tab',
}: {
  refs: Reference[];
  activeKey: string | null;
  selected: boolean;
  onOpen?: () => void;
  onSelect: (r: Reference) => void;
  variant?: 'tab' | 'picker';
}) {
  const activeName = refs
    .find((reference) => reference.key === activeKey)
    ?.path.split('/')
    .pop();
  return (
    <DropdownMenu.Root
      onOpenChange={(open) => {
        if (open) onOpen?.();
      }}
    >
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          role={variant === 'tab' ? 'tab' : undefined}
          className={
            variant === 'tab'
              ? `chat-rail-section-tab chat-rail-section-tab-menu${selected ? ' is-active' : ''}`
              : 'chat-rail-compact-picker chat-rail-section-tab-menu'
          }
          aria-selected={variant === 'tab' ? selected : undefined}
        >
          <span>{variant === 'tab' ? 'References' : (activeName ?? 'Choose reference')}</span>
          <DropdownChevron className="chat-rail-section-tab-chevron" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="app-nav-menu chat-rail-reference-menu"
          sideOffset={4}
          align="start"
          aria-label="Choose reference"
        >
          {refs.map((reference) => {
            const active = reference.key === activeKey;
            const name = reference.path.split('/').pop() || reference.path;
            return (
              <DropdownMenu.Item
                key={reference.key}
                className={`app-nav-menu-item chat-rail-reference-menu-item${
                  active ? ' active' : ''
                }`}
                aria-current={active ? 'true' : undefined}
                onSelect={() => onSelect(reference)}
                title={reference.path}
              >
                <span className="chat-rail-menu-check" aria-hidden="true">
                  {active && (
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                      <path
                        d="m2.25 6.25 2.25 2.25 5.25-5.25"
                        stroke="currentColor"
                        strokeWidth="1.6"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  )}
                </span>
                <span className="chat-rail-reference-menu-name">{name}</span>
              </DropdownMenu.Item>
            );
          })}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/**
 * Ordered resolution for a reference: try the primary kind's store first
 * (the tool that produced it was almost always right), then fall back to
 * the other two stores if the file isn't where we expected. Returns the
 * kind that actually resolved so the UI can update the pill. Only fall
 * back on 404 — other errors (401, 500, network) propagate.
 */
type ResolvedReference =
  | { kind: RefKind; mode: 'text'; content: string }
  | { kind: RefKind; mode: 'markdown'; content: string; sidecarPath: string }
  | { kind: RefKind; mode: 'media'; mediaKind: 'image' | 'video' | 'audio'; blob: Blob }
  | { kind: RefKind; mode: 'binary' };

async function resolveReference(
  projectId: string,
  reference: Reference,
): Promise<ResolvedReference> {
  const order: RefKind[] = [
    reference.kind,
    ...(['artifact', 'workspace', 'document'] as const).filter((k) => k !== reference.kind),
  ];
  let lastErr: unknown = null;
  for (const kind of order) {
    try {
      const preview = await api.previewReference(projectId, { kind, path: reference.path });
      if (preview.mode === 'media') {
        const blob = await readBlobByKind(projectId, kind, reference.path);
        return { kind, mode: 'media', mediaKind: preview.mediaKind, blob };
      }
      return { kind, ...preview };
    } catch (err) {
      lastErr = err;
      if (err instanceof GezelApiError && err.status === 404) {
        continue;
      }
      throw err;
    }
  }
  throw lastErr ?? new Error(`not found: ${reference.path}`);
}

async function readBlobByKind(projectId: string, kind: RefKind, path: string): Promise<Blob> {
  if (kind === 'artifact') {
    return api.fetchProjectArtifactBlob(projectId, path);
  }
  if (kind === 'workspace') {
    return api.fetchProjectWorkspaceBlob(projectId, path);
  }
  return api.fetchDocumentBlob(path);
}

function ReferenceViewer({
  projectId,
  reference,
  onClose,
  onResolved,
}: {
  projectId: string;
  reference: Reference;
  onClose?: () => void;
  onResolved?: (refKey: string, resolvedKind: RefKind) => void;
}) {
  const [content, setContent] = useState<string | null>(null);
  const [contentMode, setContentMode] = useState<'text' | 'markdown' | null>(null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [mediaKind, setMediaKind] = useState<'image' | 'video' | 'audio' | null>(null);
  const [machineFile, setMachineFile] = useState(false);
  const [resolvedKind, setResolvedKind] = useState<RefKind>(reference.kind);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let createdUrl: string | null = null;
    setLoading(true);
    setContent(null);
    setContentMode(null);
    setBlobUrl(null);
    setMediaKind(null);
    setMachineFile(false);
    setError(null);
    setActionError(null);
    setResolvedKind(reference.kind);
    void (async () => {
      try {
        const res = await resolveReference(projectId, reference);
        if (cancelled) return;
        if (res.mode === 'media') {
          createdUrl = URL.createObjectURL(res.blob);
          setBlobUrl(createdUrl);
          setMediaKind(res.mediaKind);
        } else if (res.mode === 'binary') {
          setMachineFile(true);
        } else {
          setContent(res.content);
          setContentMode(res.mode);
        }
        setResolvedKind(res.kind);
        if (res.kind !== reference.kind) {
          onResolved?.(reference.key, res.kind);
        }
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof GezelApiError && err.status === 404
              ? `Not found in artifacts, workspace, or documents: ${reference.path}`
              : (err as Error).message,
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [projectId, reference, onResolved]);

  const resolvedDiffers = resolvedKind !== reference.kind;
  const actionRequest = { projectId, kind: resolvedKind, path: reference.path } as const;

  const saveCopy = async () => {
    setActionError(null);
    const action = window.__GEZEL__?.saveReferenceCopy;
    if (!action) {
      setActionError('Saving a copy is available in the desktop app.');
      return;
    }
    try {
      const result = await action(actionRequest);
      if (!result.ok) setActionError(result.error);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  };

  const showContainingFolder = async () => {
    setActionError(null);
    const action = window.__GEZEL__?.showReferenceInFolder;
    if (!action) {
      setActionError('Showing the containing folder is available in the desktop app.');
      return;
    }
    try {
      const result = await action(actionRequest);
      if (!result.ok) setActionError(result.error);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="chat-rail-viewer">
      <header className="chat-rail-viewer-header">
        <div>
          <span className={`chat-rail-ref-kind chat-rail-ref-kind-${resolvedKind}`}>
            {resolvedKind}
          </span>
          {resolvedDiffers && (
            <span className="muted small" style={{ marginLeft: '0.35rem' }}>
              (resolved from {reference.kind})
            </span>
          )}
          <code className="chat-rail-viewer-path">{reference.path}</code>
        </div>
        <div className="chat-rail-viewer-actions">
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button
                type="button"
                className="tree-actions-trigger chat-rail-viewer-actions-trigger"
                aria-label={`Actions for ${reference.path.split('/').pop() || reference.path}`}
                title="File actions"
              >
                <span aria-hidden="true">⋯</span>
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                className="app-nav-menu tree-actions-menu chat-rail-viewer-actions-menu"
                sideOffset={4}
                align="end"
              >
                <DropdownMenu.Item className="app-nav-menu-item" onSelect={() => void saveCopy()}>
                  Save copy as…
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  className="app-nav-menu-item"
                  onSelect={() => void showContainingFolder()}
                >
                  Open containing folder
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
          {onClose && (
            <button type="button" className="chat-rail-viewer-close" onClick={onClose}>
              ×
            </button>
          )}
        </div>
      </header>
      {actionError && <p className="error small chat-rail-viewer-action-error">{actionError}</p>}
      <div className="chat-rail-viewer-body">
        {loading && <p className="muted small">Loading…</p>}
        {error && <p className="error">{error}</p>}
        {blobUrl !== null && !loading && !error && mediaKind === 'video' && (
          <ReferenceVideoPreview path={reference.path} src={blobUrl} />
        )}
        {blobUrl !== null && !loading && !error && mediaKind === 'audio' && (
          <ReferenceAudioPreview path={reference.path} src={blobUrl} />
        )}
        {blobUrl !== null && !loading && !error && mediaKind === 'image' && (
          <ReferenceImagePreview path={reference.path} src={blobUrl} />
        )}
        {machineFile && !loading && !error && (
          <ReferenceMachineFile
            path={reference.path}
            onSaveCopy={() => void saveCopy()}
            onOpenContainingFolder={() => void showContainingFolder()}
          />
        )}
        {content !== null &&
          !loading &&
          !error &&
          (contentMode === 'markdown' || isMarkdown(reference.path) ? (
            <RenderedMarkdownPreview
              markdown={content}
              projectId={projectId}
              reportPath={resolvedKind === 'artifact' ? reference.path : undefined}
            />
          ) : isHtml(reference.path) &&
            (resolvedKind === 'artifact' || resolvedKind === 'workspace') ? (
            // Artifact or workspace HTML both go through the shared
            // `HtmlPreviewFrame` primitive, which first mints a scoped
            // capability and then loads `/preview/:capability/:source/*`.
            // Relative `<link>` / `<script>` / `<img>` references
            // resolve against sibling files on the same origin.
            <HtmlPreviewFrame
              projectId={projectId}
              path={reference.path}
              source={resolvedKind === 'workspace' ? 'workspace' : 'artifacts'}
              title={reference.path}
              className="chat-rail-viewer-iframe"
            />
          ) : (
            // Global-library HTML has no scoped preview capability. Render it
            // as inert source instead of srcDoc: CSP cannot reliably prevent
            // every document-navigation channel (for example meta refresh)
            // in a normal browser shell.
            <ReferenceCodePreview path={reference.path} content={content} />
          ))}
      </div>
    </div>
  );
}

function ReferenceCodePreview({ path, content }: { path: string; content: string }) {
  const editorTheme = useEffectiveTheme();
  return (
    <div className="chat-rail-viewer-code">
      <EditorShell
        key={path}
        initialMarkdown={content}
        fileName={path}
        height="100%"
        colorScheme={editorTheme}
        showPlayTab={false}
        fullWidth
        readOnly
      />
    </div>
  );
}

function ReferenceImagePreview({ path, src }: { path: string; src: string }) {
  return (
    <div className="chat-rail-viewer-code">
      <img
        key={path}
        src={src}
        alt={path}
        style={{
          maxWidth: '100%',
          maxHeight: '100%',
          objectFit: 'contain',
          display: 'block',
          margin: '0 auto',
        }}
      />
    </div>
  );
}

function ReferenceVideoPreview({ path, src }: { path: string; src: string }) {
  return (
    <div className="chat-rail-viewer-code">
      {/* biome-ignore lint/a11y/useMediaCaption: generated clips have no caption track. */}
      <video
        key={path}
        src={src}
        controls
        preload="metadata"
        playsInline
        style={{
          maxWidth: '100%',
          maxHeight: '100%',
          display: 'block',
          margin: '0 auto',
          background: '#000',
        }}
      />
    </div>
  );
}

function ReferenceAudioPreview({ path, src }: { path: string; src: string }) {
  return (
    <div className="chat-rail-viewer-code chat-rail-audio-preview">
      {/* biome-ignore lint/a11y/useMediaCaption: user-created audio has no caption track. */}
      <audio key={path} src={src} controls preload="metadata" />
    </div>
  );
}

function ReferenceMachineFile({
  path,
  onSaveCopy,
  onOpenContainingFolder,
}: {
  path: string;
  onSaveCopy: () => void;
  onOpenContainingFolder: () => void;
}) {
  return (
    <div className="chat-rail-machine-file">
      <svg
        className="chat-rail-machine-file-icon"
        width="40"
        height="40"
        viewBox="0 0 40 40"
        fill="none"
        aria-hidden="true"
      >
        <path d="M10 4h13l7 7v25H10z" stroke="currentColor" strokeWidth="1.5" />
        <path d="M23 4v8h7M15 21h10M15 26h10" stroke="currentColor" strokeWidth="1.5" />
      </svg>
      <p className="chat-rail-machine-file-label">{'<Machine File>'}</p>
      <code className="chat-rail-machine-file-path">{path}</code>
      <div className="chat-rail-machine-file-actions">
        <button type="button" onClick={onSaveCopy}>
          Save copy as…
        </button>
        <button type="button" onClick={onOpenContainingFolder}>
          Open containing folder
        </button>
      </div>
    </div>
  );
}

// Gezel-tinted surface schemes for the artifact previewer. Squisq's
// stock `DARK_SURFACE` is `#1a202c` (a cool slate-blue) which fights
// the rest of the app's warm/sage palette — the previewer reads as
// "from a different product" against the gezel chrome. These two
// surfaces match the app's `--bg` / `--panel` neutrals (a hair of
// green undertone in dark mode, the warm cream in light mode) so the
// artifact panel sits naturally inside the references rail.
const GEZEL_DARK_SURFACE = {
  id: 'gezel-dark',
  background: '#1c1f1c',
  backgroundLight: '#252925',
  text: '#f0ede4',
  textMuted: '#9da195',
} as const;

const GEZEL_LIGHT_SURFACE = {
  id: 'gezel-light',
  background: '#f3eddf',
  backgroundLight: '#eae5d6',
  text: '#1c1c1c',
  textMuted: '#666666',
} as const;

function RenderedMarkdownPreview({
  markdown,
  projectId,
  reportPath,
  articleId = 'ref-preview',
}: {
  markdown: string;
  projectId: string;
  /** Artifacts-relative path when this preview shows an artifact — enables gezel-action cards. */
  reportPath?: string;
  /** Keeps multiple compact Markdown documents from sharing generated ids. */
  articleId?: string;
}) {
  const doc = useMemo(() => {
    try {
      const mdDoc = parseMarkdown(markdown);
      return markdownToDoc(mdDoc, { articleId });
    } catch {
      return null;
    }
  }, [articleId, markdown]);
  const effective = useEffectiveTheme();
  // Report artifacts may embed gezel-action blocks — register the fence
  // renderer so recommendations render as fireable cards in the rail.
  const fenceRenderers = useMemo(
    () =>
      reportPath && hasReportActionFence(markdown)
        ? makeReportActionFenceRenderers({ projectId, reportPath })
        : undefined,
    [markdown, projectId, reportPath],
  );
  // Same theme the chat bubbles render with — defined in
  // [chat-theme.ts](./chat-theme.ts). Gezel-tinted surface (warm/sage,
  // not Squisq's stock cool slate-blue) so the previewer reads as part
  // of the app chrome.
  const surface = effective === 'dark' ? GEZEL_DARK_SURFACE : GEZEL_LIGHT_SURFACE;
  if (!doc) return <pre className="chat-rail-viewer-raw">{markdown}</pre>;
  return (
    <div className="chat-rail-viewer-markdown">
      <LinearDocView
        doc={doc}
        theme={gezelChatTheme}
        surface={surface}
        fenceRenderers={fenceRenderers}
      />
    </div>
  );
}
