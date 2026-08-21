import type { GezelSummary, HistoryEntry, Project, SessionSearchResult } from '@bendyline/gezel';
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
import { ToolDiffBlock } from '../components/ToolDiffBlock.js';
import { openTabAction, runNavActions } from '../components/nav-actions.js';
import { Select } from '../primitives/index.js';
import { formatAbsoluteTime, formatRelativeTime } from '../relative-time.js';

const KINDS: Array<{ value: string; label: string }> = [
  { value: '', label: 'All kinds' },
  { value: 'session', label: 'Chat threads' },
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
  { value: 'document.updated', label: 'Document edited' },
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
  // Transcript FTS hits for the same query — what was actually SAID, not just
  // session titles (which is all the history filter itself can match).
  const [transcriptHits, setTranscriptHits] = useState<SessionSearchResult[]>([]);

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
      // In parallel: full-text transcript search over what was actually said.
      // Best-effort — the history list must not fail because the transcript
      // index is unavailable on this install.
      const transcriptPromise = q.trim()
        ? api
            .searchSessions({
              q: q.trim(),
              ...(projectFilter ? { project: projectFilter } : {}),
              ...(gezelFilter ? { gezel: gezelFilter } : {}),
              maxResults: 10,
            })
            .then((r) =>
              r?.engine !== 'unavailable' && Array.isArray(r?.results) ? r.results : [],
            )
            .catch(() => [])
        : Promise.resolve([]);
      const res = await api.listHistory(filter);
      setTranscriptHits(await transcriptPromise);
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
          {transcriptHits.length > 0 && (
            <li className="history-item">
              <span className="history-transcript-header muted">Said in chats</span>
            </li>
          )}
          {transcriptHits.map((hit) => (
            <li key={`transcript:${hit.sessionId}:${hit.messageStart}`} className="history-item">
              <button
                type="button"
                className="history-row"
                onClick={() => {
                  // Deep-link into the conversation at the matched message —
                  // queue-then-dispatch, same contract as the titlebar search.
                  const intent = {
                    gezelId: hit.gezelId,
                    sessionId: hit.sessionId,
                    ...(hit.projectId ? { projectId: hit.projectId } : {}),
                    messageIndex: hit.messageStart,
                  };
                  runNavActions([
                    { kind: 'open-session', intent },
                    openTabAction({ kind: 'gezel', id: hit.gezelId }),
                    { kind: 'event', type: 'gezel:open-session', detail: intent },
                  ]);
                }}
              >
                <span className="history-line">
                  <span className="history-summary">
                    {gezelLabel(hit.gezelId) || hit.gezelId} · {hit.title || 'Untitled session'}
                  </span>
                  <time
                    className="history-time"
                    dateTime={hit.lastActivityAt}
                    title={formatAbsoluteTime(hit.lastActivityAt)}
                  >
                    {formatRelativeTime(hit.lastActivityAt)}
                  </time>
                </span>
                <span className="history-meta">
                  <span className="history-kind">Transcript</span>
                  {projectLabel(hit.projectId) && (
                    <span className="history-chip">{projectLabel(hit.projectId)}</span>
                  )}
                  <span className="history-stat">{hit.snippet}</span>
                </span>
              </button>
            </li>
          ))}
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
            return (
              <HistoryDetail
                entry={selected}
                gezelName={gezelLabel(selected.gezelId)}
                projectName={projectLabel(selected.projectId)}
                resolveGezel={gezelLabel}
                resolveProject={projectLabel}
              />
            );
          })()}
        </section>
      </div>
    </div>
  );
}

type HistoryEventEntry = Extract<HistoryEntry, { entryType: 'event' }>;
type HistorySessionEntry = Extract<HistoryEntry, { entryType: 'session' }>;

const DETAIL_FIELD_LABELS: Record<string, string> = {
  actionId: 'Action',
  appId: 'App',
  archived: 'Status',
  at: 'When',
  bookCatalogId: 'Craftbook',
  bytes: 'Size',
  capabilityFloor: 'Capability floor',
  caseId: 'Case',
  changed: 'Changed fields',
  craftbookId: 'Craftbook',
  createdAt: 'Started',
  credentialName: 'Credential',
  durationMs: 'Duration',
  fieldIds: 'Fields',
  fromPath: 'From',
  fromSteps: 'Steps before',
  gezel: 'Gezel',
  gezelId: 'Gezel',
  id: 'Reference',
  inputTokens: 'Input tokens',
  lastActivityAt: 'Last activity',
  messageCount: 'Messages',
  newName: 'New name',
  oldName: 'Previous name',
  outputTokens: 'Output tokens',
  previous: 'Before',
  previousStatus: 'Previous status',
  previousUrl: 'Previous URL',
  previousVersion: 'Previous version',
  project: 'Project',
  projectId: 'Project',
  questionId: 'Question',
  ref: 'Task',
  reportPath: 'Report',
  runId: 'Run',
  sessionId: 'Chat thread',
  stepId: 'Step',
  taskRef: 'Task',
  toPath: 'To',
  toSteps: 'Steps after',
  trialId: 'Trial',
};

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  'anthropic-cli': 'Claude CLI',
  'codex-cli': 'Codex CLI',
  copilot: 'GitHub Copilot',
  ds4: 'DwarfStar',
  'llama-cpp': 'llama.cpp',
  mlx: 'MLX',
  ollama: 'Ollama',
  openai: 'OpenAI',
  remote: 'Remote device',
};

const DETAIL_ENUM_FIELDS =
  /(?:^|\.)(action|decision|failureClass|kind|outcome|phase|provider|runMode|source|state|status|storageScope|surface|tier|trigger|via)$/i;
const DETAIL_CODE_FIELDS =
  /(?:^|\.)(command|credentialName|id|key|model|path|ref|script|tool|url)$/i;
const DETAIL_DATE_FIELDS = /(?:^at$|At$|Date$|timestamp$)/i;

function HistoryDetail({
  entry,
  gezelName,
  projectName,
  resolveGezel,
  resolveProject,
}: {
  entry: HistoryEntry;
  gezelName: string;
  projectName: string;
  resolveGezel: (id?: string) => string;
  resolveProject: (id?: string) => string;
}) {
  if (entry.entryType === 'session') {
    return <HistorySessionDetail entry={entry} gezelName={gezelName} projectName={projectName} />;
  }
  return (
    <HistoryEventDetail
      entry={entry}
      gezelName={gezelName}
      projectName={projectName}
      resolveGezel={resolveGezel}
      resolveProject={resolveProject}
    />
  );
}

function HistoryEventDetail({
  entry,
  gezelName,
  projectName,
  resolveGezel,
  resolveProject,
}: {
  entry: HistoryEventEntry;
  gezelName: string;
  projectName: string;
  resolveGezel: (id?: string) => string;
  resolveProject: (id?: string) => string;
}) {
  const details = entry.details as Record<string, unknown> | undefined;
  const diff = typeof details?.diff === 'string' ? details.diff : undefined;
  const addedLines = typeof details?.addedLines === 'number' ? details.addedLines : undefined;
  const removedLines = typeof details?.removedLines === 'number' ? details.removedLines : undefined;
  const displayDetails = details
    ? Object.fromEntries(
        Object.entries(details).filter(
          ([key, value]) =>
            value !== undefined && !['diff', 'addedLines', 'removedLines'].includes(key),
        ),
      )
    : undefined;
  const hasDetails = displayDetails && Object.keys(displayDetails).length > 0;
  const valueContext: HistoryValueContext = { resolveGezel, resolveProject };

  return (
    <article className="history-detail-document">
      <header className="history-detail-header">
        <p className="history-detail-eyebrow" title={entry.kind}>
          {kindLabel(entry.kind)}
        </p>
        <h3>{entry.summary}</h3>
        <time dateTime={entry.at} className="history-detail-time">
          {formatDateTime(entry.at)}{' '}
          <span>· {formatRelativeTime(entry.at, { style: 'long' })}</span>
        </time>
      </header>

      {(projectName || gezelName) && (
        <HistoryDetailSection heading="Context">
          <HistoryFieldList
            fields={{
              ...(projectName ? { project: projectName } : {}),
              ...(gezelName ? { gezel: gezelName } : {}),
            }}
            context={valueContext}
          />
        </HistoryDetailSection>
      )}

      {hasDetails && (
        <HistoryDetailSection heading="Details">
          <HistoryFieldList fields={displayDetails} context={valueContext} />
        </HistoryDetailSection>
      )}

      {diff && (
        <HistoryDetailSection heading="Changes">
          <ToolDiffBlock
            diff={diff}
            {...(addedLines !== undefined ? { addedLines } : {})}
            {...(removedLines !== undefined ? { removedLines } : {})}
          />
        </HistoryDetailSection>
      )}

      <HistoryRecordReference id={entry.id} />
    </article>
  );
}

function HistorySessionDetail({
  entry,
  gezelName,
  projectName,
}: {
  entry: HistorySessionEntry;
  gezelName: string;
  projectName: string;
}) {
  return (
    <article className="history-detail-document">
      <header className="history-detail-header">
        <p className="history-detail-eyebrow">Chat thread</p>
        <h3>{entry.title}</h3>
        <p className="history-detail-subtitle">
          {gezelName || entry.gezelId}
          {projectName ? ` in ${projectName}` : ''}
        </p>
      </header>

      <HistoryDetailSection heading="Conversation">
        <HistoryFieldList
          fields={{
            gezel: gezelName || entry.gezelId,
            project: projectName || entry.projectId,
            messageCount: entry.messageCount,
            durationMs: entry.durationMs,
            archived: entry.archived === true ? 'Archived' : 'Active',
          }}
        />
      </HistoryDetailSection>

      <HistoryDetailSection heading="Timing">
        <HistoryFieldList
          fields={{
            createdAt: entry.createdAt,
            lastActivityAt: entry.lastActivityAt,
          }}
        />
      </HistoryDetailSection>

      <HistoryDetailSection heading="Model">
        <HistoryFieldList
          fields={{ provider: entry.providerName, ...(entry.model ? { model: entry.model } : {}) }}
        />
      </HistoryDetailSection>

      <HistoryRecordReference id={entry.id} />
    </article>
  );
}

function HistoryDetailSection({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <section className="history-detail-section">
      <h4>{heading}</h4>
      {children}
    </section>
  );
}

function HistoryRecordReference({ id }: { id: string }) {
  return (
    <footer className="history-detail-reference">
      <span>Record reference</span>
      <code>{id}</code>
    </footer>
  );
}

interface HistoryValueContext {
  resolveGezel?: (id?: string) => string;
  resolveProject?: (id?: string) => string;
}

function HistoryFieldList({
  fields,
  context = {},
  path = '',
}: {
  fields: Record<string, unknown>;
  context?: HistoryValueContext;
  path?: string;
}) {
  const entries = Object.entries(fields).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return <p className="muted">No additional details were recorded.</p>;

  return (
    <dl className="history-detail-fields">
      {entries.map(([key, value]) => {
        const fieldPath = path ? `${path}.${key}` : key;
        return (
          <div className="history-detail-field" key={fieldPath}>
            <dt>{detailFieldLabel(key)}</dt>
            <dd>
              <HistoryFieldValue
                field={key}
                fieldPath={fieldPath}
                value={value}
                context={context}
              />
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

function HistoryFieldValue({
  field,
  fieldPath,
  value,
  context,
}: {
  field: string;
  fieldPath: string;
  value: unknown;
  context: HistoryValueContext;
}) {
  if (value === null) return <span className="history-detail-empty">Not set</span>;
  if (typeof value === 'boolean') return <span>{value ? 'Yes' : 'No'}</span>;
  if (typeof value === 'number') {
    if (field.toLowerCase().endsWith('ms')) return <span>{formatDuration(value)}</span>;
    if (field.toLowerCase().endsWith('bytes') || field === 'bytes') {
      return <span>{formatBytes(value)}</span>;
    }
    return <span>{value.toLocaleString()}</span>;
  }
  if (typeof value === 'string') {
    if (DETAIL_DATE_FIELDS.test(field) && isValidDate(value)) {
      return <time dateTime={value}>{formatDateTime(value)}</time>;
    }
    const resolved = resolveHistoryReference(field, value, context);
    const display = detailStringValue(fieldPath, resolved);
    if (DETAIL_CODE_FIELDS.test(fieldPath)) {
      return <code className="history-detail-code">{display}</code>;
    }
    return <span className="history-detail-text">{display}</span>;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="history-detail-empty">None</span>;
    return (
      <ul className="history-detail-list">
        {value.map((item, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: History arrays are immutable audit values with no stable item identity.
          <li key={`${fieldPath}:${index}`}>
            {isRecord(item) ? (
              <HistoryFieldList fields={item} context={context} path={`${fieldPath}.${index}`} />
            ) : (
              <HistoryFieldValue
                field={field}
                fieldPath={fieldPath}
                value={item}
                context={context}
              />
            )}
          </li>
        ))}
      </ul>
    );
  }
  if (isRecord(value)) {
    return (
      <div className="history-detail-nested">
        <HistoryFieldList fields={value} context={context} path={fieldPath} />
      </div>
    );
  }
  return <span className="history-detail-text">{String(value)}</span>;
}

function detailFieldLabel(field: string): string {
  const known = DETAIL_FIELD_LABELS[field];
  if (known) return known;
  const words = field
    .replace(/[._-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/\bid\b/g, 'ID')
    .replace(/\burl\b/g, 'URL')
    .replace(/\bapi\b/g, 'API')
    .trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function detailStringValue(fieldPath: string, value: string): string {
  const field = fieldPath.split('.').at(-1) ?? fieldPath;
  if (field.toLowerCase().includes('provider')) return PROVIDER_LABELS[value] ?? value;
  if (DETAIL_ENUM_FIELDS.test(fieldPath)) return humanizeEnum(value);
  return value;
}

function resolveHistoryReference(
  field: string,
  value: string,
  context: HistoryValueContext,
): string {
  if (field === 'gezelId') return context.resolveGezel?.(value) || value;
  if (field === 'projectId' || field === 'targetProjectId') {
    return context.resolveProject?.(value) || value;
  }
  return value;
}

function humanizeEnum(value: string): string {
  const words = value.replace(/[._-]+/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidDate(value: string): boolean {
  return !Number.isNaN(new Date(value).getTime());
}

function formatDateTime(iso: string): string {
  if (!isValidDate(iso)) return iso;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(iso));
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return `${ms} ms`;
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  const totalSeconds = Math.round(ms / 1_000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (days) parts.push(`${days} ${days === 1 ? 'day' : 'days'}`);
  if (hours) parts.push(`${hours} ${hours === 1 ? 'hour' : 'hours'}`);
  if (minutes) parts.push(`${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`);
  if (seconds && parts.length < 2) parts.push(`${seconds} ${seconds === 1 ? 'second' : 'seconds'}`);
  return parts.slice(0, 2).join(' ');
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return `${bytes} bytes`;
  if (bytes < 1_024) return `${bytes.toLocaleString()} ${bytes === 1 ? 'byte' : 'bytes'}`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1_024;
  let unit = units[0];
  for (let i = 1; i < units.length && value >= 1_024; i += 1) {
    value /= 1_024;
    unit = units[i];
  }
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value)} ${unit}`;
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
  'document.updated': 'Document edited',
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
        <time className="history-time" dateTime={entry.at} title={formatAbsoluteTime(entry.at)}>
          {formatRelativeTime(entry.at)}
        </time>
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
        <time
          className="history-time"
          dateTime={entry.lastActivityAt}
          title={formatAbsoluteTime(entry.lastActivityAt)}
        >
          {formatRelativeTime(entry.lastActivityAt)}
        </time>
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
