import type { GezelSummary, Project, RecentTab, RecentTabArea } from '@bendyline/gezel';
import { displayName } from '@bendyline/gezel';
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { api } from '../api.js';
import { Tooltip } from '../primitives/index.js';
import { requestSettingsSection } from '../settings-nav.js';
import { getSidebarSide } from '../sidebar-side.js';
import { railSystemNotices } from '../system-notices.js';
import { useUpdateState } from '../update-state.js';
import { AreaIcon } from './AreaIcon.js';
import { type FileEntry, FileTree } from './FileTree.js';
import { GezelActionsMenu } from './GezelActionsMenu.js';
import { GezelIcon } from './GezelIcon.js';
import { NewPathDialog } from './NewPathDialog.js';
import { ProjectActionsMenu } from './ProjectActionsMenu.js';
import { ProjectQuestionsDialog } from './ProjectQuestionsDialog.js';
import { type CreateKind, requestCreate } from './nav-intents.js';
import { queueFocusSessionError } from './pending-focus-session-error.js';
import { tabKey, toRecentTab } from './recent-tabs.js';
import { useIsFirstRun } from './useIsFirstRun.js';
import { useRoleBasedNameOnlyMode } from './useRoleBasedNameOnlyMode.js';
import { useShowAdvancedFeatures } from './useShowAdvancedFeatures.js';

/**
 * Plain-language blurbs for the Dutch craft roles — shown as the sidebar
 * subtitle in boring mode (where the label is the role name itself) and in the
 * hover tooltip otherwise. Keyed by lowercased role; matched against both the
 * gezel's `role` and its `roleBasedName`.
 */
const ROLE_DESCRIPTIONS: Record<string, string> = {
  klerk: 'Writing and editing',
  meester: 'Primary concierge',
  voorman: 'Manages projects',
  boekwachter: 'Indexes/catalogs content',
};

type ProjectLifecycleStatus = NonNullable<Project['status']>;

const PROJECT_STATUS_DESCRIPTIONS: Record<ProjectLifecycleStatus, string> = {
  active: 'Active — automatic project work can run, including scheduled tasks and handoffs.',
  stable:
    'Stable — work is at rest because its tasks are finished or canceled; new or resumed tasks reactivate it.',
  readonly: 'Read-only — automatic project work is paused for review; chat still works.',
  inactive:
    'Inactive — the project is archived and automatic project work is paused; chat still works.',
};

function roleDescription(role?: string, roleBasedName?: string): string {
  for (const candidate of [role, roleBasedName]) {
    const key = candidate?.trim().toLowerCase();
    if (!key) continue;
    for (const [roleKey, desc] of Object.entries(ROLE_DESCRIPTIONS)) {
      if (key === roleKey || key.includes(roleKey)) return desc;
    }
  }
  return '';
}

interface SidebarProps {
  /** The current selection. `null` means the Meester home view. */
  selection: RecentTab | null;
  /** Select an entity (or `null` for Meester home). */
  onSelect: (tab: RecentTab | null) => void;
  /** Open a top-level area (Tasks, Settings, Scripts, …). */
  onOpenArea: (area: RecentTabArea) => void;
  /** Project ids with a gezel currently mid-turn — drives the animated
   *  "thinking" indicator on the row (replaces the status dot). */
  activeProjectIds?: Set<string>;
  /** projectId → count of pending questions — drives the "needs input"
   *  affordance that opens the resolution dialog. */
  pendingByProject?: Map<string, number>;
  /** projectId → the poisoned (last-turn-errored) session awaiting a user
   *  turn — drives the "last turn failed" indicator that opens the chat. */
  poisonedProjects?: Map<string, { sessionId: string; gezelId: string; error: string }>;
}

type GroupId = 'projects' | 'documents' | 'gezels';

const WIDTH_KEY = 'gezel:nav:sidebar-width';
const COLLAPSED_KEY = 'gezel:nav:sidebar-collapsed';
const GROUPS_KEY = 'gezel:nav:groups';

const MIN_WIDTH = 180;
const MAX_WIDTH = 420;
const DEFAULT_WIDTH = 240;
const COLLAPSED_WIDTH = 40;
/** Drag this far left of MIN_WIDTH and the rail snaps to icon-only mode. */
const COLLAPSE_SNAP = 20;

const DEFAULT_GROUPS: Record<GroupId, boolean> = {
  projects: true,
  documents: false,
  gezels: false,
};

// Top-level area links rendered below the groups (Settings is pulled out
// last). Scripts/History live here as plain links per the nav design rather
// than under a "More" group. Benchmarks is intentionally absent — it now
// lives behind the debug-gated "Benchmarks" tab in Settings.
const AREA_LINKS: RecentTabArea[] = [
  'tasks',
  'craftbooks',
  'scripts',
  'history',
  'handboek',
  'settings',
];

// The built-in "Default" project is an always-present scratchpad, not a
// user-created project. Hide it from the sidebar's Projects group so the
// list only shows projects the user actually started. It's still
// reachable as the implicit target for ambient/scratch chats.
const HIDDEN_PROJECT_IDS = new Set<string>(['default']);
const AREA_LINK_LABELS: Record<RecentTabArea, string> = {
  projects: 'Projects',
  gezels: 'Gezellen',
  documents: 'Documents',
  tasks: 'Tasks',
  craftbooks: 'Craftbooks',
  scripts: 'Scripts',
  history: 'History',
  handboek: 'Handboek',
  benchmarks: 'Benchmarks',
  settings: 'Settings',
};

function readStoredWidth(): number {
  try {
    const raw = window.localStorage.getItem(WIDTH_KEY);
    if (!raw) return DEFAULT_WIDTH;
    const n = Number.parseInt(raw, 10);
    if (Number.isNaN(n)) return DEFAULT_WIDTH;
    return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, n));
  } catch {
    return DEFAULT_WIDTH;
  }
}

function readStoredCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

function readStoredGroups(): Record<GroupId, boolean> {
  try {
    const raw = window.localStorage.getItem(GROUPS_KEY);
    if (!raw) return { ...DEFAULT_GROUPS };
    const parsed = JSON.parse(raw) as Partial<Record<GroupId, boolean>>;
    return {
      projects: parsed.projects ?? DEFAULT_GROUPS.projects,
      documents: parsed.documents ?? DEFAULT_GROUPS.documents,
      gezels: parsed.gezels ?? DEFAULT_GROUPS.gezels,
    };
  } catch {
    return { ...DEFAULT_GROUPS };
  }
}

/** Stable color + initial for a project's icon badge (no avatar data). */
function projectInitial(name: string): string {
  return (name.trim()[0] ?? '?').toUpperCase();
}
function hueFromString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}

export function Sidebar({
  selection,
  onSelect,
  onOpenArea,
  activeProjectIds,
  pendingByProject,
  poisonedProjects,
}: SidebarProps) {
  const [projects, setProjects] = useState<Project[]>([]);
  // The project whose pending-question resolution dialog is open, if any.
  const [resolveProjectId, setResolveProjectId] = useState<string | null>(null);
  const visibleProjects = useMemo(
    () => projects.filter((p) => !HIDDEN_PROJECT_IDS.has(p.id)),
    [projects],
  );
  const [gezels, setGezels] = useState<GezelSummary[]>([]);
  const [meesterGezelId, setMeesterGezelId] = useState<string | undefined>(undefined);
  const [docs, setDocs] = useState<FileEntry[]>([]);
  const [showNewDoc, setShowNewDoc] = useState(false);
  const [groups, setGroups] = useState<Record<GroupId, boolean>>(() => readStoredGroups());
  const [width, setWidth] = useState<number>(() => readStoredWidth());
  const [collapsed, setCollapsed] = useState<boolean>(() => readStoredCollapsed());
  const roleBasedNameOnly = useRoleBasedNameOnlyMode();
  const showAdvancedFeatures = useShowAdvancedFeatures();
  // Until setup is done, the home tab reads "Get started" instead of "Home".
  const firstRun = useIsFirstRun();
  const meester = gezels.find((gezel) => gezel.id === meesterGezelId);
  const meesterName = meester ? displayName(meester, roleBasedNameOnly) : '';
  // "Home" carries the weight; the meester's name rides along muted. The
  // old dash-paren form ("Home - (Meester Ada Lovela…") truncated into
  // punctuation soup.
  const homeLabel = firstRun ? 'Get started' : meesterName ? `Home · ${meesterName}` : 'Home';
  const homeTitle = firstRun
    ? 'Get started'
    : meesterName
      ? `Home — your meester, ${meesterName}`
      : 'Home';
  // "Scripts" is a power-user surface — gated behind Settings → About →
  // Advanced → "Show advanced features".
  const areaLinks = useMemo(
    () => AREA_LINKS.filter((area) => area !== 'scripts' || showAdvancedFeatures),
    [showAdvancedFeatures],
  );
  // Install-health notices (background service, updater). They live here
  // rather than across the top of Home: neither is urgent, and neither is
  // fixable without the installer. See system-notices.ts.
  const updateState = useUpdateState();
  const systemNotices = railSystemNotices({
    reason: window.__GEZEL__?.fallbackReason ?? null,
    code: window.__GEZEL__?.fallbackCode ?? null,
    ...(window.__GEZEL__?.platform ? { platform: window.__GEZEL__.platform } : {}),
    update: updateState,
  });

  // ── Live entity lists ───────────────────────────────────────────
  const refreshProjects = useCallback(() => {
    api
      .listProjects()
      .then((r) => setProjects(r.projects))
      .catch(() => {});
  }, []);
  const refreshGezels = useCallback(() => {
    api
      .listGezels()
      .then((r) => setGezels(r.gezels))
      .catch(() => {});
  }, []);
  const refreshMeesterConfig = useCallback(() => {
    api
      .getConfig()
      .then((config) => setMeesterGezelId(config.meesterGezelId))
      .catch(() => {});
  }, []);
  const refreshDocs = useCallback(() => {
    api
      .listDocuments('', true)
      .then((r) => setDocs(r.files))
      .catch(() => {});
  }, []);

  useEffect(() => {
    refreshProjects();
    refreshGezels();
    refreshMeesterConfig();
    refreshDocs();
  }, [refreshProjects, refreshGezels, refreshMeesterConfig, refreshDocs]);

  // Renames / creates / deletes elsewhere flow back in via the same
  // window events the detail views already broadcast.
  useEffect(() => {
    const onGezel = () => refreshGezels();
    const onGezelDeleted = () => {
      refreshGezels();
      refreshMeesterConfig();
    };
    const onProject = () => refreshProjects();
    const onDoc = () => refreshDocs();
    const onConfig = (e: Event) => {
      const detail = (e as CustomEvent<{ meesterGezelId?: string }>).detail;
      if (detail && Object.hasOwn(detail, 'meesterGezelId')) {
        setMeesterGezelId(detail.meesterGezelId);
      }
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        refreshProjects();
        refreshGezels();
        refreshMeesterConfig();
        refreshDocs();
      }
    };
    window.addEventListener('gezel:gezel-updated', onGezel);
    window.addEventListener('gezel:gezel-deleted', onGezelDeleted);
    window.addEventListener('gezel:config-updated', onConfig);
    window.addEventListener('gezel:project-opened', onProject);
    // Fired by App's global SSE bridge when a project is created
    // anywhere — including a `start_project` macro a gezel runs
    // mid-chat — so the list folds it in without a manual refresh.
    window.addEventListener('gezel:project-created', onProject);
    // Fired locally by the Project Actions menu and re-broadcast by App's
    // SSE bridge when a project is deleted anywhere, so the row drops live.
    window.addEventListener('gezel:project-deleted', onProject);
    window.addEventListener('gezel:document-created', onDoc);
    window.addEventListener('gezel:document-renamed', onDoc);
    window.addEventListener('gezel:document-deleted', onDoc);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('gezel:gezel-updated', onGezel);
      window.removeEventListener('gezel:gezel-deleted', onGezelDeleted);
      window.removeEventListener('gezel:config-updated', onConfig);
      window.removeEventListener('gezel:project-opened', onProject);
      window.removeEventListener('gezel:project-created', onProject);
      window.removeEventListener('gezel:project-deleted', onProject);
      window.removeEventListener('gezel:document-created', onDoc);
      window.removeEventListener('gezel:document-renamed', onDoc);
      window.removeEventListener('gezel:document-deleted', onDoc);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refreshProjects, refreshGezels, refreshMeesterConfig, refreshDocs]);

  // ── Persistence helpers ─────────────────────────────────────────
  const commitWidth = useCallback((px: number) => {
    const clamped = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(px)));
    setWidth(clamped);
    try {
      window.localStorage.setItem(WIDTH_KEY, String(clamped));
    } catch {
      /* private mode / quota */
    }
  }, []);
  const commitCollapsed = useCallback((v: boolean) => {
    setCollapsed(v);
    try {
      window.localStorage.setItem(COLLAPSED_KEY, v ? '1' : '0');
    } catch {
      /* private mode / quota */
    }
  }, []);
  const commitGroups = useCallback((next: Record<GroupId, boolean>) => {
    setGroups(next);
    try {
      window.localStorage.setItem(GROUPS_KEY, JSON.stringify(next));
    } catch {
      /* private mode / quota */
    }
  }, []);

  const toggleGroup = useCallback(
    (id: GroupId) => {
      // Toggling a group while collapsed first expands the rail so the
      // freshly-opened list is actually visible.
      if (collapsed) {
        commitCollapsed(false);
        commitGroups({ ...groups, [id]: true });
        return;
      }
      commitGroups({ ...groups, [id]: !groups[id] });
    },
    [collapsed, groups, commitCollapsed, commitGroups],
  );

  // ── Drag-to-resize (adapted from ChatReferences) ────────────────
  const dragState = useRef<{ startX: number; startWidth: number } | null>(null);
  const onGripMouseDown = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      e.preventDefault();
      dragState.current = { startX: e.clientX, startWidth: collapsed ? COLLAPSED_WIDTH : width };
      // Neutralize iframes/webviews so they don't swallow the drag (see
      // the `body.app-resizing` rule in styles.css).
      document.body.classList.add('app-resizing');
      document.body.style.cursor = 'col-resize';
      const widthDirection = getSidebarSide() === 'left' ? 1 : -1;
      const onMove = (ev: MouseEvent) => {
        if (!dragState.current) return;
        const { startX, startWidth } = dragState.current;
        // The grip sits on the sidebar's inner edge: rightward motion grows
        // a left rail, while leftward motion grows a right rail.
        const next = startWidth + (ev.clientX - startX) * widthDirection;
        if (next < MIN_WIDTH - COLLAPSE_SNAP) {
          commitCollapsed(true);
        } else {
          commitCollapsed(false);
          commitWidth(next);
        }
      };
      const onUp = () => {
        dragState.current = null;
        document.body.style.cursor = '';
        document.body.classList.remove('app-resizing');
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [collapsed, width, commitWidth, commitCollapsed],
  );

  const onGripKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      const step = e.shiftKey ? 24 : 8;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        const physicalDirection = e.key === 'ArrowLeft' ? -1 : 1;
        const widthDirection = getSidebarSide() === 'left' ? 1 : -1;
        const delta = physicalDirection * widthDirection * step;
        if (collapsed && delta < 0) return;
        const next = (collapsed ? MIN_WIDTH : width) + delta;
        if (next < MIN_WIDTH - COLLAPSE_SNAP) {
          commitCollapsed(true);
          return;
        }
        commitCollapsed(false);
        commitWidth(next);
      } else if (e.key === 'Home') {
        e.preventDefault();
        commitCollapsed(false);
        commitWidth(MAX_WIDTH);
      } else if (e.key === 'End') {
        e.preventDefault();
        commitCollapsed(false);
        commitWidth(MIN_WIDTH);
      }
    },
    [collapsed, width, commitWidth, commitCollapsed],
  );

  // ── Add affordances → reuse existing create flows in the views ──
  // Record a one-shot intent (consumed by the view on mount) AND fire the
  // event (caught when the view is already mounted). Together these make
  // the "+" deterministic regardless of whether the area was already open.
  const addFor = useCallback(
    (area: RecentTabArea, kind: CreateKind, event: string) => (e: ReactMouseEvent) => {
      e.stopPropagation();
      requestCreate(kind);
      onOpenArea(area);
      window.dispatchEvent(new CustomEvent(event));
    },
    [onOpenArea],
  );

  // Documents "+" pops a simple create dialog in place rather than
  // navigating to the full Documents view. On create we select (open) the
  // new doc directly and broadcast so every documents list refreshes.
  const openNewDoc = useCallback((e: ReactMouseEvent) => {
    e.stopPropagation();
    setShowNewDoc(true);
  }, []);

  const handleCreateDocument = useCallback(
    async (path: string) => {
      const clean = path.trim();
      if (!clean) return;
      try {
        await api.writeDocument(clean, '');
        setShowNewDoc(false);
        window.dispatchEvent(
          new CustomEvent('gezel:document-created', { detail: { path: clean } }),
        );
        onSelect(toRecentTab({ kind: 'document', path: clean }));
      } catch {
        // Surface nothing inline here — the dialog stays open so the user
        // can retry or cancel.
      }
    },
    [onSelect],
  );

  const activeKey = selection ? tabKey(selection) : null;
  // A group header reads as "selected" only when its full area screen
  // (the Projects / Documents / Gezellen list + view) is open — NOT when
  // an individual item of that kind is selected. The area screen is the
  // `{ kind: 'area', area }` selection; individual items are their own
  // `kind` ('project' | 'document' | 'gezel').
  const activeArea = selection?.kind === 'area' ? selection.area : null;

  return (
    <aside
      className={`app-sidebar${collapsed ? ' collapsed' : ''}`}
      style={{ width: collapsed ? COLLAPSED_WIDTH : width }}
      data-testid="app-sidebar"
    >
      <nav className="app-sidebar-scroll" aria-label="Primary navigation">
        {/* Home / dashboard */}
        <button
          type="button"
          className={`app-sidebar-item app-sidebar-item-root app-sidebar-home${selection === null ? ' active' : ''}`}
          onClick={() => onSelect(null)}
          title={homeTitle}
          data-testid="sidebar-meester"
        >
          <span className="app-sidebar-item-icon">
            <HomeIcon />
          </span>
          <span className="app-sidebar-item-label">
            {firstRun || !meesterName ? (
              homeLabel
            ) : (
              <>
                Home <span className="app-sidebar-home-meester">· {meesterName}</span>
              </>
            )}
          </span>
        </button>

        {/* Projects */}
        <Group
          id="projects"
          label="Projects"
          area="projects"
          expanded={groups.projects}
          collapsed={collapsed}
          active={activeArea === 'projects'}
          onToggle={() => toggleGroup('projects')}
          onOpen={() => onOpenArea('projects')}
          onAdd={addFor('projects', 'project', 'gezel:new-project')}
          addTitle="New project"
        >
          {visibleProjects.length === 0 ? (
            <li className="app-sidebar-empty">No projects yet.</li>
          ) : (
            visibleProjects.map((p) => {
              const key = tabKey({ kind: 'project', id: p.id });
              const isActive = activeProjectIds?.has(p.id) ?? false;
              const pendingCount = pendingByProject?.get(p.id) ?? 0;
              const poisoned = poisonedProjects?.get(p.id);
              const status = p.status ?? 'active';
              const select = () => onSelect(toRecentTab({ kind: 'project', id: p.id }));
              return (
                <li
                  key={p.id}
                  className={`app-sidebar-proj-row${activeKey === key ? ' active' : ''}`}
                >
                  <button
                    type="button"
                    className={`app-sidebar-item app-sidebar-subitem${activeKey === key ? ' active' : ''}`}
                    onClick={select}
                    title={p.name}
                  >
                    <span
                      className="app-sidebar-item-icon app-sidebar-proj-badge"
                      style={{ background: `hsl(${hueFromString(p.id)}, 50%, 42%)` }}
                      aria-hidden="true"
                    >
                      {projectInitial(p.name)}
                    </span>
                    <span className="app-sidebar-item-label">{p.name}</span>
                  </button>
                  <ProjectActionsMenu
                    project={p}
                    hasError={!!poisoned}
                    onDeleted={() => void refreshProjects()}
                  />
                  {/* Right-aligned per-project signal, by precedence:
                      needs-intervention > poisoned > working > status light.
                      The wrapper is a fixed-width centering box so every
                      variant's visual centers on the same x, regardless of
                      its intrinsic width. */}
                  <span className="app-sidebar-proj-signal">
                    {pendingCount > 0 ? (
                      <button
                        type="button"
                        className="project-row-intervene"
                        onClick={(e) => {
                          e.stopPropagation();
                          setResolveProjectId(p.id);
                        }}
                        title={`${pendingCount} pending question${pendingCount === 1 ? '' : 's'} — resolve now`}
                        aria-label={`Resolve ${pendingCount} pending question${pendingCount === 1 ? '' : 's'} in ${p.name}`}
                      >
                        <span className="project-row-intervene-glyph" aria-hidden="true">
                          ?
                        </span>
                      </button>
                    ) : poisoned ? (
                      <button
                        type="button"
                        className="project-row-poisoned"
                        onClick={(e) => {
                          e.stopPropagation();
                          // Queue first: the project's timeline may not be
                          // mounted yet, so it can't hear the live event below.
                          queueFocusSessionError({
                            projectId: p.id,
                            sessionId: poisoned.sessionId,
                          });
                          select();
                          // Land on the Chat tab (where the "last turn failed"
                          // banner lives) even if the project is already open on
                          // another tab — `openProject` flips the tab to chat.
                          window.dispatchEvent(
                            new CustomEvent('gezel:open-project', { detail: { projectId: p.id } }),
                          );
                          // Live event for the already-open case (no remount):
                          // scroll the timeline to the turn that failed.
                          window.dispatchEvent(
                            new CustomEvent('gezel:focus-session-error', {
                              detail: { projectId: p.id, sessionId: poisoned.sessionId },
                            }),
                          );
                        }}
                        title={`Last turn failed: ${poisoned.error} — go to it in the chat`}
                        aria-label={`${p.name}: last turn failed — go to it in the chat`}
                      >
                        <span className="project-row-poisoned-glyph" aria-hidden="true">
                          !
                        </span>
                      </button>
                    ) : isActive ? (
                      <button
                        type="button"
                        className="project-row-thinking"
                        onClick={(e) => {
                          e.stopPropagation();
                          select();
                        }}
                        title="A gezel is working — open"
                        aria-label={`${p.name}: a gezel is working. Open project.`}
                      >
                        <span className="project-row-thinking-dot" aria-hidden="true" />
                        <span className="project-row-thinking-dot" aria-hidden="true" />
                        <span className="project-row-thinking-dot" aria-hidden="true" />
                      </button>
                    ) : (
                      <Tooltip.Hint
                        text={PROJECT_STATUS_DESCRIPTIONS[status]}
                        side="left"
                        delay={150}
                      >
                        <button
                          type="button"
                          className={`project-row-status project-row-status-${status}`}
                          onClick={select}
                          aria-label={`${p.name}: ${PROJECT_STATUS_DESCRIPTIONS[status]}`}
                        />
                      </Tooltip.Hint>
                    )}
                  </span>
                </li>
              );
            })
          )}
        </Group>

        {/* Documents — inline file tree */}
        <Group
          id="documents"
          label="Documents"
          area="documents"
          expanded={groups.documents}
          collapsed={collapsed}
          active={activeArea === 'documents'}
          onToggle={() => toggleGroup('documents')}
          onOpen={() => onOpenArea('documents')}
          onAdd={openNewDoc}
          addTitle="New document"
        >
          {docs.length === 0 ? (
            <li className="app-sidebar-empty">No documents yet.</li>
          ) : (
            <li className="app-sidebar-tree">
              <FileTree
                entries={docs}
                selectedPath={selection?.kind === 'document' ? selection.path : undefined}
                onSelect={(entry) => {
                  if (entry.isDirectory) return;
                  onSelect(toRecentTab({ kind: 'document', path: entry.path }));
                }}
                defaultExpandedDepth={1}
              />
            </li>
          )}
        </Group>

        {/* Gezels — name + role + poppetje */}
        <Group
          id="gezels"
          label="Gezellen"
          area="gezels"
          expanded={groups.gezels}
          collapsed={collapsed}
          active={activeArea === 'gezels'}
          onToggle={() => toggleGroup('gezels')}
          onOpen={() => onOpenArea('gezels')}
          onAdd={addFor('gezels', 'gezel', 'gezel:new-gezel')}
          addTitle="New gezel"
        >
          {gezels.length === 0 ? (
            <li className="app-sidebar-empty">No gezellen yet.</li>
          ) : (
            gezels.map((g) => {
              const key = tabKey({ kind: 'gezel', id: g.id });
              const name = displayName(
                { name: g.name, roleBasedName: g.roleBasedName },
                roleBasedNameOnly,
              );
              const roleLabel = g.role ?? g.roleBasedName ?? '';
              const description = roleDescription(g.role, g.roleBasedName);
              // Subtitle under the name: in boring mode the role-based name is
              // already the label, so show the plain-language description (or
              // nothing) rather than repeating the role; otherwise the role.
              const subtitle = roleBasedNameOnly ? description : roleLabel;
              // Tooltip: name + role (normal mode), plus the plain-language
              // description — where regular-name users learn what a role does.
              let title = !roleBasedNameOnly && roleLabel ? `${name} — ${roleLabel}` : name;
              if (description) title += ` · ${description}`;
              return (
                <li
                  key={g.id}
                  className={`app-sidebar-gezel-row${activeKey === key ? ' active' : ''}`}
                >
                  <button
                    type="button"
                    className={`app-sidebar-item app-sidebar-subitem app-sidebar-gezel${activeKey === key ? ' active' : ''}`}
                    onClick={() => onSelect(toRecentTab({ kind: 'gezel', id: g.id }))}
                    title={title}
                  >
                    <span className="app-sidebar-item-icon">
                      <GezelIcon
                        poppetje={g.poppetje ?? null}
                        svg={g.icon ?? null}
                        iconOverride={g.iconOverride ?? false}
                        // Display name, not raw name, so the fallback-letter
                        // avatar shows the role initial in boring mode.
                        name={name}
                        size={24}
                        variant="icon"
                      />
                    </span>
                    <span className="app-sidebar-gezel-text">
                      <span className="app-sidebar-item-label">{name}</span>
                      {subtitle && <span className="app-sidebar-item-role">{subtitle}</span>}
                    </span>
                  </button>
                  <GezelActionsMenu gezel={g} compact />
                </li>
              );
            })
          )}
        </Group>

        {/* Top-level area links */}
        <div className="app-sidebar-links">
          {areaLinks.map((area) => {
            const key = tabKey({ kind: 'area', area });
            return (
              <button
                key={area}
                type="button"
                className={`app-sidebar-item app-sidebar-item-root${activeKey === key ? ' active' : ''}`}
                onClick={() => onOpenArea(area)}
                title={AREA_LINK_LABELS[area]}
                data-testid={`sidebar-area-${area}`}
              >
                <span className="app-sidebar-item-icon">
                  <AreaIcon area={area} size={18} />
                </span>
                <span className="app-sidebar-item-label">{AREA_LINK_LABELS[area]}</span>
              </button>
            );
          })}
          {/* Settings is last in AREA_LINKS, so install-health notices land
              directly beneath it — the screen that explains them. */}
          {systemNotices.map((notice) => (
            <button
              key={notice.id}
              type="button"
              className="app-sidebar-notice"
              data-testid={`sidebar-notice-${notice.id}`}
              onClick={() => {
                // Stash for the not-yet-mounted case, open the area, then fire
                // the event for the already-open-on-another-section case.
                requestSettingsSection('about');
                onOpenArea('settings');
                window.dispatchEvent(
                  new CustomEvent('gezel:navigate', {
                    detail: { view: 'settings', section: 'about' },
                  }),
                );
              }}
              title={`${notice.title} ${notice.body}`}
            >
              <span className="app-sidebar-notice-dot" aria-hidden="true" />
              <span className="app-sidebar-notice-label">{notice.railLabel}</span>
            </button>
          ))}
        </div>
      </nav>

      <div className="app-sidebar-footer">
        <button
          type="button"
          className="app-sidebar-collapse-toggle"
          onClick={() => commitCollapsed(!collapsed)}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-pressed={collapsed}
        >
          {collapsed ? '›' : '‹'}
        </button>
      </div>

      {/* Resize grip on the right edge */}
      <div
        className="app-sidebar-grip"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        tabIndex={0}
        onMouseDown={onGripMouseDown}
        onKeyDown={onGripKeyDown}
      />

      <NewPathDialog
        open={showNewDoc}
        title="New document"
        placeholder="e.g. guidelines/coding"
        submitLabel="Create"
        suffix=".md"
        onSubmit={handleCreateDocument}
        onCancel={() => setShowNewDoc(false)}
      />

      {resolveProjectId && (
        <ProjectQuestionsDialog
          projectId={resolveProjectId}
          onClose={() => setResolveProjectId(null)}
        />
      )}
    </aside>
  );
}

interface GroupProps {
  id: GroupId;
  label: string;
  area: RecentTabArea;
  expanded: boolean;
  collapsed: boolean;
  /** Whether the current selection belongs to this group (collapsed-mode highlight). */
  active: boolean;
  /** Expand/collapse the inline list (caret click). */
  onToggle: () => void;
  /** Open the full area screen for this group (title click). */
  onOpen: () => void;
  onAdd: (e: ReactMouseEvent) => void;
  addTitle: string;
  children: React.ReactNode;
}

function Group({
  id,
  label,
  area,
  expanded,
  collapsed,
  active,
  onToggle,
  onOpen,
  onAdd,
  addTitle,
  children,
}: GroupProps) {
  const showList = expanded && !collapsed;
  return (
    <div className="app-sidebar-group" data-group={id}>
      <div className={`app-sidebar-group-header${active ? ' active' : ''}`}>
        {!collapsed && (
          <button
            type="button"
            className="app-sidebar-caret-btn"
            onClick={onToggle}
            aria-expanded={expanded}
            aria-label={expanded ? `Collapse ${label}` : `Expand ${label}`}
            data-testid={`sidebar-group-toggle-${id}`}
          >
            <span className={`app-sidebar-caret${expanded ? ' expanded' : ''}`} aria-hidden="true">
              <svg
                width={14}
                height={14}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2.2}
                strokeLinecap="round"
                strokeLinejoin="round"
                focusable="false"
                aria-hidden="true"
              >
                <polyline points="9 6 15 12 9 18" />
              </svg>
            </span>
          </button>
        )}
        <button
          type="button"
          className="app-sidebar-group-toggle"
          // Always opens the full area screen ("all projects/documents/gezels"),
          // matching a click on the text header in expanded mode. In the
          // collapsed icon-rail the caret is hidden, but the dedicated
          // collapse toggle / drag grip still expand the rail, so the icon is
          // free to navigate rather than toggle the inline list.
          onClick={onOpen}
          title={label}
          data-testid={`sidebar-group-${id}`}
        >
          <span className="app-sidebar-item-icon">
            <AreaIcon area={area} size={18} />
          </span>
          <span className="app-sidebar-item-label app-sidebar-group-label">{label}</span>
        </button>
        {!collapsed && (
          <button
            type="button"
            className="app-sidebar-add"
            onClick={onAdd}
            title={addTitle}
            aria-label={addTitle}
          >
            +
          </button>
        )}
      </div>
      {showList && <ul className="app-sidebar-list">{children}</ul>}
    </div>
  );
}

/** Small house glyph for the Home entry, matching AreaIcon's stroke style. */
function HomeIcon({ size = 18 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M3 11.5 12 4l9 7.5" />
      <path d="M5 10v9a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-9" />
      <path d="M9.5 20v-5h5v5" />
    </svg>
  );
}
