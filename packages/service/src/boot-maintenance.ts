/**
 * The daemon's background housekeeping after boot: the idle-session timers
 * and the one-shot work deferred past startup. `stop()` cancels all of it
 * as shutdown begins.
 */
import { createLogger } from '@bendyline/gezel';
import { warmEmbeddings } from '@bendyline/gezel-inference/internal/memory/embeddings';
import type { RelevanceModelManager } from '@bendyline/gezel-inference/internal/relevance/manager';
import { deferBootWork } from './boot-work.js';
import type { ChatEventBus } from './chat/events.js';
import type { ChatManager } from './chat/manager.js';
import type { OptionalDownloads } from './first-run/optional-downloads.js';
import type { Store } from './fs/store.js';
import type { MediaSearchManager } from './media-search/manager.js';
import type { ProjectTypeUpgrader } from './project-type/upgrader.js';
import { withdrawStaleServiceCardsEverywhere } from './tasks/service-card-withdrawal.js';

const log = createLogger('service');

export interface BootMaintenanceDeps {
  store: Pick<
    Store,
    | 'refreshStartupHome'
    | 'listProjects'
    | 'readTask'
    | 'listProjectQuestions'
    | 'updateProjectQuestions'
  >;
  chat: Pick<ChatManager, 'runIdleSummarizationSweep' | 'releaseIdleSessions'>;
  chatEvents: Pick<ChatEventBus, 'publishProjectEvent'>;
  projectTypeUpgrader: Pick<ProjectTypeUpgrader, 'requestSweep'>;
  relevance: Pick<RelevanceModelManager, 'bootWarm'>;
  mediaSearch: Pick<MediaSearchManager, 'bootWarm'>;
  optionalDownloads: Pick<OptionalDownloads, 'boot'>;
  isStopping: () => boolean;
}

export function startBootMaintenance(deps: BootMaintenanceDeps): { stop: () => void } {
  const { store, chat, chatEvents, isStopping } = deps;
  // Idle-session summarization sweep: every hour, distill any non-archived
  // session that's been quiet for `config.summarization.idleHours` (default
  // 24h) into project memory. First pass runs ~60s after boot so a fresh
  // process doesn't block startup.
  const idleSummarizerTimer = setInterval(
    () => {
      chat.runIdleSummarizationSweep().catch((err) => {
        log.warn('[summarize] idle sweep crashed:', err instanceof Error ? err.message : err);
      });
    },
    60 * 60 * 1000,
  );
  idleSummarizerTimer.unref();
  // Give back the provider sessions and MCP subprocesses of quiet sessions;
  // finished task sessions otherwise hold theirs until the daemon stops.
  const idleSessionTimer = setInterval(
    () => {
      chat.releaseIdleSessions().catch((err) => {
        log.warn('[chat] idle session release failed:', err instanceof Error ? err.message : err);
      });
    },
    5 * 60 * 1000,
  );
  idleSessionTimer.unref();
  // Cancelled by stop(): deferred work that starts during shutdown can load a
  // model worker that process.exit then aborts mid-load (see boot-work.ts).
  const cancelBootWork: Array<() => void> = [];
  cancelBootWork.push(
    deferBootWork(
      10_000,
      () => {
        void store.refreshStartupHome().catch(() => {});
      },
      isStopping,
    ),
  );
  cancelBootWork.push(
    deferBootWork(
      60_000,
      () => {
        chat.runIdleSummarizationSweep().catch(() => {
          /* swallow */
        });
      },
      isStopping,
    ),
  );
  // Cards whose task settled before the runtime withdrew them, or while it was down.
  cancelBootWork.push(
    deferBootWork(
      30_000,
      () => {
        void withdrawStaleServiceCardsEverywhere({
          store,
          chatEvents,
          listProjectIds: async () => (await store.listProjects()).map((project) => project.id),
          readTask: (projectId, num) => store.readTask(projectId, num),
        }).catch((err) => log.warn(`[tasks] stale card sweep failed: ${String(err)}`));
      },
      isStopping,
    ),
  );
  // Projects made with an older version of their app move to the newest of
  // the same major when nothing of the person's is affected.
  cancelBootWork.push(
    deferBootWork(2_000, () => deps.projectTypeUpgrader.requestSweep('startup'), isStopping),
  );
  // Load the embedding pipeline before an interactive caller needs it. The
  // titlebar search fans out over content on every query, so without this
  // the model's one-time load lands on somebody's first keystroke. Deferred
  // so it never competes with boot or the first-run model download.
  cancelBootWork.push(
    deferBootWork(
      20_000,
      () => {
        void warmEmbeddings().then((warmed) => {
          if (warmed) log.debug('[memory] embedding pipeline warmed');
        });
        void deps.relevance.bootWarm().catch(() => {});
        void deps.mediaSearch
          .bootWarm({ install: false })
          .then(() => deps.optionalDownloads.boot())
          .catch(() => {});
      },
      isStopping,
    ),
  );
  return {
    stop() {
      for (const cancel of cancelBootWork) cancel();
      clearInterval(idleSummarizerTimer);
      clearInterval(idleSessionTimer);
    },
  };
}
