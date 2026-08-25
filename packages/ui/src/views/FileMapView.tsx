import {
  type ComposedCodeContext,
  type FileMapResponse,
  type FileMapScope,
  type FileReviewIssue,
  type FileReviewWire,
  type GitHubPullSummary,
  type MapBlock,
  type MapBuilding,
  type MapPrChange,
  type SecurityFindingWire,
  composeFileContext,
  createLogger,
  formatReviewProvenance,
  parseGezelHref,
} from '@bendyline/gezel';
import { EditorShell, useEditorContext } from '@bendyline/squisq-editor-react';
import '@bendyline/squisq-editor-react/styles';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { FileMap, type MapRendererKind, defaultRenderer } from '../components/FileMap/FileMap.js';
import { townStyleForBlock, townStyleLabel } from '../components/FileMap/iso/town-style.js';
import { MarkdownField } from '../components/MarkdownField.js';
import { monacoLanguageForIndexedLanguage } from '../components/monaco-language.js';
import { navigateToTab } from '../components/nav-actions.js';
import { DropdownChevron } from '../primitives/index.js';
import { useEffectiveTheme } from '../theme.js';

const log = createLogger('filemap');

const noop = () => undefined;

/**
 * Plain-text label for a review issue row. Severity stays text on purpose —
 * the review vocabulary (info | minor | major) is deliberately separate from
 * security-finding severities and must not borrow their colored badges.
 */
export function reviewIssueLabel(issue: FileReviewIssue): string {
  const location = issue.line != null ? ` (Line ${issue.line})` : '';
  return `[${issue.severity}] ${issue.category} — ${issue.message}${location}`;
}

/**
 * Decoding a binary blob as UTF-8 yields a sea of U+FFFD replacement chars and
 * stray control bytes; sample the head so we don't feed one to the editor.
 */
function looksBinary(content: string): boolean {
  const sample = content.slice(0, 4096);
  if (!sample) return false;
  let suspicious = 0;
  for (let i = 0; i < sample.length; i++) {
    const code = sample.charCodeAt(i);
    if (code === 0xfffd || code < 9 || (code > 13 && code < 32)) suspicious++;
  }
  return suspicious / sample.length > 0.1;
}

type FileState =
  | { path: string; kind: 'loading' }
  | { path: string; kind: 'ready'; content: string }
  | { path: string; kind: 'binary' }
  | { path: string; kind: 'error'; error: string };

interface SourceRevealRequest {
  path: string;
  line: number;
}

const PR_CHANGE_LABEL: Record<MapPrChange['change'], string> = {
  added: 'added',
  modified: 'modified',
  deleted: 'deleted',
  renamed: 'renamed',
};

const ZONE_LABEL: Record<NonNullable<MapBlock['health']>['zone'], string> = {
  residential: 'residential',
  commercial: 'commercial',
  civic: 'civic landmark',
  industrial: 'industrial',
};
const VIBE_LABEL: Record<NonNullable<MapBlock['health']>['vibe'], string> = {
  lush: 'lush',
  tidy: 'tidy',
  plain: 'plain',
  scruffy: 'scruffy',
  blighted: 'blighted',
};

/**
 * The "Village" project tab: the codebase as a persistent 1890–1915 settlement.
 * Districts are folders, blocks are files (size ∝ LoC), buildings are symbols,
 * and roads are the import graph. Pan/zoom with the mouse; click a block for
 * details. The scope toggle separates test files (their own settlement) from the
 * core code; JSON is always excluded.
 */
const SCOPES: Array<{ value: FileMapScope; label: string }> = [
  { value: 'core', label: 'Code' },
  { value: 'tests', label: 'Tests' },
  { value: 'all', label: 'All' },
];

export function FileMapView({ projectId }: { projectId: string }) {
  const [model, setModel] = useState<FileMapResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<MapBlock | null>(null);
  const [sourceReveal, setSourceReveal] = useState<SourceRevealRequest | null>(null);
  const [scope, setScope] = useState<FileMapScope>('core');
  const [pulls, setPulls] = useState<GitHubPullSummary[]>([]);
  const [pr, setPr] = useState<number | null>(null);
  const [ageLens, setAgeLens] = useState(false);
  const [renderer, setRenderer] = useState<MapRendererKind>(() => defaultRenderer());
  const [file, setFile] = useState<FileState | null>(null);
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
  const [reviewPending, setReviewPending] = useState(false);
  const [reviewIneligible, setReviewIneligible] = useState(false);
  const [connectedOpen, setConnectedOpen] = useState(false);
  const [codeContext, setCodeContext] = useState<{
    path: string;
    value: ComposedCodeContext;
  } | null>(null);
  // Small per-map cache so flipping between connected files doesn't refetch.
  // Cleared on rebuild/scope change (facts may have changed).
  const contextCache = useRef(new Map<string, ComposedCodeContext>());

  const selectBlockAtLine = useCallback((block: MapBlock | null, line = 1) => {
    if (block && window.__GEZEL__?.openWorkspaceFile) {
      window.__GEZEL__.openWorkspaceFile(block.id, Math.max(1, line));
      return;
    }
    setSelected(block);
    setSourceReveal(block ? { path: block.id, line: Math.max(1, line) } : null);
  }, []);

  const handleMapSelect = useCallback(
    (block: MapBlock | null, building?: MapBuilding | null) => {
      selectBlockAtLine(block, building?.lineStart ?? 1);
    },
    [selectBlockAtLine],
  );

  // Load the selected file's content for the squisq viewer. Stale responses
  // (selection changed mid-flight) are dropped via the cancelled flag.
  const selectedId = selected?.id ?? null;
  useEffect(() => {
    setConnectedOpen(false);
    if (!selectedId) {
      setFile(null);
      return;
    }
    let cancelled = false;
    setFile({ path: selectedId, kind: 'loading' });
    api
      .readProjectWorkspaceFile(projectId, selectedId)
      .then((res) => {
        if (cancelled) return;
        setFile(
          looksBinary(res.content)
            ? { path: selectedId, kind: 'binary' }
            : { path: selectedId, kind: 'ready', content: res.content },
        );
      })
      .catch((e: unknown) => {
        if (!cancelled)
          setFile({
            path: selectedId,
            kind: 'error',
            error: e instanceof Error ? e.message : String(e),
          });
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId, projectId]);

  // Findings are fetched separately from the prose context because this wire
  // shape carries the stable fingerprint + task lifecycle needed by actions.
  // biome-ignore lint/correctness/useExhaustiveDependencies: findingRevision deliberately re-fetches lifecycle state after resolve/task completion.
  useEffect(() => {
    if (!selectedId) {
      setFindings([]);
      setActiveFinding(null);
      setFindingError(null);
      return;
    }
    let cancelled = false;
    setFindingsLoading(true);
    setFindingError(null);
    api
      .toolScanFindings(projectId, { path: selectedId, maxResults: 100 })
      .then((res) => {
        if (cancelled) return;
        const exact = res.findings.filter((finding) => finding.path === selectedId);
        setFindings(exact);
        setActiveFinding((current) =>
          current && exact.some((finding) => finding.fingerprint === current)
            ? current
            : (exact[0]?.fingerprint ?? null),
        );
        const firstLine = exact.find((finding) => finding.line != null)?.line;
        if (firstLine) setSourceReveal({ path: selectedId, line: firstLine });
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
  }, [selectedId, projectId, findingRevision]);

  // The boekwachter's review of the selected file (cliffs notes, issues,
  // health). Absence — never reviewed, index not ready, request failed — just
  // renders no card; `pending` renders the one-line "not reviewed yet" note.
  useEffect(() => {
    if (!selectedId) {
      setReview(null);
      setReviewPending(false);
      setReviewIneligible(false);
      return;
    }
    let cancelled = false;
    setReview(null);
    setReviewPending(false);
    setReviewIneligible(false);
    api
      .toolFileReview(projectId, { path: selectedId })
      .then((res) => {
        if (cancelled) return;
        setReview(res.review ?? null);
        setReviewPending(res.pending === true);
        setReviewIneligible(res.eligible === false);
      })
      .catch((e: unknown) => {
        if (!cancelled) log.debug('file-review unavailable', e);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId, projectId]);

  // Per-symbol context for the viewer — progressive enhancement, fetched in
  // parallel with the content. Every failure (404, index not ready, network)
  // silently renders the plain editor; sections may also arrive after the
  // content, and squisq reconciles its zones on the late prop update.
  // biome-ignore lint/correctness/useExhaustiveDependencies: findingRevision deliberately invalidates finding prose after lifecycle changes.
  useEffect(() => {
    if (!selectedId) {
      setCodeContext(null);
      return;
    }
    const cached = contextCache.current.get(selectedId);
    if (cached) {
      setCodeContext({ path: selectedId, value: cached });
      return;
    }
    let cancelled = false;
    setCodeContext(null);
    api
      .toolFileContext(projectId, { path: selectedId })
      .then((res) => {
        if (cancelled) return;
        const value = composeFileContext(res);
        if (contextCache.current.size >= 20) {
          const oldest = contextCache.current.keys().next().value;
          if (oldest !== undefined) contextCache.current.delete(oldest);
        }
        contextCache.current.set(selectedId, value);
        setCodeContext({ path: selectedId, value });
      })
      .catch((e: unknown) => {
        if (!cancelled) log.debug('file-context unavailable', e);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId, projectId, findingRevision]);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    contextCache.current.clear();
    api
      .toolFileMap(projectId, { scope, ...(pr ? { pr } : {}) })
      .then((m) => {
        setModel(m);
        setSelected((current) =>
          current ? (m.blocks.find((block) => block.id === current.id) ?? null) : null,
        );
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [projectId, scope, pr]);

  useEffect(() => {
    selectBlockAtLine(null);
    load();
  }, [load, selectBlockAtLine]);

  // Best-effort PR list for the overlay picker; absent/empty for non-GitHub projects.
  useEffect(() => {
    let cancelled = false;
    api
      .listProjectGitHubPulls(projectId)
      .then((r) => {
        if (!cancelled) setPulls(r.pulls);
      })
      .catch(() => {
        if (!cancelled) setPulls([]);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const overlayById = useMemo(
    () => new Map((model?.overlay?.changedBlocks ?? []).map((c) => [c.blockId, c])),
    [model],
  );

  // Blast radius: blocks that (transitively, ≤3 hops) import a changed file.
  // Roads are directed (a imports b), so a change to b ripples back to a; a
  // bidirectional road ripples both ways.
  const affectedIds = useMemo(() => {
    const overlay = model?.overlay;
    if (!model || !overlay || overlay.changedBlocks.length === 0) return undefined;
    const dependents = new Map<string, string[]>();
    const add = (key: string, dep: string) => {
      const list = dependents.get(key);
      if (list) list.push(dep);
      else dependents.set(key, [dep]);
    };
    for (const r of model.roads) {
      add(r.b, r.a); // a imports b ⇒ changing b affects a
      if (r.bidirectional) add(r.a, r.b);
    }
    const changed = new Set(overlay.changedBlocks.map((c) => c.blockId));
    const affected = new Set<string>();
    let frontier = [...changed];
    for (let depth = 0; depth < 3 && frontier.length > 0; depth++) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const dep of dependents.get(id) ?? []) {
          if (changed.has(dep) || affected.has(dep)) continue;
          affected.add(dep);
          next.push(dep);
        }
      }
      frontier = next;
    }
    return affected.size > 0 ? affected : undefined;
  }, [model]);

  const stats = useMemo(() => {
    if (!model) return null;
    const live = model.blocks.filter((b) => b.state !== 'tombstoned' && !b.phantom);
    return {
      files: live.length,
      folders: model.districts.length,
      roads: model.roads.length,
      symbols: live.reduce((n, b) => n + b.buildingCount, 0),
    };
  }, [model]);

  // Files connected to the selected block by an import road (for navigation).
  const connected = useMemo(() => {
    if (!selected || !model) return [] as MapBlock[];
    const ids = new Set<string>();
    for (const r of model.roads) {
      if (r.a === selected.id) ids.add(r.b);
      else if (r.b === selected.id) ids.add(r.a);
    }
    const byId = new Map(model.blocks.map((b) => [b.id, b]));
    return [...ids]
      .sort()
      .map((id) => byId.get(id))
      .filter((b): b is MapBlock => !!b);
  }, [selected, model]);

  // Section links (gezel-nav:<path>) fly the map to that building. In-file
  // #L links never reach here — squisq reveals those natively. A target
  // outside the current scope is swallowed (handled-no-op) rather than
  // becoming a dead browser navigation.
  const handleContextLink = useCallback(
    (href: string): boolean => {
      const parsed = parseGezelHref(href);
      if (parsed?.kind !== 'file' || !model) return false;
      const block = model.blocks.find((b) => b.id === parsed.path);
      if (block) selectBlockAtLine(block, parsed.line);
      return true;
    },
    [model, selectBlockAtLine],
  );

  const selectFinding = useCallback((finding: SecurityFindingWire) => {
    setActiveFinding(finding.fingerprint);
    if (finding.line != null) {
      setSourceReveal({ path: finding.path, line: finding.line });
    }
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
        setFindingRevision((revision) => revision + 1);
        load();
      } catch (e) {
        setFindingError(e instanceof Error ? e.message : String(e));
      } finally {
        setFindingAction(null);
      }
    },
    [load, projectId],
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
        setFindingRevision((revision) => revision + 1);
        load();
      }
    };
    const timer = window.setInterval(() => void check(), 5_000);
    void check();
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [findings, load]);

  const reviewProvenance = review ? formatReviewProvenance(review) : null;

  return (
    <section className="filemap-view">
      <header className="filemap-header">
        <div className="filemap-title">
          <strong>Village</strong>
          {stats && (
            <span className="filemap-stats">
              {stats.files} files · {stats.folders} neighborhoods · {stats.roads} roads ·{' '}
              {stats.symbols} symbols
            </span>
          )}
          {model?.overlay && (
            <span className="filemap-overlay-stat">
              PR #{model.overlay.prNumber} · {model.overlay.changedBlocks.length} changed
              {affectedIds ? ` · ${affectedIds.size} affected` : ''}
            </span>
          )}
        </div>
        <div className="filemap-actions">
          {pulls.length > 0 && (
            <select
              className="filemap-pr"
              aria-label="Overlay a pull request"
              value={pr ?? ''}
              onChange={(e) => setPr(e.target.value ? Number(e.target.value) : null)}
            >
              <option value="">No PR overlay</option>
              {pulls.map((p) => (
                <option key={p.number} value={p.number}>
                  #{p.number} {p.title}
                </option>
              ))}
            </select>
          )}
          <fieldset className="filemap-scope" aria-label="Village scope">
            {SCOPES.map((s) => (
              <button
                key={s.value}
                type="button"
                className={scope === s.value ? 'active' : ''}
                aria-pressed={scope === s.value}
                onClick={() => setScope(s.value)}
              >
                {s.label}
              </button>
            ))}
          </fieldset>
          <fieldset className="filemap-scope" aria-label="Color lens">
            <button
              type="button"
              className={ageLens ? 'active' : ''}
              aria-pressed={ageLens}
              title="Color blocks by how recently they were added — the evolution lens"
              onClick={() => setAgeLens((v) => !v)}
            >
              Age
            </button>
          </fieldset>
          <fieldset className="filemap-scope" aria-label="Renderer">
            <button
              type="button"
              className={renderer === 'iso' ? 'active' : ''}
              aria-pressed={renderer === 'iso'}
              title="Isometric village view; toggle off for the flat top-down plan"
              onClick={() =>
                setRenderer((v) => {
                  const next = v === 'iso' ? 'flat' : 'iso';
                  try {
                    window.localStorage.setItem('gezel.mapRenderer', next);
                  } catch {
                    /* private-mode storage — the toggle still works this session */
                  }
                  return next;
                })
              }
            >
              3D
            </button>
          </fieldset>
          <button type="button" className="filemap-refresh" onClick={load} disabled={loading}>
            {loading ? 'Building…' : 'Rebuild'}
          </button>
        </div>
      </header>

      <div className="filemap-body">
        {error ? (
          <div className="filemap-empty">Couldn’t build the village: {error}</div>
        ) : model && !model.indexed ? (
          <div className="filemap-empty">
            This project hasn’t been indexed yet. The village appears once the workspace has been
            scanned.
          </div>
        ) : model && model.blocks.length === 0 && !loading ? (
          <div className="filemap-empty">
            {scope === 'tests' ? 'No test files found.' : 'No files to build a village from yet.'}
          </div>
        ) : model ? (
          <>
            <FileMap
              model={model}
              selectedId={selected?.id ?? null}
              onSelect={handleMapSelect}
              {...(affectedIds ? { affectedIds } : {})}
              renderer={renderer}
              ageLens={ageLens}
            />
            {selected ? (
              <aside className="filemap-inspector filemap-fileview open">
                <header className="filemap-fileview-head">
                  <div className="filemap-fileview-titlerow">
                    <span className="filemap-fileview-name" title={selected.id}>
                      {selected.label}
                    </span>
                    <div className="filemap-fileview-actions">
                      {connected.length > 0 && (
                        <button
                          type="button"
                          className="filemap-fileview-connected-btn"
                          aria-expanded={connectedOpen}
                          onClick={() => setConnectedOpen((o) => !o)}
                        >
                          <span>Connected ({connected.length})</span>
                          <DropdownChevron />
                        </button>
                      )}
                      <button
                        type="button"
                        className="filemap-fileview-close"
                        onClick={() => selectBlockAtLine(null)}
                        aria-label="Close"
                      >
                        ×
                      </button>
                    </div>
                    {connectedOpen && connected.length > 0 && (
                      <div className="filemap-fileview-menu">
                        <ul>
                          {connected.slice(0, 60).map((b) => (
                            <li key={b.id}>
                              <button
                                type="button"
                                title={b.id}
                                onClick={() => {
                                  selectBlockAtLine(b);
                                  setConnectedOpen(false);
                                }}
                              >
                                {b.label}
                              </button>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                  <div className="filemap-fileview-stats">
                    <span className="filemap-fileview-path">{selected.id}</span>
                    <span className="filemap-chip">{Math.round(selected.weight)} lines</span>
                    <span className="filemap-chip">{selected.buildingCount} symbols</span>
                    {selected.lang && <span className="filemap-chip">{selected.lang}</span>}
                    {renderer === 'iso' && (
                      <span className="filemap-chip">
                        {townStyleLabel(townStyleForBlock(selected))}
                      </span>
                    )}
                    {selected.health && (
                      <span className="filemap-chip">
                        {ZONE_LABEL[selected.health.zone]} · {VIBE_LABEL[selected.health.vibe]}
                      </span>
                    )}
                    {selected.health && (
                      <span className="filemap-chip">↓{selected.health.fanIn} imported</span>
                    )}
                    {selected.health && (
                      <span className="filemap-chip">↑{selected.health.fanOut} imports</span>
                    )}
                    {selected.health && selected.health.findings > 0 && (
                      <span className="filemap-chip filemap-chip-warn">
                        {selected.health.findings} finding{selected.health.findings > 1 ? 's' : ''}
                        {selected.health.maxSeverity ? ` (max ${selected.health.maxSeverity})` : ''}
                      </span>
                    )}
                    {selected.placedAt && (
                      <span className="filemap-chip">since {selected.placedAt.slice(0, 10)}</span>
                    )}
                    {overlayById.get(selected.id) && (
                      <span className="filemap-chip">
                        PR: {PR_CHANGE_LABEL[overlayById.get(selected.id)!.change]}{' '}
                        <span className="filemap-add">
                          +{overlayById.get(selected.id)!.additions}
                        </span>{' '}
                        <span className="filemap-del">
                          −{overlayById.get(selected.id)!.deletions}
                        </span>
                      </span>
                    )}
                  </div>
                </header>
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
                                    onClick={() =>
                                      navigateToTab({ kind: 'task', ref: finding.taskRef! })
                                    }
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
                                  disabled={
                                    findingAction != null || finding.status === 'in_progress'
                                  }
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
                {(review || reviewPending || reviewIneligible) && (
                  <section className="filemap-review" aria-label="Boekwachter review">
                    {review ? (
                      <>
                        <div className="filemap-review-heading">
                          <strong>Boekwachter review · {review.health}/10</strong>
                          <span className="filemap-review-reason">{review.healthReason}</span>
                        </div>
                        {review.notesMd && (
                          <div className="filemap-review-notes">
                            <MarkdownField
                              key={`${selected.id}:review-notes`}
                              value={review.notesMd}
                              readOnly
                              minHeight="0"
                              onCommit={noop}
                            />
                          </div>
                        )}
                        {review.issues.length > 0 && (
                          <ul className="filemap-review-issues">
                            {review.issues.map((issue, index) => {
                              const line = issue.line;
                              return (
                                <li key={`${issue.category}:${issue.message}:${index}`}>
                                  {line != null ? (
                                    <button
                                      type="button"
                                      className="filemap-review-issue"
                                      onClick={() => setSourceReveal({ path: selected.id, line })}
                                    >
                                      {reviewIssueLabel(issue)}
                                    </button>
                                  ) : (
                                    <span className="filemap-review-issue">
                                      {reviewIssueLabel(issue)}
                                    </span>
                                  )}
                                </li>
                              );
                            })}
                          </ul>
                        )}
                        <p className="filemap-review-advice">
                          Leads from a background model pass — its opinion, not a verdict.
                        </p>
                        {reviewProvenance && (
                          <p className="filemap-review-provenance">{reviewProvenance}</p>
                        )}
                      </>
                    ) : reviewIneligible ? (
                      <p className="filemap-review-pending">This file type isn’t reviewed.</p>
                    ) : (
                      <p className="filemap-review-pending">
                        Not reviewed yet — the boekwachter studies files when idle or during Night
                        Shift.
                      </p>
                    )}
                  </section>
                )}
                <div className="filemap-fileview-body">
                  {!file || file.kind === 'loading' ? (
                    <div className="filemap-empty">Loading {selected.label}…</div>
                  ) : file.kind === 'error' ? (
                    <div className="filemap-empty">Couldn’t read this file: {file.error}</div>
                  ) : file.kind === 'binary' ? (
                    <div className="filemap-empty">Binary file — no preview.</div>
                  ) : (
                    <FileView
                      path={file.path}
                      content={file.content}
                      language={monacoLanguageForIndexedLanguage(selected.lang)}
                      sourceReveal={sourceReveal?.path === file.path ? sourceReveal : undefined}
                      findings={findings}
                      activeFinding={activeFinding}
                      codeContext={codeContext?.path === file.path ? codeContext.value : null}
                      onContextLink={handleContextLink}
                    />
                  )}
                </div>
              </aside>
            ) : (
              <p className="filemap-hint filemap-hint-float">
                Scroll to zoom, drag to pan. Each building is a file; click one to open it.
              </p>
            )}
          </>
        ) : (
          <div className="filemap-empty">{loading ? 'Building the village…' : ''}</div>
        )}
      </div>
    </section>
  );
}

/**
 * Read-only squisq view of a file: EditorShell auto-selects by extension —
 * Monaco for code, the rich WYSIWYG surface for markdown/text. Keyed by path so
 * a new selection remounts (EditorShell reads `initialMarkdown` once at mount).
 * `codeContext` (per-symbol intelligence sections) may arrive after mount —
 * squisq reconciles its view zones on the prop update.
 */
function FileView({
  path,
  content,
  language,
  sourceReveal,
  findings,
  activeFinding,
  codeContext,
  onContextLink,
}: {
  path: string;
  content: string;
  language?: string;
  sourceReveal?: SourceRevealRequest;
  findings: SecurityFindingWire[];
  activeFinding: string | null;
  codeContext: ComposedCodeContext | null;
  onContextLink: (href: string) => boolean;
}) {
  const theme = useEffectiveTheme();
  const sections = useMemo(() => {
    if (!codeContext || (codeContext.sections.length === 0 && !codeContext.fileTop)) {
      return undefined;
    }
    return {
      ...(codeContext.fileTop ? { fileTop: codeContext.fileTop } : {}),
      sections: codeContext.sections,
      linkSchemes: ['gezel-nav'],
      onLinkClick: (href: string) => onContextLink(href),
    };
  }, [codeContext, onContextLink]);
  return (
    <EditorShell
      key={path}
      initialMarkdown={content}
      fileName={path}
      language={language}
      height="100%"
      colorScheme={theme}
      showPlayTab={false}
      showStatusBar={false}
      toolbarSlotLeft={
        <>
          <RevealEditorLine request={sourceReveal} />
          <HighlightEditorFindings findings={findings} activeFinding={activeFinding} />
        </>
      }
      fullWidth
      readOnly
      {...(sections ? { codeContext: sections } : {})}
    />
  );
}

/** Invisible host bridge that reveals a map-selected symbol after Monaco mounts. */
function RevealEditorLine({ request }: { request?: SourceRevealRequest }) {
  const { monacoEditor } = useEditorContext();
  useEffect(() => {
    if (!monacoEditor || !request) return;
    const model = monacoEditor.getModel();
    if (!model) return;
    const lineNumber = Math.min(request.line, model.getLineCount());
    monacoEditor.setPosition({ lineNumber, column: 1 });
    monacoEditor.revealLineInCenter(lineNumber);
  }, [monacoEditor, request]);
  return null;
}

/** Monaco line decorations for every active finding in the selected file. */
function HighlightEditorFindings({
  findings,
  activeFinding,
}: {
  findings: SecurityFindingWire[];
  activeFinding: string | null;
}) {
  const { monacoEditor } = useEditorContext();
  const decorationIds = useRef<string[]>([]);
  useEffect(() => {
    if (!monacoEditor) return;
    const model = monacoEditor.getModel();
    if (!model) return;
    const byLine = new Map<number, boolean>();
    for (const finding of findings) {
      if (finding.line == null) continue;
      const line = Math.min(finding.line, model.getLineCount());
      byLine.set(line, byLine.get(line) === true || finding.fingerprint === activeFinding);
    }
    decorationIds.current = monacoEditor.deltaDecorations(
      decorationIds.current,
      [...byLine].map(([line, active]) => ({
        range: {
          startLineNumber: line,
          startColumn: 1,
          endLineNumber: line,
          endColumn: model.getLineMaxColumn(line),
        },
        options: {
          isWholeLine: true,
          className: active ? 'filemap-finding-line-active' : 'filemap-finding-line',
          linesDecorationsClassName: active
            ? 'filemap-finding-gutter-active'
            : 'filemap-finding-gutter',
        },
      })),
    );
    return () => {
      decorationIds.current = monacoEditor.deltaDecorations(decorationIds.current, []);
    };
  }, [activeFinding, findings, monacoEditor]);
  return null;
}
