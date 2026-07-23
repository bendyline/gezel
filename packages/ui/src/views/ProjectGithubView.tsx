import type { GithubStatusResponse, ProjectDetail } from '@bendyline/gezel';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { ConflictResolutionView } from '../components/github/ConflictResolutionView.js';
import { GitChangesView } from '../components/github/GitChangesView.js';
import { GitTimelineView } from '../components/github/GitTimelineView.js';
import { PullRequestsView } from '../components/github/PullRequestsView.js';
import { GIT_COPY } from '../components/github/gitCopy.js';
import { GITHUB_CHANGED_EVENT, useGitSync } from '../components/github/useGitSync.js';
import { Tabs } from '../primitives/index.js';

type GithubSubTab = 'changes' | 'timeline' | 'prs';

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
export function ProjectGithubView({ project, onProjectChange }: Props) {
  const [subTab, setSubTab] = useState<GithubSubTab>('changes');
  const [status, setStatus] = useState<GithubStatusResponse | null>(null);
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
      const s = await api.getProjectGithubStatus(project.id);
      setStatus(s);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [project.id]);

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
    window.addEventListener(GITHUB_CHANGED_EVENT, onChanged);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener(GITHUB_CHANGED_EVENT, onChanged);
    };
  }, [refreshStatus, project.id]);

  // Background fetch on mount + every 5 minutes while the tab is open,
  // so the "new changes available" nudge appears without user action.
  const checkoutExists = status?.exists === true;
  useEffect(() => {
    if (!checkoutExists) return;
    const fetchRemote = () =>
      api
        .fetchProjectGithub(project.id)
        .then(() => refreshStatus())
        .catch(() => {
          /* offline — the nudge just doesn't update */
        });
    void fetchRemote();
    const interval = window.setInterval(() => void fetchRemote(), 300_000);
    return () => window.clearInterval(interval);
  }, [checkoutExists, project.id, refreshStatus]);

  const onClone = useCallback(async () => {
    setBusy('Downloading…');
    setError(null);
    try {
      await api.cloneProjectGithub(project.id);
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

      {missingCreds && (
        <div className="github-banner gh-banner-warn">
          No GitHub sign-in found. Public repos will clone, but private repos and PR listings need
          credentials. Sign in with the GitHub CLI (<code>gh auth login</code>) or install the{' '}
          <strong>GitHub</strong> toolset in Settings → Toolsets.
        </div>
      )}

      {authIssue && <div className="github-banner gh-banner-warn">{GIT_COPY.syncAuth}</div>}

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
          <Tabs.Root value={subTab} onValueChange={(v) => setSubTab(v as GithubSubTab)}>
            <Tabs.List>
              <Tabs.Trigger value="changes">
                Changes
                {changesCount > 0 && <span className="gh-tab-badge">{changesCount}</span>}
              </Tabs.Trigger>
              <Tabs.Trigger value="timeline">Timeline</Tabs.Trigger>
              <Tabs.Trigger value="prs">Pull requests</Tabs.Trigger>
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
              />
            ))}

          {subTab === 'timeline' && <GitTimelineView projectId={project.id} />}

          {subTab === 'prs' && <PullRequestsView projectId={project.id} />}
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
