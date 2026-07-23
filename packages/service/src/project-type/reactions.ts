import {
  type Project,
  type ProjectTypeTool,
  type ScriptRun,
  createLogger,
  projectAllowsAmbientWork,
} from '@bendyline/gezel';
import type { Store } from '../fs/store.js';
import type { HistoryManager } from '../history/manager.js';
import { renderProjectTypeTemplate } from './apply.js';

const log = createLogger('project-type');

/** The slice of ChatManager reactions need — kept narrow for tests. */
export interface ReactionChatPort {
  deliverReaction(args: {
    projectId: string;
    gezelId: string;
    seed: string;
    hidden?: boolean;
  }): Promise<{ sessionId: string } | null>;
}

export interface ReactionDispatchResult {
  delivered: boolean;
  gezelId?: string;
  /** 'engagement-off' | 'project-inactive' | 'no-target' | 'send-failed' */
  reason?: string;
}

/**
 * Flatten a script run's output into dot-path template keys (depth ≤ 2):
 * `{board, stats: {moves}}` → `output.board`, `output.stats.moves`, plus a
 * JSON `output.stats` for the object itself. Non-strings stringify;
 * objects/arrays JSON-stringify — templates pick whichever form reads
 * best.
 */
export function flattenRunOutput(output: unknown): Record<string, unknown> {
  const map: Record<string, unknown> = {};
  if (output === null || output === undefined || typeof output !== 'object') {
    if (output !== undefined) map.output = output;
    return map;
  }
  map.output = JSON.stringify(output);
  for (const [key, value] of Object.entries(output as Record<string, unknown>)) {
    if (value !== null && typeof value === 'object') {
      map[`output.${key}`] = JSON.stringify(value);
      for (const [inner, innerValue] of Object.entries(value as Record<string, unknown>)) {
        if (innerValue !== null && typeof innerValue === 'object') {
          map[`output.${key}.${inner}`] = JSON.stringify(innerValue);
        } else {
          map[`output.${key}.${inner}`] = innerValue;
        }
      }
    } else {
      map[`output.${key}`] = value;
    }
  }
  return map;
}

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

  const renderMap: Record<string, unknown> = {
    ...(args.params ?? {}),
    ...flattenRunOutput(args.run.output),
    tool: args.tool.name,
  };
  const seed = `[${args.typeName} page]: ${renderProjectTypeTemplate(reaction.prompt, renderMap)}`;

  try {
    const delivered = await deps.chat.deliverReaction({
      projectId: args.project.id,
      gezelId: targetGezelId,
      seed,
      ...(reaction.hideSeed ? { hidden: true } : {}),
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
