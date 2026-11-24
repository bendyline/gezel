/**
 * What a script run may read of the data kept on models on this computer.
 *
 * A run's output goes to whoever started it. The person's own runs (a page, a
 * manual run, a connector's sync) read everything. A gezel's chat run follows
 * its session; a task step's run follows the gezel the step belongs to; a
 * nested run cannot see whose it is, so it follows the cautious answer.
 */

import { type KeptLocalSource, parseTaskRef, stepOwnerGezelId } from '@bendyline/gezel';
import type { ChatManager } from '../chat/manager.js';
import { type KeptLocalArea, KeptLocalData, taskArtifactFolder } from '../connectors/kept-local.js';
import type { Store } from '../fs/store.js';
import { keptMemoryTag } from '../memory/daily-markdown.js';

export interface ScriptCaller {
  projectId: string;
  initiatedByGezel?: boolean | undefined;
  sessionId?: string | undefined;
  /** The task step the run serves, when it is one. */
  step?: { taskRef: string; stepId: string } | undefined;
}

export type KeptLocalChat = Pick<
  ChatManager,
  | 'sessionRunsOnThisComputer'
  | 'gezelRunsOnThisComputer'
  | 'markKeptLocal'
  | 'markKeptLocalTags'
  | 'keptLocalSources'
>;

export class ScriptKeptLocal {
  private readonly data: KeptLocalData;

  constructor(
    private readonly store: Store,
    private readonly chat: KeptLocalChat,
  ) {
    this.data = new KeptLocalData(store);
  }

  /** The kept area an artifact path is in, or undefined when there is none. */
  async areaFor(caller: ScriptCaller, path: string): Promise<KeptLocalArea | undefined> {
    const areas = await this.data.areas(caller.projectId);
    const byPath = this.data.areaForPath(areas, path);
    if (byPath || areas.length === 0) return byPath;
    const file = await this.store
      .resolveProjectArtifactReadPath(caller.projectId, path)
      .catch(() => null);
    return file ? this.data.areaForFile(caller.projectId, areas, file) : undefined;
  }

  /** A listing as this run may see it. */
  async visible<T extends { path: string }>(caller: ScriptCaller, entries: T[]): Promise<T[]> {
    const areas = await this.data.areas(caller.projectId);
    if (areas.length === 0) return entries;
    const kept = entries.filter((e) => this.data.areaForPath(areas, e.path));
    if (kept.length === 0) return entries;
    if (await this.withheld(caller)) return entries.filter((e) => !kept.includes(e));
    await this.shown(
      caller,
      kept.flatMap((e) => this.data.areaForPath(areas, e.path)?.source ?? []),
    );
    return entries;
  }

  /** Whether the run's output would go to a model that is not on this computer. */
  async withheld(caller: ScriptCaller): Promise<boolean> {
    if (!caller.initiatedByGezel) return false;
    if (caller.sessionId) return !(await this.chat.sessionRunsOnThisComputer(caller.sessionId));
    const owner = await this.stepOwner(caller);
    return owner ? !(await this.chat.gezelRunsOnThisComputer(owner)) : true;
  }

  private async stepOwner(caller: ScriptCaller): Promise<string | null> {
    const ref = caller.step ? parseTaskRef(caller.step.taskRef) : null;
    const task = ref ? await this.store.readTask(ref.projectId, ref.num).catch(() => null) : null;
    const step = task?.craftbook.steps.find((s) => s.id === caller.step?.stepId);
    return task && step ? (stepOwnerGezelId(task, step) ?? null) : null;
  }

  /** The run was shown these: its conversation, or its task, stays here. */
  async shown(caller: ScriptCaller, sources: readonly KeptLocalSource[]): Promise<void> {
    if (sources.length === 0 || !caller.initiatedByGezel) return;
    if (caller.sessionId) return this.chat.markKeptLocal(caller.sessionId, sources);
    const ref = caller.step ? parseTaskRef(caller.step.taskRef) : null;
    if (!ref) return;
    const task = await this.store.readTask(ref.projectId, ref.num).catch(() => null);
    await this.data.remember(
      ref.projectId,
      [taskArtifactFolder(ref.num), ...(task?.artifactDir ? [task.artifactDir] : [])],
      sources,
    );
  }

  async shownMemories(caller: ScriptCaller, tags: readonly string[]): Promise<void> {
    if (caller.sessionId) await this.chat.markKeptLocalTags(caller.sessionId, tags);
  }

  /** Artifacts a run wrote for a conversation that read kept-local data. */
  async wrote(caller: ScriptCaller, path: string): Promise<void> {
    if (!caller.sessionId) return;
    const sources = await this.chat.keptLocalSources(caller.sessionId);
    await this.data.remember(caller.projectId, [path], sources);
  }

  /** The tag for a memory the run saves. */
  async memoryTag(caller: ScriptCaller): Promise<string | undefined> {
    if (!caller.sessionId) return undefined;
    const sources = await this.chat.keptLocalSources(caller.sessionId);
    return keptMemoryTag(sources.map((source) => source.bindingId));
  }
}
