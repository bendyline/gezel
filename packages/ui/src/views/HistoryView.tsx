import type { GezelSummary, HistoryEntry, HistoryEventKind, Project } from '@bendyline/gezel';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { ToolDiffBlock } from '../components/ToolDiffBlock.js';
import { Select } from '../primitives/index.js';

const KINDS: Array<{ value: string; label: string }> = [
  { value: '', label: 'All kinds' },
  { value: 'session', label: '💬 Chat threads' },
  { value: 'gezel.created', label: 'Gezel created' },
  { value: 'gezel.deleted', label: 'Gezel removed' },
  { value: 'gezel.renamed', label: 'Gezel renamed' },
  { value: 'gezel.settings.updated', label: 'Gezel settings updated' },
  { value: 'icon.generated', label: 'Icon generated' },
  { value: 'icon.reverted', label: 'Icon reverted' },
  { value: 'project.created', label: 'Project created' },
  { value: 'project.updated', label: 'Project updated' },
  { value: 'project.about.updated', label: 'Project about updated' },
  { value: 'project.mission.updated', label: 'Project mission updated' },
  { value: 'project.voorman.changed', label: 'Project voorman changed' },
  { value: 'document.created', label: 'Document created' },
  { value: 'document.deleted', label: 'Document deleted' },
  { value: 'tool.called', label: 'Tool called' },
  { value: 'meester.changed', label: 'Meester changed' },
  { value: 'task.created', label: 'Task created' },
  { value: 'task.updated', label: 'Task updated' },
  { value: 'task.about.updated', label: 'Task description updated' },
  { value: 'task.status.changed', label: 'Task status changed' },
  { value: 'task.assignee.changed', label: 'Task reassigned' },
  { value: 'task.step.added', label: 'Task step added' },
  { value: 'task.step.activated', label: 'Task step activated' },
  { value: 'task.step.completed', label: 'Task step completed' },
  { value: 'task.tick', label: 'Task cron tick' },
  { value: 'task.canceled', label: 'Task canceled' },
  { value: 'debug.bridge.failed', label: '🛠 Debug: MCP bridge failed to start' },
];

export function HistoryView({ projectId }: { projectId?: string } = {}) {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [gezels, setGezels] = useState<GezelSummary[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [gezelFilter, setGezelFilter] = useState('');
  const [projectFilter, setProjectFilter] = useState(projectId ?? '');
  useEffect(() => {
    if (projectId !== undefined) setProjectFilter(projectId);
  }, [projectId]);
  const [kindFilter, setKindFilter] = useState('');
  const [q, setQ] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const gezelLabel = useMemo(() => {
    const m = new Map<string, string>();
    for (const g of gezels) m.set(g.id, g.name);
    return (id?: string) => (id ? (m.get(id) ?? id) : '');
  }, [gezels]);

  const projectLabel = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of projects) m.set(p.id, p.name);
    return (id?: string) => (id ? (m.get(id) ?? id) : '');
  }, [projects]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const filter: {
        projectId?: string;
        gezelId?: string;
        kind?: string;
        q?: string;
        limit?: number;
      } = { limit: 200 };
      if (projectFilter) filter.projectId = projectFilter;
      if (gezelFilter) filter.gezelId = gezelFilter;
      if (kindFilter && kindFilter !== 'session') filter.kind = kindFilter;
      if (q.trim()) filter.q = q.trim();
      const res = await api.listHistory(filter);
      // If 'session' is the kind filter, keep only session entries client-side.
      const filtered =
        kindFilter === 'session'
          ? res.entries.filter((e) => e.entryType === 'session')
          : res.entries;
      setEntries(filtered);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [projectFilter, gezelFilter, kindFilter, q]);

  useEffect(() => {
    api
      .listGezels()
      .then((r) => setGezels(r.gezels))
      .catch(() => {});
    api
      .listProjects()
      .then((r) => setProjects(r.projects))
      .catch(() => {});
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="history-view" data-testid="history-view">
      <header className="history-header">
        <h2>History</h2>
        <div className="history-filters">
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
            value={gezelFilter || '__ALL__'}
            onValueChange={(v) => setGezelFilter(v === '__ALL__' ? '' : v)}
          >
            <Select.Trigger>
              <Select.Value />
            </Select.Trigger>
            <Select.Content>
              <Select.Item value="__ALL__">All gezels</Select.Item>
              {gezels.map((g) => (
                <Select.Item key={g.id} value={g.id}>
                  {g.name}
                  {g.role ? ` — ${g.role}` : ''}
                </Select.Item>
              ))}
            </Select.Content>
          </Select.Root>
          <Select.Root
            value={kindFilter || '__ALL__'}
            onValueChange={(v) => setKindFilter(v === '__ALL__' ? '' : v)}
          >
            <Select.Trigger>
              <Select.Value />
            </Select.Trigger>
            <Select.Content>
              {KINDS.map((k) => (
                <Select.Item key={k.value || '__ALL__'} value={k.value || '__ALL__'}>
                  {k.label}
                </Select.Item>
              ))}
            </Select.Content>
          </Select.Root>
          <input
            placeholder="Search…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            style={{ flex: 1 }}
          />
          <button type="button" onClick={() => void refresh()}>
            Refresh
          </button>
        </div>
      </header>

      {error && <p className="error">{error}</p>}
      {loading && entries.length === 0 && <p className="muted">Loading…</p>}
      {!loading && entries.length === 0 && !error && (
        <p className="muted">
          No entries yet. Create a gezel, edit a project, or have a chat — events will show up here.
        </p>
      )}

      <div className="history-split">
        <ul className="history-list">
          {entries.map((e) => {
            const entryId = e.entryType === 'event' ? e.id : `session:${e.id}`;
            const isSelected = selectedId === entryId;
            return (
              <li key={entryId} className="history-item">
                <button
                  type="button"
                  className={`history-row${isSelected ? ' history-row-selected' : ''}`}
                  onClick={() => setSelectedId(entryId)}
                >
                  {e.entryType === 'session' ? (
                    <HistorySessionRow
                      entry={e}
                      gezelName={gezelLabel(e.gezelId)}
                      projectName={projectLabel(e.projectId)}
                    />
                  ) : (
                    <HistoryEventRow
                      entry={e}
                      gezelName={gezelLabel(e.gezelId)}
                      projectName={projectLabel(e.projectId)}
                    />
                  )}
                </button>
              </li>
            );
          })}
        </ul>
        <section className="history-detail">
          {(() => {
            const selected = entries.find(
              (e) => (e.entryType === 'event' ? e.id : `session:${e.id}`) === selectedId,
            );
            if (!selected) {
              return (
                <p className="placeholder">
                  Click a history entry on the left to view its details.
                </p>
              );
            }
            // Surface the Layer 4 diff inline when present (a
            // `tool.called` event for replaceInFile / applyPatch /
            // insertAtMarker carries the unified diff in its details).
            // Falls back to the raw JSON dump for any event without
            // structured edit metadata.
            const details =
              selected.entryType === 'event'
                ? (selected.details as Record<string, unknown> | undefined)
                : undefined;
            const diff = details && typeof details.diff === 'string' ? details.diff : undefined;
            const addedLines =
              details && typeof details.addedLines === 'number' ? details.addedLines : undefined;
            const removedLines =
              details && typeof details.removedLines === 'number'
                ? details.removedLines
                : undefined;
            return (
              <>
                {diff && (
                  <ToolDiffBlock
                    diff={diff}
                    {...(addedLines !== undefined ? { addedLines } : {})}
                    {...(removedLines !== undefined ? { removedLines } : {})}
                  />
                )}
                <pre className="history-details">{JSON.stringify(selected, null, 2)}</pre>
              </>
            );
          })()}
        </section>
      </div>
    </div>
  );
}

function HistoryEventRow({
  entry,
  gezelName,
  projectName,
}: {
  entry: HistoryEntry & { entryType: 'event' };
  gezelName: string;
  projectName: string;
}) {
  return (
    <>
      <span className="history-kind">📜 {entry.kind}</span>
      <span className="history-summary">{entry.summary}</span>
      <span className="history-meta">
        {projectName && <span className="history-chip">{projectName}</span>}
        {gezelName && <span className="history-chip">{gezelName}</span>}
        <time className="history-time">{formatRelative(entry.at)}</time>
      </span>
    </>
  );
}

function HistorySessionRow({
  entry,
  gezelName,
  projectName,
}: {
  entry: HistoryEntry & { entryType: 'session' };
  gezelName: string;
  projectName: string;
}) {
  const mins = Math.max(1, Math.round(entry.durationMs / 60_000));
  const activity = entry.durationMs < 60_000 ? '<1m' : `${mins}m`;
  return (
    <>
      <span className="history-kind">💬 thread</span>
      <span className="history-summary">
        {gezelName || entry.gezelId} · {entry.title} ({entry.messageCount} msgs, {activity})
      </span>
      <span className="history-meta">
        {projectName && <span className="history-chip">{projectName}</span>}
        <time className="history-time">{formatRelative(entry.lastActivityAt)}</time>
      </span>
    </>
  );
}

function formatRelative(iso: string): string {
  try {
    const then = new Date(iso).getTime();
    const now = Date.now();
    const diff = Math.max(0, now - then);
    const mins = Math.floor(diff / 60_000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  } catch {
    return '';
  }
}
