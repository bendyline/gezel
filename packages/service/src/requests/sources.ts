import {
  type DurationEstimates,
  type RequestTrack,
  type Task,
  assembleRequestTracks,
  stepDurationEstimates,
} from '@bendyline/gezel';
import type { ServiceContext } from '../http/context.js';

/** Medians move only when work finishes; recomputing them per poll is waste. */
const ESTIMATE_TTL_MS = 60_000;
const estimateCache = new WeakMap<ServiceContext, { at: number; value: DurationEstimates }>();

function estimatesFor(ctx: ServiceContext, tasks: readonly Task[], now: number): DurationEstimates {
  const cached = estimateCache.get(ctx);
  if (cached && now - cached.at < ESTIMATE_TTL_MS) return cached.value;
  const value = stepDurationEstimates(tasks);
  estimateCache.set(ctx, { at: now, value });
  return value;
}

/**
 * The person's requests and how far each has got (core's
 * `assembleRequestTracks` over this daemon's tasks, sessions and turns).
 * Pass `tasks` and `questions` when the caller already read them.
 */
export async function listRequestTracks(
  ctx: ServiceContext,
  filter: { sessions?: readonly string[]; live?: boolean } = {},
  read: {
    tasks?: readonly Task[];
    questions?: Awaited<ReturnType<ServiceContext['store']['listAllPendingQuestions']>>;
  } = {},
): Promise<RequestTrack[]> {
  const now = Date.now();
  const [tasks, questions, config] = await Promise.all([
    read.tasks ?? ctx.tasks.list(),
    read.questions ?? ctx.store.listAllPendingQuestions(),
    ctx.store.readConfig(),
  ]);
  return assembleRequestTracks(
    {
      tasks,
      session: (id) => ctx.store.findSessionById(id),
      project: (id) => ctx.store.getProject(id),
      ...(config.meesterGezelId ? { meesterGezelId: config.meesterGezelId } : {}),
      inflight: ctx.chat.listInflight(),
      waiting: ctx.taskRunner.waitingStates(),
      questions,
      estimates: estimatesFor(ctx, tasks, now),
      now,
    },
    filter,
  );
}
