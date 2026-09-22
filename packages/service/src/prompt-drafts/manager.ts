import { join } from 'node:path';
import {
  type CreatePromptDraftRequest,
  type DuplicatePromptDraftRequest,
  KeyedLock,
  type PatchPromptDraftRequest,
  type PromptDraft,
  type PromptDraftMeta,
  type PromptDraftStatus,
  type PromptDraftSummary,
  createLogger,
  nowIso,
} from '@bendyline/gezel';
import { PROJECT_PROMPTS_DIR_NAME } from '@bendyline/gezel/paths';
import {
  PromptDraftInvalidIdError,
  PromptDraftNotFoundError,
  createPromptDraft,
  deletePromptDraft,
  duplicatePromptDraft,
  getPromptDraft,
  listPromptDrafts,
  markPromptDraftSent,
  patchPromptDraft,
  planSessionCleanup,
  stampPromptDraftSentMessageAt,
  sweepableSentDrafts,
  writePromptDraftContent,
} from '@bendyline/gezel/runtime';
import type { ChatEventBus } from '../chat/events.js';
import type { Store } from '../fs/store.js';
import { isSyncJunkName } from '../fs/sync-junk.js';
import { nodePromptDraftFiles } from './node-files.js';

/**
 * Owner of `artifacts/prompts/` on the desktop.
 *
 * The draft logic itself is the shared module in core, the same one the
 * portable host runs; this class supplies what the desktop adds: a
 * per-project lock around allocation and every metadata change, and a
 * project-stream event after each one. `touchProject` is never called here,
 * by construction — the shared module cannot reach the project record.
 */

export { PromptDraftInvalidIdError, PromptDraftNotFoundError };

const log = createLogger('prompt-drafts');

export interface PromptDraftManagerOptions {
  store: Store;
  events?: Pick<ChatEventBus, 'publishProjectEvent'>;
  now?: () => Date;
}

export interface PromptDraftListFilter {
  gezelId?: string;
  /** `undefined` matches any thread; `null` matches only new-thread drafts. */
  sessionId?: string | null;
  status?: PromptDraftStatus;
}

export class PromptDraftManager {
  private readonly store: Store;
  private readonly events: Pick<ChatEventBus, 'publishProjectEvent'> | undefined;
  private readonly now: () => Date;
  private readonly locks = new KeyedLock();
  private readonly host: {
    now: () => string;
    allocatedAt: () => string;
    isJunkName: (name: string) => boolean;
  };

  constructor(opts: PromptDraftManagerOptions) {
    this.store = opts.store;
    this.events = opts.events;
    this.now = opts.now ?? (() => new Date());
    // Timestamps read the real clock; only the id's date follows an injected
    // `now`, which is what lets a test mint drafts across days.
    this.host = {
      now: () => nowIso(),
      allocatedAt: () => this.now().toISOString(),
      isJunkName: isSyncJunkName,
    };
  }

  rootDir(projectId: string): string {
    return join(this.store.projectArtifactsDir(projectId), PROJECT_PROMPTS_DIR_NAME);
  }

  draftDir(projectId: string, draftId: string): string {
    if (!/^\d{4}-\d{2}-\d{2}-\d{4,}$/.test(draftId)) throw new PromptDraftInvalidIdError(draftId);
    return join(this.rootDir(projectId), draftId);
  }

  private files(projectId: string) {
    return nodePromptDraftFiles(this.rootDir(projectId));
  }

  async list(projectId: string, filter: PromptDraftListFilter = {}): Promise<PromptDraftSummary[]> {
    return listPromptDrafts(this.files(projectId), this.host, projectId, filter);
  }

  async get(projectId: string, draftId: string): Promise<PromptDraft | null> {
    return getPromptDraft(this.files(projectId), this.host, projectId, draftId);
  }

  async create(projectId: string, input: CreatePromptDraftRequest): Promise<PromptDraft> {
    return this.locks.run(projectId, async () => {
      const draft = await createPromptDraft(this.files(projectId), this.host, projectId, input);
      this.publish(draft);
      return draft;
    });
  }

  async writeContent(
    projectId: string,
    draftId: string,
    content: string,
  ): Promise<{ draft: PromptDraftSummary | null; deleted: boolean }> {
    return this.locks.run(projectId, async () => {
      const { meta, ...result } = await writePromptDraftContent(
        this.files(projectId),
        this.host,
        projectId,
        draftId,
        content,
      );
      this.publish(meta, result.deleted);
      return result;
    });
  }

  /** Re-file a draft. An explicit `null` clears an optional ref. */
  async patchMeta(
    projectId: string,
    draftId: string,
    patch: PatchPromptDraftRequest,
  ): Promise<PromptDraftSummary> {
    return this.locks.run(projectId, async () => {
      const { content: _content, ...summary } = await patchPromptDraft(
        this.files(projectId),
        this.host,
        projectId,
        draftId,
        patch,
      );
      this.publish(summary);
      return summary;
    });
  }

  /**
   * Record that this draft was sent. `content` is the ORIGINAL
   * document-relative markdown, not the rewritten form the transcript
   * carries: the draft stays an editable document.
   */
  async markSent(
    projectId: string,
    draftId: string,
    info: { sessionId: string; content?: string },
  ): Promise<PromptDraftSummary> {
    return this.locks.run(projectId, async () => {
      const { content: _content, ...summary } = await markPromptDraftSent(
        this.files(projectId),
        this.host,
        projectId,
        draftId,
        info,
      );
      this.publish(summary);
      return summary;
    });
  }

  /** Stamp the `at` of the persisted user message. Quiet when the draft is gone. */
  async noteSentMessageAt(projectId: string, draftId: string, at: string): Promise<void> {
    await this.locks.run(projectId, () =>
      stampPromptDraftSentMessageAt(this.files(projectId), projectId, draftId, at),
    );
  }

  /** "Use again" — copy a draft's text and files into a fresh open draft. */
  async duplicate(
    projectId: string,
    draftId: string,
    input: DuplicatePromptDraftRequest = {},
  ): Promise<PromptDraft> {
    return this.locks.run(projectId, async () => {
      const draft = await duplicatePromptDraft(
        this.files(projectId),
        this.host,
        projectId,
        draftId,
        input,
      );
      this.publish(draft);
      return draft;
    });
  }

  async delete(projectId: string, draftId: string): Promise<boolean> {
    return this.locks.run(projectId, async () => {
      const { deleted, meta } = await deletePromptDraft(this.files(projectId), projectId, draftId);
      if (meta) this.publish({ ...meta, updatedAt: this.host.now() }, true);
      return deleted;
    });
  }

  /**
   * A thread was deleted. Its sent drafts go with it; its unsent ones are
   * detached rather than destroyed.
   */
  async onSessionDeleted(
    projectId: string,
    sessionId: string,
  ): Promise<{ deleted: number; detached: number }> {
    const plan = planSessionCleanup(await this.list(projectId, { sessionId }), sessionId);
    let deleted = 0;
    let detached = 0;
    for (const id of plan.delete) {
      try {
        if (await this.delete(projectId, id)) deleted += 1;
      } catch (err) {
        log.warn(`session cleanup failed for ${projectId}/${id}: ${describe(err)}`);
      }
    }
    for (const id of plan.detach) {
      try {
        await this.patchMeta(projectId, id, { sessionId: null });
        detached += 1;
      } catch (err) {
        log.warn(`session cleanup failed for ${projectId}/${id}: ${describe(err)}`);
      }
    }
    return { deleted, detached };
  }

  /** Remove sent drafts last sent before `cutoffIso`. Unsent are never swept. */
  async sweepSent(projectId: string, cutoffIso: string): Promise<number> {
    let removed = 0;
    for (const id of sweepableSentDrafts(
      await this.list(projectId, { status: 'sent' }),
      cutoffIso,
    )) {
      try {
        if (await this.delete(projectId, id)) removed += 1;
      } catch (err) {
        log.warn(`sweep failed for ${projectId}/${id}: ${describe(err)}`);
      }
    }
    return removed;
  }

  private publish(meta: PromptDraftMeta, deleted?: boolean): void {
    this.events?.publishProjectEvent(meta.projectId, {
      type: 'prompt_draft_changed',
      projectId: meta.projectId,
      gezelId: meta.gezelId,
      draftId: meta.id,
      sessionId: meta.sessionId,
      status: meta.status,
      ...(deleted ? { deleted: true } : {}),
      updatedAt: meta.updatedAt,
    });
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
