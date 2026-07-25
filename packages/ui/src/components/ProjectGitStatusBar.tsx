import type {
  GithubBranchesResponse,
  GithubStatusResponse,
  WorkspaceIndexStatus,
} from '@bendyline/gezel';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { Popover, Select, Tooltip } from '../primitives/index.js';
import { statusChipPhrase } from './github/gitCopy.js';
import { GITHUB_CHANGED_EVENT, useGitSync } from './github/useGitSync.js';

type ProjectStatus = 'active' | 'readonly' | 'inactive' | 'stable';

interface Props {
  projectId: string;
  /**
   * Narrow form factor (VS Code sidebar or a compact desktop window).
   * Hides ambient Git chrome and treats edits-enabled as the implicit
   * default, while keeping the edits-off control visible.
   */
  compact?: boolean;
  /**
   * Raw per-project write flag (tri-state; effective writability is
   * `allowGezelWrites ?? !workingDir` — see `projectWorkspaceWritable`
   * in core). Effective writability is surfaced through the
   * "Edits on/off" dropdown; `workingDir` feeds its tooltip.
   */
  allowGezelWrites?: boolean;
  workingDir?: string | null;
  /**
   * Flip the per-project write switch. When provided, the bar renders an
   * always-visible "Edits on/off" dropdown next to the status select.
   * The caller owns the external-dir confirmation flow (enabling writes
   * on a user-supplied folder must confirm first).
   */
  onAllowWritesChange?: (next: boolean) => void;
  /** Opens the GitHub tab — the workbench for saves, diffs, and conflicts. */
  onOpenGithub?: () => void;
  /**
   * Project lifecycle status, surfaced as an always-visible dropdown in the
   * bar (next to the index chip) so it doesn't hide inside the Settings tab.
   * Omit `onStatusChange` to hide the control.
   */
  status?: ProjectStatus;
  onStatusChange?: (status: ProjectStatus) => void;
}

const STATUS_TOOLTIP =
  'Active — the Meester nudges the voorman, phase handoffs auto-start, and scheduled tasks tick. ' +
  'Read-only or Inactive — ambient gezel work pauses. Chat still works.';

const WRITES_TOOLTIP =
  "Whether gezels may create, edit, and delete files in this project's workspace. " +
  'Internal workspaces default to on; a project opened from an existing folder defaults to off ' +
  '(turning it on asks for confirmation first). Gezels can always write reports into artifacts.';

const PROJECT_STATUS_OPTIONS: ReadonlyArray<{ value: ProjectStatus; label: string }> = [
  { value: 'active', label: 'Active' },
  { value: 'stable', label: 'Stable' },
  { value: 'readonly', label: 'Read-only' },
  { value: 'inactive', label: 'Inactive' },
];

/**
 * Secondary project controls moved behind an ellipsis by the status bar's
 * container query. The trigger stays mounted so CSS—not viewport guessing—
 * decides when the bar is genuinely too narrow for its inline controls.
 */
function ProjectControlsOverflow({
  projectStatus,
  onStatusChange,
  gezelWritesOn,
  onAllowWritesChange,
}: {
  projectStatus: ProjectStatus;
  onStatusChange?: (status: ProjectStatus) => void;
  gezelWritesOn: boolean;
  onAllowWritesChange?: (next: boolean) => void;
}) {
  const [open, setOpen] = useState(false);

  if (!onStatusChange && (!onAllowWritesChange || gezelWritesOn)) return null;

  return (
    <div className="project-controls-overflow">
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild>
          <button
            type="button"
            className="project-controls-overflow-trigger"
            title="More project controls"
            aria-label="More project controls"
          >
            …
          </button>
        </Popover.Trigger>
        <Popover.Content className="project-controls-overflow-popover" side="bottom" align="end">
          <fieldset className="project-controls-overflow-fieldset">
            <legend className="sr-only">Project controls overflow</legend>
            {onStatusChange && (
              <section className="project-controls-overflow-section">
                <span className="project-controls-overflow-label">Project status</span>
                <div className="project-controls-overflow-options">
                  {PROJECT_STATUS_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      className={`project-controls-overflow-item project-status-select-${option.value}`}
                      aria-pressed={projectStatus === option.value}
                      onClick={() => {
                        onStatusChange(option.value);
                        setOpen(false);
                      }}
                    >
                      <span className="project-status-select-dot" aria-hidden />
                      <span>{option.label}</span>
                    </button>
                  ))}
                </div>
              </section>
            )}
            {onAllowWritesChange && !gezelWritesOn && (
              <section className="project-controls-overflow-section">
                <span className="project-controls-overflow-label">File edits are off</span>
                <button
                  type="button"
                  className="project-controls-overflow-item"
                  onClick={() => {
                    onAllowWritesChange(true);
                    setOpen(false);
                  }}
                >
                  <span className="project-writes-select-icon" aria-hidden>
                    ✎
                  </span>
                  <span>Turn edits on</span>
                </button>
              </section>
            )}
          </fieldset>
        </Popover.Content>
      </Popover.Root>
    </div>
  );
}

/**
 * Sticky strip rendered above the per-project tabs whenever a project
 * is GitHub-linked. The AMBIENT git surface: branch picker, a plain-
 * language status chip ("3 unsaved changes · 1 to get") that clicks
 * through to the GitHub tab, and one Sync button. Saving, diffs, and
 * conflict resolution live in the GitHub tab — the workbench — so the
 * two surfaces never compete over the same actions.
 */
export function ProjectGitStatusBar({
  projectId,
  compact = false,
  allowGezelWrites,
  workingDir,
  onAllowWritesChange,
  onOpenGithub,
  status: projectStatus,
  onStatusChange,
}: Props) {
  const [status, setStatus] = useState<GithubStatusResponse | null>(null);
  const [indexStatus, setIndexStatus] = useState<WorkspaceIndexStatus | null>(null);
  const [branches, setBranches] = useState<GithubBranchesResponse | null>(null);
  const [branchMenuOpen, setBranchMenuOpen] = useState(false);
  const [newBranchOpen, setNewBranchOpen] = useState(false);
  const [newBranchDraft, setNewBranchDraft] = useState('');
  const [busy, setBusy] = useState<string>('');
  const [toast, setToast] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const branchMenuRef = useRef<HTMLDivElement | null>(null);
  // Effective per-project writability — mirrors `projectWorkspaceWritable`
  // in core: explicit flag wins, else internal workspaces are writable and
  // external working dirs are not.
  const gezelWritesOn = allowGezelWrites ?? !workingDir;

  const refresh = useCallback(async () => {
    try {
      const s = await api.getProjectGithubStatus(projectId);
      setStatus(s);
    } catch {
      /* swallow — status bar is best-effort UX */
    }
  }, [projectId]);

  const refreshIndex = useCallback(async () => {
    try {
      setIndexStatus(await api.getProjectIndexStatus(projectId));
    } catch {
      /* swallow */
    }
  }, [projectId]);

  // Periodic refresh; runs while the project view is mounted. Both
  // polls share the 30s cadence so the bar doesn't run two
  // independent timers.
  useEffect(() => {
    void refresh();
    void refreshIndex();
    const id = window.setInterval(() => {
      void refresh();
      void refreshIndex();
    }, 30_000);
    return () => window.clearInterval(id);
  }, [refresh, refreshIndex]);

  // Re-poll immediately when the GitHub tab (or this bar) mutates state.
  useEffect(() => {
    const onChanged = (e: Event) => {
      if ((e as CustomEvent).detail?.projectId === projectId) void refresh();
    };
    window.addEventListener(GITHUB_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(GITHUB_CHANGED_EVENT, onChanged);
  }, [projectId, refresh]);

  const onClickIndexDot = useCallback(async () => {
    try {
      await api.refreshProjectIndex(projectId);
      // Optimistic: flip the chip to "indexing" until the next poll
      // returns fresh meta.
      setIndexStatus((prev) => ({
        state: 'indexing',
        ...(prev?.meta ? { meta: prev.meta } : {}),
      }));
      // Quick re-poll so the chip updates without waiting 30s.
      window.setTimeout(() => void refreshIndex(), 800);
    } catch {
      /* swallow */
    }
  }, [projectId, refreshIndex]);

  // Outside-click dismisses the branch dropdown.
  useEffect(() => {
    if (!branchMenuOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (branchMenuRef.current && !branchMenuRef.current.contains(e.target as Node)) {
        setBranchMenuOpen(false);
        setNewBranchOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [branchMenuOpen]);

  // Lazy-load branches the first time the dropdown opens.
  useEffect(() => {
    if (!branchMenuOpen || branches) return;
    void api
      .listProjectGithubBranches(projectId)
      .then(setBranches)
      .catch(() => setBranches({ local: [], remote: [] }));
  }, [branchMenuOpen, branches, projectId]);

  const showToast = useCallback((kind: 'ok' | 'err', text: string) => {
    setToast({ kind, text });
    window.setTimeout(() => setToast(null), 4_000);
  }, []);

  const { sync, syncing } = useGitSync(projectId, {
    onToast: showToast,
    // Needs-save and conflicts both resolve in the GitHub tab — hand off.
    onNeedsSave: () => {
      showToast('err', 'Save your changes first — they’re waiting in the GitHub tab.');
      onOpenGithub?.();
    },
    onConflicts: () => onOpenGithub?.(),
  });

  const onSync = useCallback(async () => {
    await sync();
    await refresh();
  }, [sync, refresh]);

  const onSwitchBranch = useCallback(
    async (branch: string) => {
      setBranchMenuOpen(false);
      setBusy('branch');
      try {
        await api.setProjectGithubBranch(projectId, branch);
        await refresh();
        showToast('ok', `Switched to ${branch}.`);
      } catch (err) {
        showToast('err', `Couldn’t switch: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setBusy('');
      }
    },
    [projectId, refresh, showToast],
  );

  const onCreateBranch = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const name = newBranchDraft.trim();
      if (!name) return;
      setBranchMenuOpen(false);
      setNewBranchOpen(false);
      setNewBranchDraft('');
      setBusy('branch');
      try {
        await api.createProjectGithubBranch(projectId, name);
        // Invalidate cached branches so the dropdown reflects the new one
        // next time it opens.
        setBranches(null);
        await refresh();
        showToast('ok', `Created and switched to ${name}.`);
      } catch (err) {
        showToast('err', `Couldn’t create: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setBusy('');
      }
    },
    [newBranchDraft, projectId, refresh, showToast],
  );

  const hasGithub = Boolean(status?.github);
  const branch = status?.branch;
  const lastSynced = status?.github?.lastSyncedAt;
  const indexState = indexStatus?.state ?? 'never';
  const aiScanPending = indexStatus?.aiScanPending === true;
  // Steady-state pill colour (the dot):
  //   fresh + scan done → green ('fresh')   — all up to date
  //   fresh + scan todo → amber ('scan')    — index fresh, AI scan still pending
  //   stale / never     → red   ('stale')   — index out of date
  //   indexing          → blue pulse ('indexing', transient)
  const indexDotState =
    indexState === 'indexing'
      ? 'indexing'
      : indexState === 'fresh'
        ? aiScanPending
          ? 'scan'
          : 'fresh'
        : 'stale';
  const enrichment = indexStatus?.enrichment;
  const aiCoverage = enrichment ? coveragePercent(enrichment.embedded, enrichment.eligible) : null;
  const indexHeadline =
    indexStatus === null
      ? 'Checking workspace index'
      : indexState === 'indexing'
        ? 'Scanning workspace'
        : indexState === 'never'
          ? 'Workspace not indexed'
          : indexState === 'stale'
            ? 'Workspace scan is out of date'
            : aiScanPending
              ? aiCoverage === null
                ? 'AI indexing is pending'
                : `AI indexing ${aiCoverage}% complete`
              : 'Workspace index is ready';
  const indexTooltip = `${indexHeadline}. ${
    indexState === 'indexing'
      ? 'Scan in progress.'
      : indexState === 'never' || indexState === 'stale'
        ? 'Click to scan now.'
        : aiScanPending
          ? 'AI indexing continues while the app is idle.'
          : 'Click to rescan.'
  }`;

  const chipPhrase = status
    ? statusChipPhrase({
        mergeInProgress: status.mergeInProgress,
        changesCount: status.changesCount,
        ahead: status.ahead,
        behind: status.behind,
      })
    : '';
  const chipAttention =
    status?.mergeInProgress === true ||
    (status?.changesCount ?? 0) > 0 ||
    (status?.ahead ?? 0) > 0 ||
    (status?.behind ?? 0) > 0;

  return (
    <div className={`project-git-status-bar${compact ? ' is-compact' : ''}`}>
      <div className="project-git-status-bar-left">
        {hasGithub && (
          <>
            <div className="project-git-branch-picker" ref={branchMenuRef}>
              <button
                type="button"
                className="project-git-branch-chip"
                onClick={() => setBranchMenuOpen((o) => !o)}
                disabled={!status?.exists}
                title="Switch branch"
              >
                <span className="project-git-icon" aria-hidden>
                  ⎇
                </span>
                <span className="project-git-branch-name">{branch ?? '(detached)'}</span>
                <span className="project-git-chevron" aria-hidden>
                  ▾
                </span>
              </button>
              {branchMenuOpen && (
                <div className="project-git-branch-menu" role="menu">
                  {branches === null ? (
                    <div className="project-git-branch-loading muted small">Loading branches…</div>
                  ) : (
                    <>
                      {branches.local.length > 0 && (
                        <div className="project-git-branch-group">
                          <div className="project-git-branch-group-label muted small">Local</div>
                          {branches.local.map((b) => (
                            <button
                              key={`local-${b}`}
                              type="button"
                              className={`project-git-branch-item${b === branch ? ' is-current' : ''}`}
                              onClick={() => void onSwitchBranch(b)}
                            >
                              {b}
                            </button>
                          ))}
                        </div>
                      )}
                      {branches.remote.length > 0 && (
                        <div className="project-git-branch-group">
                          <div className="project-git-branch-group-label muted small">Remote</div>
                          {branches.remote.map((b) => (
                            <button
                              key={`remote-${b}`}
                              type="button"
                              className="project-git-branch-item"
                              onClick={() => void onSwitchBranch(b)}
                            >
                              {b}
                            </button>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                  <div className="project-git-branch-divider" />
                  {newBranchOpen ? (
                    <form className="project-git-new-branch-form" onSubmit={onCreateBranch}>
                      <input
                        value={newBranchDraft}
                        onChange={(e) => setNewBranchDraft(e.target.value)}
                        placeholder="new-branch-name"
                        // biome-ignore lint/a11y/noAutofocus: user-triggered form, focus follows intent
                        autoFocus
                      />
                      <button type="submit" className="primary">
                        Create
                      </button>
                    </form>
                  ) : (
                    <button
                      type="button"
                      className="project-git-branch-item project-git-new-branch-trigger"
                      onClick={() => setNewBranchOpen(true)}
                    >
                      + new branch
                    </button>
                  )}
                </div>
              )}
            </div>
            {status && !compact && (
              <button
                type="button"
                className={`project-git-status-chip${chipAttention ? ' has-attention' : ''}${
                  status.mergeInProgress ? ' has-conflict' : ''
                }`}
                onClick={onOpenGithub}
                title="Open the GitHub tab"
              >
                {chipPhrase}
                {!chipAttention && lastSynced && (
                  <span className="muted small"> · synced {formatRelative(lastSynced)}</span>
                )}
              </button>
            )}
          </>
        )}
        <Tooltip.Provider delayDuration={150}>
          <Tooltip.Root
            onOpenChange={(open) => {
              if (open) void refreshIndex();
            }}
          >
            <Tooltip.Trigger asChild>
              <button
                type="button"
                className={`project-index-chip project-index-chip-${indexDotState}`}
                onClick={() => void onClickIndexDot()}
                aria-label={indexTooltip}
              >
                {/* Notebook glyph — stands in for "workspace index"; the dot to its
                    right carries the status colour. */}
                <svg
                  className="project-index-icon"
                  width="14"
                  height="14"
                  viewBox="0 0 16 16"
                  aria-hidden="true"
                  focusable="false"
                >
                  <rect
                    x="3"
                    y="2"
                    width="10.5"
                    height="12"
                    rx="1.3"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.2"
                  />
                  <line x1="6" y1="2" x2="6" y2="14" stroke="currentColor" strokeWidth="1.2" />
                  <line
                    x1="8"
                    y1="5.5"
                    x2="11.5"
                    y2="5.5"
                    stroke="currentColor"
                    strokeWidth="1.1"
                    strokeLinecap="round"
                  />
                  <line
                    x1="8"
                    y1="8"
                    x2="11.5"
                    y2="8"
                    stroke="currentColor"
                    strokeWidth="1.1"
                    strokeLinecap="round"
                  />
                  <line
                    x1="8"
                    y1="10.5"
                    x2="10.5"
                    y2="10.5"
                    stroke="currentColor"
                    strokeWidth="1.1"
                    strokeLinecap="round"
                  />
                </svg>
                <span className="project-index-dot" aria-hidden />
              </button>
            </Tooltip.Trigger>
            <Tooltip.Content side="bottom">
              <div className="project-index-tooltip">
                <div className="project-index-tooltip-heading">
                  <span
                    className={`project-index-tooltip-dot project-index-tooltip-dot-${indexDotState}`}
                    aria-hidden
                  />
                  <strong>{indexHeadline}</strong>
                </div>

                {enrichment && enrichment.eligible > 0 && aiCoverage !== null && (
                  <div className="project-index-tooltip-progress">
                    <div className="project-index-tooltip-progress-label">
                      <span>AI search coverage</span>
                      <strong>{aiCoverage}%</strong>
                    </div>
                    <div
                      className="project-index-tooltip-progress-track"
                      role="progressbar"
                      aria-label="AI search coverage"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={aiCoverage}
                      tabIndex={-1}
                    >
                      <span style={{ width: `${aiCoverage}%` }} />
                    </div>
                    <span className="project-index-tooltip-caption">
                      {enrichment.embedded} of {enrichment.eligible} files ready
                      {enrichment.pending > 0 ? ` · ${enrichment.pending} waiting` : ''}
                    </span>
                  </div>
                )}

                <dl className="project-index-tooltip-details">
                  <div>
                    <dt>File scan</dt>
                    <dd>{indexStateLabel(indexState)}</dd>
                  </div>
                  {indexStatus?.meta && (
                    <>
                      <div>
                        <dt>Indexed</dt>
                        <dd>
                          {indexStatus.meta.fileCount} file
                          {indexStatus.meta.fileCount === 1 ? '' : 's'} ·{' '}
                          {indexStatus.meta.commandCount} command
                          {indexStatus.meta.commandCount === 1 ? '' : 's'}
                        </dd>
                      </div>
                      <div>
                        <dt>Last scan</dt>
                        <dd>
                          {formatRelative(indexStatus.meta.scannedAt)} ·{' '}
                          {formatDuration(indexStatus.meta.durationMs)}
                        </dd>
                      </div>
                    </>
                  )}
                  {enrichment && enrichment.eligible > 0 && (
                    <div>
                      <dt>AI summaries</dt>
                      <dd>
                        {enrichment.summarized} of {enrichment.eligible} files
                      </dd>
                    </div>
                  )}
                  {enrichment?.reviews && enrichment.reviews.eligible > 0 && (
                    <div>
                      <dt>Quality review</dt>
                      <dd>
                        {enrichment.reviews.reviewed} of {enrichment.reviews.eligible}
                        {enrichment.reviews.pending > 0
                          ? ` · ${enrichment.reviews.pending} waiting`
                          : ''}
                        {enrichment.reviews.stale > 0
                          ? ` · ${enrichment.reviews.stale} to refresh`
                          : ''}
                      </dd>
                    </div>
                  )}
                </dl>

                <div className="project-index-tooltip-footer">
                  {indexState === 'indexing'
                    ? 'The status updates automatically.'
                    : aiScanPending
                      ? 'AI indexing continues while the app is idle. Click to rescan files.'
                      : 'Click to rescan the workspace.'}
                </div>
              </div>
            </Tooltip.Content>
          </Tooltip.Root>
        </Tooltip.Provider>
        <div className="project-controls-inline">
          {onStatusChange && (
            <Select.Root
              value={projectStatus ?? 'active'}
              onValueChange={(v) => onStatusChange(v as ProjectStatus)}
            >
              <Select.Trigger
                className={`project-status-select project-status-select-${projectStatus ?? 'active'}`}
                title={STATUS_TOOLTIP}
                aria-label="Project status"
              >
                <span className="project-status-select-dot" aria-hidden />
                <Select.Value />
              </Select.Trigger>
              <Select.Content>
                {PROJECT_STATUS_OPTIONS.map((option) => (
                  <Select.Item key={option.value} value={option.value}>
                    {option.label}
                  </Select.Item>
                ))}
              </Select.Content>
            </Select.Root>
          )}
          {onAllowWritesChange && (!compact || !gezelWritesOn) && (
            <Select.Root
              value={gezelWritesOn ? 'on' : 'off'}
              onValueChange={(v) => onAllowWritesChange(v === 'on')}
            >
              <Select.Trigger
                className={`project-writes-select project-writes-select-${gezelWritesOn ? 'on' : 'off'}`}
                title={WRITES_TOOLTIP}
                aria-label="Gezel file edits for this project"
              >
                <span className="project-writes-select-icon" aria-hidden>
                  {gezelWritesOn ? '✎' : '🔒'}
                </span>
                <Select.Value />
              </Select.Trigger>
              <Select.Content>
                <Select.Item value="on">Edits on</Select.Item>
                <Select.Item value="off">Edits off</Select.Item>
              </Select.Content>
            </Select.Root>
          )}
        </div>
        {compact && (
          <ProjectControlsOverflow
            projectStatus={projectStatus ?? 'active'}
            onStatusChange={onStatusChange}
            gezelWritesOn={gezelWritesOn}
            onAllowWritesChange={onAllowWritesChange}
          />
        )}
        {!onAllowWritesChange && !gezelWritesOn && (
          <span
            className="project-lockdown-chip"
            title='Gezel file edits are off for this project. Enable "Allow gezels to modify the workspace directory" in Project → Settings.'
            aria-label="Gezel file edits are off for this project."
          >
            <span className="project-lockdown-chip-icon" aria-hidden>
              🔒
            </span>
            <span className="project-lockdown-chip-label">edits off</span>
          </span>
        )}
      </div>
      {!compact && (
        <div className="project-git-status-bar-right">
          {hasGithub && (
            <button
              type="button"
              className="project-git-action"
              onClick={() => void onSync()}
              disabled={syncing || busy !== ''}
              title="Get new changes from GitHub and send yours"
            >
              {syncing ? 'Syncing…' : 'Sync'}
            </button>
          )}
        </div>
      )}
      {toast && (
        <output className={`project-git-toast project-git-toast-${toast.kind}`}>
          {toast.text}
        </output>
      )}
    </div>
  );
}

/**
 * "5s ago" / "2m ago" / "3h ago" — short relative formatter for the
 * status bar's last-synced chip. Anything older than a day rolls into
 * a plain calendar date.
 */
function formatRelative(iso: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return 'recently';
  const diffMs = Date.now() - then;
  const sec = Math.max(1, Math.round(diffMs / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return new Date(then).toLocaleDateString();
}

function coveragePercent(complete: number, total: number): number | null {
  if (total <= 0) return null;
  return Math.round((Math.min(Math.max(complete, 0), total) / total) * 100);
}

function indexStateLabel(state: WorkspaceIndexStatus['state']): string {
  switch (state) {
    case 'fresh':
      return 'Up to date';
    case 'stale':
      return 'Needs a rescan';
    case 'indexing':
      return 'Scanning now';
    case 'never':
      return 'Not scanned yet';
  }
}

function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.max(1, Math.round(ms))}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const min = Math.floor(ms / 60_000);
  const sec = Math.round((ms % 60_000) / 1_000);
  return sec > 0 ? `${min}m ${sec}s` : `${min}m`;
}
