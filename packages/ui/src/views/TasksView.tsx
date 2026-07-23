import type { GezelSummary, Project, Task, TaskStatus } from '@bendyline/gezel';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { Select } from '../primitives/index.js';
import { TaskTabContent } from './TaskTabContent.js';
import { NewTaskDialog } from './tasks/NewTaskDialog.js';

const SELECTED_TASK_STORAGE_KEY = 'gezel:tasks:selectedRef';

interface TaskGroup {
  parent: Task;
  children: Task[];
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
  const [creating, setCreating] = useState(false);
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
  // The Tasks area always renders as a list/detail split (matches Documents
  // and Scripts). The `shortRef` flag drops the project prefix on row labels
  // when the view is scoped to a single project — without it, the ref already
  // tells you which project, so duplicating that wastes width.
  const shortRef = projectId !== undefined;
  const openTask = useCallback(
    (ref: string) => {
      setCreating(false);
      setSelectedRef(ref);
      // Only the standalone Tasks area persists selection across remounts;
      // task detail panels embedded inside a project tab live alongside other
      // per-project state and shouldn't bleed into the global slot.
      if (projectId === undefined) {
        try {
          window.localStorage.setItem(SELECTED_TASK_STORAGE_KEY, ref);
        } catch {
          /* ignore */
        }
      }
    },
    [projectId],
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

  const gezelName = useMemo(() => {
    const m = new Map<string, string>();
    for (const g of gezels) m.set(g.id, g.name);
    return (id?: string) => (id ? (m.get(id) ?? id) : '');
  }, [gezels]);

  const groups = useMemo(() => groupTasks(tasks), [tasks]);

  const openCreate = useCallback(() => setCreating(true), []);

  const onCreated = useCallback(
    async (task: Task) => {
      setCreating(false);
      await refresh();
      openTask(task.ref);
    },
    [refresh, openTask],
  );

  const showEmptyState = hasLoadedTasks && tasks.length === 0;
  const hideTaskPanes = !hasLoadedTasks || showEmptyState;

  return (
    <div className="tasks-view" data-testid="tasks-view">
      <header className="tasks-header">
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
          <button
            type="button"
            className="primary"
            onClick={openCreate}
            disabled={!(projectFilter || projects[0])}
          >
            + New task
          </button>
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
                  : 'No tasks have been created yet.'}
              </p>
            )}
          </div>
        )}
        <aside className="tasks-list" hidden={hideTaskPanes}>
          <ul>
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
                      className={`task-row${selectedRef === g.parent.ref ? ' task-row-selected' : ''}`}
                      onClick={() => openTask(g.parent.ref)}
                    >
                      <span
                        className={`task-status-dot task-status-${g.parent.status}`}
                        title={g.parent.status}
                        aria-label={g.parent.status}
                      />
                      <span className="task-row-body">
                        <span className="task-row-meta">
                          <span className="task-ref">
                            {shortRef
                              ? (g.parent.ref.split('/').pop() ?? g.parent.ref)
                              : g.parent.ref}
                          </span>
                          {badge && (
                            <span className={`task-badge task-badge-${badge}`}>{badge}</span>
                          )}
                          {g.children.length > 0 && (
                            <span className="task-child-count">
                              {g.children.length} run{g.children.length === 1 ? '' : 's'}
                            </span>
                          )}
                          <span className="task-assignee">
                            {g.parent.assignee.kind === 'user'
                              ? 'user'
                              : gezelName(g.parent.assignee.gezelId) || 'gezel'}
                          </span>
                        </span>
                        <span className="task-title">{g.parent.title}</span>
                      </span>
                    </button>
                  </div>
                  {expanded && g.children.length > 0 && (
                    <ul className="task-children">
                      {g.children.map((c) => (
                        <li key={c.ref}>
                          <button
                            type="button"
                            className={`task-row task-row-child${selectedRef === c.ref ? ' task-row-selected' : ''}`}
                            onClick={() => openTask(c.ref)}
                          >
                            <span
                              className={`task-status-dot task-status-${c.status}`}
                              title={c.status}
                              aria-label={c.status}
                            />
                            <span className="task-row-body">
                              <span className="task-row-meta">
                                <span className="task-ref">
                                  {shortRef ? (c.ref.split('/').pop() ?? c.ref) : c.ref}
                                </span>
                                <span className="task-assignee">
                                  {c.assignee.kind === 'user'
                                    ? 'user'
                                    : gezelName(c.assignee.gezelId) || 'gezel'}
                                </span>
                              </span>
                              <span className="task-title">{c.title}</span>
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
          {selectedRef ? (
            <TaskTabContent key={selectedRef} taskRef={selectedRef} onTaskChanged={onTaskChanged} />
          ) : (
            <p className="placeholder">Click a task to view it here.</p>
          )}
        </section>
      </div>

      <NewTaskDialog
        open={creating}
        defaultProjectId={projectFilter || projects[0]?.id || ''}
        projects={projects}
        gezels={gezels}
        projectLocked={projectId !== undefined}
        onClose={() => setCreating(false)}
        onCreated={onCreated}
      />
    </div>
  );
}
