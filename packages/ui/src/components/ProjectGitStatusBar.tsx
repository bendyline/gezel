import type {
  ClaudePermissionMode,
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
import type { ProjectClaudePermissionMode } from './project-ai-editability.js';

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
   * Resolved Gezel-managed write access. The parent must derive this through
   * `projectManagedWorkspaceWritable`; this component never interprets raw
   * persistence fields.
   */
  managedWorkspaceWritable?: boolean;
  /**
   * Flip the per-project write switch. When provided, the bar renders an
   * explicitly labelled "Can edit/Read-only" dropdown next to the
   * status select.
   * The caller owns the external-dir confirmation flow (enabling writes
   * on a user-supplied folder must confirm first).
   */
  onManagedWorkspaceWritesChange?: (next: boolean) => void;
  /** Codex-specific project posture, displayed independently from managed tools. */
  codexMode?: CodexPermissionMode;
  onCodexModeChange?: (mode: CodexPermissionMode) => void;
  /** Claude CLI posture, displayed only when Claude is represented in the project. */
  claudeMode?: ProjectClaudePermissionMode;
  onClaudeModeChange?: (mode: ClaudePermissionMode) => void;
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
  "Whether Gezel-managed tools and background work may create, edit, and delete files in this project's workspace. " +
  'Internal workspaces default to on; a project opened from an existing folder defaults to off ' +
  '(turning it on asks for confirmation first). Provider-native access such as Codex is shown separately.';

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

const CLAUDE_MODE_OPTIONS: ReadonlyArray<{
  value: ClaudePermissionMode;
  label: string;
  hint: string;
}> = [
  { value: 'plan', label: 'Plan', hint: 'Read and reason without changing workspace files.' },
  { value: 'default', label: 'Ask', hint: 'Let Claude request permission for tool use.' },
  { value: 'acceptEdits', label: 'Edit', hint: 'Auto-approve file edits; gate shell commands.' },
  {
    value: 'bypassPermissions',
    label: 'Full',
    hint: 'Bypass Claude permission prompts, including for shell commands.',
  },
];

function codexModeTitle(mode: CodexPermissionMode): string {
  const option = CODEX_MODE_OPTIONS.find((item) => item.value === mode);
  return `Codex ${option?.label ?? mode}: ${option?.hint ?? ''}`;
}

function claudeModeTitle(mode: ProjectClaudePermissionMode): string {
  if (mode === 'mixed') return 'Claude: assigned gezels currently use different permission modes.';
  const option = CLAUDE_MODE_OPTIONS.find((item) => item.value === mode);
  return `Claude ${option?.label ?? mode}: ${option?.hint ?? ''}`;
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
  managedWritesOn,
  onManagedWorkspaceWritesChange,
  codexMode,
  onCodexModeChange,
  claudeMode,
  onClaudeModeChange,
}: {
  projectStatus: ProjectStatus;
  statusLocked?: boolean;
  onStatusChange?: (status: ProjectStatus) => void;
  managedWritesOn: boolean;
  onManagedWorkspaceWritesChange?: (next: boolean) => void;
  codexMode?: CodexPermissionMode;
  onCodexModeChange?: (mode: CodexPermissionMode) => void;
  claudeMode?: ProjectClaudePermissionMode;
  onClaudeModeChange?: (mode: ClaudePermissionMode) => void;
}) {
  const [open, setOpen] = useState(false);

  if (
    !onStatusChange &&
    !onCodexModeChange &&
    !onClaudeModeChange &&
    (!onManagedWorkspaceWritesChange || managedWritesOn)
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
            {onManagedWorkspaceWritesChange && !managedWritesOn && (
              <section className="project-controls-overflow-section">
                <span className="project-controls-overflow-label">Built-in tools</span>
                <button
                  type="button"
                  className="project-controls-overflow-item"
                  onClick={() => {
                    onManagedWorkspaceWritesChange(true);
                    setOpen(false);
                  }}
                >
                  <span className="project-writes-select-icon" aria-hidden>
                    <EditsLockIcon unlocked />
                  </span>
                  <span>Allow workspace edits</span>
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
            {claudeMode && onClaudeModeChange && (
              <section className="project-controls-overflow-section">
                <span className="project-controls-overflow-label">Claude access</span>
                <div className="project-controls-overflow-options">
                  {CLAUDE_MODE_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      className="project-controls-overflow-item"
                      aria-pressed={claudeMode === option.value}
                      title={option.hint}
                      onClick={() => {
                        onClaudeModeChange(option.value);
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
  managedWorkspaceWritable = true,
  onManagedWorkspaceWritesChange,
  codexMode,
  onCodexModeChange,
  claudeMode,
  onClaudeModeChange,
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
  const [fullScanState, setFullScanState] = useState<'idle' | 'starting' | 'running'>('idle');
  const [fullScanError, setFullScanError] = useState<string | null>(null);
  const branchMenuRef = useRef<HTMLDivElement | null>(null);
  const managedWritesOn = managedWorkspaceWritable;

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

  // While an AI drive is running, poll the index status faster — the whole
  // point of the drive is visible progress, and 30s gaps read as "stuck".
  const drivePolling = indexStatus?.aiDrive != null || fullScanState !== 'idle';
  useEffect(() => {
    if (!drivePolling) return;
    const id = window.setInterval(() => void refreshIndex(), 5_000);
    return () => window.clearInterval(id);
  }, [drivePolling, refreshIndex]);

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

  // Full-bore drive: one call starts a server-side job (static refresh, then
  // every AI tier to drain) with non-ambient one-shots — it competes with
  // chat for the model, which is exactly what the user asked for by clicking.
  // The response returns immediately; the popover's polling tracks the drain.
  const fullScanBaseline = useRef<typeof indexStatus>(null);
  const onFullScan = useCallback(async () => {
    if (
      fullScanState !== 'idle' ||
      indexStatus === null ||
      indexStatus.state === 'disabled' ||
      indexStatus.aiDrive != null
    ) {
      return;
    }
    setFullScanState('starting');
    setFullScanError(null);
    fullScanBaseline.current = indexStatus;
    try {
      await api.driveIndexEnrichment(projectId, { intensity: 'full' });
      setFullScanState('running');
      window.setTimeout(() => void refreshIndex(), 800);
    } catch (err) {
      // GezelApiError carries the server's body under `details` — the enrich
      // route's 409s ("Add a Boekwachter to this project crew…") are
      // actionable, unlike the generic retry line.
      const detail =
        err && typeof err === 'object' && 'details' in err
          ? (err as { details?: { message?: string } }).details?.message
          : undefined;
      setFullScanError(detail ?? 'Couldn’t start the full scan. Try again.');
      setFullScanState('idle');
    }
  }, [fullScanState, indexStatus, projectId, refreshIndex]);

  // Re-arm the full-scan button once the server reports the drive gone —
  // whether it drained, failed, or was paused. Only a status polled AFTER
  // the drive started counts: the pre-drive snapshot carries no `aiDrive`
  // and would re-arm before the server registered the run.
  useEffect(() => {
    if (
      fullScanState === 'running' &&
      indexStatus !== fullScanBaseline.current &&
      indexStatus !== null &&
      indexStatus.aiDrive == null
    ) {
      setFullScanState('idle');
    }
  }, [fullScanState, indexStatus]);

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
  // The bar aggregates the totality of indexing (summaries + embeddings +
  // quality review); `aiCoverage` keeps feeding the caption's search-ready
  // count, which is a narrower question than "is all the work done".
  const overallProgress = enrichment ? overallIndexingPercent(enrichment) : null;
  // Server truth for a running AI drive — set no matter which window, the
  // night-shift catch-up, or the API started it.
  const serverDrive = indexStatus?.aiDrive ?? null;
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
                ? overallProgress === null
                  ? 'AI indexing is pending'
                  : `AI indexing ${overallProgress}% complete`
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

              {enrichment && enrichment.eligible > 0 && overallProgress !== null && (
                <div className="project-index-panel-progress">
                  <div className="project-index-panel-progress-label">
                    <span>Indexing progress</span>
                    <strong>{overallProgress}%</strong>
                  </div>
                  <div
                    className="project-index-panel-progress-track"
                    role="progressbar"
                    aria-label="Indexing progress"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={overallProgress}
                    tabIndex={-1}
                  >
                    <span style={{ width: `${overallProgress}%` }} />
                  </div>
                  <span className="project-index-panel-caption">
                    {enrichment.embedded} of {enrichment.eligible} files searchable
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
                        {indexStatus.meta.fileCount === 1 ? '' : 's'}
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
                {serverDrive && (
                  <div>
                    <dt>AI scan</dt>
                    <dd>
                      {serverDrive === 'full'
                        ? 'Running at full speed'
                        : 'Running quietly in background'}
                    </dd>
                  </div>
                )}
                {enrichment && (enrichment.shadowsPending ?? 0) > 0 && (
                  <div>
                    <dt>Media scan</dt>
                    <dd>{enrichment.shadowsPending} waiting</dd>
                  </div>
                )}
                {enrichment && enrichment.eligible > 0 && (
                  <div>
                    <dt>AI summaries</dt>
                    <dd>
                      {enrichment.summarized} of {enrichment.eligible} files
                      {(enrichment.skipped ?? 0) > 0
                        ? ` · ${enrichment.skipped} skipped after repeated failures`
                        : ''}
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
                    : serverDrive === 'full'
                      ? 'Full scan in progress — it shares the model with chat, so counts move as calls finish.'
                      : serverDrive === 'background'
                        ? 'Background scan in progress — it politely waits while you chat.'
                        : indexState === 'indexing'
                          ? 'The status updates automatically while the scan runs.'
                          : aiScanPending
                            ? 'AI indexing continues while the app is idle.'
                            : 'Refresh the index whenever you need the latest workspace state.'}
                </span>
                <div className="project-index-panel-actions">
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
                  {indexState !== 'disabled' && (
                    <button
                      type="button"
                      className="project-index-update-button project-index-full-scan-button"
                      disabled={
                        fullScanState !== 'idle' || serverDrive !== null || indexStatus === null
                      }
                      onClick={() => void onFullScan()}
                      title="Bring the whole index up to date at full speed — file scan plus AI summaries, rollups, and reviews, run to completion. Shares the model with chat while it works."
                    >
                      {fullScanState === 'starting'
                        ? 'Starting full scan…'
                        : fullScanState === 'running' || serverDrive === 'full'
                          ? 'Full scan running…'
                          : serverDrive === 'background'
                            ? 'Background scan running…'
                            : 'Full AI scan now'}
                    </button>
                  )}
                </div>
                {indexRefreshError && (
                  <span className="project-index-panel-error" role="alert">
                    {indexRefreshError}
                  </span>
                )}
                {fullScanError && (
                  <span className="project-index-panel-error" role="alert">
                    {fullScanError}
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
          {onManagedWorkspaceWritesChange && (!compact || !managedWritesOn) && (
            <Select.Root
              value={managedWritesOn ? 'on' : 'off'}
              onValueChange={(v) => onManagedWorkspaceWritesChange(v === 'on')}
            >
              <Select.Trigger
                className={`project-writes-select project-writes-select-${managedWritesOn ? 'on' : 'off'}`}
                title={WRITES_TOOLTIP}
                aria-label="Built-in tool workspace access for this project"
              >
                <span className="project-writes-select-icon" aria-hidden>
                  <EditsLockIcon unlocked={managedWritesOn} />
                </span>
                <Select.Value />
              </Select.Trigger>
              <Select.Content>
                <Select.Item value="on">Can edit</Select.Item>
                <Select.Item value="off">Read-only</Select.Item>
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
                <span className="project-permission-scope">Codex:</span>
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
          {claudeMode && onClaudeModeChange && (
            <Select.Root
              value={claudeMode}
              onValueChange={(value) => {
                if (value !== 'mixed') onClaudeModeChange(value as ClaudePermissionMode);
              }}
            >
              <Select.Trigger
                className={`project-writes-select project-claude-mode project-claude-mode-${claudeMode}`}
                title={claudeModeTitle(claudeMode)}
                aria-label="Claude execution mode for this project"
              >
                <span className="project-writes-select-icon" aria-hidden>
                  <EditsLockIcon unlocked={claudeMode !== 'plan' && claudeMode !== 'mixed'} />
                </span>
                <span className="project-permission-scope">Claude:</span>
                <Select.Value />
              </Select.Trigger>
              <Select.Content>
                {claudeMode === 'mixed' && (
                  <Select.Item value="mixed" disabled>
                    Mixed
                  </Select.Item>
                )}
                {CLAUDE_MODE_OPTIONS.map((option) => (
                  <Select.Item key={option.value} value={option.value} textValue={option.label}>
                    {option.label}
                  </Select.Item>
                ))}
              </Select.Content>
            </Select.Root>
          )}
        </div>
        {compact && (
          <ProjectControlsOverflow
            projectStatus={projectStatus ?? 'active'}
            statusLocked={statusLocked}
            onStatusChange={onStatusChange}
            managedWritesOn={managedWritesOn}
            onManagedWorkspaceWritesChange={onManagedWorkspaceWritesChange}
            codexMode={codexMode}
            onCodexModeChange={onCodexModeChange}
            claudeMode={claudeMode}
            onClaudeModeChange={onClaudeModeChange}
          />
        )}
        {!onManagedWorkspaceWritesChange && !managedWritesOn && (
          <span
            className="project-lockdown-chip"
            title='Managed workspace edits are off for this project. Enable "Allow built-in tools and background work to modify the workspace" in Project → Settings.'
            aria-label="Built-in tool workspace access is read-only for this project."
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

/**
 * Composite progress across the whole indexing pipeline the panel reports.
 * The structural file scan is folded in by construction — enrichment counts
 * only appear once that scan is fresh — so the aggregate spans the AI tiers:
 * one unit per eligible file for summaries, one for embeddings, one per
 * review-eligible file for the quality review. Media descriptions carry no
 * eligible total on the wire; their pending row keeps that phase visible.
 */
function overallIndexingPercent(
  enrichment: NonNullable<WorkspaceIndexStatus['enrichment']>,
): number | null {
  const phases: Array<[done: number, total: number]> = [
    [enrichment.summarized, enrichment.eligible],
    [enrichment.embedded, enrichment.eligible],
  ];
  if (enrichment.reviews) phases.push([enrichment.reviews.reviewed, enrichment.reviews.eligible]);
  let done = 0;
  let total = 0;
  for (const [phaseDone, phaseTotal] of phases) {
    if (phaseTotal <= 0) continue;
    done += Math.min(Math.max(phaseDone, 0), phaseTotal);
    total += phaseTotal;
  }
  return total > 0 ? Math.round((done / total) * 100) : null;
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
