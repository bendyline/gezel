import type { GezelSummary, Project, Task, TaskStatus } from '@bendyline/gezel';
import {
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { api } from '../api.js';
import { TASK_STATUS_KEY_ORDER, TaskStatusKeys } from '../components/TaskStatusKeys.js';
import { DropdownChevron, DropdownMenu, Select } from '../primitives/index.js';
import { TaskTabContent } from './TaskTabContent.js';
import { NewTaskDialog, type TaskCreationMode } from './tasks/NewTaskDialog.js';

const SELECTED_TASK_STORAGE_KEY = 'gezel:tasks:selectedRef';

interface TaskGroup {
  parent: Task;
  children: Task[];
}

type TaskKindFilter = TaskCreationMode;

const TASK_KIND_OPTIONS: Array<{ value: TaskKindFilter; label: string }> = [
  { value: 'one-time', label: 'One-time tasks' },
  { value: 'scheduled', label: 'Scheduled tasks' },
  { value: 'night-shift', label: 'Night Shift tasks' },
];

function taskKind(task: Task): TaskKindFilter {
  if (task.nightShift?.enabled) return 'night-shift';
  // Standing background jobs the service installs (workspace indexing) are
  // scheduled work, not the user's backlog — the default One-time view must
  // never lead a fresh install with a system job (2026-09-02 UX review).
  if (task.origin?.kind === 'system-job') return 'scheduled';
  if (task.cron) return 'scheduled';
  return 'one-time';
}

/**
 * Filter by the top-level task's kind while keeping its child runs nested
 * beneath it. A scheduled run therefore stays with its schedule rather than
 * leaking into the one-time list as an orphan.
 */
function tasksForKind(tasks: Task[], kind: TaskKindFilter): Task[] {
  const included = new Set(
    tasks.filter((task) => !task.parentTaskRef && taskKind(task) === kind).map((task) => task.ref),
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of tasks) {
      if (task.parentTaskRef && included.has(task.parentTaskRef) && !included.has(task.ref)) {
        included.add(task.ref);
        changed = true;
      }
    }
  }
  return tasks.filter((task) => included.has(task.ref));
}

/**
 * Group tasks so children sit under their parent. Orphan children (whose
 * parent isn't in the current filtered set) are promoted to top-level so
 * they don't just silently vanish.
 */
function groupTasks(tasks: Task[]): TaskGroup[] {
  const byRef = new Map<string, Task>();
  for (const t of tasks) byRef.set(t.ref, t);
  const childrenOf = new Map<string, Task[]>();
  const topLevel: Task[] = [];
  for (const t of tasks) {
    if (t.parentTaskRef && byRef.has(t.parentTaskRef)) {
      const list = childrenOf.get(t.parentTaskRef);
      if (list) list.push(t);
      else childrenOf.set(t.parentTaskRef, [t]);
    } else {
      topLevel.push(t);
    }
  }
  // Newest-first within each child list.
  for (const list of childrenOf.values()) {
    list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  return topLevel.map((parent) => ({
    parent,
    children: childrenOf.get(parent.ref) ?? [],
  }));
}

function taskBadge(task: Task): string | null {
  if (task.nightShift?.enabled) return 'night-shift';
  if (task.origin?.kind === 'system-job') return 'system';
  if (task.spawnsCraftbook && task.craftbook.steps.length === 0) return 'template';
  if (task.spawnsCraftbook && task.fanout?.materializedAt) return 'coordinator';
  if (task.cron) return 'cron';
  if (task.parentTaskRef) return 'instance';
  return null;
}

const STATUS_OPTIONS: Array<{ value: '' | TaskStatus; label: string }> = [
  { value: '', label: 'All statuses' },
  { value: 'active', label: 'Active' },
  { value: 'draft', label: 'Ready to fire' },
  { value: 'paused', label: 'Paused' },
  { value: 'complete', label: 'Complete' },
  { value: 'canceled', label: 'Canceled' },
];

function BulkTaskDetail({
  tasks,
  onTaskChanged,
}: {
  tasks: Task[];
  onTaskChanged: (task: Task) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sharedStatus = tasks.every((task) => task.status === tasks[0]?.status)
    ? (tasks[0]?.status ?? 'draft')
    : 'draft';
  const availableStatuses = tasks.some((task) => task.origin?.kind === 'system-job')
    ? TASK_STATUS_KEY_ORDER.filter((status) => status === 'active' || status === 'paused')
    : TASK_STATUS_KEY_ORDER;

  const setStatus = async (status: TaskStatus) => {
    setBusy(true);
    setMessage(null);
    setError(null);
    const results = await Promise.allSettled(
      tasks.map((task) =>
        task.status === 'draft' && status === 'active'
          ? api.activateTask(task.projectId, task.num, false)
          : api.setTaskStatus(task.projectId, task.num, status),
      ),
    );
    const failures: string[] = [];
    for (const result of results) {
      if (result.status === 'fulfilled') onTaskChanged(result.value);
      else
        failures.push(
          result.reason instanceof Error ? result.reason.message : String(result.reason),
        );
    }
    if (failures.length > 0) {
      setError(
        `Couldn't update ${failures.length} of ${tasks.length} selected tasks. ${failures[0]}`,
      );
    } else {
      setMessage(`Updated ${tasks.length} tasks to ${status}.`);
    }
    setBusy(false);
  };

  return (
    <div className="task-bulk-detail" data-testid="task-bulk-detail">
      <header className="task-bulk-header">
        <div>
          <span className="task-detail-ref">{tasks.length} tasks selected</span>
          <h3>Selected tasks</h3>
          <p>Change the status for every selected task.</p>
        </div>
        <TaskStatusKeys
          value={sharedStatus}
          options={availableStatuses}
          disabled={busy}
          ariaLabel="Set status for selected tasks"
          onChange={(status) => void setStatus(status)}
        />
      </header>

      {error && <p className="error">{error}</p>}
      {message && <output className="task-bulk-message">{message}</output>}

      <ul className="task-bulk-list" aria-label="Selected task titles">
        {tasks.map((task) => (
          <li key={task.ref} className="task-bulk-item">
            <span
              className={`task-status-dot task-status-${task.status}`}
              title={task.status}
              aria-label={task.status}
            />
            <span className="task-row-body">
              <strong>{task.title}</strong>
              <span className="task-row-meta">
                <span className="task-ref">{task.ref}</span>
                <span className="task-bulk-current-status">{task.status}</span>
              </span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export interface TasksViewProps {
  /** When set, the view is pinned to one project and the project filter is hidden. */
  projectId?: string;
}

export function TasksView({ projectId }: TasksViewProps = {}) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [gezels, setGezels] = useState<GezelSummary[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [projectFilter, setProjectFilter] = useState(projectId ?? '');
  const [statusFilter, setStatusFilter] = useState<'' | TaskStatus>('');
  const [assigneeFilter, setAssigneeFilter] = useState('');
  const [kindFilter, setKindFilter] = useState<TaskKindFilter>('one-time');
  const [creating, setCreating] = useState<TaskCreationMode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hasLoadedTasks, setHasLoadedTasks] = useState(false);
  const [expandedParents, setExpandedParents] = useState<Set<string>>(() => new Set());
  const [selectedRef, setSelectedRef] = useState<string | null>(() => {
    try {
      return projectId === undefined
        ? window.localStorage.getItem(SELECTED_TASK_STORAGE_KEY)
        : null;
    } catch {
      return null;
    }
  });
  const [selectedRefs, setSelectedRefs] = useState<Set<string>>(() =>
    selectedRef ? new Set([selectedRef]) : new Set(),
  );
  const selectedRefsRef = useRef(selectedRefs);
  const selectionAnchorRef = useRef<string | null>(selectedRef);
  const dragSelectionRef = useRef<{ anchor: string; base: Set<string> } | null>(null);
  // The Tasks area always renders as a list/detail split (matches Documents
  // and Scripts). The `shortRef` flag drops the project prefix on row labels
  // when the view is scoped to a single project — without it, the ref already
  // tells you which project, so duplicating that wastes width.
  const shortRef = projectId !== undefined;
  const commitSelection = useCallback(
    (refs: Set<string>, primaryRef: string | null) => {
      selectedRefsRef.current = refs;
      setSelectedRefs(refs);
      setCreating(null);
      setSelectedRef(primaryRef);
      // Only the standalone Tasks area persists selection across remounts;
      // task detail panels embedded inside a project tab live alongside other
      // per-project state and shouldn't bleed into the global slot.
      if (projectId === undefined) {
        try {
          if (primaryRef) window.localStorage.setItem(SELECTED_TASK_STORAGE_KEY, primaryRef);
          else window.localStorage.removeItem(SELECTED_TASK_STORAGE_KEY);
        } catch {
          /* ignore */
        }
      }
    },
    [projectId],
  );

  const openTask = useCallback(
    (ref: string) => {
      selectionAnchorRef.current = ref;
      commitSelection(new Set([ref]), ref);
    },
    [commitSelection],
  );

  useEffect(() => {
    if (projectId !== undefined) setProjectFilter(projectId);
  }, [projectId]);

  useEffect(() => {
    api
      .listProjects()
      .then((r) => setProjects(r.projects))
      .catch(() => {});
    api
      .listGezels()
      .then((r) => setGezels(r.gezels))
      .catch(() => {});
  }, []);

  const refresh = useCallback(async () => {
    try {
      const filter: { status?: TaskStatus; assignee?: string } = {};
      if (statusFilter) filter.status = statusFilter;
      if (assigneeFilter) filter.assignee = assigneeFilter;
      const res = projectFilter
        ? await api.listProjectTasks(projectFilter, filter)
        : await api.listTasks(filter);
      setTasks(res.tasks);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setHasLoadedTasks(true);
    }
  }, [projectFilter, statusFilter, assigneeFilter]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Keep the list live without a manual Refresh button — poll on an
  // interval so status/assignee changes (from here, from chat, or from a
  // running agent) surface on their own.
  useEffect(() => {
    const id = window.setInterval(() => void refresh(), 4000);
    return () => window.clearInterval(id);
  }, [refresh]);

  // Patch a single task in place when the detail panel edits it, so the
  // list reflects the change immediately instead of waiting for the next
  // poll.
  const onTaskChanged = useCallback((updated: Task) => {
    setTasks((prev) => prev.map((t) => (t.ref === updated.ref ? updated : t)));
  }, []);

  const visibleTasks = useMemo(() => tasksForKind(tasks, kindFilter), [tasks, kindFilter]);
  const groups = useMemo(() => groupTasks(visibleTasks), [visibleTasks]);
  const selectableTasks = useMemo(
    () =>
      groups.flatMap((group) => [
        group.parent,
        ...(expandedParents.has(group.parent.ref) ? group.children : []),
      ]),
    [groups, expandedParents],
  );
  const selectableRefs = useMemo(() => selectableTasks.map((task) => task.ref), [selectableTasks]);

  // Land on the newest task instead of a two-thirds-empty "click a task"
  // pane. Also prune selections that disappear behind a filter or a collapsed
  // parent so the detail pane never describes invisible rows.
  useEffect(() => {
    // Keep the last selection while a filter has no results (the panes are
    // hidden in that state), and while a just-created task is waiting for the
    // refreshed list to include it.
    if (selectableRefs.length === 0) return;
    const available = new Set(selectableRefs);
    const current = selectedRefsRef.current;
    const next = new Set([...current].filter((ref) => available.has(ref)));
    if (next.size === 0) {
      const first = selectableRefs[0];
      if (first) {
        selectionAnchorRef.current = first;
        commitSelection(new Set([first]), first);
      }
      return;
    }
    const unchanged = next.size === current.size && [...next].every((ref) => current.has(ref));
    const primary = selectedRef && next.has(selectedRef) ? selectedRef : ([...next].at(-1) ?? null);
    if (!unchanged || primary !== selectedRef) commitSelection(next, primary);
  }, [commitSelection, selectableRefs, selectedRef]);

  const refsBetween = useCallback(
    (anchor: string, target: string) => {
      const start = selectableRefs.indexOf(anchor);
      const end = selectableRefs.indexOf(target);
      if (start < 0 || end < 0) return [target];
      return selectableRefs.slice(Math.min(start, end), Math.max(start, end) + 1);
    },
    [selectableRefs],
  );

  const selectTask = useCallback(
    (ref: string, options: { toggle?: boolean; range?: boolean; additive?: boolean } = {}) => {
      const current = selectedRefsRef.current;
      let next: Set<string>;
      if (options.range && selectionAnchorRef.current) {
        const range = refsBetween(selectionAnchorRef.current, ref);
        next = options.additive ? new Set([...current, ...range]) : new Set(range);
      } else if (options.toggle) {
        next = new Set(current);
        if (next.has(ref)) next.delete(ref);
        else next.add(ref);
        selectionAnchorRef.current = ref;
      } else {
        next = new Set([ref]);
        selectionAnchorRef.current = ref;
      }

      const primary = next.has(ref)
        ? ref
        : selectedRef && next.has(selectedRef)
          ? selectedRef
          : ([...next].at(-1) ?? null);
      commitSelection(next, primary);
    },
    [commitSelection, refsBetween, selectedRef],
  );

  const beginMouseSelection = useCallback(
    (ref: string, event: ReactMouseEvent<HTMLButtonElement>) => {
      if (event.button !== 0) return;
      const additive = event.ctrlKey || event.metaKey;
      selectTask(ref, {
        range: event.shiftKey,
        toggle: additive && !event.shiftKey,
        additive,
      });
      dragSelectionRef.current =
        !additive && !event.shiftKey ? { anchor: ref, base: new Set() } : null;
    },
    [selectTask],
  );

  const extendMouseSelection = useCallback(
    (ref: string, event: ReactMouseEvent<HTMLButtonElement>) => {
      const drag = dragSelectionRef.current;
      if (!drag || (event.buttons & 1) === 0) return;
      const next = new Set([...drag.base, ...refsBetween(drag.anchor, ref)]);
      commitSelection(next, ref);
    },
    [commitSelection, refsBetween],
  );

  useEffect(() => {
    const endMouseSelection = () => {
      dragSelectionRef.current = null;
    };
    window.addEventListener('mouseup', endMouseSelection);
    return () => window.removeEventListener('mouseup', endMouseSelection);
  }, []);

  const selectionPropsFor = (ref: string) => ({
    'aria-pressed': selectedRefs.has(ref),
    onMouseDown: (event: ReactMouseEvent<HTMLButtonElement>) => beginMouseSelection(ref, event),
    onMouseEnter: (event: ReactMouseEvent<HTMLButtonElement>) => extendMouseSelection(ref, event),
    onClick: (event: ReactMouseEvent<HTMLButtonElement>) => {
      // A real mouse click was already handled on mousedown so dragging can
      // paint the range live. Keyboard/programmatic clicks have detail 0.
      if (event.detail === 0) {
        const additive = event.ctrlKey || event.metaKey;
        selectTask(ref, {
          range: event.shiftKey,
          toggle: additive && !event.shiftKey,
          additive,
        });
      }
    },
  });

  const selectedTasks = useMemo(
    () => selectableTasks.filter((task) => selectedRefs.has(task.ref)),
    [selectableTasks, selectedRefs],
  );

  const gezelName = useMemo(() => {
    const m = new Map<string, string>();
    for (const g of gezels) m.set(g.id, g.name);
    return (id?: string) => (id ? (m.get(id) ?? id) : '');
  }, [gezels]);

  const openCreate = useCallback((mode: TaskCreationMode) => setCreating(mode), []);

  const onCreated = useCallback(
    async (task: Task) => {
      setCreating(null);
      setKindFilter(taskKind(task));
      await refresh();
      openTask(task.ref);
    },
    [refresh, openTask],
  );

  const showEmptyState = hasLoadedTasks && visibleTasks.length === 0;
  const hideTaskPanes = !hasLoadedTasks || showEmptyState;
  const standalone = projectId === undefined;

  return (
    <div
      className={`tasks-view${standalone ? ' tasks-view-overall' : ''}`}
      data-testid="tasks-view"
    >
      <header className="tasks-header">
        <div className="gz-tray tasks-kind-filter" role="radiogroup" aria-label="Task type">
          {TASK_KIND_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              // biome-ignore lint/a11y/useSemanticElements: keys use the documented radio-group pattern; a native input would duplicate the pressable key surface.
              role="radio"
              aria-checked={kindFilter === option.value}
              className={`gz-key${kindFilter === option.value ? ' gz-key-active' : ''}`}
              onClick={() => setKindFilter(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
        <div className="tasks-filters">
          {projectId === undefined && (
            <Select.Root
              value={projectFilter || '__ALL__'}
              onValueChange={(v) => setProjectFilter(v === '__ALL__' ? '' : v)}
            >
              <Select.Trigger>
                <Select.Value />
              </Select.Trigger>
              <Select.Content>
                <Select.Item value="__ALL__">All projects</Select.Item>
                {projects.map((p) => (
                  <Select.Item key={p.id} value={p.id}>
                    {p.name}
                  </Select.Item>
                ))}
              </Select.Content>
            </Select.Root>
          )}
          <Select.Root
            value={statusFilter || '__ALL__'}
            onValueChange={(v) => setStatusFilter(v === '__ALL__' ? '' : (v as TaskStatus))}
          >
            <Select.Trigger>
              <Select.Value />
            </Select.Trigger>
            <Select.Content>
              {STATUS_OPTIONS.map((o) => (
                <Select.Item key={o.value || '__ALL__'} value={o.value || '__ALL__'}>
                  {o.label}
                </Select.Item>
              ))}
            </Select.Content>
          </Select.Root>
          <Select.Root
            value={assigneeFilter || '__ALL__'}
            onValueChange={(v) => setAssigneeFilter(v === '__ALL__' ? '' : v)}
          >
            <Select.Trigger>
              <Select.Value />
            </Select.Trigger>
            <Select.Content>
              <Select.Item value="__ALL__">Any assignee</Select.Item>
              {gezels.map((g) => (
                <Select.Item key={g.id} value={g.id}>
                  {g.name}
                  {g.role ? ` — ${g.role}` : ''}
                </Select.Item>
              ))}
            </Select.Content>
          </Select.Root>
          <div className="tasks-create-split">
            <button
              type="button"
              className="primary tasks-create-main"
              onClick={() => openCreate('one-time')}
              disabled={!(projectFilter || projects[0])}
            >
              + New task
            </button>
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <button
                  type="button"
                  className="primary tasks-create-more"
                  aria-label="More task types"
                  disabled={!(projectFilter || projects[0])}
                >
                  <DropdownChevron />
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  className="app-nav-menu tasks-create-menu"
                  sideOffset={4}
                  align="end"
                >
                  <DropdownMenu.Item
                    className="app-nav-menu-item"
                    onSelect={() => openCreate('scheduled')}
                  >
                    <span>New scheduled task</span>
                    <small>Runs a fresh copy on a cadence</small>
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    className="app-nav-menu-item"
                    onSelect={() => openCreate('night-shift')}
                  >
                    <span>New Night Shift task</span>
                    <small>Waits for the unattended work window</small>
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </div>
        </div>
      </header>

      {error && <p className="error">{error}</p>}

      <div className="tasks-layout">
        {!hasLoadedTasks && (
          <output className="tasks-empty-state">
            <p>Loading tasks…</p>
          </output>
        )}
        {showEmptyState && (
          <div className="tasks-empty-state">
            {!error && (
              <p>
                {statusFilter || assigneeFilter
                  ? 'No tasks match these filters.'
                  : `No ${TASK_KIND_OPTIONS.find((option) => option.value === kindFilter)?.label.toLowerCase()} have been created yet.`}
              </p>
            )}
          </div>
        )}
        <aside className="tasks-list" hidden={hideTaskPanes}>
          <ul aria-label="Tasks — use Control or Command to toggle and Shift to select a range">
            {groups.map((g) => {
              const badge = taskBadge(g.parent);
              const expanded = expandedParents.has(g.parent.ref);
              return (
                <li key={g.parent.ref}>
                  <div className="task-row-wrap">
                    {g.children.length > 0 && (
                      <button
                        type="button"
                        className="task-expand"
                        aria-label={expanded ? 'Collapse instances' : 'Expand instances'}
                        aria-expanded={expanded}
                        title={expanded ? 'Collapse instances' : 'Expand instances'}
                        onClick={() =>
                          setExpandedParents((prev) => {
                            const next = new Set(prev);
                            if (next.has(g.parent.ref)) next.delete(g.parent.ref);
                            else next.add(g.parent.ref);
                            return next;
                          })
                        }
                      >
                        {expanded ? '▾' : '▸'}
                      </button>
                    )}
                    <button
                      type="button"
                      className={`task-row${selectedRefs.has(g.parent.ref) ? ' task-row-selected' : ''}`}
                      {...selectionPropsFor(g.parent.ref)}
                    >
                      <span
                        className={`task-status-dot task-status-${g.parent.status}`}
                        title={g.parent.status}
                        aria-label={g.parent.status}
                      />
                      <span className="task-row-body">
                        <span className="task-title" title={g.parent.title}>
                          {g.parent.title}
                        </span>
                        <span className="task-row-meta">
                          <span className="task-ref">
                            {shortRef
                              ? (g.parent.ref.split('/').pop() ?? g.parent.ref)
                              : g.parent.ref}
                          </span>
                          {badge && (
                            <span className={`task-badge task-badge-${badge}`}>
                              {badge === 'night-shift' ? 'night shift' : badge}
                            </span>
                          )}
                          {g.children.length > 0 && (
                            <span className="task-child-count">
                              {g.children.length} run{g.children.length === 1 ? '' : 's'}
                            </span>
                          )}
                          <span className="task-assignee">
                            {g.parent.origin?.kind === 'system-job' &&
                            g.parent.origin.managedByGezelId
                              ? `${gezelName(g.parent.origin.managedByGezelId) || 'gezel'} · system`
                              : g.parent.assignee.kind === 'user'
                                ? 'You'
                                : gezelName(g.parent.assignee.gezelId) || 'gezel'}
                          </span>
                        </span>
                      </span>
                    </button>
                  </div>
                  {expanded && g.children.length > 0 && (
                    <ul className="task-children">
                      {g.children.map((c) => (
                        <li key={c.ref}>
                          <button
                            type="button"
                            className={`task-row task-row-child${selectedRefs.has(c.ref) ? ' task-row-selected' : ''}`}
                            {...selectionPropsFor(c.ref)}
                          >
                            <span
                              className={`task-status-dot task-status-${c.status}`}
                              title={c.status}
                              aria-label={c.status}
                            />
                            <span className="task-row-body">
                              <span className="task-title" title={c.title}>
                                {c.title}
                              </span>
                              <span className="task-row-meta">
                                <span className="task-ref">
                                  {shortRef ? (c.ref.split('/').pop() ?? c.ref) : c.ref}
                                </span>
                                <span className="task-assignee">
                                  {c.origin?.kind === 'system-job' && c.origin.managedByGezelId
                                    ? `${gezelName(c.origin.managedByGezelId) || 'gezel'} · system`
                                    : c.assignee.kind === 'user'
                                      ? 'You'
                                      : gezelName(c.assignee.gezelId) || 'gezel'}
                                </span>
                              </span>
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        </aside>

        <section className="task-detail-panel" hidden={hideTaskPanes}>
          {selectedTasks.length > 1 ? (
            <BulkTaskDetail tasks={selectedTasks} onTaskChanged={onTaskChanged} />
          ) : selectedRef ? (
            <TaskTabContent key={selectedRef} taskRef={selectedRef} onTaskChanged={onTaskChanged} />
          ) : (
            <p className="placeholder">Click a task to view it here.</p>
          )}
        </section>
      </div>

      <NewTaskDialog
        open={creating !== null}
        creationMode={creating ?? 'one-time'}
        defaultProjectId={projectFilter || projects[0]?.id || ''}
        projects={projects}
        gezels={gezels}
        projectLocked={projectId !== undefined}
        onClose={() => setCreating(null)}
        onCreated={onCreated}
      />
    </div>
  );
}
