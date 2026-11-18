/**
 * The runner's operations over a loaded callable component.
 *
 * `poll` drains a polling trigger: it performs page after page, carrying the
 * trigger's pagination state, until the trigger says it is done or a limit
 * stops it. The trigger's position (its polling state) and an unfinished
 * drain's pagination state go back to the service as the binding's cursor.
 *
 * `list` pages an action: it calls it, feeding each next-page token back,
 * until there is none. Tokens never leave the run; a listing that stops at a
 * limit says it is incomplete.
 */

import { closeSync, openSync, writeSync } from 'node:fs';
import { type RunContext, basePayload, makeRunContext } from './context.js';
import { RunnerError, scrub } from './failure.js';
import type {
  ComponentDescription,
  ConnectionDescription,
  EntityDescription,
  InputDescription,
  RunJob,
  RunResult,
} from './protocol.js';

const CALLABLE_TARGET = Symbol.for('@prismatic-io/spectral/callable-mock/v1');
const MAX_CALL_BYTES = 4 * 1024 * 1024;

type RunWithContext = <T>(context: unknown, fn: () => T) => T;
type Fn = (...args: unknown[]) => unknown;

interface CallableTrigger extends Fn {
  perform: (payload: unknown, values?: Record<string, unknown>) => Promise<{ payload?: unknown }>;
  triggerResolver?: {
    resolveItems?: (result: unknown) => unknown;
    getNextPaginationState?: (result: unknown) => unknown;
  };
  batchConfig?: { batchSize?: number };
  triggerType?: string;
  display?: { label?: string; description?: string };
  inputs?: Record<string, unknown>;
}

export interface CallableComponentLike {
  actions?: Record<string, Fn>;
  triggers?: Record<string, CallableTrigger>;
  dataSources?: Record<string, unknown>;
  connections?: Record<string, unknown>;
}

export interface OpEnv {
  runWithContext: RunWithContext;
  secrets: readonly string[];
  itemsPath: string;
}

/** `$.a.b` against a value; undefined when absent. */
export function jget(value: unknown, path: string): unknown {
  if (path === '$') return value;
  if (!path.startsWith('$.')) throw new RunnerError('input', `not a JSON path: ${path}`);
  let cur: unknown = value;
  for (const part of path.slice(2).split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function itemsAt(value: unknown, paths: readonly string[]): unknown[] {
  const out: unknown[] = [];
  for (const path of paths) {
    const found = jget(value, path);
    if (found === undefined || found === null) continue;
    if (!Array.isArray(found)) {
      throw new RunnerError('component', `expected a list at ${path} but found ${typeof found}`);
    }
    out.push(...found);
  }
  return out;
}

/** Items to `out/items.ndjson`, one JSON value per line, scrubbed. */
class ItemSink {
  count = 0;
  bytes = 0;
  private readonly fd: number;
  constructor(
    path: string,
    private readonly maxItems: number,
    private readonly maxBytes: number,
    private readonly secrets: readonly string[],
  ) {
    this.fd = openSync(path, 'w', 0o600);
  }
  add(items: readonly unknown[]): void {
    for (const item of items) {
      const line = `${scrub(JSON.stringify(item) ?? 'null', this.secrets)}\n`;
      const size = Buffer.byteLength(line);
      // One page is always written whole; the limits are checked between
      // pages. Twice the byte limit is a page no run should hold.
      if (this.bytes + size > this.maxBytes * 2) {
        throw new RunnerError('component', 'one page of results is larger than a run may hold');
      }
      writeSync(this.fd, line);
      this.bytes += size;
      this.count += 1;
    }
  }
  full(): 'items' | 'bytes' | undefined {
    if (this.count >= this.maxItems) return 'items';
    if (this.bytes >= this.maxBytes) return 'bytes';
    return undefined;
  }
  close(): void {
    closeSync(this.fd);
  }
}

function inputsFor(job: RunJob): Record<string, unknown> {
  return {
    ...(job.inputs ?? {}),
    ...(job.connection ? { [job.connection.input]: job.connection.value } : {}),
  };
}

function limitsOf(job: RunJob) {
  return {
    maxPages: job.limits?.maxPages ?? 200,
    maxItems: job.limits?.maxItems ?? 10_000,
    maxBytes: job.limits?.maxBytes ?? 64 * 1024 * 1024,
    deadline: Date.now() + (job.limits?.budgetMs ?? 4 * 60_000),
  };
}

export async function poll(
  component: CallableComponentLike,
  job: RunJob,
  env: OpEnv,
): Promise<RunResult & { op: 'poll' }> {
  const trigger = job.key ? component.triggers?.[job.key] : undefined;
  if (!trigger || typeof trigger.perform !== 'function') {
    throw new RunnerError('input', `the component has no trigger named ${job.key ?? '(none)'}`);
  }
  const batchSize = trigger.batchConfig?.batchSize;
  const run: RunContext = makeRunContext({
    state: job.state,
    ...(batchSize !== undefined ? { batchSize } : {}),
    secrets: env.secrets,
  });
  const limits = limitsOf(job);
  const sink = new ItemSink(env.itemsPath, limits.maxItems, limits.maxBytes, env.secrets);
  const inputs = inputsFor(job);
  const resolver = trigger.triggerResolver;
  let pagination: unknown = job.resume;
  let pages = 0;
  try {
    while (true) {
      const result = await env.runWithContext(run.context, () =>
        trigger.perform(basePayload(pagination), inputs),
      );
      pages += 1;
      const items =
        job.items?.resolver && resolver?.resolveItems
          ? await env.runWithContext(run.context, () => resolver.resolveItems?.(result))
          : itemsAt(result?.payload, job.items?.paths ?? []);
      if (!Array.isArray(items)) {
        throw new RunnerError('component', 'the trigger resolver did not return a list');
      }
      sink.add(items);
      const next = resolver?.getNextPaginationState
        ? await env.runWithContext(run.context, () => resolver.getNextPaginationState?.(result))
        : (result?.payload as { paginationState?: unknown } | undefined)?.paginationState;
      if (next === undefined || next === null) {
        return {
          ok: true,
          op: 'poll',
          items: sink.count,
          pages,
          drained: true,
          state: run.pollingState(),
          logs: run.logs,
        };
      }
      pagination = next;
      const stoppedBy =
        sink.full() ??
        (pages >= limits.maxPages ? 'pages' : Date.now() >= limits.deadline ? 'budget' : undefined);
      if (stoppedBy) {
        return {
          ok: true,
          op: 'poll',
          items: sink.count,
          pages,
          drained: false,
          state: run.pollingState(),
          resume: pagination,
          stoppedBy,
          logs: run.logs,
        };
      }
    }
  } finally {
    sink.close();
  }
}

export async function list(
  component: CallableComponentLike,
  job: RunJob,
  env: OpEnv,
): Promise<RunResult & { op: 'list' }> {
  const action = job.key ? component.actions?.[job.key] : undefined;
  if (typeof action !== 'function') {
    throw new RunnerError('input', `the component has no action named ${job.key ?? '(none)'}`);
  }
  const run = makeRunContext({ secrets: env.secrets });
  const limits = limitsOf(job);
  const sink = new ItemSink(env.itemsPath, limits.maxItems, limits.maxBytes, env.secrets);
  const base = inputsFor(job);
  let token = job.page?.token;
  let pages = 0;
  try {
    while (true) {
      const values =
        job.page && token !== undefined && token !== null
          ? { ...base, [job.page.input]: token }
          : base;
      const out = await env.runWithContext(run.context, () => action(values));
      pages += 1;
      sink.add(itemsAt(out, job.items?.paths ?? ['$.data']));
      token = job.page ? jget(out, job.page.from) : undefined;
      if (token === undefined || token === null || token === '') {
        return { ok: true, op: 'list', items: sink.count, pages, complete: true, logs: run.logs };
      }
      const stoppedBy =
        sink.full() ??
        (pages >= limits.maxPages ? 'pages' : Date.now() >= limits.deadline ? 'budget' : undefined);
      if (stoppedBy) {
        return {
          ok: true,
          op: 'list',
          items: sink.count,
          pages,
          complete: false,
          stoppedBy,
          logs: run.logs,
        };
      }
    }
  } finally {
    sink.close();
  }
}

export async function call(
  component: CallableComponentLike,
  job: RunJob,
  env: OpEnv,
): Promise<RunResult & { op: 'call' }> {
  const action = job.key ? component.actions?.[job.key] : undefined;
  if (typeof action !== 'function') {
    throw new RunnerError('input', `the component has no action named ${job.key ?? '(none)'}`);
  }
  const run = makeRunContext({ secrets: env.secrets });
  const out = await env.runWithContext(run.context, () => action(inputsFor(job)));
  const data = (out as { data?: unknown } | undefined)?.data ?? out;
  if (Buffer.byteLength(JSON.stringify(data) ?? '') > MAX_CALL_BYTES) {
    throw new RunnerError('component', 'the action returned more than a call may hold');
  }
  return { ok: true, op: 'call', data, logs: run.logs };
}

function describeInputs(inputs: unknown): Record<string, InputDescription> {
  const out: Record<string, InputDescription> = {};
  if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) return out;
  for (const [key, raw] of Object.entries(inputs as Record<string, Record<string, unknown>>)) {
    if (!raw || typeof raw !== 'object') continue;
    const d: InputDescription = {};
    if (typeof raw.type === 'string') d.type = raw.type;
    if (typeof raw.label === 'string') d.label = raw.label;
    if (typeof raw.required === 'boolean') d.required = raw.required;
    if (typeof raw.collection === 'string') d.collection = raw.collection;
    if (typeof raw.comments === 'string') d.comments = raw.comments;
    if (typeof raw.shown === 'boolean') d.shown = raw.shown;
    const def = raw.default;
    if (def !== undefined && typeof def !== 'function') {
      try {
        d.default = JSON.parse(JSON.stringify(def));
      } catch {
        /* not data */
      }
    }
    out[key] = d;
  }
  return out;
}

function entity(def: unknown): EntityDescription {
  const d = (def ?? {}) as { display?: { label?: string; description?: string }; inputs?: unknown };
  return {
    ...(d.display?.label ? { label: d.display.label } : {}),
    ...(d.display?.description ? { description: d.display.description } : {}),
    inputs: describeInputs(d.inputs),
  };
}

function authoringDefinition(
  component: CallableComponentLike,
): Record<string, unknown> | undefined {
  const candidates: unknown[] = [
    ...Object.values(component.actions ?? {}),
    ...Object.values(component.triggers ?? {}).map((t) => t.perform),
  ];
  for (const fn of candidates) {
    const target = (fn as Record<symbol, { owner?: unknown }> | undefined)?.[CALLABLE_TARGET];
    if (target?.owner && typeof target.owner === 'object') {
      return target.owner as Record<string, unknown>;
    }
  }
  return undefined;
}

export function describe(component: CallableComponentLike): ComponentDescription {
  const owner = authoringDefinition(component);
  const ownerActions = (owner?.actions ?? {}) as Record<string, unknown>;
  const actions: ComponentDescription['actions'] = {};
  for (const key of Object.keys(component.actions ?? {})) actions[key] = entity(ownerActions[key]);
  const triggers: ComponentDescription['triggers'] = {};
  for (const [key, t] of Object.entries(component.triggers ?? {})) {
    triggers[key] = {
      ...entity(t),
      polling: t.triggerType === 'polling',
      ...(typeof t.batchConfig?.batchSize === 'number'
        ? { batchSize: t.batchConfig.batchSize }
        : {}),
    };
  }
  const connections: ConnectionDescription[] = [];
  for (const c of (owner?.connections ?? []) as Record<string, unknown>[]) {
    if (!c || typeof c.key !== 'string') continue;
    const display = c.display as { label?: string } | undefined;
    connections.push({
      key: c.key,
      ...(display?.label ? { label: display.label } : {}),
      ...(typeof c.oauth2Type === 'string' ? { oauth2Type: c.oauth2Type } : {}),
      inputs: describeInputs(c.inputs),
    });
  }
  const display = owner?.display as { label?: unknown; description?: unknown } | undefined;
  return {
    ...(typeof owner?.key === 'string' ? { key: owner.key } : {}),
    ...(typeof display?.label === 'string' ? { label: display.label } : {}),
    ...(typeof display?.description === 'string' ? { description: display.description } : {}),
    actions,
    triggers,
    connections,
    dataSources: Object.keys(component.dataSources ?? {}),
  };
}
