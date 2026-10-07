/**
 * Noninteractive craftbook invocation and task observation for shell pipelines.
 * Task observation retries only transient read failures, within the caller's
 * original awake-time budget. It never changes task state or retries dispatch.
 */
import { setTimeout as delay } from 'node:timers/promises';
import type { Craftbook, Task } from '@bendyline/gezel';
import {
  type AwakeBudget,
  composeCraftbookLaunch,
  createAwakeTimeout,
  paramAsksUser,
} from '@bendyline/gezel';
import type { GezelClient } from '@bendyline/gezel-client';
import { CliError } from './connection.js';
import { type StartCraftbook, findCraftbook } from './tui/craftbook-start.js';

/** Longest matching name preserves `do Code Review` while permitting trailing arguments. */
export function resolveCraftbookInvocation(books: StartCraftbook[], tokens: string[]) {
  for (let length = tokens.length; length > 0; length--) {
    const book = findCraftbook(books, tokens.slice(0, length).join(' '));
    if (book) return { book, args: tokens.slice(length) };
  }
  throw new CliError(`craftbook not found: ${tokens.join(' ')}`);
}

const NAMED_ARGUMENT = /^([A-Za-z][\w.-]*)=([\s\S]*)$/;

function checkParamValue(key: string, def: Record<string, unknown>, value: string) {
  if (Array.isArray(def.enum) && !def.enum.map(String).includes(value)) {
    throw new CliError(`${key} must be one of: ${def.enum.join(', ')}`);
  }
  if (def.type === 'boolean' && !['true', 'false'].includes(value))
    throw new CliError(`${key} must be true or false`);
  if (def.type === 'number' || def.type === 'integer') {
    const number = Number(value);
    if (
      !value.trim() ||
      !Number.isFinite(number) ||
      (def.type === 'integer' && !Number.isInteger(number))
    )
      throw new CliError(`${key} must be a ${def.type}`);
    if (typeof def.minimum === 'number' && number < def.minimum)
      throw new CliError(`${key} must be at least ${def.minimum}`);
    if (typeof def.maximum === 'number' && number > def.maximum)
      throw new CliError(`${key} must be at most ${def.maximum}`);
  }
  if (typeof def.pattern === 'string' && !new RegExp(def.pattern).test(value))
    throw new CliError(`${key} must match ${def.pattern}`);
  if (typeof def.minLength === 'number' && value.trim().length < def.minLength)
    throw new CliError(`${key} is too short`);
}

export interface CraftbookArguments {
  params: Record<string, string>;
  /**
   * The bare words no required parameter took, joined: the person's request.
   * `composeCraftbookLaunch` makes it the task description and, when the
   * book declares one, its main content parameter.
   */
  request?: string;
}

/**
 * Split `gezel do` arguments into parameters and a request. `key=value` (or
 * `--param key=value`, passed as `named`) sets any declared parameter,
 * including ones a launch form never shows. A bare word fills the next
 * required parameter a person is asked for that has no default, in
 * declaration order: what a book cannot start without, such as a branch or a
 * source file. Every other bare word belongs to the request.
 *
 * Bare words used to fill parameters in declaration order regardless. In 257
 * of 296 bundled books the first was the runtime-owned `workPath`, so
 * `gezel do summarize-long "Summarize notes.txt"` named the artifacts folder
 * after the sentence, and the request itself reached the task nowhere.
 */
export function parseCraftbookArguments(
  book: Pick<Craftbook, 'paramSchema'>,
  tokens: string[],
  named: string[] = [],
): CraftbookArguments {
  const schema = book.paramSchema ?? {};
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const slots = Object.keys(properties).filter(
    (key) =>
      required.has(key) &&
      properties[key]!.default === undefined &&
      paramAsksUser(properties[key], key),
  );
  const params: Record<string, string> = {};
  const requestWords: string[] = [];
  const set = (key: string, value: string, token: string) => {
    if (!Object.hasOwn(properties, key)) throw new CliError(`unknown craftbook argument: ${token}`);
    if (Object.hasOwn(params, key)) throw new CliError(`duplicate craftbook parameter: ${key}`);
    checkParamValue(key, properties[key]!, value);
    params[key] = value;
  };

  for (const token of tokens) {
    const match = NAMED_ARGUMENT.exec(token);
    if (match) {
      set(match[1]!, match[2]!, token);
      continue;
    }
    const slot = slots.find((key) => !Object.hasOwn(params, key));
    if (slot) set(slot, token, token);
    else requestWords.push(token);
  }
  for (const token of named) {
    const match = NAMED_ARGUMENT.exec(token);
    if (!match) throw new CliError(`--param expects key=value: ${token}`);
    set(match[1]!, match[2]!, token);
  }
  for (const key of required) {
    if (
      typeof key === 'string' &&
      !Object.hasOwn(params, key) &&
      properties[key]?.default === undefined
    )
      throw new CliError(`missing required craftbook parameter: ${key}`);
  }
  // Defaults, especially {{task.dir}}, belong to the server after task allocation.
  const request = requestWords.join(' ').trim();
  return request ? { params, request } : { params };
}

/**
 * The task fields `gezel do` lays over the book's start request. A request
 * goes through the launch composition every other surface uses, so it reads
 * the same here as from the chat composer.
 */
export function craftbookDoLaunch(
  craftbook: Pick<Craftbook, 'name' | 'paramSchema'>,
  { params, request }: CraftbookArguments,
): { description?: string; craftbookParams: Record<string, string> } {
  if (!request) return { craftbookParams: params };
  const launch = composeCraftbookLaunch({
    message: request,
    craftbookName: craftbook.name,
    paramSchema: craftbook.paramSchema,
    params,
  });
  return { description: launch.description, craftbookParams: launch.params };
}

export interface TaskWaitResult {
  task: Task;
  outcome: 'complete' | 'blocked' | 'canceled' | 'timeout';
  exitCode: number;
  questionIds?: string[];
}

const READ_RETRY_DELAYS = [250, 750, 1500];

function transientTaskReadError(error: unknown): boolean {
  const codes =
    /ECONNRESET|ECONNREFUSED|ECONNABORTED|EPIPE|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|UND_ERR_(?:SOCKET|CONNECT_TIMEOUT)|NGHTTP2_ENHANCE_YOUR_CALM|Connect Timeout Error|socket hang up|other side closed/;
  // Root and Node package entries can carry distinct bundled error classes.
  // Match the public error shape while keeping HTTP/auth and TLS failures fatal.
  if (error instanceof Error && error.name === 'GezelApiError') {
    const apiError = error as Error & {
      status?: number;
      details?: { kind?: string; cause?: unknown; readRetryExhausted?: boolean };
    };
    return (
      apiError.status === 0 &&
      apiError.details?.kind === 'transport' &&
      apiError.details.readRetryExhausted !== true &&
      typeof apiError.details.cause === 'string' &&
      codes.test(apiError.details.cause)
    );
  }
  // fetch may fail while consuming a successful response body, after headers.
  return (
    error instanceof TypeError &&
    error.cause instanceof Error &&
    codes.test(`${(error.cause as Error & { code?: string }).code ?? ''} ${error.cause.message}`)
  );
}

async function readTaskObservation<T>(
  read: () => Promise<T>,
  budget: AwakeBudget,
  signal: AbortSignal,
): Promise<T> {
  for (let retries = 0; ; retries++) {
    signal.throwIfAborted();
    // The budget bounds retries, never the first attempt: a wait whose budget
    // lapsed before any read would otherwise throw instead of reporting the
    // task as timed out. `Date.now()` ticks in whole milliseconds, so a 1 ms
    // budget lapses about 1% of the time before the first read even starts.
    if (retries > 0 && budget.expired()) throw new CliError('Task observation timed out.');
    try {
      return await read();
    } catch (error) {
      signal.throwIfAborted();
      if (!transientTaskReadError(error) || retries >= READ_RETRY_DELAYS.length || budget.expired())
        throw error;
      await sleepWithinBudget(READ_RETRY_DELAYS[retries]!, budget, signal);
    }
  }
}

/**
 * A backoff the budget cannot hold ends only once the budget reads spent.
 * Linux timers can resolve a millisecond before `Date.now()` agrees the time
 * has passed, and a clamped sleep that wakes that tick early would buy one
 * more read the budget had already ruled out.
 */
async function sleepWithinBudget(
  backoffMs: number,
  budget: AwakeBudget,
  signal: AbortSignal,
): Promise<void> {
  if (budget.remainingMs() > backoffMs) {
    await delay(backoffMs, undefined, { signal });
    return;
  }
  while (!budget.expired()) {
    await delay(Math.max(1, budget.remainingMs()), undefined, { signal });
  }
}

export async function waitForTask(
  client: Pick<GezelClient, 'getTaskByRef' | 'listTaskChildren'> &
    Partial<Pick<GezelClient, 'listQuestions'>>,
  ref: string,
  options: {
    timeoutMs: number;
    pollMs?: number;
    onProgress?: (task: Task) => void;
    signal?: AbortSignal;
  },
): Promise<TaskWaitResult> {
  const timeout = createAwakeTimeout(options.timeoutMs, { pollMs: 100 });
  const budget = timeout.budget;
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeout.signal])
    : timeout.signal;
  let previous = '';
  let lastTask: Task | undefined;
  const read = <T>(operation: () => Promise<T>) => readTaskObservation(operation, budget, signal);
  try {
    for (;;) {
      const task = await read(() => client.getTaskByRef(ref, signal));
      lastTask = task;
      const progress = `${task.status}:${task.activeStepId}`;
      if (progress !== previous) {
        options.onProgress?.(task);
        previous = progress;
      }
      if (task.status === 'complete') return { task, outcome: 'complete', exitCode: 0 };
      if (task.status === 'canceled') return { task, outcome: 'canceled', exitCode: 1 };
      if (task.status === 'paused' || task.status === 'draft')
        return { task, outcome: 'blocked', exitCode: 2 };
      // CLI workflow drivers own partial-failure policy and set the parent's
      // status themselves. A paused article must not stop watching other work.
      const refs = new Set([task.ref]);
      if (task.fanout || task.craftbook.spawn || task.craftbook.cliWorkflow) {
        const { tasks } = await read(() =>
          client.listTaskChildren(task.projectId, task.num, undefined, signal),
        );
        if (
          !task.craftbook.cliWorkflow &&
          !tasks.some((child) => child.status === 'active') &&
          tasks.some((child) => child.status === 'paused' || child.status === 'canceled')
        )
          return { task, outcome: 'blocked', exitCode: 2 };
        if (!task.craftbook.cliWorkflow) for (const child of tasks) refs.add(child.ref);
      }
      if (client.listQuestions) {
        const { questions } = await read(() =>
          client.listQuestions!(
            {
              projectId: task.projectId,
              pending: true,
            },
            signal,
          ),
        );
        const questionIds = questions
          .filter(
            (q) =>
              q.taskRef &&
              refs.has(q.taskRef) &&
              // A service pause card is a historical notification. Actual task
              // status above decides whether it is still paused; real session
              // questions and permissions must continue to block observation.
              !(q.sessionId === '' && q.intent?.kind === 'task-paused'),
          )
          .map((q) => q.id);
        if (questionIds.length) return { task, outcome: 'blocked', exitCode: 2, questionIds };
      }
      if (budget.expired()) return { task, outcome: 'timeout', exitCode: 3 };
      await delay(Math.min(options.pollMs ?? 1000, budget.remainingMs()), undefined, { signal });
    }
  } catch (error) {
    options.signal?.throwIfAborted();
    if (budget.expired() && lastTask) return { task: lastTask, outcome: 'timeout', exitCode: 3 };
    throw error;
  } finally {
    timeout.dispose();
  }
}
