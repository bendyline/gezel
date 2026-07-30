import type { GitHubIdentity, GitStatusResponse, ProjectDetail } from '@bendyline/gezel';
import { GezelApiError } from '@bendyline/gezel-client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { GitHubSignInChip } from '../components/GithubSignInChip.js';
import { CodeReviewView } from '../components/github/CodeReviewView.js';
import { ConflictResolutionView } from '../components/github/ConflictResolutionView.js';
import { GitChangesView } from '../components/github/GitChangesView.js';
import { GitTimelineView } from '../components/github/GitTimelineView.js';
import { PullRequestsView } from '../components/github/PullRequestsView.js';
import { GIT_COPY } from '../components/github/gitCopy.js';
import { useCodeReviews } from '../components/github/useCodeReviews.js';
import { GIT_CHANGED_EVENT, useGitSync } from '../components/github/useGitSync.js';
import { Tabs } from '../primitives/index.js';

type GitHubSubTab = 'changes' | 'timeline' | 'prs' | 'review';

interface Props {
  project: ProjectDetail;
  onProjectChange: (project: ProjectDetail) => void;
}

/**
 * Per-project GitHub tab — the git workbench for non-technical users.
 * Sub-tabs: Changes (changed files + diff + save box; becomes the
 * guided conflict flow mid-merge), Timeline (save history), and Pull
 * requests. The Files browser this tab used to carry is gone — the
 * Workspace tab already browses files. "Timeline", not "History",
 * because the project already has a History tab for the activity log.
 */
export function ProjectGitHubView({ project, onProjectChange }: Props) {
  const [subTab, setSubTab] = useState<GitHubSubTab>('changes');
  const [status, setStatus] = useState<GitStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState('');
  const [toast, setToast] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [needsSaveOpen, setNeedsSaveOpen] = useState(false);
  const [authIssue, setAuthIssue] = useState(false);
  const [nudgeDismissed, setNudgeDismissed] = useState(false);
  // Distinguishes "found a merge waiting at mount" (app restarted mid-
  // sync) from a conflict the user just hit — the wizard's intro changes.
  const syncClickedRef = useRef(false);

  const showToast = useCallback((kind: 'ok' | 'err', text: string) => {
    setToast({ kind, text });
    window.setTimeout(() => setToast(null), 5_000);
  }, []);

  const refreshStatus = useCallback(async () => {
    try {
      const s = await api.getProjectGitStatus(project.id);
      setStatus(s);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [project.id]);

  const {
    reviews,
    running: runningReviews,
    start: startReview,
    cancel: cancelReview,
    busy: reviewBusy,
  } = useCodeReviews(project.id, showToast);

  const kickOffReview = useCallback(
    (kind: 'commit' | 'pr') => {
      void startReview(kind).then((ok) => {
        if (ok) setSubTab('review');
      });
    },
    [startReview],
  );

  const { sync, syncing } = useGitSync(project.id, {
    onToast: showToast,
    onConflicts: () => {
      setSubTab('changes');
      void refreshStatus();
    },
    onNeedsSave: () => {
      setSubTab('changes');
      setNeedsSaveOpen(true);
    },
    onAuth: () => setAuthIssue(true),
  });

  const doSync = useCallback(async () => {
    syncClickedRef.current = true;
    const result = await sync();
    if (result?.state === 'synced') {
      setAuthIssue(false);
      setNudgeDismissed(false);
    }
    await refreshStatus();
  }, [sync, refreshStatus]);

  const handleGitHubIdentityChange = useCallback(
    (identity: GitHubIdentity | null) => {
      if (!identity) return;
      setAuthIssue(false);
      void refreshStatus();
    },
    [refreshStatus],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: project.id change must re-fire the reset + refresh.
  useEffect(() => {
    setError(null);
    setSubTab('changes');
    setAuthIssue(false);
    setNudgeDismissed(false);
    syncClickedRef.current = false;
    void refreshStatus();
  }, [project.id, refreshStatus]);

  // 30s status cadence + cross-surface invalidation events.
  useEffect(() => {
    const interval = window.setInterval(() => void refreshStatus(), 30_000);
    const onChanged = (e: Event) => {
      if ((e as CustomEvent).detail?.projectId === project.id) void refreshStatus();
    };
    window.addEventListener(GIT_CHANGED_EVENT, onChanged);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener(GIT_CHANGED_EVENT, onChanged);
    };
  }, [refreshStatus, project.id]);

  // Background fetch on mount + every 5 minutes while the tab is open,
  // so the "new changes available" nudge appears without user action.
  const checkoutExists = status?.exists === true;
  useEffect(() => {
    if (!checkoutExists) return;
    const fetchRemote = () =>
      api
        .fetchProjectGit(project.id)
        .then(() => refreshStatus())
        .catch((err) => {
          if (isMissingGitHubAuth(err)) setAuthIssue(true);
          // Offline and other passive-fetch failures stay quiet — the
          // freshness nudge simply does not update.
        });
    void fetchRemote();
    const interval = window.setInterval(() => void fetchRemote(), 300_000);
    return () => window.clearInterval(interval);
  }, [checkoutExists, project.id, refreshStatus]);

  const onClone = useCallback(async () => {
    setBusy('Downloading…');
    setError(null);
    try {
      await api.cloneProjectGit(project.id);
      const next = await api.getProject(project.id);
      onProjectChange(next);
      await refreshStatus();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy('');
    }
  }, [project.id, refreshStatus, onProjectChange]);

  const needsClone = status && !status.exists;
  // No stored PAT *and* no ambient credential (GH_TOKEN env or signed-in
  // GitHub CLI). Older services don't send credentialSource — fall back
  // to the PAT bit so the banner doesn't nag a signed-in gh user.
  const missingCreds = status
    ? (status.credentialSource ?? (status.hasPat ? 'pat' : 'none')) === 'none'
    : false;
  const mergeInProgress = status?.mergeInProgress === true;
  const behind = status?.behind ?? 0;
  const changesCount = status?.changesCount ?? 0;

  return (
    <div className="project-github">
      <div className="github-toolbar">
        <strong>{project.github?.url}</strong>
        {busy && <span className="status">{busy}</span>}
      </div>

      {(missingCreds || authIssue) && (
        <div className="github-banner gh-banner-warn">
          {authIssue
            ? 'GitHub needs you to sign in again.'
            : 'No GitHub sign-in found. Public repositories still work; sign in for private repositories, pull requests, and sending changes.'}{' '}
          <GitHubSignInChip onChange={handleGitHubIdentityChange} compact />
        </div>
      )}

      {!mergeInProgress && behind > 0 && !nudgeDismissed && (
        <div className="github-banner gh-banner-nudge">
          <span>{GIT_COPY.nudgeBanner}</span>
          <button
            type="button"
            className="primary"
            onClick={() => void doSync()}
            disabled={syncing}
          >
            {syncing ? 'Syncing…' : 'Sync'}
          </button>
          <button
            type="button"
            className="gh-banner-dismiss"
            aria-label="Dismiss"
            onClick={() => setNudgeDismissed(true)}
          >
            ✕
          </button>
        </div>
      )}

      {error && <p className="error">{error}</p>}

      {needsClone ? (
        <div className="gh-clone-state">
          <p>This project lives on GitHub but isn't on this computer yet.</p>
          <button
            type="button"
            className="primary"
            onClick={() => void onClone()}
            disabled={!!busy}
          >
            Download project
          </button>
        </div>
      ) : (
        <>
          <Tabs.Root value={subTab} onValueChange={(v) => setSubTab(v as GitHubSubTab)}>
            <Tabs.List>
              <Tabs.Trigger value="changes">
                Changes
                {changesCount > 0 && <span className="gh-tab-badge">{changesCount}</span>}
              </Tabs.Trigger>
              <Tabs.Trigger value="timeline">Timeline</Tabs.Trigger>
              <Tabs.Trigger value="prs">Pull requests</Tabs.Trigger>
              <Tabs.Trigger value="review">
                {GIT_COPY.reviewTabLabel}
                {runningReviews.length > 0 && (
                  <span className="gh-tab-badge">{runningReviews.length}</span>
                )}
              </Tabs.Trigger>
            </Tabs.List>
          </Tabs.Root>

          {subTab === 'changes' &&
            (mergeInProgress ? (
              <ConflictResolutionView
                projectId={project.id}
                resumed={!syncClickedRef.current}
                showToast={showToast}
                onFinished={() => {
                  void refreshStatus();
                  void doSync();
                }}
                onExited={() => void refreshStatus()}
              />
            ) : (
              <GitChangesView
                projectId={project.id}
                onSyncRequested={() => void doSync()}
                syncing={syncing}
                lastSyncedAt={status?.github?.lastSyncedAt}
                showToast={showToast}
                onReviewRequested={() => kickOffReview('commit')}
                onBranchReviewRequested={() => kickOffReview('pr')}
                reviewBusy={reviewBusy !== '' || runningReviews.some((r) => r.kind === 'commit')}
              />
            ))}

          {subTab === 'timeline' && <GitTimelineView projectId={project.id} />}

          {subTab === 'prs' && <PullRequestsView projectId={project.id} />}

          {subTab === 'review' && (
            <CodeReviewView
              projectId={project.id}
              reviews={reviews}
              busy={reviewBusy}
              changesCount={changesCount}
              branch={status?.branch}
              defaultBranch={status?.defaultBranch ?? status?.github?.defaultBranch}
              onStart={(kind) => void startReview(kind)}
              onCancel={(id) => void cancelReview(id)}
            />
          )}
        </>
      )}

      {toast && (
        <output className={`project-git-toast project-git-toast-${toast.kind}`}>
          {toast.text}
        </output>
      )}

      <ConfirmDialog
        open={needsSaveOpen}
        title={GIT_COPY.needsSaveTitle}
        message={GIT_COPY.needsSaveBody}
        confirmLabel={GIT_COPY.needsSaveConfirm}
        cancelLabel={GIT_COPY.needsSaveCancel}
        onConfirm={() => {
          setNeedsSaveOpen(false);
          setSubTab('changes');
        }}
        onCancel={() => setNeedsSaveOpen(false)}
      />
    </div>
  );
}

function isMissingGitHubAuth(err: unknown): boolean {
  if (!(err instanceof GezelApiError) || !err.details || typeof err.details !== 'object') {
    return false;
  }
  return 'code' in err.details && err.details.code === 'MISSING_PAT';
}
