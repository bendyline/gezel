import { createLogger, resolveSecurityPolicy } from '@bendyline/gezel';
import type { Store } from '../fs/store.js';
import type { GitManager } from '../git/manager.js';
import type { GitHubPrs } from '../github/prs.js';
import { registerMailAdapters } from '../mail/registry.js';
import { watchNetworkPresence } from '../system/network-presence.js';
import type { TaskManager } from '../tasks/manager.js';
import type { ConnectorManager } from './manager.js';
import { registerAzureMonitorLogsAdapters } from './natives/azure-monitor-logs.js';
import { registerBlueskyAdapters } from './natives/bluesky-posts.js';
import { registerCalendarAdapters } from './natives/calendar-google.js';
import { registerFilesAdapters } from './natives/files-shared.js';
import { registerGitHubPullsAdapters } from './natives/github-pulls.js';
import { registerGitHubReleasesAdapters } from './natives/github-releases.js';
import { registerGitHubWikiAdapters } from './natives/github-wiki.js';
import { registerInstagramAdapters } from './natives/instagram-media.js';
import { registerLinkedInAdapters } from './natives/linkedin-posts.js';
import { registerRssFeedAdapters } from './natives/rss-feed.js';
import { registerWebsiteAdapters } from './natives/website.js';
import { registerXAdapters } from './natives/x-posts.js';
import { registerYouTubeAdapters } from './natives/youtube-videos.js';
import type { ComponentStore } from './spectral/component-store.js';
import { sweepConnectorStaging } from './staging-sweep.js';
import type { ConnectorSyncManager, ConnectorSyncSource } from './sync-manager.js';
import { runConnectorTaskPrep } from './task-prep.js';

const log = createLogger('service');

/**
 * The connector runtime's housekeeping: staging folders a daemon that stopped
 * mid-pass left behind, components no connection uses any more (a day after
 * their last use), and an early pass when the network comes back (a network
 * joined, the lid opened) for connections that could not reach their service.
 * Returns the stop function.
 */
export function startConnectorHousekeeping(deps: {
  connectors: Pick<ConnectorManager, 'componentPinsInUse' | 'retryWaiting'>;
  components: Pick<ComponentStore, 'prune'>;
  sync: Pick<ConnectorSyncManager, 'tickSoon'>;
}): () => void {
  void sweepConnectorStaging().catch(() => {});
  const pruneComponents = () =>
    void deps.connectors
      .componentPinsInUse()
      .then((pins) => deps.components.prune(pins))
      .catch((err) => log.warn(`[connectors] component cleanup failed: ${String(err)}`));
  pruneComponents();
  const pruneTimer = setInterval(pruneComponents, 24 * 60 * 60_000);
  pruneTimer.unref?.();
  const stopNetworkWatch = watchNetworkPresence(() => {
    if (deps.connectors.retryWaiting() > 0) deps.sync.tickSoon();
  });
  return () => {
    clearInterval(pruneTimer);
    stopNetworkWatch();
  };
}

/**
 * What the background loop syncs. Read-only connections (feeds, wikis, saved
 * web pages) refresh whenever the machine may use the network for the
 * person; ones that can send or post wait for Unrestricted. Device bindings
 * never sync. A binding backing off after a failure is left out until its
 * backoff ends, so it cannot keep its project due and starve the others.
 */
export function connectorSyncSource(
  connectors: Pick<ConnectorManager, 'backgroundBindings' | 'backoffUntil' | 'syncProject'> &
    Partial<Pick<ConnectorManager, 'syncIntervalMs'>>,
): ConnectorSyncSource {
  return {
    label: 'connectors',
    listBindings: async (project, policy) => {
      const eligible = (await connectors.backgroundBindings(project, policy)).filter(
        (b) => !connectors.backoffUntil(b.id),
      );
      return Promise.all(
        eligible.map(async (b) => {
          const intervalMs = await connectors.syncIntervalMs?.(b);
          return {
            id: b.id,
            ...(b.lastSyncedAt ? { lastSyncedAt: b.lastSyncedAt } : {}),
            ...(intervalMs ? { intervalMs } : {}),
            ...(b.unreachable ? { waiting: true } : {}),
          };
        }),
      );
    },
    posture: (policy) => policy.allowConnectorData,
    syncProject: (project, policy, bindingIds) =>
      connectors.syncProject(project, { policy, bindingIds }),
  };
}

/** Register the native connector catalog before the connector managers start. */
export function registerProductConnectorAdapters(): void {
  registerMailAdapters();
  registerCalendarAdapters();
  registerFilesAdapters();
  registerRssFeedAdapters();
  registerWebsiteAdapters();
  registerYouTubeAdapters();
  registerBlueskyAdapters();
  registerXAdapters();
  registerInstagramAdapters();
  registerLinkedInAdapters();
  registerGitHubReleasesAdapters();
  registerGitHubWikiAdapters();
  registerAzureMonitorLogsAdapters();
}

/**
 * Connect craftbook launch preparation to the product's connector runtime.
 * TaskManager stays connector-agnostic; this service-layer seam pulls the
 * declared corpus down before the task's first prompt is interpolated.
 */
export function wireProductConnectorTaskPreparation(deps: {
  store: Store;
  connectors: ConnectorManager;
  tasks: TaskManager;
  git: GitManager;
  gitHubPrs: GitHubPrs;
}): void {
  registerGitHubPullsAdapters({
    prs: deps.gitHubPrs,
    project: async (projectId) => {
      const project = await deps.store.getProject(projectId);
      if (!project) throw new Error(`project ${projectId} not found`);
      return project;
    },
    // Degrades to the link's pinned branch rather than failing the launch
    // when the checkout is missing or git is unreadable.
    currentBranch: async (project) => (await deps.git.status(project).catch(() => null))?.branch,
  });

  deps.tasks.setConnectorPrepHook(
    async ({ projectId, craftbookId, connectors: needs, params }) => {
      const prep = await runConnectorTaskPrep(
        {
          getProject: (id) => deps.store.getProject(id),
          sync: (project, bindingId, opts) =>
            deps.connectors.syncBinding(project, bindingId, { ...opts, trigger: 'task' }),
          allowConnectorData: async () =>
            resolveSecurityPolicy(await deps.store.readConfig()).allowConnectorData,
          ensureBinding: async (project, need) => {
            if (need.typeId !== 'github-pulls') return null;
            if (!project.github?.url) return null;
            return deps.connectors.bind(project, {
              type: 'github-pulls',
              displayName: 'GitHub Pull Requests',
              config: {},
            });
          },
          ...(process.env.GEZEL_EVAL_REUSE_PREPARED_CONNECTOR_CORPORA === '1'
            ? {
                reusePreparedCorpus: async (project, need, preparedParams) => {
                  const corpusScope = preparedParams.corpusScope
                    ?.trim()
                    .replace(/^artifacts\//, '')
                    .replace(/\/+$/, '');
                  if (!corpusScope) return null;
                  const listing = await deps.store.listProjectArtifactsRecursiveDetailed(
                    project.id,
                    { subpath: corpusScope },
                  );
                  const fileCount = listing.entries.filter((entry) => !entry.isDirectory).length;
                  if (fileCount === 0) return null;
                  return {
                    params: { corpusScope },
                    summary: `Reused ${fileCount}${listing.truncated ? '+' : ''} locally seeded ${need.typeId} record(s) from \`${corpusScope}/\` (eval fixture; no source sync).`,
                  };
                },
              }
            : {}),
        },
        { projectId, craftbookId, connectors: needs, params },
      );
      return { params: prep.params, ...(prep.note ? { note: prep.note } : {}) };
    },
    { autoPreparedTypes: ['github-pulls'] },
  );
}
