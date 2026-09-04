import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type CreatePromptDraftRequest,
  type DuplicatePromptDraftRequest,
  KeyedLock,
  PROMPT_DRAFT_FILES_DIR_NAME,
  PROMPT_DRAFT_MESSAGE_FILE,
  PROMPT_DRAFT_META_FILE,
  type PatchPromptDraftRequest,
  type PromptDraft,
  type PromptDraftMeta,
  PromptDraftMetaSchema,
  type PromptDraftStatus,
  type PromptDraftSummary,
  createLogger,
  derivePromptDraftTitle,
  formatPromptDraftId,
  isPromptDraftId,
  nowIso,
  parsePromptDraftId,
} from '@bendyline/gezel';
import { PROJECT_PROMPTS_DIR_NAME } from '@bendyline/gezel/paths';
import type { ChatEventBus } from '../chat/events.js';
import { writeFileAtomic } from '../fs/atomic.js';
import type { Store } from '../fs/store.js';
import { isSyncJunkName } from '../fs/sync-junk.js';

/**
 * Owner of `artifacts/prompts/` — the messages a user is still writing.
 *
 * A deliberate carve-out from `Store`: a draft folder is a small document
 * tree (`message.md` + `message_files/` + `draft.json`) whose files the
 * squisq editor writes directly through the ordinary artifact routes, so
 * routing the metadata through Store's schema-per-entity layer would buy
 * nothing and split ownership in two.
 *
 * Three habits are load-bearing:
 *
 * - **`touchProject` is never called.** Autosave writes here about once a
 *   second while someone types, and `project.updatedAt` is read elsewhere as
 *   "this project saw activity" by the nudge scheduler. A draft is private
 *   scratch; it is not the project doing anything.
 * - **Allocation and every metadata mutation run under a per-project lock.**
 *   The id is `max(existing sequence) + 1` read off the directory listing —
 *   no counter file to corrupt or migrate — which is only safe if two
 *   concurrent creates cannot both read the same max.
 * - **The folder name is the record.** A draft whose folder was renamed by
 *   hand to something that is not an id stops being listed; the files are
 *   still there and nothing is lost, but this manager will not adopt it.
 */

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

export class PromptDraftNotFoundError extends Error {
  readonly code = 'prompt-draft-not-found' as const;
  constructor(draftId: string) {
    super(`prompt draft not found: ${draftId}`);
    this.name = 'PromptDraftNotFoundError';
  }
}

export class PromptDraftInvalidIdError extends Error {
  readonly code = 'prompt-draft-invalid-id' as const;
  constructor(draftId: string) {
    super(`not a prompt draft id: ${draftId}`);
    this.name = 'PromptDraftInvalidIdError';
  }
}

export class PromptDraftManager {
  private readonly store: Store;
  private readonly events: Pick<ChatEventBus, 'publishProjectEvent'> | undefined;
  private readonly now: () => Date;
  private readonly locks = new KeyedLock();

  constructor(opts: PromptDraftManagerOptions) {
    this.store = opts.store;
    this.events = opts.events;
    this.now = opts.now ?? (() => new Date());
  }

  rootDir(projectId: string): string {
    return join(this.store.projectArtifactsDir(projectId), PROJECT_PROMPTS_DIR_NAME);
  }

  draftDir(projectId: string, draftId: string): string {
    if (!isPromptDraftId(draftId)) throw new PromptDraftInvalidIdError(draftId);
    return join(this.rootDir(projectId), draftId);
  }

  async list(projectId: string, filter: PromptDraftListFilter = {}): Promise<PromptDraftSummary[]> {
    const ids = await this.listDraftIds(projectId);
    const out: PromptDraftSummary[] = [];
    for (const id of ids) {
      const summary = await this.readSummary(projectId, id);
      if (!summary) continue;
      if (filter.gezelId && summary.gezelId !== filter.gezelId) continue;
      if (filter.sessionId !== undefined && summary.sessionId !== filter.sessionId) continue;
      if (filter.status && summary.status !== filter.status) continue;
      out.push(summary);
    }
    // Most recently touched first, with the sequence as the tie-break so two
    // drafts saved in the same millisecond still have a stable order.
    out.sort((a, b) => {
      if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
      return (parsePromptDraftId(b.id)?.seq ?? 0) - (parsePromptDraftId(a.id)?.seq ?? 0);
    });
    return out;
  }

  async get(projectId: string, draftId: string): Promise<PromptDraft | null> {
    const meta = await this.readMeta(projectId, draftId);
    if (!meta) return null;
    const content = await this.readContent(projectId, draftId);
    const fileCount = await this.countFiles(projectId, draftId);
    return { ...meta, ...this.derived(content, fileCount), content };
  }

  async create(projectId: string, input: CreatePromptDraftRequest): Promise<PromptDraft> {
    const content = input.content ?? '';
    return this.locks.run(projectId, async () => {
      const id = await this.allocateId(projectId);
      const at = nowIso();
      const meta: PromptDraftMeta = {
        id,
        projectId,
        gezelId: input.gezelId,
        sessionId: input.sessionId ?? null,
        ...(input.taskRef ? { taskRef: input.taskRef } : {}),
        ...(input.craftbookRef ? { craftbookRef: input.craftbookRef } : {}),
        ...(input.scope ? { scope: input.scope } : {}),
        createdAt: at,
        updatedAt: at,
        status: 'draft',
      };
      const dir = this.draftDir(projectId, id);
      await mkdir(join(dir, PROMPT_DRAFT_FILES_DIR_NAME), { recursive: true });
      await writeFileAtomic(join(dir, PROMPT_DRAFT_MESSAGE_FILE), content);
      await this.writeMeta(projectId, meta);
      this.publish(meta);
      return { ...meta, ...this.derived(content, 0), content };
    });
  }

  /**
   * Save the draft's text. A draft with nothing in it and nothing attached is
   * deleted rather than kept: the composer clears itself on send and on
   * discard, and a husk left behind would show up as a blank row in the
   * picker forever.
   */
  async writeContent(
    projectId: string,
    draftId: string,
    content: string,
  ): Promise<{ draft: PromptDraftSummary | null; deleted: boolean }> {
    return this.locks.run(projectId, async () => {
      const meta = await this.readMeta(projectId, draftId);
      if (!meta) throw new PromptDraftNotFoundError(draftId);
      const fileCount = await this.countFiles(projectId, draftId);
      if (!content.trim() && fileCount === 0) {
        await this.removeDir(projectId, draftId);
        this.publish({ ...meta, updatedAt: nowIso() }, true);
        return { draft: null, deleted: true };
      }
      await writeFileAtomic(
        join(this.draftDir(projectId, draftId), PROMPT_DRAFT_MESSAGE_FILE),
        content,
      );
      const next: PromptDraftMeta = { ...meta, updatedAt: nowIso() };
      await this.writeMeta(projectId, next);
      this.publish(next);
      return { draft: { ...next, ...this.derived(content, fileCount) }, deleted: false };
    });
  }

  /** Re-file a draft. An explicit `null` clears an optional ref. */
  async patchMeta(
    projectId: string,
    draftId: string,
    patch: PatchPromptDraftRequest,
  ): Promise<PromptDraftSummary> {
    return this.locks.run(projectId, async () => {
      const meta = await this.readMeta(projectId, draftId);
      if (!meta) throw new PromptDraftNotFoundError(draftId);
      const next: PromptDraftMeta = { ...meta, updatedAt: nowIso() };
      if (patch.gezelId !== undefined) next.gezelId = patch.gezelId;
      if (patch.sessionId !== undefined) next.sessionId = patch.sessionId;
      for (const key of ['taskRef', 'craftbookRef', 'scope'] as const) {
        const value = patch[key];
        if (value === undefined) continue;
        if (value === null) delete next[key];
        else next[key] = value;
      }
      await this.writeMeta(projectId, next);
      this.publish(next);
      return this.summarize(projectId, next);
    });
  }

  /**
   * Record that this draft was sent. `content` is the ORIGINAL
   * document-relative markdown, not the rewritten form the transcript
   * carries: the draft stays an editable document, and rewriting its own
   * refs would break the editor's Files panel and any later reuse.
   */
  async markSent(
    projectId: string,
    draftId: string,
    info: { sessionId: string; content?: string },
  ): Promise<PromptDraftSummary> {
    return this.locks.run(projectId, async () => {
      const meta = await this.readMeta(projectId, draftId);
      if (!meta) throw new PromptDraftNotFoundError(draftId);
      if (info.content !== undefined) {
        await writeFileAtomic(
          join(this.draftDir(projectId, draftId), PROMPT_DRAFT_MESSAGE_FILE),
          info.content,
        );
      }
      const at = nowIso();
      const next: PromptDraftMeta = {
        ...meta,
        sessionId: meta.sessionId ?? info.sessionId,
        status: 'sent',
        sentAt: at,
        sentSessionId: info.sessionId,
        updatedAt: at,
      };
      await this.writeMeta(projectId, next);
      this.publish(next);
      return this.summarize(projectId, next);
    });
  }

  /**
   * Stamp the `at` of the persisted user message. Best-effort and quiet: the
   * send route accepts before the turn writes its message, so this lands a
   * beat later and nothing gates on it.
   */
  async noteSentMessageAt(projectId: string, draftId: string, at: string): Promise<void> {
    await this.locks.run(projectId, async () => {
      const meta = await this.readMeta(projectId, draftId);
      if (!meta) return;
      await this.writeMeta(projectId, { ...meta, sentMessageAt: at });
    });
  }

  /** "Use again" — copy a draft's text and files into a fresh open draft. */
  async duplicate(
    projectId: string,
    draftId: string,
    input: DuplicatePromptDraftRequest = {},
  ): Promise<PromptDraft> {
    const source = await this.get(projectId, draftId);
    if (!source) throw new PromptDraftNotFoundError(draftId);
    const created = await this.create(projectId, {
      gezelId: source.gezelId,
      sessionId: input.sessionId !== undefined ? input.sessionId : source.sessionId,
      content: source.content,
      ...(source.taskRef ? { taskRef: source.taskRef } : {}),
      ...(source.craftbookRef ? { craftbookRef: source.craftbookRef } : {}),
      ...(source.scope ? { scope: source.scope } : {}),
    });
    if (source.hasFiles) {
      const { cp } = await import('node:fs/promises');
      await cp(
        join(this.draftDir(projectId, draftId), PROMPT_DRAFT_FILES_DIR_NAME),
        join(this.draftDir(projectId, created.id), PROMPT_DRAFT_FILES_DIR_NAME),
        { recursive: true },
      );
    }
    return (await this.get(projectId, created.id)) ?? created;
  }

  async delete(projectId: string, draftId: string): Promise<boolean> {
    return this.locks.run(projectId, async () => {
      const meta = await this.readMeta(projectId, draftId);
      if (!meta) return false;
      await this.removeDir(projectId, draftId);
      this.publish({ ...meta, updatedAt: nowIso() }, true);
      return true;
    });
  }

  /**
   * A thread was deleted. Its sent drafts go with it — they record a
   * conversation that no longer exists — while unsent ones are detached
   * rather than destroyed: those words are still the user's, they just have
   * nowhere to go yet.
   */
  async onSessionDeleted(
    projectId: string,
    sessionId: string,
  ): Promise<{ deleted: number; detached: number }> {
    const drafts = await this.list(projectId, { sessionId });
    let deleted = 0;
    let detached = 0;
    for (const draft of drafts) {
      try {
        if (draft.status === 'sent') {
          if (await this.delete(projectId, draft.id)) deleted += 1;
        } else {
          await this.patchMeta(projectId, draft.id, { sessionId: null });
          detached += 1;
        }
      } catch (err) {
        log.warn(`session cleanup failed for ${projectId}/${draft.id}: ${describe(err)}`);
      }
    }
    return { deleted, detached };
  }

  /** Remove sent drafts last sent before `cutoffIso`. Unsent are never swept. */
  async sweepSent(projectId: string, cutoffIso: string): Promise<number> {
    const drafts = await this.list(projectId, { status: 'sent' });
    let removed = 0;
    for (const draft of drafts) {
      const sentAt = draft.sentAt ?? draft.updatedAt;
      if (sentAt >= cutoffIso) continue;
      try {
        if (await this.delete(projectId, draft.id)) removed += 1;
      } catch (err) {
        log.warn(`sweep failed for ${projectId}/${draft.id}: ${describe(err)}`);
      }
    }
    return removed;
  }

  // ---------- internals ----------

  private async allocateId(projectId: string): Promise<string> {
    const ids = await this.listDraftIds(projectId);
    let maxSeq = 0;
    for (const id of ids) {
      const seq = parsePromptDraftId(id)?.seq ?? 0;
      if (seq > maxSeq) maxSeq = seq;
    }
    return formatPromptDraftId(this.now(), maxSeq + 1);
  }

  private async listDraftIds(projectId: string): Promise<string[]> {
    let entries: string[];
    try {
      entries = await readdir(this.rootDir(projectId));
    } catch {
      return [];
    }
    return entries.filter((name) => isPromptDraftId(name));
  }

  private async readMeta(projectId: string, draftId: string): Promise<PromptDraftMeta | null> {
    let raw: string;
    try {
      raw = await readFile(join(this.draftDir(projectId, draftId), PROMPT_DRAFT_META_FILE), 'utf8');
    } catch {
      return null;
    }
    try {
      return PromptDraftMetaSchema.parse(JSON.parse(raw));
    } catch (err) {
      log.warn(`unreadable draft metadata at ${projectId}/${draftId}: ${describe(err)}`);
      return null;
    }
  }

  private async writeMeta(projectId: string, meta: PromptDraftMeta): Promise<void> {
    await writeFileAtomic(
      join(this.draftDir(projectId, meta.id), PROMPT_DRAFT_META_FILE),
      `${JSON.stringify(meta, null, 2)}\n`,
    );
  }

  private async readContent(projectId: string, draftId: string): Promise<string> {
    try {
      return await readFile(
        join(this.draftDir(projectId, draftId), PROMPT_DRAFT_MESSAGE_FILE),
        'utf8',
      );
    } catch {
      return '';
    }
  }

  private async countFiles(projectId: string, draftId: string): Promise<number> {
    const dir = join(this.draftDir(projectId, draftId), PROMPT_DRAFT_FILES_DIR_NAME);
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return 0;
    }
    let count = 0;
    for (const name of entries) {
      // A stray .DS_Store must not keep an empty draft alive.
      if (isSyncJunkName(name)) continue;
      try {
        if ((await stat(join(dir, name))).isFile()) count += 1;
      } catch {
        /* vanished between listing and stat */
      }
    }
    return count;
  }

  private async removeDir(projectId: string, draftId: string): Promise<void> {
    // Retries because an editor on Windows may still hold a just-written file.
    await rm(this.draftDir(projectId, draftId), {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  }

  private derived(
    content: string,
    fileCount: number,
  ): Pick<PromptDraftSummary, 'title' | 'hasFiles' | 'fileCount'> {
    return { title: derivePromptDraftTitle(content), hasFiles: fileCount > 0, fileCount };
  }

  private async readSummary(
    projectId: string,
    draftId: string,
  ): Promise<PromptDraftSummary | null> {
    const meta = await this.readMeta(projectId, draftId);
    if (!meta) return null;
    return this.summarize(projectId, meta);
  }

  private async summarize(projectId: string, meta: PromptDraftMeta): Promise<PromptDraftSummary> {
    const content = await this.readContent(projectId, meta.id);
    const fileCount = await this.countFiles(projectId, meta.id);
    return { ...meta, ...this.derived(content, fileCount) };
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
