/**
 * Noninteractive craftbook invocation and task observation for shell pipelines.
 * Task observation retries only transient read failures, within the caller's
 * original awake-time budget. It never changes task state or retries dispatch.
 */
import { setTimeout as delay } from 'node:timers/promises';
import type { Craftbook, Task } from '@bendyline/gezel';
import {
  type AwakeBudget,
  PROJECT_EDITS_CLI_COMMAND,
  composeCraftbookLaunch,
  createAwakeTimeout,
  isRuntimeTemplateDefault,
  paramAsksUser,
  paramInputSpec,
  projectManagedWorkspaceWritable,
  stepWorkspaceDeliverableFiles,
} from '@bendyline/gezel';
import type { GezelClient } from '@bendyline/gezel-client';
import { CliError } from './connection.js';
import type { SetupPrompter } from './craftbook-setup.js';
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

/**
 * The parameters bare words fill, in order: required, without a default, and
 * asked of a person. `gezel craftbook show` prints the same list, so the
 * usage line it shows is the one the parser accepts.
 */
export function craftbookBareSlots(book: Pick<Craftbook, 'paramSchema'>): string[] {
  const schema = book.paramSchema ?? {};
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  return Object.keys(properties).filter(
    (key) =>
      required.has(key) &&
      properties[key]!.default === undefined &&
      paramAsksUser(properties[key], key),
  );
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
  const slots = craftbookBareSlots(book);
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

/** Every file the book's steps save into the project folder itself, in step order. */
export function craftbookFolderFiles(craftbook: Pick<Craftbook, 'steps'>): string[] {
  const files = new Set<string>();
  for (const step of craftbook.steps ?? []) {
    for (const file of stepWorkspaceDeliverableFiles(step)) files.add(file);
  }
  return [...files];
}

/** `summary.md`, `index.html and 2 more files`, or `its results` when every name is a template. */
function nameFolderFiles(files: readonly string[]): string {
  const named = files.filter((file) => !isRuntimeTemplateDefault(file));
  if (named.length === 0) return 'its results';
  const rest = files.length - 1;
  return rest === 0 ? named[0]! : `${named[0]} and ${rest} more file${rest === 1 ? '' : 's'}`;
}

export type ProjectEditsClient = Pick<GezelClient, 'getProject' | 'updateProject'>;

/**
 * Before a book that saves into the project folder starts in a folder Gezel
 * may not change, say so, and let the person allow it: `--allow-edits` in a
 * script, a question at a terminal. The desktop asks the same thing in its
 * confirmation dialog; the command line used to start the task and let it
 * pause a minute later with a fix that named a desktop setting (2026-11-10).
 *
 * Never refuses. A book whose files already exist can pass on their contents
 * alone, and only the service can tell, so a "no" starts the task anyway and
 * the pause, if it comes, names the command.
 */
export async function ensureProjectEdits(
  client: ProjectEditsClient,
  options: {
    projectId: string;
    craftbook: Pick<Craftbook, 'name' | 'steps'>;
    /** `--allow-edits`: the person already said yes on the command line. */
    allow: boolean;
    prompter: SetupPrompter | null;
    write: (text: string) => void;
  },
): Promise<void> {
  const files = craftbookFolderFiles(options.craftbook);
  if (files.length === 0) return;
  const project = await client.getProject(options.projectId);
  if (projectManagedWorkspaceWritable(project)) return;
  const what = nameFolderFiles(files);
  const where = project.workingDir ?? 'this project';
  const turnOn = async () => {
    await client.updateProject(options.projectId, { managedWorkspaceWritePolicy: 'allow' });
  };
  if (options.allow) {
    await turnOn();
    options.write(`Gezel may now change files in ${where} (--allow-edits).\n`);
    return;
  }
  const saves = `${options.craftbook.name} saves ${what} into ${where}, and Gezel may not change files there yet.`;
  if (options.prompter) {
    if (await options.prompter.confirm(`${saves} Allow it? [y/N] `)) {
      await turnOn();
      options.write('Project edits: on\n');
      return;
    }
  }
  options.write(
    `${saves} If it stops for that, run \`${PROJECT_EDITS_CLI_COMMAND}\` here, or start it with --allow-edits.\n`,
  );
}

/**
 * A launch the service refused because an input parameter names nothing in
 * the project, as advice. The usual cause is a request sentence landing in
 * the input's slot: `gezel do meeting-notes-to-actions "Turn notes.txt into
 * actions"` answered `"Turn notes.txt into actions" does not exist in this
 * project` and a line about a 422. Returns null for any other failure.
 */
export function taskInputFailure(
  err: unknown,
  book: Pick<StartCraftbook, 'command' | 'name'>,
  params: Readonly<Record<string, string>>,
): CliError | null {
  if (!(err instanceof Error) || err.name !== 'GezelApiError') return null;
  const details = (err as Error & { details?: unknown }).details;
  if (!details || typeof details !== 'object') return null;
  const { code, param, error } = details as { code?: unknown; param?: unknown; error?: unknown };
  if (code !== 'task-input' || typeof param !== 'string') return null;
  const value = params[param];
  const lines = [
    `${book.name} did not start: ${typeof error === 'string' ? error : `${param} is not usable.`}`,
  ];
  if (value && /\s/.test(value.trim())) {
    lines.push(
      `It read "${value}" as ${param}, which comes before your request:`,
      `  gezel do ${book.command} <${param}> "your request"`,
    );
  }
  lines.push(`\`gezel craftbook show ${book.command}\` lists what it takes.`);
  return new CliError(lines.join('\n'));
}

function firstParagraph(text: string | undefined): string {
  return (
    (text ?? '')
      .split(/\n\s*\n/)[0]
      ?.replace(/\s+/g, ' ')
      .trim() ?? ''
  );
}

/** What one parameter accepts, in a few words: `a folder in this project`, `one of: a, b`, `a number`. */
function paramAccepts(property: Record<string, unknown>): string {
  const input = paramInputSpec(property);
  if (input) {
    const kinds = input.accept ? ` (${input.accept.join(', ')})` : '';
    return input.kind === 'folder'
      ? 'a folder or file in this project'
      : `a file in this project${kinds}`;
  }
  if (Array.isArray(property.enum)) return `one of: ${property.enum.map(String).join(', ')}`;
  if (property.type === 'boolean') return 'true or false';
  if (property.type === 'number' || property.type === 'integer') return 'a number';
  return 'text';
}

/**
 * `gezel craftbook show <command>`: what a book does, what it takes, and the
 * command that starts it. Parameters Gezel fills itself (the task folder)
 * are left out, like every launch form does.
 */
export function describeCraftbook(
  book: Pick<StartCraftbook, 'command' | 'name'>,
  craftbook: Pick<Craftbook, 'description' | 'paramSchema' | 'steps'>,
): string {
  const schema = craftbook.paramSchema ?? {};
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const slots = craftbookBareSlots(craftbook);
  const asked = Object.keys(properties).filter((key) => paramAsksUser(properties[key], key));
  const lines = [`${book.command} — ${book.name}`];
  const about = firstParagraph(craftbook.description);
  if (about) lines.push(about);

  lines.push('', 'Start it:');
  lines.push(
    `  gezel do ${[book.command, ...slots.map((key) => `<${key}>`)].join(' ')} "your request"`,
  );

  if (asked.length > 0) {
    const width = Math.max(...asked.map((key) => key.length));
    lines.push('', 'Takes:');
    for (const key of asked) {
      const property = properties[key]!;
      const need = required.has(key) && property.default === undefined ? 'required' : 'optional';
      const fallback =
        property.default !== undefined && !isRuntimeTemplateDefault(property.default)
          ? `, default ${String(property.default)}`
          : '';
      const note = firstParagraph(
        typeof property.title === 'string'
          ? property.title
          : typeof property.description === 'string'
            ? property.description
            : '',
      );
      lines.push(
        `  ${key.padEnd(width)}  ${need}, ${paramAccepts(property)}${fallback}${note ? ` — ${note}` : ''}`,
      );
    }
    const named = asked.filter((key) => !slots.includes(key));
    if (named.length > 0)
      lines.push(`Set the optional ones by name, for example ${named[0]}=value.`);
  }

  const files = craftbookFolderFiles(craftbook);
  lines.push(
    '',
    files.length > 0
      ? `Saves ${nameFolderFiles(files)} into the project folder, so the project must allow edits (\`${PROJECT_EDITS_CLI_COMMAND}\`, or --allow-edits).`
      : "Saves its results in the task's own folder; add --out <dir> to copy them out.",
  );
  return lines.join('\n');
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
        // Server-side task filter: the whole pending list once reached
        // 4,600 cards, downloaded every second by each observer.
        const { questions } = await read(() =>
          client.listQuestions!(
            {
              projectId: task.projectId,
              pending: true,
              taskRefs: [...refs],
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

/**
 * One line from a task note: its heading and the first sentence after it.
 * Pause notes open with a `#` heading ("Handoff failed — paused for help")
 * and put the cause in the next paragraph.
 */
export function summarizeTaskNote(text: string, maxLength = 240): string {
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  const headingIndex = lines.findIndex((line) => line.startsWith('#'));
  const heading = headingIndex >= 0 ? lines[headingIndex]!.replace(/^#+\s*/, '') : '';
  const body = lines
    .slice(headingIndex + 1)
    .find((line) => line.length > 0 && !line.startsWith('#'));
  const sentence = body?.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? body ?? '';
  const summary = heading && sentence ? `${heading}: ${sentence}` : heading || sentence;
  return summary.length > maxLength ? `${summary.slice(0, maxLength - 1).trimEnd()}…` : summary;
}

/**
 * Why a waited-on task stopped short, for the person at the terminal.
 *
 * WHY: `gezel do --wait` printed only `<ref>: blocked` and exited 2; the reason
 * sat in the task notes and nothing pointed there (2026-10-15 npm audit).
 */
export async function blockedTaskReason(
  client: Pick<GezelClient, 'listTaskNotes'>,
  result: TaskWaitResult,
): Promise<string | undefined> {
  return (await blockedTaskDetails(client, result)).reason;
}

/**
 * Why a waited-on task stopped, and the command that gets it going again
 * when the stop has one. A folder Gezel may not change is the common case:
 * the pause note carries `gezel project edits on`, and the hint repeats it
 * with the resume command, so nobody has to open the notes to find a fix
 * that used to name a desktop setting.
 */
export async function blockedTaskDetails(
  client: Pick<GezelClient, 'listTaskNotes'>,
  result: TaskWaitResult,
): Promise<{ reason?: string; hint?: string }> {
  if (result.outcome !== 'blocked') return {};
  if (result.questionIds?.length) {
    return {
      reason:
        'Gezel is waiting for your answer to a question. Answer it in the Gezel app or the interactive `gezel` terminal.',
    };
  }
  if (result.task.status === 'draft') {
    return { reason: 'The task is still a draft and has not started.' };
  }
  const { notes } = await client
    .listTaskNotes(result.task.projectId, result.task.num)
    .catch(() => ({ notes: [] }));
  const latest = [...notes].sort((a, b) => a.at.localeCompare(b.at)).at(-1);
  if (!latest) return {};
  const reason = summarizeTaskNote(latest.text) || undefined;
  const hint = latest.text.includes(PROJECT_EDITS_CLI_COMMAND)
    ? `Allow it with \`${PROJECT_EDITS_CLI_COMMAND}\` in the project's folder, then continue with \`gezel task resume ${result.task.ref}\`.`
    : undefined;
  return { ...(reason ? { reason } : {}), ...(hint ? { hint } : {}) };
}

/**
 * The craftbooks whose command, title, category or tags contain every word,
 * so `gezel craftbook list deck` finds the presentation books.
 */
export function filterCraftbooks(
  books: readonly StartCraftbook[],
  words: readonly string[],
): StartCraftbook[] {
  const needles = words.map((word) => word.trim().toLowerCase()).filter(Boolean);
  if (needles.length === 0) return [...books];
  return books.filter((book) => {
    const haystack = [book.command, book.name, book.category, ...book.tags].join(' ').toLowerCase();
    return needles.every((needle) => haystack.includes(needle));
  });
}
