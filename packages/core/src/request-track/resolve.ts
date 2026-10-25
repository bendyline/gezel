import { type ActivityTurn, isReadyQuestion } from '../activity.js';
import { type ChatMessage, isLocalProvider } from '../schemas/gezel.js';
import { projectLeadGezelId } from '../schemas/project.js';
import type { Question } from '../schemas/question.js';
import type { TaskDeliverable } from '../schemas/referenced-file.js';
import type { RequestState, RequestStop, RequestTrack } from '../schemas/request-track.js';
import { type Task, type TaskWaitState, taskEffectiveStatus } from '../schemas/task.js';
import { deliverableFormatNoun, taskDeliverableCandidates } from '../task-deliverable.js';
import { taskActiveAssignee } from '../task-execution.js';
import type { EtaEngine } from './duration-seeds.js';
import { type DurationEstimates, estimateRemaining, remainingText } from './eta.js';
import {
  type TaskRequestRef,
  deriveTaskRequestRef,
  isPersonMessage,
  latestPersonMessage,
  requestKey,
} from './identity.js';
import { craftbookStepStages, stepPersonLabel } from './stage.js';

/** The parts of a thread a tracker reads. A `ChatSession` fits. */
export interface RequestThread {
  id: string;
  gezelId: string;
  projectId: string;
  taskRef?: string | undefined;
  messages: ReadonlyArray<
    Pick<
      ChatMessage,
      | 'role'
      | 'at'
      | 'id'
      | 'content'
      | 'synthetic'
      | 'referencedTasks'
      | 'deliverable'
      | 'makerGezelId'
      | 'from'
      | 'hidden'
      | 'nudge'
      | 'origin'
    >
  >;
}

export interface RequestTrackInput {
  /** Every task that may answer a request, fanout shards included. */
  tasks: readonly Task[];
  /** Requests derived for tasks recorded before `requestRef` was stamped. */
  derivedRefs?: ReadonlyMap<string, TaskRequestRef>;
  /** The threads requests were written in, and threads with a turn running. */
  threads: ReadonlyMap<string, RequestThread>;
  inflight: readonly ActivityTurn[];
  waiting: readonly TaskWaitState[];
  questions: readonly Question[];
  /** Who the person hears from for a project; presentation only. */
  leadOf: (projectId: string) => string | undefined;
  estimates: DurationEstimates;
  engineOf?: (task: Task) => EtaEngine | undefined;
  now: number;
}

const STOPS: readonly RequestStop[] = ['got-it', 'making', 'checking', 'ready'];
const STAGE_STOP = { intake: 'got-it', make: 'making', check: 'checking' } as const;

function furthest(a: RequestStop, b: RequestStop): RequestStop {
  return STOPS.indexOf(a) >= STOPS.indexOf(b) ? a : b;
}

/** The furthest stop a task's steps have reached: done steps, and the one under way. */
function taskStop(task: Task): RequestStop {
  if (taskEffectiveStatus(task) === 'complete') return 'ready';
  const stages = craftbookStepStages(task.craftbook.steps);
  let stop: RequestStop = 'got-it';
  for (const step of task.craftbook.steps) {
    if (step.completedAt || step.id === task.activeStepId) {
      stop = furthest(stop, STAGE_STOP[stages.get(step.id) ?? 'make']);
    }
  }
  return stop;
}

const WAIT_LINES: Readonly<Record<TaskWaitState['reason'], string>> = {
  dispatching: 'is about to start',
  'provider-busy': 'is waiting for the model to be free',
  'night-shift': 'will start tonight',
  'night-quota': 'is waiting for cloud time to free up',
  'engagement-off': 'is waiting: AI work is off in Settings',
  'engagement-paused': 'is waiting while automatic work is paused',
  queued: 'is about to start',
};

const HOLD_LINES = {
  behind: 'is waiting for another chat to finish',
  yielding: 'is letting another chat go first',
} as const;

function summaryOf(text: string | undefined, fallback: string): string {
  const line = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!line) return fallback;
  return line.length > 140 ? `${line.slice(0, 139).trimEnd()}…` : line;
}

function personMessageFor(
  thread: RequestThread | undefined,
  ref: Pick<TaskRequestRef, 'at' | 'messageId'>,
) {
  return thread?.messages.find(
    (m) => m.role === 'user' && (ref.messageId ? m.id === ref.messageId : m.at === ref.at),
  );
}

function stepGezels(task: Task): string[] {
  const ids = task.craftbook.steps.flatMap((step) =>
    step.assignee?.kind === 'gezel'
      ? [step.assignee.gezelId]
      : step.suggestedGezelId
        ? [step.suggestedGezelId]
        : [],
  );
  if (task.assignee.kind === 'gezel') ids.push(task.assignee.gezelId);
  return ids;
}

/** The newest wrap-up in `thread` for one of `refs`: the file the person gets, and who made it. */
function wrapUpFor(thread: RequestThread | undefined, refs: ReadonlySet<string>) {
  if (!thread) return undefined;
  for (let i = thread.messages.length - 1; i >= 0; i--) {
    const m = thread.messages[i]!;
    if (m.synthetic !== 'task-wrapup' || !m.referencedTasks?.some((r) => refs.has(r))) continue;
    return m;
  }
  return undefined;
}

/**
 * Every request the input knows about, newest first: one per person message
 * with work on it, plus one per reply still being written that has no work
 * yet. Pure; `assembleRequestTracks` gathers the input on either host.
 */
export function resolveRequestTracks(input: RequestTrackInput): RequestTrack[] {
  const refOf = (task: Task) => task.requestRef ?? input.derivedRefs?.get(task.ref);
  const groups = new Map<string, { ref: TaskRequestRef; tasks: Task[] }>();
  for (const task of input.tasks) {
    const ref = refOf(task);
    if (!ref) continue;
    const key = requestKey(ref);
    const group = groups.get(key) ?? { ref, tasks: [] };
    group.tasks.push(task);
    groups.set(key, group);
  }

  const pendingQuestions = input.questions.filter((q) => !q.answer && !isReadyQuestion(q));
  const turnsBySession = new Map(input.inflight.map((turn) => [turn.sessionId, turn]));
  const out: RequestTrack[] = [];

  for (const [key, { ref, tasks }] of groups) {
    const refs = new Set(tasks.map((t) => t.ref));
    const primaries = tasks.filter((t) => !t.parentTaskRef || !refs.has(t.parentTaskRef));
    const shards = tasks.filter((t) => !primaries.includes(t));
    const thread = input.threads.get(ref.sessionId);
    const asked = personMessageFor(thread, ref);
    const live = primaries.filter((t) => {
      const status = taskEffectiveStatus(t);
      return status === 'active' || status === 'draft';
    });
    const current =
      live.sort(
        (a, b) =>
          Date.parse(activeStepOf(b)?.lastActivatedAt ?? b.createdAt) -
          Date.parse(activeStepOf(a)?.lastActivatedAt ?? a.createdAt),
      )[0] ?? primaries.at(-1)!;
    // A canceled duplicate does not hold back the task that finished.
    const kept = primaries.filter((t) => taskEffectiveStatus(t) !== 'canceled');
    const allDone = kept.length > 0 && kept.every((t) => taskEffectiveStatus(t) === 'complete');
    const allStopped = kept.length === 0;
    const lead =
      input.leadOf(current.projectId) ??
      (current.assignee.kind === 'gezel' ? current.assignee.gezelId : undefined) ??
      thread?.gezelId;

    const stop = allDone ? 'ready' : primaries.map(taskStop).reduce(furthest, 'got-it');

    const turns = input.inflight.filter((turn) => turn.taskRef && refs.has(turn.taskRef));
    const waits = input.waiting.filter((wait) => refs.has(wait.ref));
    const questions = pendingQuestions.filter(
      (q) => (q.taskRef && refs.has(q.taskRef)) || turns.some((t) => t.sessionId === q.sessionId),
    );
    const threadTurn = turnsBySession.get(ref.sessionId);
    const newerAsk = thread?.messages.some((m) => m.at > ref.at && isPersonMessage(m, thread));
    const trailing = allDone && threadTurn !== undefined && !newerAsk;
    const held = turns.find((turn) => turn.engineHold)?.engineHold;

    let state: RequestState;
    // Finished work is Ready even with a question still open: the wrap-up
    // passes the maker's question on, and the work it asked about is done.
    if (allDone) state = 'ready';
    else if (questions.length > 0) state = 'needs-you';
    else if (allStopped) state = 'stopped';
    else if (kept.some((t) => ['paused', 'draft'].includes(taskEffectiveStatus(t)))) {
      state = 'needs-you';
    } else if (turns.length > 0) state = held ? 'waiting' : 'working';
    else if (waits.some((w) => w.reason === 'dispatching')) state = 'working';
    else state = 'waiting';

    const active = activeStepOf(current);
    const stage = active ? craftbookStepStages(current.craftbook.steps).get(active.id) : undefined;
    const promised = taskDeliverableCandidates(current)[0];
    const noun = promised ? deliverableFormatNoun(promised.path) : undefined;
    let doing: string | undefined;
    if (state === 'ready') doing = trailing ? 'is wrapping up' : undefined;
    else if (state === 'stopped') doing = 'stopped working on this';
    else if (state === 'needs-you')
      doing =
        questions.length > 0
          ? 'has a question for you'
          : kept.some((t) => taskEffectiveStatus(t) === 'draft')
            ? 'is waiting for you to start it'
            : 'is waiting for you to go on';
    else if (held) doing = HOLD_LINES[held];
    else if (state === 'waiting') {
      const wait = waits[0];
      doing = wait ? WAIT_LINES[wait.reason] : 'is about to start';
    } else if (active)
      doing = `is ${stepPersonLabel(active, stage ?? 'make', noun ? { noun } : {})}`;
    else doing = 'is working on it';

    // Where it is running decides which medians fit: a live turn says.
    const runningOn = turns.find((turn) => turn.providerName)?.providerName;
    const engine =
      input.engineOf?.(current) ??
      (runningOn ? (isLocalProvider(runningOn) ? 'device' : 'cloud') : undefined);
    const estimate =
      state === 'working' || (state === 'waiting' && !waits.some((w) => w.reason === 'night-shift'))
        ? estimateRemaining(current, input.estimates, {
            now: input.now,
            ...(engine ? { engine } : {}),
          })
        : null;

    const wrapUp = allDone ? wrapUpFor(thread, refs) : undefined;
    const fallback: TaskDeliverable | undefined =
      allDone && promised ? { ...promised, projectId: current.projectId } : undefined;
    const deliverable = wrapUp?.deliverable ?? fallback;
    const assignee = active ? taskActiveAssignee(current) : undefined;
    const crew = [...new Set(tasks.flatMap(stepGezels))].filter((id) => id !== lead);
    const liveSessionIds = [
      ...new Set([
        ...turns.map((t) => t.sessionId),
        ...waits.flatMap((w) => (w.sessionId ? [w.sessionId] : [])),
        ...(trailing ? [ref.sessionId] : []),
      ]),
    ];

    out.push({
      key,
      sessionId: ref.sessionId,
      projectId: thread?.projectId ?? current.projectId,
      at: ref.at,
      ...(ref.messageId ? { messageId: ref.messageId } : {}),
      summary: summaryOf(asked?.content, current.title),
      kind: 'work',
      ...(lead ? { leadGezelId: lead } : {}),
      stop,
      state,
      ...(doing ? { line: { ...(lead ? { gezelId: lead } : {}), doing } } : {}),
      actual: {
        taskRef: current.ref,
        ...(assignee?.kind === 'gezel' ? { gezelId: assignee.gezelId } : {}),
        ...(active ? { stepId: active.id, stepName: active.name } : {}),
      },
      ...(estimate ? { eta: { ...estimate, text: remainingText(estimate) } } : {}),
      taskRefs: [...primaries, ...shards].map((t) => t.ref),
      ...(shards.length > 0
        ? {
            parts: {
              done: shards.filter((t) => taskEffectiveStatus(t) === 'complete').length,
              total: shards.length,
            },
          }
        : {}),
      liveSessionIds,
      crew,
      ...(deliverable ? { deliverable } : {}),
      ...(wrapUp?.makerGezelId ? { makerGezelId: wrapUp.makerGezelId } : {}),
      ...(trailing ? { trailing: true } : {}),
      questionIds: questions.map((q) => q.id),
    });
  }

  // A reply still being written to a person, with no work started for it yet:
  // the person sees "Got it" from the moment they press Send.
  for (const turn of input.inflight) {
    if (turn.taskRef) continue;
    const thread = input.threads.get(turn.sessionId);
    if (!thread || thread.taskRef) continue;
    const asked = latestPersonMessage(thread, new Date(turn.startedAt).toISOString());
    if (!asked) continue;
    const key = requestKey({ sessionId: thread.id, at: asked.at });
    if (groups.has(key)) continue;
    out.push({
      key,
      sessionId: thread.id,
      projectId: thread.projectId,
      at: asked.at,
      ...(asked.id ? { messageId: asked.id } : {}),
      summary: summaryOf(asked.content, 'Your message'),
      kind: 'conversation',
      leadGezelId: thread.gezelId,
      stop: 'got-it',
      state: turn.engineHold ? 'waiting' : 'working',
      line: {
        gezelId: thread.gezelId,
        doing: turn.engineHold ? HOLD_LINES[turn.engineHold] : 'is looking into it',
      },
      taskRefs: [],
      liveSessionIds: [thread.id],
      crew: [],
      questionIds: [],
    });
  }

  return out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

function activeStepOf(task: Task) {
  return task.craftbook.steps.find((step) => step.id === task.activeStepId);
}

/** Where `assembleRequestTracks` reads; both hosts' stores fit it. */
export interface RequestTrackSources {
  tasks: readonly Task[];
  session: (id: string) => Promise<RequestThread | null>;
  project: (id: string) => Promise<{ id: string; voormanGezelId?: string } | null>;
  meesterGezelId?: string;
  inflight: readonly ActivityTurn[];
  waiting: readonly TaskWaitState[];
  questions: readonly Question[];
  estimates: DurationEstimates;
  engineOf?: (task: Task) => EtaEngine | undefined;
  now: number;
}

/** Older tasks are worth deriving a request for only while someone may still look at it. */
const DERIVE_WINDOW_MS = 14 * 24 * 60 * 60_000;

/**
 * Gather what {@link resolveRequestTracks} needs and resolve it. `sessions`
 * keeps the requests written in those threads; `live` keeps only requests
 * still under way (or wrapping up).
 */
export async function assembleRequestTracks(
  src: RequestTrackSources,
  filter: { sessions?: readonly string[]; live?: boolean } = {},
): Promise<RequestTrack[]> {
  const sessionCache = new Map<string, Promise<RequestThread | null>>();
  const session = (id: string) => {
    let pending = sessionCache.get(id);
    if (!pending) {
      pending = src.session(id).catch(() => null);
      sessionCache.set(id, pending);
    }
    return pending;
  };
  const byRef = new Map(src.tasks.map((task) => [task.ref, task]));
  const derivedRefs = new Map<string, TaskRequestRef>();
  for (const task of src.tasks) {
    if (task.requestRef || (!task.launchSessionId && !task.parentTaskRef)) continue;
    const recent = src.now - Date.parse(task.updatedAt) < DERIVE_WINDOW_MS;
    if (!recent && taskEffectiveStatus(task) !== 'active') continue;
    const ref = await deriveTaskRequestRef(task, {
      task: async (taskRef) => byRef.get(taskRef) ?? null,
      session,
    });
    if (ref) derivedRefs.set(task.ref, ref);
  }

  const wanted = filter.sessions ? new Set(filter.sessions) : undefined;
  const refFor = (task: Task) => task.requestRef ?? derivedRefs.get(task.ref);
  const tasks = src.tasks.filter((task) => {
    const ref = refFor(task);
    return ref !== undefined && (!wanted || wanted.has(ref.sessionId));
  });
  const threadIds = new Set([
    ...tasks.map((task) => refFor(task)!.sessionId),
    ...src.inflight
      .filter((turn) => !turn.taskRef && (!wanted || wanted.has(turn.sessionId)))
      .map((turn) => turn.sessionId),
  ]);
  const threads = new Map<string, RequestThread>();
  for (const id of threadIds) {
    const thread = await session(id);
    if (thread) threads.set(id, thread);
  }
  const projects = new Map<string, { id: string; voormanGezelId?: string } | null>();
  for (const projectId of new Set(tasks.map((task) => task.projectId))) {
    projects.set(projectId, await src.project(projectId).catch(() => null));
  }

  const tracks = resolveRequestTracks({
    tasks,
    derivedRefs,
    threads,
    inflight: src.inflight,
    waiting: src.waiting,
    questions: src.questions,
    leadOf: (projectId) => {
      const project = projects.get(projectId);
      return project ? projectLeadGezelId(project, src.meesterGezelId) : undefined;
    },
    estimates: src.estimates,
    ...(src.engineOf ? { engineOf: src.engineOf } : {}),
    now: src.now,
  });
  return filter.live ? tracks.filter((track) => track.state !== 'ready' || track.trailing) : tracks;
}
