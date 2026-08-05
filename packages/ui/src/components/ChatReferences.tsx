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
import { DropdownChevron, DropdownMenu } from '../primitives/index.js';
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
 * Minimum widths for the split chat/reference layout. The side rail drops
 * before the conversation can shrink below 480 px; while the split remains,
 * CSS caps the resizable side track against the same constraint. This is
 * measured on the rail itself because an output pane can squeeze chat even
 * while the surrounding project view is still wide.
 */
export const CHAT_RAIL_MIN_CHAT_PX = 480;
const CHAT_RAIL_MIN_SIDE_PX = 192;
const CHAT_RAIL_GRIP_TRACK_PX = 14;
export const CHAT_RAIL_MIN_SPLIT_PX =
  CHAT_RAIL_MIN_CHAT_PX + CHAT_RAIL_MIN_SIDE_PX + CHAT_RAIL_GRIP_TRACK_PX;

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

function isImage(path: string): boolean {
  return /\.(png|jpg|jpeg|gif|webp|bmp|ico|avif)$/i.test(path);
}

function isVideo(path: string): boolean {
  return /\.(mp4|webm|ogv|mov|m4v)$/i.test(path);
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
   */
  onTaskReference: (ref: string, opts?: { scoped?: boolean }) => void;
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
  commandsProjectId,
  compact = false,
  onStageTerminalCommand,
  children,
}: {
  /** Project context used to resolve reference paths. Defaults to 'default'. */
  projectId?: string;
  /** Stable key for the current chat — changing it resets the reference list. */
  chatKey: string;
  /**
   * When set, the side rail gains a "Commands" tab that lists the
   * workspace's discovered runnable commands for this project. The
   * rail is always visible while this prop is set, even with no
   * references in the chat. Omit for chats that aren't scoped to a
   * single project workspace (the global Meester timeline).
   */
  commandsProjectId?: string;
  /**
   * Narrow-form-factor mode (VS Code chat panel, mobile, anywhere the
   * pane is under ~500 px wide). The side rail — commands listing,
   * artifact previewer, resize grip — is suppressed entirely; only
   * the chat surface renders. Tool-activity is still tracked (so
   * follow-up surfaces could surface references differently) but no
   * preview UI is offered. Callers should also avoid passing
   * `commandsProjectId` in compact mode if they want a guarantee the
   * commands list never spawns its fetch loop.
   */
  compact?: boolean;
  /**
   * Stage a command string into the project-chat terminal composer
   * (switch to terminal mode + insert text; does NOT run it). Wired from
   * ProjectChatBody and handed to the CommandsPanel craftbook launcher.
   * Optional — surfaces without a terminal (the Meester timeline) omit it.
   */
  onStageTerminalCommand?: (command: string) => void;
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
  const [activeTab, setActiveTab] = useState<'tasks' | 'references' | 'commands'>(
    commandsProjectId ? 'commands' : 'references',
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: chatKey is the reset trigger — the effect body doesn't read it, but changing it must re-fire.
  useEffect(() => {
    setReferences([]);
    setActiveRef(null);
    setTaskRefs([]);
    setActiveTaskRef(null);
  }, [chatKey]);

  const handleTaskReference = useCallback((ref: string, opts?: { scoped?: boolean }) => {
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
  }, []);

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
    if (!tool.path) return;
    const kind = classifyTool(tool.name);
    if (!kind) return;
    // Workspace HTML already gets a dedicated, larger live preview in the
    // left-hand Output pane (ProjectOutputPane). Surfacing it here too just
    // duplicates the running app, so skip it. Non-HTML workspace files
    // (code, markdown, images) and artifact/document references aren't
    // shown by the Output pane, so they still belong in this rail.
    if (kind === 'workspace' && isHtml(tool.path)) return;
    const key = referenceKey(kind, tool.projectId, tool.path);
    setReferences((prev) => {
      if (prev.some((r) => r.key === key)) return prev;
      return [
        ...prev,
        {
          key,
          kind,
          path: tool.path!,
          firstSeenAt: Date.now(),
          ...(tool.projectId ? { projectId: tool.projectId } : {}),
        },
      ];
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
    if (ref) setActiveRef(ref);
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
    if (ref) setActiveRef(ref);
  }, []);

  const api = useMemo<ChatReferencesApi>(
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
  // we also measure this rail's own width here.
  const narrow = useCompactLayout(containerRef, CHAT_RAIL_MIN_SPLIT_PX);
  const isCompact = compact || narrow;

  const effectiveActive = activeRef ?? references[0] ?? null;
  const hasReferences = effectiveActive !== null;
  const hasCommands = Boolean(commandsProjectId);
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
  const hasSide = !isCompact && (hasTasks || hasReferences || hasCommands);

  // Auto-switch to References whenever a new ref arrives, but only on
  // the rising edge — don't fight the user if they've manually
  // selected Commands and then dismiss a viewer.
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

  // Compact short-circuit: skip the grid layout (and the empty `<aside>`
  // that the default chat-rail-body grid reserves a 22 rem column for)
  // so the chat surface gets the full pane width. No side rail, no
  // grip, no commands panel — what the VS Code chat webview wants.
  if (isCompact) {
    return (
      <div ref={containerRef} className="chat-rail-body chat-rail-body-compact">
        <div className="chat-rail-main">{children(api)}</div>
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
      <div className="chat-rail-main">{children(api)}</div>

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

      <aside className="chat-rail-side">
        {hasSide && (
          <div className="chat-rail-side-inner">
            {([hasTasks, hasReferences, hasCommands].filter(Boolean).length > 1 ||
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
                {hasCommands && (
                  <button
                    type="button"
                    role="tab"
                    className={`chat-rail-section-tab${activeTab === 'commands' ? ' is-active' : ''}`}
                    aria-selected={activeTab === 'commands'}
                    onClick={() => setActiveTab('commands')}
                  >
                    Commands
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
            {activeTab === 'commands' && commandsProjectId && (
              <div className="chat-rail-section-body">
                <CommandsPanel
                  projectId={commandsProjectId}
                  {...(onStageTerminalCommand ? { onStageCommand: onStageTerminalCommand } : {})}
                />
              </div>
            )}
          </div>
        )}
      </aside>
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
}: {
  tasks: TaskRef[];
  activeRef: string | null;
  selected: boolean;
  onOpen: () => void;
  onSelect: (ref: string) => void;
}) {
  return (
    <DropdownMenu.Root
      onOpenChange={(open) => {
        if (open) onOpen();
      }}
    >
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          role="tab"
          className={`chat-rail-section-tab chat-rail-section-tab-menu${
            selected ? ' is-active' : ''
          }`}
          aria-selected={selected}
        >
          <span>Tasks</span>
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
}: {
  refs: Reference[];
  activeKey: string | null;
  selected: boolean;
  onOpen: () => void;
  onSelect: (r: Reference) => void;
}) {
  return (
    <DropdownMenu.Root
      onOpenChange={(open) => {
        if (open) onOpen();
      }}
    >
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          role="tab"
          className={`chat-rail-section-tab chat-rail-section-tab-menu${
            selected ? ' is-active' : ''
          }`}
          aria-selected={selected}
        >
          <span>References</span>
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
  | { kind: RefKind; mode: 'blob'; blob: Blob };

async function resolveReference(
  projectId: string,
  reference: Reference,
): Promise<ResolvedReference> {
  const order: RefKind[] = [
    reference.kind,
    ...(['artifact', 'workspace', 'document'] as const).filter((k) => k !== reference.kind),
  ];
  const wantBlob = isImage(reference.path) || isVideo(reference.path);
  let lastErr: unknown = null;
  for (const kind of order) {
    try {
      if (wantBlob) {
        const blob = await readBlobByKind(projectId, kind, reference.path);
        return { kind, mode: 'blob', blob };
      }
      const content = await readByKind(projectId, kind, reference.path);
      return { kind, mode: 'text', content };
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

async function readByKind(projectId: string, kind: RefKind, path: string): Promise<string> {
  if (kind === 'artifact') {
    const r = await api.readProjectArtifact(projectId, path);
    return r.content;
  }
  if (kind === 'document') {
    const r = await api.readDocument(path);
    return r.content;
  }
  const r = await api.readProjectWorkspaceFile(projectId, path);
  return r.content;
}

async function readBlobByKind(projectId: string, kind: RefKind, path: string): Promise<Blob> {
  if (kind === 'artifact') {
    return api.fetchProjectArtifactBlob(projectId, path);
  }
  if (kind === 'workspace') {
    return api.fetchProjectWorkspaceBlob(projectId, path);
  }
  // Documents are global and currently text-only — fall back to fetching
  // the text body and wrapping it in a Blob so the caller's image branch
  // can still render whatever was returned (rare path; mostly here so the
  // kind-cascade doesn't dead-end).
  const r = await api.readDocument(path);
  return new Blob([r.content]);
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
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [resolvedKind, setResolvedKind] = useState<RefKind>(reference.kind);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let createdUrl: string | null = null;
    setLoading(true);
    setContent(null);
    setImageUrl(null);
    setError(null);
    setActionError(null);
    setResolvedKind(reference.kind);
    void (async () => {
      try {
        const res = await resolveReference(projectId, reference);
        if (cancelled) return;
        if (res.mode === 'blob') {
          createdUrl = URL.createObjectURL(res.blob);
          setImageUrl(createdUrl);
        } else {
          setContent(res.content);
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
                  Show containing folder
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
        {imageUrl !== null && !loading && !error && isVideo(reference.path) && (
          <ReferenceVideoPreview path={reference.path} src={imageUrl} />
        )}
        {imageUrl !== null && !loading && !error && !isVideo(reference.path) && (
          <ReferenceImagePreview path={reference.path} src={imageUrl} />
        )}
        {content !== null &&
          !loading &&
          !error &&
          (isMarkdown(reference.path) ? (
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
          ) : isHtml(reference.path) ? (
            // Document HTML has no project-scoped preview route (the
            // documents library is global). Fall back to `srcDoc` with
            // the same sandbox attributes — loses relative-asset
            // resolution but stays isolated.
            <iframe
              title={reference.path}
              srcDoc={content}
              sandbox="allow-scripts"
              referrerPolicy="no-referrer"
              className="chat-rail-viewer-iframe"
            />
          ) : (
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
