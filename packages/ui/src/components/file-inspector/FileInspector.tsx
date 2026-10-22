import {
  type BoekwachterIssue,
  type ComposedCodeContext,
  type FileInsightResponse,
  type FileReviewIssue,
  type FileReviewWire,
  type SecurityFindingWire,
  composeFileContext,
  createLogger,
  formatReviewProvenance,
  parseGezelHref,
} from '@bendyline/gezel';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api.js';
import { DropdownChevron } from '../../primitives/index.js';
import { MarkdownField } from '../MarkdownField.js';
import { PhotoThumb } from '../PhotoThumb.js';
import { isImage } from '../file-browser/FilePreview.js';
import { looksBinary } from '../file-browser/index.js';
import { monacoLanguageForIndexedLanguage } from '../monaco-language.js';
import { navigateToTab, openProjectFileActions, runNavActions } from '../nav-actions.js';
import { FileSourceView, type SourceRevealRequest } from './FileSourceView.js';
import { InspectorInsight, insightChips } from './InspectorInsight.js';
import {
  BOEKWACHTER_ISSUES_CHANGED_EVENT,
  type BoekwachterIssuePatch,
  TrackedIssueItem,
  announceBoekwachterIssuesChanged,
  isOpenIssue,
  sendIssuePatch,
  useIssueActions,
} from './tracked-issues.js';
import '../../styles/file-inspector.css';

const log = createLogger('file-inspector');

const noop = () => undefined;

/** How many composed file contexts one inspector keeps, so hopping between files doesn't refetch. */
const CONTEXT_CACHE_SIZE = 20;

/**
 * Plain-text label for a review issue row. Severity stays text on purpose —
 * the review vocabulary (info | minor | major) is deliberately separate from
 * security-finding severities and must not borrow their colored badges.
 */
export function reviewIssueLabel(issue: FileReviewIssue): string {
  const location = issue.line != null ? ` (Line ${issue.line})` : '';
  return `[${issue.severity}] ${issue.category} — ${issue.message}${location}`;
}

type FileState =
  | { path: string; kind: 'loading' }
  | { path: string; kind: 'ready'; content: string }
  | { path: string; kind: 'binary' }
  | { path: string; kind: 'error'; error: string };

interface CachedContext {
  composed: ComposedCodeContext;
  summary: string | null;
}

export interface FileInspectorConnection {
  path: string;
  label: string;
}

export interface FileInspectorProps {
  projectId: string;
  path: string;
  /** What the view already knows about the file, shown before anything loads. */
  known?: { label?: string; lang?: string | null; lines?: number; symbols?: number };
  /** Chips only the current view can say (the Village's town style, a PR's change). */
  chips?: ReactNode;
  /** Files the view knows are connected to this one (the Village's import roads). */
  connections?: readonly FileInspectorConnection[];
  /** A line the view asked to show (a symbol building); a new object re-reveals. */
  sourceReveal?: SourceRevealRequest | null;
  /** Move the selection within the view — a connected file or a code-context link. */
  onSelectPath: (path: string, line?: number) => void;
  onClose: () => void;
  /** A finding changed lifecycle, so anything drawn from findings can refresh. */
  onFindingsChanged?: () => void;
  /** Ask the host to draft a fix for a tracked Boekwachter issue. */
  onFixIssue?: (path: string, issue: BoekwachterIssue) => void;
  /** Bump to forget cached file context (the view rebuilt from a fresh index). */
  revision?: number;
  className?: string;
}

/**
 * The right-hand pane every project view opens for a selected file: what the
 * file is, what it touches, what the background passes found in it, and the
 * file itself. One pane for every view, so a file reads the same whichever
 * view it was picked from. Each section degrades to nothing when the index
 * has nothing to say — a missing review or context is never an error here.
 */
export function FileInspector({
  projectId,
  path,
  known,
  chips,
  connections = [],
  sourceReveal: requestedReveal,
  onSelectPath,
  onClose,
  onFindingsChanged,
  onFixIssue,
  revision = 0,
  className,
}: FileInspectorProps) {
  const [file, setFile] = useState<FileState | null>(null);
  const [sourceReveal, setSourceReveal] = useState<SourceRevealRequest | null>(null);
  const [findings, setFindings] = useState<SecurityFindingWire[]>([]);
  const [findingsLoading, setFindingsLoading] = useState(false);
  const [activeFinding, setActiveFinding] = useState<string | null>(null);
  const [findingAction, setFindingAction] = useState<{
    fingerprint: string;
    kind: 'resolve' | 'delegate';
  } | null>(null);
  const [findingError, setFindingError] = useState<string | null>(null);
  const [findingRevision, setFindingRevision] = useState(0);
  const [review, setReview] = useState<FileReviewWire | null>(null);
  const [trackedIssues, setTrackedIssues] = useState<BoekwachterIssue[]>([]);
  const [reviewPending, setReviewPending] = useState(false);
  const [reviewIneligible, setReviewIneligible] = useState(false);
  const [reviewRevision, setReviewRevision] = useState(0);
  const [showClosed, setShowClosed] = useState(false);
  const [connectedOpen, setConnectedOpen] = useState(false);
  const [codeContext, setCodeContext] = useState<{ path: string; value: CachedContext } | null>(
    null,
  );
  const [insight, setInsight] = useState<{ path: string; value: FileInsightResponse } | null>(null);
  const contextCache = useRef(new Map<string, CachedContext>());

  // A rebuilt view may know new facts; drop what this pane remembered.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `revision` is the trigger, not an input.
  useEffect(() => {
    contextCache.current.clear();
  }, [revision]);

  useEffect(() => {
    if (requestedReveal) setSourceReveal(requestedReveal);
  }, [requestedReveal]);

  // Load the file for the viewer. Stale responses (selection changed
  // mid-flight) are dropped via the cancelled flag.
  useEffect(() => {
    setConnectedOpen(false);
    setShowClosed(false);
    let cancelled = false;
    setFile({ path, kind: 'loading' });
    api
      .readProjectWorkspaceFile(projectId, path)
      .then((res) => {
        if (cancelled) return;
        setFile(
          looksBinary(res.content, path)
            ? { path, kind: 'binary' }
            : { path, kind: 'ready', content: res.content },
        );
      })
      .catch((e: unknown) => {
        if (!cancelled)
          setFile({ path, kind: 'error', error: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [path, projectId]);

  // Findings are fetched separately from the prose context because this wire
  // shape carries the stable fingerprint + task lifecycle needed by actions.
  // biome-ignore lint/correctness/useExhaustiveDependencies: findingRevision deliberately re-fetches lifecycle state after resolve/task completion.
  useEffect(() => {
    let cancelled = false;
    setFindingsLoading(true);
    setFindingError(null);
    api
      .toolScanFindings(projectId, { path, maxResults: 100 })
      .then((res) => {
        if (cancelled) return;
        const exact = res.findings.filter((finding) => finding.path === path);
        setFindings(exact);
        setActiveFinding((current) =>
          current && exact.some((finding) => finding.fingerprint === current)
            ? current
            : (exact[0]?.fingerprint ?? null),
        );
        const firstLine = exact.find((finding) => finding.line != null)?.line;
        if (firstLine) setSourceReveal({ path, line: firstLine });
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setFindings([]);
          setFindingError(e instanceof Error ? e.message : String(e));
        }
      })
      .finally(() => {
        if (!cancelled) setFindingsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [path, projectId, findingRevision]);

  // The boekwachter's review of the file (cliffs notes, issues, health).
  // Absence — never reviewed, index not ready, request failed — just renders
  // no card; `pending` renders the one-line "not reviewed yet" note.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reviewRevision re-fetches after an issue changed anywhere.
  useEffect(() => {
    let cancelled = false;
    api
      .toolFileReview(projectId, { path })
      .then((res) => {
        if (cancelled) return;
        setReview(res.review ?? null);
        setTrackedIssues(res.trackedIssues ?? []);
        setReviewPending(res.pending === true);
        setReviewIneligible(res.eligible === false);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        log.debug('file-review unavailable', e);
        setReview(null);
        setTrackedIssues([]);
        setReviewPending(false);
        setReviewIneligible(false);
      });
    return () => {
      cancelled = true;
    };
  }, [path, projectId, reviewRevision]);

  // A clean slate per file, so the last file's review never shows under this one.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset when the file changes.
  useEffect(() => {
    setReview(null);
    setTrackedIssues([]);
    setReviewPending(false);
    setReviewIneligible(false);
  }, [path, projectId]);

  useEffect(() => {
    const onChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId?: string }>).detail;
      if (!detail?.projectId || detail.projectId === projectId) {
        setReviewRevision((n) => n + 1);
      }
    };
    window.addEventListener(BOEKWACHTER_ISSUES_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(BOEKWACHTER_ISSUES_CHANGED_EVENT, onChanged);
  }, [projectId]);

  // Per-symbol context for the viewer and the file's own summary — progressive
  // enhancement, fetched in parallel with the content. Every failure (404,
  // index not ready, network) silently renders the plain editor.
  // biome-ignore lint/correctness/useExhaustiveDependencies: findingRevision deliberately invalidates finding prose after lifecycle changes.
  useEffect(() => {
    const cached = contextCache.current.get(path);
    if (cached) {
      setCodeContext({ path, value: cached });
      return;
    }
    let cancelled = false;
    setCodeContext(null);
    api
      .toolFileContext(projectId, { path })
      .then((res) => {
        if (cancelled) return;
        const value: CachedContext = {
          composed: composeFileContext(res),
          summary: res.summary ?? null,
        };
        if (contextCache.current.size >= CONTEXT_CACHE_SIZE) {
          const oldest = contextCache.current.keys().next().value;
          if (oldest !== undefined) contextCache.current.delete(oldest);
        }
        contextCache.current.set(path, value);
        setCodeContext({ path, value });
      })
      .catch((e: unknown) => {
        if (!cancelled) log.debug('file-context unavailable', e);
      });
    return () => {
      cancelled = true;
    };
  }, [path, projectId, findingRevision, revision]);

  // What the index knows about the file whatever its kind: summary, folder,
  // photo and git facts, and its connections. A failure shows none of it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision re-reads after the view rebuilt.
  useEffect(() => {
    let cancelled = false;
    api
      .getFileInsight(projectId, path)
      .then((value) => {
        if (cancelled) return;
        setInsight(value && typeof value === 'object' && 'path' in value ? { path, value } : null);
      })
      .catch((e: unknown) => {
        if (!cancelled) log.debug('file-insight unavailable', e);
      });
    return () => {
      cancelled = true;
    };
  }, [path, projectId, revision]);
  const currentInsight = insight?.path === path ? insight.value : null;
  const contextSummary = codeContext?.path === path ? codeContext.value.summary : null;

  const handleContextLink = useCallback(
    (href: string): boolean => {
      const parsed = parseGezelHref(href);
      if (parsed?.kind !== 'file') return false;
      onSelectPath(parsed.path, parsed.line);
      return true;
    },
    [onSelectPath],
  );

  const selectFinding = useCallback((finding: SecurityFindingWire) => {
    setActiveFinding(finding.fingerprint);
    if (finding.line != null) setSourceReveal({ path: finding.path, line: finding.line });
  }, []);

  const resolveFinding = useCallback(
    async (finding: SecurityFindingWire) => {
      setFindingAction({ fingerprint: finding.fingerprint, kind: 'resolve' });
      setFindingError(null);
      try {
        await api.resolveSecurityFinding(projectId, { fingerprint: finding.fingerprint });
        setFindings((current) => current.filter((f) => f.fingerprint !== finding.fingerprint));
        setActiveFinding(null);
        contextCache.current.delete(finding.path);
        setFindingRevision((n) => n + 1);
        onFindingsChanged?.();
      } catch (e) {
        setFindingError(e instanceof Error ? e.message : String(e));
      } finally {
        setFindingAction(null);
      }
    },
    [onFindingsChanged, projectId],
  );

  const delegateFinding = useCallback(
    async (finding: SecurityFindingWire) => {
      setFindingAction({ fingerprint: finding.fingerprint, kind: 'delegate' });
      setFindingError(null);
      try {
        const result = await api.delegateSecurityFinding(projectId, {
          fingerprint: finding.fingerprint,
        });
        setFindings((current) =>
          current.map((item) => (item.fingerprint === finding.fingerprint ? result.finding : item)),
        );
        setActiveFinding(finding.fingerprint);
      } catch (e) {
        setFindingError(e instanceof Error ? e.message : String(e));
      } finally {
        setFindingAction(null);
      }
    },
    [projectId],
  );

  // The service closes findings when their linked terminal task completes.
  // Poll only while this file visibly has delegated work so the fire and card
  // disappear promptly without keeping a global background loop in the UI.
  useEffect(() => {
    const taskRefs = [
      ...new Set(findings.flatMap((finding) => (finding.taskRef ? [finding.taskRef] : []))),
    ];
    if (taskRefs.length === 0) return;
    let cancelled = false;
    const check = async () => {
      const tasks = await Promise.all(
        taskRefs.map((ref) => api.getTaskByRef(ref).catch(() => null)),
      );
      if (cancelled) return;
      if (tasks.some((task) => task?.status === 'complete' || task?.status === 'canceled')) {
        contextCache.current.clear();
        setFindingRevision((n) => n + 1);
        onFindingsChanged?.();
      }
    };
    const timer = window.setInterval(() => void check(), 5_000);
    void check();
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [findings, onFindingsChanged]);

  const updateIssue = useCallback(
    async (issue: BoekwachterIssue, patch: BoekwachterIssuePatch) => {
      await sendIssuePatch(projectId, issue, patch);
      announceBoekwachterIssuesChanged(projectId);
    },
    [projectId],
  );
  const { issueAction, issueActionError, runIssueAction } = useIssueActions(updateIssue);

  const name = known?.label ?? path.slice(path.lastIndexOf('/') + 1);
  const reviewProvenance = review ? formatReviewProvenance(review) : null;
  const visibleTrackedIssues = useMemo(
    () => trackedIssues.filter((issue) => showClosed || isOpenIssue(issue)),
    [showClosed, trackedIssues],
  );
  const legacyIssues = trackedIssues.length === 0 ? (review?.issues ?? []) : [];
  const revealLine = (line: number) => setSourceReveal({ path, line });

  return (
    <aside
      className={`file-inspector filemap-fileview${className ? ` ${className}` : ''}`}
      aria-label={`About ${name}`}
    >
      <header className="filemap-fileview-head">
        <div className="filemap-fileview-titlerow">
          <span className="filemap-fileview-name" title={path}>
            {name}
          </span>
          <div className="filemap-fileview-actions">
            {connections.length > 0 && (
              <button
                type="button"
                className="filemap-fileview-connected-btn"
                aria-expanded={connectedOpen}
                onClick={() => setConnectedOpen((o) => !o)}
              >
                <span>Connected ({connections.length})</span>
                <DropdownChevron />
              </button>
            )}
            <button
              type="button"
              className="filemap-fileview-connected-btn"
              title="Open this file in the Workspace tab"
              onClick={() =>
                runNavActions(openProjectFileActions({ projectId, path, source: 'workspace' }))
              }
            >
              Open
            </button>
            <button
              type="button"
              className="filemap-fileview-close"
              onClick={onClose}
              aria-label="Close"
            >
              ×
            </button>
          </div>
          {connectedOpen && connections.length > 0 && (
            <div className="filemap-fileview-menu">
              <ul>
                {connections.slice(0, 60).map((c) => (
                  <li key={c.path}>
                    <button
                      type="button"
                      title={c.path}
                      onClick={() => {
                        onSelectPath(c.path);
                        setConnectedOpen(false);
                      }}
                    >
                      {c.label}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
        <div className="filemap-fileview-stats">
          <span className="filemap-fileview-path">{path}</span>
          {known?.lines !== undefined && (
            <span className="filemap-chip">{Math.round(known.lines)} lines</span>
          )}
          {known?.symbols !== undefined && (
            <span className="filemap-chip">{known.symbols} symbols</span>
          )}
          {known?.lang && <span className="filemap-chip">{known.lang}</span>}
          {insightChips(currentInsight).map((chip) => (
            <span key={chip} className="filemap-chip">
              {chip}
            </span>
          ))}
          {chips}
        </div>
      </header>
      <InspectorInsight
        insight={currentInsight}
        fallbackSummary={contextSummary}
        onSelectPath={(p) => onSelectPath(p)}
      />
      {(findingsLoading || findings.length > 0 || findingError) && (
        <section className="filemap-findings" aria-label="Findings in this file">
          <div className="filemap-findings-heading">
            <strong>
              {findings.length} open finding{findings.length === 1 ? '' : 's'}
            </strong>
            {findingsLoading && <span>Checking…</span>}
          </div>
          {findings.map((finding) => {
            const active = finding.fingerprint === activeFinding;
            const resolving =
              findingAction?.fingerprint === finding.fingerprint &&
              findingAction.kind === 'resolve';
            const delegating =
              findingAction?.fingerprint === finding.fingerprint &&
              findingAction.kind === 'delegate';
            return (
              <article
                key={finding.fingerprint}
                className={`filemap-finding-card${active ? ' active' : ''}`}
                data-severity={finding.severity}
              >
                <button
                  type="button"
                  className="filemap-finding-summary"
                  aria-pressed={active}
                  onClick={() => selectFinding(finding)}
                >
                  <span className="filemap-finding-severity">{finding.severity}</span>
                  <strong>{finding.title}</strong>
                  <span className="filemap-finding-location">
                    {finding.line != null ? `Line ${finding.line}` : 'Whole file'}
                  </span>
                </button>
                {active && (
                  <div className="filemap-finding-detail">
                    {finding.evidence && <code>{finding.evidence}</code>}
                    <span>
                      {finding.source} · {finding.ruleId} · {finding.category}
                    </span>
                    {finding.taskRef && (
                      <span className="filemap-finding-task">
                        Developer gezel working ·{' '}
                        <button
                          type="button"
                          className="link-button filemap-finding-task-link"
                          aria-label={`Open task ${finding.taskRef}`}
                          onClick={() => navigateToTab({ kind: 'task', ref: finding.taskRef! })}
                        >
                          {finding.taskRef}
                        </button>
                      </span>
                    )}
                    <div className="filemap-finding-actions">
                      <button
                        type="button"
                        onClick={() => void resolveFinding(finding)}
                        disabled={findingAction != null}
                      >
                        {resolving ? 'Resolving…' : 'Mark resolved'}
                      </button>
                      <button
                        type="button"
                        onClick={() => void delegateFinding(finding)}
                        disabled={findingAction != null || finding.status === 'in_progress'}
                      >
                        {delegating
                          ? 'Finding a developer…'
                          : finding.status === 'in_progress'
                            ? 'Developer working'
                            : 'Ask a developer gezel'}
                      </button>
                    </div>
                  </div>
                )}
              </article>
            );
          })}
          {findingError && <p className="filemap-finding-error error">{findingError}</p>}
        </section>
      )}
      {(review || trackedIssues.length > 0 || reviewPending || reviewIneligible) && (
        <section className="filemap-review" aria-label="Boekwachter review">
          {review || trackedIssues.length > 0 ? (
            <>
              {review && (
                <div className="filemap-review-heading">
                  <strong>Boekwachter review · {review.health}/10</strong>
                  <span className="filemap-review-reason">{review.healthReason}</span>
                </div>
              )}
              {review?.notesMd && (
                <div className="filemap-review-notes">
                  <MarkdownField
                    key={`${path}:review-notes`}
                    value={review.notesMd}
                    readOnly
                    minHeight="0"
                    onCommit={noop}
                  />
                </div>
              )}
              {visibleTrackedIssues.length > 0 && (
                <div className="workspace-index-issues file-inspector-tracked-issues">
                  <ul>
                    {visibleTrackedIssues.map((issue) => (
                      <TrackedIssueItem
                        key={issue.id}
                        issue={issue}
                        fileName={name}
                        busy={issueAction !== null}
                        onSelectLine={revealLine}
                        onUpdateIssue={updateIssue}
                        onFixIssue={onFixIssue ? (i) => onFixIssue(path, i) : undefined}
                        onOpenTask={(taskRef) => navigateToTab({ kind: 'task', ref: taskRef })}
                        runIssueAction={runIssueAction}
                      />
                    ))}
                  </ul>
                </div>
              )}
              {trackedIssues.some((issue) => !isOpenIssue(issue)) && (
                <button
                  type="button"
                  className="link-button file-inspector-show-closed"
                  onClick={() => setShowClosed((shown) => !shown)}
                >
                  {showClosed ? 'Hide closed' : 'Show closed'}
                </button>
              )}
              {legacyIssues.length > 0 && (
                <ul className="filemap-review-issues">
                  {legacyIssues.map((issue, index) => {
                    const line = issue.line;
                    return (
                      <li key={`${issue.category}:${issue.message}:${index}`}>
                        {line != null ? (
                          <button
                            type="button"
                            className="filemap-review-issue"
                            onClick={() => revealLine(line)}
                          >
                            {reviewIssueLabel(issue)}
                          </button>
                        ) : (
                          <span className="filemap-review-issue">{reviewIssueLabel(issue)}</span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
              {issueActionError && (
                <p className="workspace-index-issue-error error" role="alert">
                  Couldn’t update the issue: {issueActionError}
                </p>
              )}
              <p className="filemap-review-advice">
                Leads from a background model pass — its opinion, not a verdict.
              </p>
              {reviewProvenance && <p className="filemap-review-provenance">{reviewProvenance}</p>}
            </>
          ) : reviewIneligible ? (
            <p className="filemap-review-pending">This file type isn’t reviewed.</p>
          ) : (
            <p className="filemap-review-pending">
              Not reviewed yet — the boekwachter studies files when idle or during Night Shift.
            </p>
          )}
        </section>
      )}
      <div className="filemap-fileview-body">
        {!file || file.path !== path || file.kind === 'loading' ? null : file.kind === 'error' ? (
          <div className="filemap-empty">Couldn’t read this file: {file.error}</div>
        ) : file.kind === 'binary' ? (
          isImage(path) ? (
            <div className="file-inspector-image">
              <PhotoThumb projectId={projectId} path={path} width={640} alt={name} />
            </div>
          ) : (
            <div className="filemap-empty">Binary file — no preview.</div>
          )
        ) : (
          <FileSourceView
            path={file.path}
            content={file.content}
            language={monacoLanguageForIndexedLanguage(known?.lang ?? null)}
            sourceReveal={sourceReveal?.path === file.path ? sourceReveal : undefined}
            findings={findings}
            activeFinding={activeFinding}
            codeContext={codeContext?.path === file.path ? codeContext.value.composed : null}
            onContextLink={handleContextLink}
          />
        )}
      </div>
    </aside>
  );
}
