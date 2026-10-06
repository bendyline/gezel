import {
  type Project,
  type ProjectTypeTool,
  type ScriptRun,
  createLogger,
  flattenRunOutput,
  projectAllowsAmbientWork,
  renderProjectTypeReactionSeed,
} from '@bendyline/gezel';
import type { Store } from '../fs/store.js';
import type { HistoryManager } from '../history/manager.js';

const log = createLogger('project-type');

/** The slice of ChatManager reactions need — kept narrow for tests. */
export interface ReactionChatPort {
  deliverReaction(args: {
    projectId: string;
    gezelId: string;
    seed: string;
    hidden?: boolean;
    standalone?: boolean;
  }): Promise<{ sessionId: string } | null>;
}

export interface ReactionDispatchResult {
  delivered: boolean;
  gezelId?: string;
  /** 'engagement-off' | 'project-inactive' | 'no-target' | 'send-failed' */
  reason?: string;
}

export { flattenRunOutput };

/**
 * Summon the declared gezel's turn after a page-invoked tool completed.
 * Called ONLY from the page-invoke route (the hard no-self-loop rule:
 * model-called tools never react). Failures never propagate — the user's
 * action already applied; only the summons is at stake.
 */
export async function dispatchToolReaction(
  deps: { store: Store; chat: ReactionChatPort; history?: HistoryManager },
  args: {
    project: Project;
    typeName: string;
    params?: Record<string, unknown>;
    tool: ProjectTypeTool;
    run: ScriptRun;
  },
): Promise<ReactionDispatchResult> {
  const reaction = args.tool.reaction;
  if (!reaction) return { delivered: false, reason: 'no-reaction' };

  if (!projectAllowsAmbientWork(args.project)) {
    return { delivered: false, reason: 'project-inactive' };
  }

  let targetGezelId: string | undefined;
  for (const id of args.project.gezelIds ?? []) {
    const gezel = await deps.store.getGezel(id).catch(() => null);
    if (gezel?.templateId === reaction.gezel) {
      targetGezelId = id;
      break;
    }
  }
  targetGezelId ??= args.project.voormanGezelId;
  if (!targetGezelId) {
    log.warn(
      `reactions: tool '${args.tool.name}' in project ${args.project.id} has no roster gezel ` +
        `from template '${reaction.gezel}' and no voorman; skipping`,
    );
    return { delivered: false, reason: 'no-target' };
  }

  const seed = renderProjectTypeReactionSeed({
    typeName: args.typeName,
    prompt: reaction.prompt,
    tool: args.tool.name,
    ...(args.params ? { params: args.params } : {}),
    output: args.run.output,
  });

  try {
    const delivered = await deps.chat.deliverReaction({
      projectId: args.project.id,
      gezelId: targetGezelId,
      seed,
      ...(reaction.hideSeed ? { hidden: true } : {}),
      ...(reaction.standalone ? { standalone: true } : {}),
    });
    if (!delivered) return { delivered: false, gezelId: targetGezelId, reason: 'engagement-off' };

    await deps.history
      ?.log({
        kind: 'page.reaction.sent',
        projectId: args.project.id,
        gezelId: targetGezelId,
        summary: `Page tool '${args.tool.name}' summoned a turn`,
        details: {
          tool: args.tool.name,
          gezelId: targetGezelId,
          sessionId: delivered.sessionId,
          runId: args.run.id,
        },
      })
      .catch((err) => log.warn('reactions: history log failed:', err));

    return { delivered: true, gezelId: targetGezelId };
  } catch (err) {
    log.warn(
      `reactions: delivery failed for tool '${args.tool.name}' in ${args.project.id}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return { delivered: false, gezelId: targetGezelId, reason: 'send-failed' };
  }
}
