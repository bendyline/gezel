/** Noninteractive craftbook invocation and task observation for shell pipelines. */
import type { Craftbook, Task } from '@bendyline/gezel';
import { AwakeBudget } from '@bendyline/gezel';
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

export function parseCraftbookParams(book: Pick<Craftbook, 'paramSchema'>, tokens: string[]) {
  const schema = book.paramSchema ?? {};
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const keys = Object.keys(properties);
  const params: Record<string, string> = {};
  for (const token of tokens) {
    const match = /^([A-Za-z][\w.-]*)=([\s\S]*)$/.exec(token);
    const key = match?.[1] ?? keys.find((name) => !Object.hasOwn(params, name));
    if (!key || !Object.hasOwn(properties, key))
      throw new CliError(`unknown craftbook argument: ${token}`);
    if (Object.hasOwn(params, key)) throw new CliError(`duplicate craftbook parameter: ${key}`);
    const value = match ? match[2]! : token;
    const def = properties[key]!;
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
    params[key] = value;
  }
  for (const key of Array.isArray(schema.required) ? schema.required : []) {
    if (
      typeof key === 'string' &&
      !Object.hasOwn(params, key) &&
      properties[key]?.default === undefined
    )
      throw new CliError(`missing required craftbook parameter: ${key}`);
  }
  // Defaults, especially {{task.dir}}, belong to the server after task allocation.
  return params;
}

export interface TaskWaitResult {
  task: Task;
  outcome: 'complete' | 'blocked' | 'canceled' | 'timeout';
  exitCode: number;
  questionIds?: string[];
}

export async function waitForTask(
  client: Pick<GezelClient, 'getTaskByRef' | 'listTaskChildren'> &
    Partial<Pick<GezelClient, 'listQuestions'>>,
  ref: string,
  options: { timeoutMs: number; pollMs?: number; onProgress?: (task: Task) => void },
): Promise<TaskWaitResult> {
  const budget = new AwakeBudget(options.timeoutMs);
  let previous = '';
  for (;;) {
    const task = await client.getTaskByRef(ref);
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
      const { tasks } = await client.listTaskChildren(task.projectId, task.num);
      if (
        !task.craftbook.cliWorkflow &&
        !tasks.some((child) => child.status === 'active') &&
        tasks.some((child) => child.status === 'paused' || child.status === 'canceled')
      )
        return { task, outcome: 'blocked', exitCode: 2 };
      if (!task.craftbook.cliWorkflow) for (const child of tasks) refs.add(child.ref);
    }
    if (client.listQuestions) {
      const { questions } = await client.listQuestions({
        projectId: task.projectId,
        pending: true,
      });
      const questionIds = questions
        .filter((q) => q.taskRef && refs.has(q.taskRef))
        .map((q) => q.id);
      if (questionIds.length) return { task, outcome: 'blocked', exitCode: 2, questionIds };
    }
    if (budget.expired()) return { task, outcome: 'timeout', exitCode: 3 };
    await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 1000));
  }
}
