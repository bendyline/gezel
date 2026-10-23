import { mkdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type ChatSession,
  KeyedLock,
  type MeesterStatusReport,
  type NightShiftReviewResponse,
  type StartupHomeSnapshot,
  StartupHomeSnapshotSchema,
} from '@bendyline/gezel';
import { writeFileAtomic } from '@bendyline/gezel-inference/internal/fs/atomic';
import type { Store } from './store.js';

type StartupHomeSource = Pick<
  Store,
  | 'readConfig'
  | 'getGezel'
  | 'readMeesterStatus'
  | 'statProjectArtifactPath'
  | 'readProjectArtifact'
>;

function readingStatus(report: MeesterStatusReport | null): StartupHomeSnapshot['status'] {
  return report
    ? {
        headline: report.headline,
        content: report.report.slice(0, 16_000),
        at: report.generatedAt,
      }
    : null;
}

/** Store-owned cache; Electron reads just this file before a service exists. */
export class StartupHomeCache {
  private readonly lock = new KeyedLock();
  private messageAt = '';
  constructor(private readonly home: string) {}

  async refresh(source: StartupHomeSource): Promise<void> {
    const config = await source.readConfig();
    const meester = config.meesterGezelId ? await source.getGezel(config.meesterGezelId) : null;
    const status = await source.readMeesterStatus();
    await this.update({
      meester: meester
        ? { id: meester.id, name: meester.name.slice(0, 200), poppetje: meester.poppetje }
        : null,
      showPoppetjes: config.showPoppetjes !== false,
      theme: config.themePref ?? 'system',
      sidebar: config.sidebarSide ?? 'right',
      status: readingStatus(status),
    });
  }

  cacheStatus(report: MeesterStatusReport): Promise<void> {
    return this.update({ status: readingStatus(report) });
  }

  async cacheNightReview(
    source: StartupHomeSource,
    review: NightShiftReviewResponse,
  ): Promise<void> {
    const reports = await Promise.all(
      review.reports.slice(0, 3).map(async (report) => {
        const info = await source
          .statProjectArtifactPath(report.projectId, report.path)
          .catch(() => null);
        const content =
          info?.kind === 'file' && (info.size ?? Number.POSITIVE_INFINITY) <= 128_000
            ? await source.readProjectArtifact(report.projectId, report.path).catch(() => null)
            : null;
        return {
          title: report.title.slice(0, 300),
          project: report.projectName.slice(0, 200),
          content: content?.slice(0, 16_000) || 'Open the full report when your workshop is ready.',
        };
      }),
    );
    await this.update({
      night: {
        windowEnd: review.windowEnd,
        completed: review.tasksCompleted.length,
        reportCount: review.reports.length,
        proposals: review.diffpacks.length,
        actions: review.reports.reduce((total, report) => total + report.actionCounts.suggested, 0),
        reports,
      },
    });
  }

  async cacheSession(session: ChatSession): Promise<void> {
    if (session.taskRef) return;
    for (let index = session.messages.length - 1; index >= 0; index--) {
      const message = session.messages[index]!;
      if (message.role !== 'user' || message.from || message.hidden) continue;
      if (message.at > this.messageAt) {
        this.messageAt = message.at;
        await this.update({
          lastMessage: {
            content: message.content.slice(0, 8_000),
            at: message.at,
          },
        });
      }
      break;
    }
  }

  async read(): Promise<StartupHomeSnapshot | null> {
    try {
      const path = join(this.home, 'startup-home.json');
      if ((await stat(path)).size > 256_000) return null;
      return StartupHomeSnapshotSchema.parse(JSON.parse(await readFile(path, 'utf8')));
    } catch {
      return null;
    }
  }

  update(patch: Partial<Omit<StartupHomeSnapshot, 'version' | 'savedAt'>>): Promise<void> {
    return this.lock.run('snapshot', async () => {
      const previous = await this.read();
      // A changed Meester must not inherit the previous one's conversation.
      const changed =
        previous?.meester &&
        patch.meester !== undefined &&
        patch.meester?.id !== previous.meester.id;
      const lastMessage = changed ? null : previous?.lastMessage;
      const next = StartupHomeSnapshotSchema.parse({
        ...previous,
        lastMessage,
        ...patch,
        version: 1,
        savedAt: new Date().toISOString(),
        meester: patch.meester !== undefined ? patch.meester : (previous?.meester ?? null),
      });
      if (
        patch.lastMessage &&
        previous?.lastMessage &&
        patch.lastMessage.at < previous.lastMessage.at
      ) {
        next.lastMessage = previous.lastMessage;
      }
      await mkdir(this.home, { recursive: true });
      await writeFileAtomic(join(this.home, 'startup-home.json'), `${JSON.stringify(next)}\n`);
    });
  }
}
