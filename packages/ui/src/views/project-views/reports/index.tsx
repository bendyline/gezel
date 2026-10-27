import type {
  ProjectReport,
  ProjectReportKind,
  ProjectReportsResponse,
  WritableReportKind,
} from '@bendyline/gezel';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../../api.js';
import { ReportDocument } from '../../../components/ReportDocument.js';
import { DropdownChevron, DropdownMenu, Select } from '../../../primitives/index.js';
import { formatRelativeTime } from '../../../relative-time.js';
import type { ProjectViewProps } from '../types.js';
import { IssueHandoffActions } from './IssueHandoffActions.js';
import '../../../styles/reports-view.css';

/** Groups in reading order: the standing map first, then the dated reports. */
const KIND_ORDER: readonly ProjectReportKind[] = [
  'map',
  'issues',
  'codebase',
  'documents',
  'photos',
  'review',
  'digest',
  'other',
];

const KIND_LABEL: Record<ProjectReportKind, string> = {
  map: 'Codebase map',
  issues: 'Issues for review',
  codebase: 'Codebase',
  documents: 'Documents',
  photos: 'Photos',
  review: 'Code reviews',
  digest: 'Digests',
  other: 'From tasks',
};

const WRITE_LABEL: Record<WritableReportKind, { title: string; hint: string }> = {
  codebase: { title: 'Codebase report', hint: 'Hotspots, load-bearing files and open issues' },
  map: { title: 'Codebase map', hint: 'What each folder is for, and where to start' },
  issues: {
    title: 'Issues for review',
    hint: 'Suspected problems, for your coding app to check and answer',
  },
  documents: { title: 'Documents report', hint: 'What changed this week, with a summary of each' },
  photos: { title: 'Photos report', hint: 'Recent outings, on this day, and duplicates' },
};

/**
 * The Reports view: every report in the project's artifacts drawer — the
 * nightly ones, the codebase map, code reviews, digests and what tasks wrote —
 * listed by kind beside a reader. A file a report names opens in the shared
 * inspector. "Write … now" runs the model-free writers on request, so a
 * project does not have to wait for its first night.
 */
export default function ReportsProjectView({
  projectId,
  compact,
  onSelectPath,
  setInspectorExtras,
}: ProjectViewProps) {
  const [data, setData] = useState<ProjectReportsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [writing, setWriting] = useState<WritableReportKind | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(
    (select?: string) => {
      setError(null);
      return api
        .listProjectReports(projectId)
        .then((res) => {
          setData(res);
          if (select) setChosen(select);
        })
        .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    },
    [projectId],
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    setInspectorExtras(null);
    return () => setInspectorExtras(null);
  }, [setInspectorExtras]);

  const reports = data?.reports ?? [];
  const current = reports.find((r) => r.path === chosen) ?? reports[0] ?? null;
  const groups = useMemo(() => {
    const byKind = new Map<ProjectReportKind, ProjectReport[]>();
    for (const r of reports) byKind.set(r.kind, [...(byKind.get(r.kind) ?? []), r]);
    return KIND_ORDER.filter((k) => byKind.has(k)).map((k) => ({ kind: k, reports: byKind.get(k)! }));
  }, [reports]);

  const write = async (kind: WritableReportKind) => {
    setWriting(kind);
    setNote(null);
    try {
      const res = await api.generateProjectReport(projectId, kind);
      if (res.path) await load(res.path);
      if (!res.wrote) {
        setNote(
          res.path
            ? `The ${WRITE_LABEL[kind].title.toLowerCase()} is already up to date.`
            : `Nothing new to put in a ${WRITE_LABEL[kind].title.toLowerCase()} yet.`,
        );
      }
    } catch (e: unknown) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setWriting(null);
    }
  };

  const writable = data?.writable ?? [];
  const openPath = (path: string, line?: number) => onSelectPath(path, line ? { line } : undefined);

  return (
    <section className={compact ? 'reports-view reports-view--compact' : 'reports-view'}>
      <header className="reports-view-header">
        {compact && reports.length > 0 ? (
          <Select.Root value={current?.path ?? ''} onValueChange={setChosen}>
            <Select.Trigger aria-label="Choose a report">
              <Select.Value />
            </Select.Trigger>
            <Select.Content>
              {reports.map((r) => (
                <Select.Item key={r.path} value={r.path}>
                  {r.title}
                </Select.Item>
              ))}
            </Select.Content>
          </Select.Root>
        ) : (
          <h2>Reports</h2>
        )}
        {writable.length > 0 && (
          <WriteNow writable={writable} writing={writing} onWrite={(k) => void write(k)} />
        )}
      </header>
      {note && <p className="reports-view-note">{note}</p>}
      {error && <p className="reports-view-empty">Couldn’t load the reports: {error}</p>}
      {!error && data && reports.length === 0 && (
        <p className="reports-view-empty">
          {writable.length > 0
            ? 'No reports yet. Gezel writes them overnight, or you can write one now.'
            : 'No reports yet. Reports Gezel or its gezellen write for this project appear here.'}
        </p>
      )}
      {reports.length > 0 && (
        <div className="reports-view-body">
          {!compact && (
            <nav className="reports-list" aria-label="Reports">
              {groups.map((group) => (
                <section key={group.kind} className="reports-list-group">
                  <h3>{KIND_LABEL[group.kind]}</h3>
                  <ul>
                    {group.reports.map((r) => (
                      <li key={r.path}>
                        <button
                          type="button"
                          className="reports-list-item"
                          aria-current={r.path === current?.path ? 'true' : undefined}
                          title={r.path}
                          onClick={() => setChosen(r.path)}
                        >
                          <span className="reports-list-title">{r.title}</span>
                          <span className="reports-list-meta">
                            {formatRelativeTime(r.mtimeMs, { style: 'long' })}
                            {r.actions > 0 &&
                              ` · ${r.actions} suggestion${r.actions === 1 ? '' : 's'}`}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
              {data?.truncated && (
                <p className="reports-view-note">Older reports are in the Artifacts tab.</p>
              )}
            </nav>
          )}
          {current && (
            <article className="reports-reader" aria-label={current.title}>
              {current.kind === 'issues' && (
                <IssueHandoffActions
                  projectId={projectId}
                  path={current.path}
                  onImported={() => void load(current.path)}
                />
              )}
              <ReportDocument
                key={`${current.path}:${current.mtimeMs}`}
                projectId={projectId}
                path={current.path}
                onOpenPath={openPath}
              />
            </article>
          )}
        </div>
      )}
    </section>
  );
}

function WriteNow({
  writable,
  writing,
  onWrite,
}: {
  writable: readonly WritableReportKind[];
  writing: WritableReportKind | null;
  onWrite: (kind: WritableReportKind) => void;
}) {
  const [first, ...rest] = writable;
  if (!first) return null;
  return (
    <div className="gz-tray" role="group" aria-label="Write a report now">
      <button
        type="button"
        className="gz-key"
        disabled={writing !== null}
        title={WRITE_LABEL[first].hint}
        onClick={() => onWrite(first)}
      >
        {writing === first ? 'Writing…' : `Write ${WRITE_LABEL[first].title.toLowerCase()} now`}
      </button>
      {rest.length > 0 && (
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button
              type="button"
              className="gz-key gz-key--icon"
              aria-label="Other reports"
              disabled={writing !== null}
            >
              <DropdownChevron />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content className="app-nav-menu" sideOffset={4} align="end">
              {rest.map((kind) => (
                <DropdownMenu.Item
                  key={kind}
                  className="app-nav-menu-item"
                  onSelect={() => onWrite(kind)}
                >
                  <span>{WRITE_LABEL[kind].title}</span>
                  <small>{WRITE_LABEL[kind].hint}</small>
                </DropdownMenu.Item>
              ))}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      )}
    </div>
  );
}
