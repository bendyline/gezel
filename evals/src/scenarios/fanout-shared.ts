import type { ChatSession, Task } from '@bendyline/gezel';
import type { GezelClient } from '@bendyline/gezel-client/node';
import type { EvalContext } from '../types.ts';

/**
 * Shared plumbing for the hermetic fanout scenarios (`fanout-stories`,
 * `fanout-tally`). Both drive CREATE-TIME fanout — `CreateTaskRequest.fanout
 * {count, variations}` plus `spawnsSteps` — because inline steps cannot carry
 * a `spawn.overFile` block and no gilde book is needed. `dispatchEntry` is
 * rejected on a fanout host by design: the host's first turn comes from the
 * barrier release when its last child settles, which is exactly the
 * mechanism these scenarios exist to exercise.
 *
 * Installing ANY per-gezel builtin group replaces the worker's role kit
 * wholesale (see craftbooks/scenario.ts), so this list IS the worker's whole
 * roster in both A/B arms — the arms then measure execution mode, not roster.
 */
export const FANOUT_EVAL_TOOLSET_IDS = [
  'builtin.workspace-fs-read',
  'builtin.workspace-fs-write',
  'builtin.memory',
  'builtin.documents',
  'builtin.artifacts',
  'builtin.tasks',
] as const;

export async function createFanoutWorker(
  ctx: EvalContext,
  projectId: string,
  worker: { name: string; role: string; description: string; about: string },
): Promise<string> {
  let workerId: string;
  try {
    const created = await ctx.client.createGezel(worker);
    workerId = created.id;
  } catch (err) {
    const { gezels } = await ctx.client.listGezels();
    const existing = gezels.find((g) => g.name === worker.name);
    if (!existing) throw err;
    workerId = existing.id;
  }
  for (const id of FANOUT_EVAL_TOOLSET_IDS) {
    await ctx.client.installToolset(id, { scope: { kind: 'gezel', gezelId: workerId } });
  }
  await ctx.client.addGezelToProject(projectId, workerId);
  return workerId;
}

export interface FanoutState {
  project: { id: string };
  host: Task;
  children: Task[];
}

export async function findFanoutState(
  client: GezelClient,
  projectName: string,
  hostTitle: string,
): Promise<FanoutState | null> {
  const { projects } = await client.listProjects();
  const project = projects.find((p) => p.name === projectName);
  if (!project) return null;
  const { tasks } = await client.listProjectTasks(project.id);
  const host = tasks.find((t) => !t.parentTaskRef && t.title === hostTitle);
  if (!host) return null;
  const children = (await client.listTaskChildren(project.id, host.num, { limit: 1_000 })).tasks;
  return { project: { id: project.id }, host, children };
}

export async function readWorkspaceText(
  client: GezelClient,
  projectId: string,
  path: string,
): Promise<string | null> {
  try {
    return await (await client.fetchProjectWorkspaceBlob(projectId, path)).text();
  } catch {
    return null;
  }
}

export function elapsedMs(start?: string, end?: string): number | null {
  if (!start || !end) return null;
  const value = Date.parse(end) - Date.parse(start);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export interface HostSessionReview {
  hostSessionCount: number;
  /** Successful workspace writes the HOST made under `forbiddenPrefix` — the crew's work done by the wrong hands. */
  hostWrotePaths: string[];
  /** Timestamp of the host's first persisted tool call, or the earliest host session creation. */
  firstHostActivityAt: string | null;
}

export async function reviewHostSessions(
  client: GezelClient,
  projectId: string,
  hostRef: string,
  forbiddenPrefix: string,
): Promise<HostSessionReview> {
  const summaries = (await client.listChatSessions({ projectId })).sessions.filter(
    (s) => s.taskRef === hostRef,
  );
  const hostWrotePaths: string[] = [];
  let firstHostActivityAt: string | null = null;
  for (const summary of summaries) {
    const session: ChatSession = await client.getChatSession(summary.id);
    const created = session.createdAt;
    if (created && (!firstHostActivityAt || created < firstHostActivityAt)) {
      firstHostActivityAt = created;
    }
    for (const message of session.messages) {
      for (const call of message.toolCalls ?? []) {
        const at = call.at ?? message.at;
        if (at && (!firstHostActivityAt || at < firstHostActivityAt)) firstHostActivityAt = at;
        if (
          call.success &&
          /^(write_file|append_to_file|replace_in_file|replace_lines|apply_patch)$/.test(call.name)
        ) {
          for (const path of [call.path, ...(call.paths ?? [])]) {
            if (path?.startsWith(forbiddenPrefix)) hostWrotePaths.push(path);
          }
        }
      }
    }
  }
  return { hostSessionCount: summaries.length, hostWrotePaths, firstHostActivityAt };
}

/** Wall-clock shape of the fanout: how long the crew took, and how fast the host picked up afterwards. */
export function fanoutDiagnostics(
  host: Task,
  children: Task[],
  review: HostSessionReview,
): Record<string, unknown> {
  const starts = children.map((c) => Date.parse(c.createdAt)).filter(Number.isFinite);
  const ends = children.map((c) => Date.parse(c.updatedAt)).filter(Number.isFinite);
  const lastChildSettledAt = ends.length > 0 ? Math.max(...ends) : null;
  const firstHost = review.firstHostActivityAt ? Date.parse(review.firstHostActivityAt) : null;
  return {
    fanout: {
      children: children.length,
      childrenCompleted: children.filter((c) => c.status === 'complete').length,
      makespanMs:
        starts.length > 0 && lastChildSettledAt !== null
          ? lastChildSettledAt - Math.min(...starts)
          : null,
      hostResumeLatencyMs:
        firstHost !== null && lastChildSettledAt !== null ? firstHost - lastChildSettledAt : null,
      barrierHeld:
        firstHost !== null && lastChildSettledAt !== null
          ? firstHost >= lastChildSettledAt - 2_000
          : null,
      hostSessions: review.hostSessionCount,
      hostWrotePaths: review.hostWrotePaths,
      perChildMs: children.map((c) => elapsedMs(c.createdAt, c.updatedAt)),
      hostTotalMs: elapsedMs(host.createdAt, host.updatedAt),
    },
  };
}
