import type {
  CodexPermissionMode,
  GitBranchesResponse,
  GitStatusResponse,
  WorkspaceIndexStatus,
} from '@bendyline/gezel';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { DropdownChevron, Popover, Select } from '../primitives/index.js';
import { statusChipPhrase } from './github/gitCopy.js';
import { GIT_CHANGED_EVENT, useGitSync } from './github/useGitSync.js';

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
  /**
   * A configured AI provider can edit the workspace through its own harness,
   * outside the scoped Gezel write gate. The edits control becomes a disabled
   * indicator because its on/off value cannot guarantee read-only behavior.
   */
  editableViaAiProvider?: boolean;
  /** Codex-specific project posture. When present, replaces Edits on/off. */
  codexMode?: CodexPermissionMode;
  onCodexModeChange?: (mode: CodexPermissionMode) => void;
  /** Opens the GitHub tab — the workbench for saves, diffs, and conflicts. */
  onOpenGitHub?: () => void;
  /**
   * Project lifecycle status, surfaced as an always-visible dropdown in the
   * bar (next to the index chip) so it doesn't hide inside the Settings tab.
   * Omit `onStatusChange` to hide the control.
   */
  status?: ProjectStatus;
  /** Archived projects remain visibly inactive but must be restored before
   *  their lifecycle status can change. */
  statusLocked?: boolean;
  onStatusChange?: (status: ProjectStatus) => void;
}

const STATUS_TOOLTIP =
  'Active — the Meester nudges the voorman, phase handoffs auto-start, and scheduled tasks tick. ' +
  'Read-only or Inactive — ambient gezel work pauses. Chat still works.';

const WRITES_TOOLTIP =
  "Whether gezellen may create, edit, and delete files in this project's workspace. " +
  'Internal workspaces default to on; a project opened from an existing folder defaults to off ' +
  '(turning it on asks for confirmation first). Gezels can always write reports into artifacts.';

const PROVIDER_WRITES_TOOLTIP =
  'Codex CLI, Claude CLI, or Copilot built-in tools can edit this workspace directly. ' +
  'The Gezel edits switch cannot guarantee a read-only project while that provider is in use.';

const CODEX_MODE_OPTIONS: ReadonlyArray<{
  value: CodexPermissionMode;
  label: string;
  hint: string;
}> = [
  { value: 'plan', label: 'Plan', hint: 'Read and reason without changing workspace files.' },
  { value: 'edit', label: 'Edit', hint: 'Edit inside the workspace; deny boundary crossings.' },
  {
    value: 'reviewed',
    label: 'Reviewed',
    hint: 'Edit in the workspace; send boundary crossings to an independent Codex reviewer.',
  },
  {
    value: 'full',
    label: 'Full',
    hint: 'Run without Codex sandboxing or approvals. Gezel still blocks a narrow set of unmistakably destructive commands.',
  },
];

function codexModeTitle(mode: CodexPermissionMode): string {
  const option = CODEX_MODE_OPTIONS.find((item) => item.value === mode);
  return `Codex ${option?.label ?? mode}: ${option?.hint ?? ''}`;
}

const PROJECT_STATUS_OPTIONS: ReadonlyArray<{ value: ProjectStatus; label: string }> = [
  { value: 'active', label: 'Active' },
  { value: 'stable', label: 'Stable' },
  { value: 'readonly', label: 'Read-only' },
  { value: 'inactive', label: 'Inactive' },
];

function EditsLockIcon({ unlocked = false }: { unlocked?: boolean }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false">
      <rect x="3" y="7" width="10" height="7" rx="1.25" stroke="currentColor" strokeWidth="1.5" />
      {unlocked ? (
        <path
          d="M5 7V5a3 3 0 0 1 5.75-1.2"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      ) : (
        <path
          d="M5 7V5a3 3 0 0 1 6 0v2"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      )}
    </svg>
  );
}

/**
 * Secondary project controls moved behind an ellipsis by the status bar's
 * container query. The trigger stays mounted so CSS—not viewport guessing—
 * decides when the bar is genuinely too narrow for its inline controls.
 */
function ProjectControlsOverflow({
  projectStatus,
  statusLocked,
  onStatusChange,
  gezelWritesOn,
  onAllowWritesChange,
  editableViaAiProvider,
  codexMode,
  onCodexModeChange,
}: {
  projectStatus: ProjectStatus;
  statusLocked?: boolean;
  onStatusChange?: (status: ProjectStatus) => void;
  gezelWritesOn: boolean;
  onAllowWritesChange?: (next: boolean) => void;
  editableViaAiProvider: boolean;
  codexMode?: CodexPermissionMode;
  onCodexModeChange?: (mode: CodexPermissionMode) => void;
}) {
  const [open, setOpen] = useState(false);

  if (
    !onStatusChange &&
    !onCodexModeChange &&
    (!onAllowWritesChange || (gezelWritesOn && !editableViaAiProvider))
  ) {
    return null;
  }

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
        <Popover.Content className="project-controls-overflow-popover" side="top" align="end">
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
                      disabled={statusLocked}
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
            {!codexMode && onAllowWritesChange && (editableViaAiProvider || !gezelWritesOn) && (
              <section className="project-controls-overflow-section">
                <span className="project-controls-overflow-label">
                  {editableViaAiProvider ? 'File edits' : 'File edits are off'}
                </span>
                <button
                  type="button"
                  className="project-controls-overflow-item"
                  disabled={editableViaAiProvider}
                  title={editableViaAiProvider ? PROVIDER_WRITES_TOOLTIP : undefined}
                  onClick={() => {
                    if (editableViaAiProvider) return;
                    onAllowWritesChange(true);
                    setOpen(false);
                  }}
                >
                  <span className="project-writes-select-icon" aria-hidden>
                    <EditsLockIcon unlocked />
                  </span>
                  <span>
                    {editableViaAiProvider ? 'Editable via AI provider' : 'Turn edits on'}
                  </span>
                </button>
              </section>
            )}
            {codexMode && onCodexModeChange && (
              <section className="project-controls-overflow-section">
                <span className="project-controls-overflow-label">Codex access</span>
                <div className="project-controls-overflow-options">
                  {CODEX_MODE_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      className="project-controls-overflow-item"
                      aria-pressed={codexMode === option.value}
                      title={option.hint}
                      onClick={() => {
                        onCodexModeChange(option.value);
                        setOpen(false);
                      }}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </section>
            )}
          </fieldset>
        </Popover.Content>
      </Popover.Root>
    </div>
  );
}

/**
 * The status bar along the bottom edge of a project. The AMBIENT surface:
 * workspace index, project status, the edits switch, and — when the project
 * is GitHub-linked — a branch picker, a plain-language status chip ("3
 * unsaved changes · 1 to get") that clicks through to the GitHub tab, and
 * one Sync button. Saving, diffs, and conflict resolution live in the
 * GitHub tab — the workbench — so the two surfaces never compete over the
 * same actions.
 *
 * Everything that overlays out of this bar opens *upward*: the branch menu
 * and toast are hand-positioned (see styles.css), the Radix tooltip and
 * overflow popover are told `side="top"`, and the Radix selects flip on
 * their own via collision detection.
 */
export function ProjectGitStatusBar({
  projectId,
  compact = false,
  allowGezelWrites,
  workingDir,
  onAllowWritesChange,
  editableViaAiProvider = false,
  codexMode,
  onCodexModeChange,
  onOpenGitHub,
  status: projectStatus,
  statusLocked = false,
  onStatusChange,
}: Props) {
  const [status, setStatus] = useState<GitStatusResponse | null>(null);
  const [indexStatus, setIndexStatus] = useState<WorkspaceIndexStatus | null>(null);
  const [branches, setBranches] = useState<GitBranchesResponse | null>(null);
  const [branchMenuOpen, setBranchMenuOpen] = useState(false);
  const [newBranchOpen, setNewBranchOpen] = useState(false);
  const [newBranchDraft, setNewBranchDraft] = useState('');
  const [busy, setBusy] = useState<string>('');
  const [toast, setToast] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [indexPanelOpen, setIndexPanelOpen] = useState(false);
  const [indexRefreshBusy, setIndexRefreshBusy] = useState(false);
  const [indexRefreshError, setIndexRefreshError] = useState<string | null>(null);
  const branchMenuRef = useRef<HTMLDivElement | null>(null);
  // Effective per-project writability — mirrors `projectWorkspaceWritable`
  // in core: explicit flag wins, else internal workspaces are writable and
  // external working dirs are not.
  const gezelWritesOn = allowGezelWrites ?? !workingDir;

  const refresh = useCallback(async () => {
    try {
      const s = await api.getProjectGitStatus(projectId);
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
    window.addEventListener(GIT_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(GIT_CHANGED_EVENT, onChanged);
  }, [projectId, refresh]);

  const onUpdateIndex = useCallback(async () => {
    if (
      indexRefreshBusy ||
      indexStatus === null ||
      indexStatus.state === 'disabled' ||
      indexStatus.state === 'indexing'
    ) {
      return;
    }
    setIndexRefreshBusy(true);
    setIndexRefreshError(null);
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
      setIndexRefreshError('Couldn’t start the index update. Try again.');
    } finally {
      setIndexRefreshBusy(false);
    }
  }, [indexRefreshBusy, indexStatus, projectId, refreshIndex]);

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
      .listProjectGitBranches(projectId)
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
      onOpenGitHub?.();
    },
    onConflicts: () => onOpenGitHub?.(),
    onAuth: () => onOpenGitHub?.(),
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
        await api.setProjectGitBranch(projectId, branch);
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
        await api.createProjectGitBranch(projectId, name);
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

  const hasGitHub = Boolean(status?.github);
  const branch = status?.branch;
  const lastSynced = status?.github?.lastSyncedAt;
  const indexState = indexStatus?.state ?? 'never';
  const aiScanPending = indexStatus?.aiScanPending === true;
  // Steady-state pill colour (the dot):
  //   fresh + scan done → green ('fresh')   — all up to date
  //   fresh + scan todo → amber ('scan')    — index fresh, AI scan still pending
  //   stale / never     → red   ('stale')   — index out of date
  //   indexing          → blue pulse ('indexing', transient)
  //   disabled          → neutral ('disabled')
  const indexDotState =
    indexState === 'disabled'
      ? 'disabled'
      : indexState === 'indexing'
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
      : indexState === 'disabled'
        ? 'Workspace indexing is off'
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
  const indexTriggerLabel = `Indexing status: ${indexHeadline}`;
  const indexUpdateDisabled =
    indexStatus === null ||
    indexState === 'disabled' ||
    indexState === 'indexing' ||
    indexRefreshBusy;

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
        {hasGitHub && (
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
                <DropdownChevron className="project-git-chevron" />
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
                onClick={onOpenGitHub}
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
        <Popover.Root
          open={indexPanelOpen}
          onOpenChange={(open) => {
            setIndexPanelOpen(open);
            if (open) {
              setIndexRefreshError(null);
              void refreshIndex();
            }
          }}
        >
          <Popover.Trigger asChild>
            <button
              type="button"
              className={`project-index-chip project-index-chip-${indexDotState}`}
              aria-label={indexTriggerLabel}
              title="Open indexing status"
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
          </Popover.Trigger>
          <Popover.Content
            className="project-index-popover"
            side="top"
            align="center"
            aria-label="Indexing status"
          >
            <div className="project-index-panel">
              <div className="project-index-panel-heading">
                <span
                  className={`project-index-panel-dot project-index-panel-dot-${indexDotState}`}
                  aria-hidden
                />
                <strong>{indexHeadline}</strong>
              </div>

              {enrichment && enrichment.eligible > 0 && aiCoverage !== null && (
                <div className="project-index-panel-progress">
                  <div className="project-index-panel-progress-label">
                    <span>AI search coverage</span>
                    <strong>{aiCoverage}%</strong>
                  </div>
                  <div
                    className="project-index-panel-progress-track"
                    role="progressbar"
                    aria-label="AI search coverage"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={aiCoverage}
                    tabIndex={-1}
                  >
                    <span style={{ width: `${aiCoverage}%` }} />
                  </div>
                  <span className="project-index-panel-caption">
                    {enrichment.embedded} of {enrichment.eligible} files ready
                    {enrichment.pending > 0 ? ` · ${enrichment.pending} waiting` : ''}
                  </span>
                </div>
              )}

              <dl className="project-index-panel-details">
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

              <div className="project-index-panel-footer">
                <span className="project-index-panel-note">
                  {indexState === 'disabled'
                    ? 'Workspace indexing is off. Turn it on in Project Settings.'
                    : indexState === 'indexing'
                      ? 'The status updates automatically while the scan runs.'
                      : aiScanPending
                        ? 'AI indexing continues while the app is idle.'
                        : 'Refresh the index whenever you need the latest workspace state.'}
                </span>
                <button
                  type="button"
                  className="project-index-update-button"
                  disabled={indexUpdateDisabled}
                  onClick={() => void onUpdateIndex()}
                >
                  {indexState === 'indexing' || indexRefreshBusy
                    ? 'Updating index…'
                    : 'Update index now'}
                </button>
                {indexRefreshError && (
                  <span className="project-index-panel-error" role="alert">
                    {indexRefreshError}
                  </span>
                )}
              </div>
            </div>
          </Popover.Content>
        </Popover.Root>
        <div className="project-controls-inline">
          {onStatusChange && (
            <Select.Root
              value={projectStatus ?? 'active'}
              disabled={statusLocked}
              onValueChange={(v) => onStatusChange(v as ProjectStatus)}
            >
              <Select.Trigger
                className={`project-status-select project-status-select-${projectStatus ?? 'active'}`}
                title={
                  statusLocked
                    ? 'Archived projects are inactive. Restore this project to change its status.'
                    : STATUS_TOOLTIP
                }
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
          {codexMode && onCodexModeChange && (
            <Select.Root
              value={codexMode}
              onValueChange={(value) => onCodexModeChange(value as CodexPermissionMode)}
            >
              <Select.Trigger
                className={`project-writes-select project-codex-mode project-codex-mode-${codexMode}`}
                title={codexModeTitle(codexMode)}
                aria-label="Codex execution mode for this project"
              >
                <span className="project-writes-select-icon" aria-hidden>
                  <EditsLockIcon unlocked={codexMode !== 'plan'} />
                </span>
                <Select.Value />
              </Select.Trigger>
              <Select.Content>
                {CODEX_MODE_OPTIONS.map((option) => (
                  <Select.Item key={option.value} value={option.value} textValue={option.label}>
                    {option.label}
                  </Select.Item>
                ))}
              </Select.Content>
            </Select.Root>
          )}
          {!codexMode &&
            onAllowWritesChange &&
            (!compact || !gezelWritesOn || editableViaAiProvider) && (
              <Select.Root
                value={editableViaAiProvider ? 'provider' : gezelWritesOn ? 'on' : 'off'}
                disabled={editableViaAiProvider}
                onValueChange={(v) => {
                  if (!editableViaAiProvider) onAllowWritesChange(v === 'on');
                }}
              >
                <Select.Trigger
                  className={`project-writes-select project-writes-select-${
                    editableViaAiProvider ? 'provider' : gezelWritesOn ? 'on' : 'off'
                  }`}
                  title={editableViaAiProvider ? PROVIDER_WRITES_TOOLTIP : WRITES_TOOLTIP}
                  aria-label="Gezel file edits for this project"
                >
                  <span className="project-writes-select-icon" aria-hidden>
                    <EditsLockIcon unlocked={editableViaAiProvider || gezelWritesOn} />
                  </span>
                  <Select.Value />
                </Select.Trigger>
                <Select.Content>
                  <Select.Item value="on">Edits on</Select.Item>
                  <Select.Item value="off">Edits off</Select.Item>
                  <Select.Item value="provider">Editable via AI provider</Select.Item>
                </Select.Content>
              </Select.Root>
            )}
        </div>
        {compact && (
          <ProjectControlsOverflow
            projectStatus={projectStatus ?? 'active'}
            statusLocked={statusLocked}
            onStatusChange={onStatusChange}
            gezelWritesOn={gezelWritesOn}
            onAllowWritesChange={onAllowWritesChange}
            editableViaAiProvider={editableViaAiProvider}
            codexMode={codexMode}
            onCodexModeChange={onCodexModeChange}
          />
        )}
        {!onAllowWritesChange && !gezelWritesOn && (
          <span
            className="project-lockdown-chip"
            title='Gezel file edits are off for this project. Enable "Allow gezellen to modify the workspace directory" in Project → Settings.'
            aria-label="Gezel file edits are off for this project."
          >
            <span className="project-lockdown-chip-icon" aria-hidden>
              <EditsLockIcon />
            </span>
            <span className="project-lockdown-chip-label">edits off</span>
          </span>
        )}
      </div>
      {!compact && (
        <div className="project-git-status-bar-right">
          {hasGitHub && (
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
    case 'disabled':
      return 'Off for this project';
  }
}

function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.max(1, Math.round(ms))}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const min = Math.floor(ms / 60_000);
  const sec = Math.round((ms % 60_000) / 1_000);
  return sec > 0 ? `${min}m ${sec}s` : `${min}m`;
}
