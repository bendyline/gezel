import type { GezelSummary, HistoryEntry, HistoryEventKind, Project } from '@bendyline/gezel';
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
  { value: 'document.renamed', label: 'Document renamed' },
  { value: 'document.deleted', label: 'Document deleted' },
  { value: 'tool.called', label: 'Tool called' },
  { value: 'meester.changed', label: 'Meester changed' },
  { value: 'klerk.changed', label: 'Klerk changed' },
  { value: 'boekwachter.changed', label: 'Boekwachter changed' },
  { value: 'keurmeester.changed', label: 'Keurmeester changed' },
  { value: 'gilde.updated', label: 'Catalog content updated' },
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
  { value: 'v1.chat.completion', label: 'App chat (connected apps)' },
  { value: 'debug.bridge.failed', label: 'Debug: MCP bridge failed to start' },
];

const LIST_FRACTION_STORAGE_KEY = 'gezel:history-list-fraction:v1';
const MIN_LIST_FRACTION = 0.2;
const MAX_LIST_FRACTION = 0.7;
const DEFAULT_LIST_FRACTION = 0.36;

function clampListFraction(f: number): number {
  if (!Number.isFinite(f)) return DEFAULT_LIST_FRACTION;
  return Math.max(MIN_LIST_FRACTION, Math.min(MAX_LIST_FRACTION, f));
}

function readStoredListFraction(): number {
  if (typeof window === 'undefined') return DEFAULT_LIST_FRACTION;
  try {
    const raw = window.localStorage.getItem(LIST_FRACTION_STORAGE_KEY);
    if (!raw) return DEFAULT_LIST_FRACTION;
    return clampListFraction(Number.parseFloat(raw));
  } catch {
    return DEFAULT_LIST_FRACTION;
  }
}

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
      // Land on the newest entry instead of an empty detail pane; never
      // stomp a selection the user (or a deep link) already made.
      setSelectedId((prev) => {
        const idOf = (e: HistoryEntry) => (e.entryType === 'event' ? e.id : `session:${e.id}`);
        if (prev && filtered.some((e) => idOf(e) === prev)) return prev;
        const first = filtered[0];
        return first ? idOf(first) : null;
      });
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

  // Resizable splitter between the entry list and the detail pane. The
  // list is the LEFT column, so dragging the grip right grows it. Reuses
  // the chat-rail `body.chat-rail-resizing` class to block text selection
  // for the duration of the drag.
  const splitRef = useRef<HTMLDivElement | null>(null);
  const [listFraction, setListFraction] = useState<number>(() => readStoredListFraction());
  const dragState = useRef<{ startX: number; startFraction: number; width: number } | null>(null);
  const commitListFraction = useCallback((next: number) => {
    const clamped = clampListFraction(next);
    setListFraction(clamped);
    try {
      window.localStorage.setItem(LIST_FRACTION_STORAGE_KEY, clamped.toFixed(4));
    } catch {
      /* quota / private mode — state still in memory */
    }
  }, []);
  const onGripMouseDown = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      e.preventDefault();
      dragState.current = {
        startX: e.clientX,
        startFraction: listFraction,
        width: splitRef.current?.clientWidth ?? 1,
      };
      document.body.classList.add('chat-rail-resizing');
      document.body.style.cursor = 'col-resize';
      const onMove = (ev: MouseEvent) => {
        const st = dragState.current;
        if (!st || st.width <= 0) return;
        commitListFraction(st.startFraction + (ev.clientX - st.startX) / st.width);
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
    [listFraction, commitListFraction],
  );
  const onGripKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      const step = e.shiftKey ? 0.08 : 0.02;
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        commitListFraction(listFraction + step);
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        commitListFraction(listFraction - step);
      } else if (e.key === 'Home') {
        e.preventDefault();
        commitListFraction(MIN_LIST_FRACTION);
      } else if (e.key === 'End') {
        e.preventDefault();
        commitListFraction(MAX_LIST_FRACTION);
      }
    },
    [listFraction, commitListFraction],
  );

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

      <div
        className="history-split"
        ref={splitRef}
        style={{ ['--history-list-width' as string]: `${(listFraction * 100).toFixed(2)}%` }}
      >
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
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize history list"
          tabIndex={0}
          className="chat-rail-grip history-split-grip"
          onMouseDown={onGripMouseDown}
          onKeyDown={onGripKeyDown}
        />
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
            // `tool.called` event for replace_in_file / apply_patch /
            // insert_at_marker carries the unified diff in its details).
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

/**
 * Human labels for event kinds. The raw dotted identifiers (`poppetje.
 * generated`) are for `search_history` and the JSONL on disk — as a row's
 * lead text they read as plumbing. The raw kind stays one hover away via
 * the title attribute. Unknown kinds fall back to de-dotted words so new
 * event types never regress to identifiers.
 */
const KIND_LABELS: Record<string, string> = {
  'gezel.created': 'Gezel created',
  'gezel.renamed': 'Gezel renamed',
  'gezel.settings.updated': 'Gezel settings',
  'project.created': 'Project created',
  'project.updated': 'Project updated',
  'project.about.updated': 'Project brief',
  'project.mission.updated': 'Mission updated',
  'project.voorman.changed': 'Voorman changed',
  'project.gezel.joined': 'Joined project',
  'icon.generated': 'Icon generated',
  'icon.reverted': 'Icon reverted',
  'poppetje.generated': 'Portrait carved',
  'document.created': 'Document created',
  'document.renamed': 'Document renamed',
  'document.deleted': 'Document deleted',
  'craftbook.created': 'Craftbook created',
  'task.created': 'Task created',
  'tool.called': 'Tool call',
  'meester.changed': 'Meester changed',
  'klerk.changed': 'Klerk changed',
  'boekwachter.changed': 'Boekwachter changed',
  'keurmeester.changed': 'Keurmeester changed',
  'gilde.updated': 'Catalog content updated',
  'v1.chat.completion': 'App chat',
};

function kindLabel(kind: string): string {
  const known = KIND_LABELS[kind];
  if (known) return known;
  const words = kind.split('.').join(' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
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
      <span className="history-line">
        <span className="history-summary">{entry.summary}</span>
        <time className="history-time">{formatRelative(entry.at)}</time>
      </span>
      <span className="history-meta">
        <span className="history-kind" title={entry.kind}>
          {kindLabel(entry.kind)}
        </span>
        {projectName && <span className="history-chip">{projectName}</span>}
        {gezelName && <span className="history-chip">{gezelName}</span>}
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
      <span className="history-line">
        <span className="history-summary">
          {gezelName || entry.gezelId} · {entry.title}
        </span>
        <time className="history-time">{formatRelative(entry.lastActivityAt)}</time>
      </span>
      <span className="history-meta">
        <span className="history-kind">Thread</span>
        {projectName && <span className="history-chip">{projectName}</span>}
        <span className="history-stat">
          {entry.messageCount} msgs, {activity}
        </span>
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
