import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, describe as group, it } from 'vitest';
import { RunnerError } from './failure.js';
import { type CallableComponentLike, type OpEnv, call, describe, jget, list, poll } from './ops.js';
import type { RunJob } from './protocol.js';

/**
 * The operations over a component, in process, against plain functions
 * shaped like a callable component. The spawned end-to-end run lives in
 * ../run.test.ts; this covers the limits and refusals it does not reach.
 */

let dir: string;
let env: OpEnv;
const contexts: unknown[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gezel-spectral-ops-'));
  contexts.length = 0;
  env = {
    runWithContext: (context, fn) => {
      contexts.push(context);
      return fn();
    },
    secrets: ['sk-1234567890'],
    itemsPath: join(dir, 'items.ndjson'),
  };
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const written = () =>
  existsSync(env.itemsPath)
    ? readFileSync(env.itemsPath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];

/** An action that serves `pages` in order, keyed by the `page` input. */
function pagedAction(pages: Record<string, { data: unknown[]; next?: string }>) {
  const seen: Record<string, unknown>[] = [];
  const action = async (values: unknown) => {
    const v = values as Record<string, unknown>;
    seen.push(v);
    return pages[String(v.page ?? 'first')];
  };
  return { action, seen };
}

group('jget', () => {
  it('follows a dotted path and reports absence as undefined', () => {
    const value = { a: { b: [1, 2] }, n: null };
    expect(jget(value, '$')).toBe(value);
    expect(jget(value, '$.a.b')).toEqual([1, 2]);
    expect(jget(value, '$.a.missing.deeper')).toBeUndefined();
    expect(jget(value, '$.n.x')).toBeUndefined();
    expect(() => jget(value, 'a.b')).toThrow(RunnerError);
  });
});

group('list', () => {
  const job = (over: Partial<RunJob> = {}): RunJob => ({
    v: 2,
    op: 'list',
    key: 'records',
    connection: { input: 'connection', value: { fields: { apiKey: 'sk-1234567890' } } },
    inputs: { base: 'x' },
    page: { input: 'page', from: '$.next' },
    ...over,
  });

  it('feeds each token back until there is none, and passes the connection as an input', async () => {
    const { action, seen } = pagedAction({
      first: { data: [{ id: 1 }, { id: 2 }], next: 'b' },
      b: { data: [{ id: 3, echo: 'sk-1234567890' }], next: '' },
    });
    const result = await list({ actions: { records: action } }, job(), env);
    expect(result).toEqual({ ok: true, op: 'list', items: 3, pages: 2, complete: true, logs: [] });
    expect(written()).toEqual([{ id: 1 }, { id: 2 }, { id: 3, echo: '[secret]' }]);
    expect(seen[0]).toEqual({ base: 'x', connection: { fields: { apiKey: 'sk-1234567890' } } });
    expect(seen[1]).toMatchObject({ page: 'b' });
  });

  it('starts from a token the service carried over', async () => {
    const { action, seen } = pagedAction({ c: { data: [{ id: 9 }] } });
    const result = await list(
      { actions: { records: action } },
      job({ page: { input: 'page', from: '$.next', token: 'c' } }),
      env,
    );
    expect(result).toMatchObject({ items: 1, complete: true });
    expect(seen[0]).toMatchObject({ page: 'c' });
  });

  it('takes one page when the action has no paging', async () => {
    const { action } = pagedAction({ first: { data: [{ id: 1 }], next: 'b' } });
    const result = await list({ actions: { records: action } }, job({ page: undefined }), env);
    expect(result).toMatchObject({ items: 1, pages: 1, complete: true });
  });

  it.each([
    ['pages', { maxPages: 1 }],
    ['items', { maxItems: 2 }],
    ['bytes', { maxBytes: 10 }],
    ['budget', { budgetMs: -1 }],
  ] as const)(
    'stops short at its %s limit and says the listing is incomplete',
    async (by, limits) => {
      const { action } = pagedAction({
        first: { data: [{ id: 1 }, { id: 2 }], next: 'b' },
        b: { data: [{ id: 3 }] },
      });
      const result = await list({ actions: { records: action } }, job({ limits }), env);
      expect(result).toMatchObject({
        ok: true,
        items: 2,
        pages: 1,
        complete: false,
        stoppedBy: by,
      });
    },
  );

  it('refuses a page far larger than a run may hold', async () => {
    const { action } = pagedAction({ first: { data: [{ blob: 'x'.repeat(100) }] } });
    await expect(
      list({ actions: { records: action } }, job({ limits: { maxBytes: 10 } }), env),
    ).rejects.toThrow(/larger than a run may hold/);
  });

  it('refuses an action it does not have, and items that are not a list', async () => {
    await expect(list({ actions: {} }, job(), env)).rejects.toThrow(/no action named records/);
    await expect(list({}, job({ key: undefined }), env)).rejects.toThrow(/\(none\)/);
    const notAList = async () => ({ data: { id: 1 } });
    await expect(list({ actions: { records: notAList } }, job(), env)).rejects.toThrow(
      /expected a list at \$\.data but found object/,
    );
  });

  it('skips a path with nothing at it', async () => {
    const action = async () => ({ data: null, more: [{ id: 1 }] });
    const result = await list(
      { actions: { records: action } },
      job({ page: undefined, items: { paths: ['$.data', '$.more'] } }),
      env,
    );
    expect(result).toMatchObject({ items: 1 });
  });
});

group('poll', () => {
  const job = (over: Partial<RunJob> = {}): RunJob => ({
    v: 2,
    op: 'poll',
    key: 'changes',
    inputs: { base: 'x' },
    ...over,
  });

  /** A trigger that pages through `pages` by pagination state and records its position at the end. */
  function trigger(pages: unknown[][], opts: { resolver?: boolean; batchSize?: number } = {}) {
    const performed: unknown[] = [];
    const perform = async (payload: unknown) => {
      const p = payload as { paginationState?: number };
      performed.push(p.paginationState);
      const at = p.paginationState ?? 0;
      const more = at + 1 < pages.length;
      const ctx = contexts.at(-1) as { instanceState: Record<string, unknown> };
      if (!more) ctx.instanceState.__prismaticInternal = { polling: { at } };
      return {
        payload: { items: pages[at], ...(more ? { paginationState: at + 1 } : {}) },
      };
    };
    const t = Object.assign(async () => undefined, {
      perform,
      triggerType: 'polling',
      ...(opts.batchSize !== undefined ? { batchConfig: { batchSize: opts.batchSize } } : {}),
      ...(opts.resolver
        ? {
            triggerResolver: {
              resolveItems: (r: unknown) => (r as { payload: { items: unknown } }).payload.items,
              getNextPaginationState: (r: unknown) =>
                (r as { payload: { paginationState?: unknown } }).payload.paginationState ?? null,
            },
          }
        : {}),
    });
    return { component: { triggers: { changes: t } } as CallableComponentLike, performed };
  }

  it('drains by the payload pagination state and returns the position reached', async () => {
    const { component, performed } = trigger([[{ id: 1 }], [{ id: 2 }]]);
    const result = await poll(component, job({ items: { paths: ['$.items'] } }), env);
    expect(result).toEqual({
      ok: true,
      op: 'poll',
      items: 2,
      pages: 2,
      drained: true,
      state: { at: 1 },
      logs: [],
    });
    expect(performed).toEqual([undefined, 1]);
    expect(written()).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('uses the trigger resolver when asked, and declares the batch size to the trigger', async () => {
    const { component } = trigger([[{ id: 1 }, { id: 2 }], [{ id: 3 }]], {
      resolver: true,
      batchSize: 2,
    });
    const result = await poll(component, job({ items: { resolver: true } }), env);
    expect(result).toMatchObject({ drained: true, items: 3, pages: 2 });
    expect((contexts[0] as { batch: unknown }).batch).toEqual({ enabled: true, batchSize: 2 });
  });

  it('stops at a limit with the place to resume, and resumes from it', async () => {
    const { component, performed } = trigger([[{ id: 1 }], [{ id: 2 }], [{ id: 3 }]]);
    const first = await poll(
      component,
      job({ items: { paths: ['$.items'] }, limits: { maxItems: 1 } }),
      env,
    );
    expect(first).toMatchObject({ drained: false, stoppedBy: 'items', resume: 1, state: null });
    const second = await poll(
      component,
      job({ items: { paths: ['$.items'] }, resume: 1, state: { at: -1 } }),
      env,
    );
    expect(second).toMatchObject({ drained: true, items: 2, state: { at: 2 } });
    expect(performed).toEqual([undefined, 1, 2]);
  });

  it.each([
    ['pages', { maxPages: 1 }],
    ['budget', { budgetMs: -1 }],
  ] as const)('stops a drain at its %s limit', async (by, limits) => {
    const { component } = trigger([[{ id: 1 }], [{ id: 2 }]]);
    const result = await poll(component, job({ items: { paths: ['$.items'] }, limits }), env);
    expect(result).toMatchObject({ drained: false, stoppedBy: by, pages: 1 });
  });

  it('refuses a trigger it does not have, and a resolver that returns no list', async () => {
    await expect(poll({ triggers: {} }, job(), env)).rejects.toThrow(/no trigger named changes/);
    await expect(poll({}, job({ key: undefined }), env)).rejects.toThrow(/\(none\)/);
    const { component } = trigger([[{ id: 1 }]], { resolver: true });
    const t = component.triggers?.changes;
    if (!t?.triggerResolver) throw new Error('fixture has no resolver');
    t.triggerResolver.resolveItems = () => 'not a list';
    await expect(poll(component, job({ items: { resolver: true } }), env)).rejects.toThrow(
      /did not return a list/,
    );
  });
});

group('call', () => {
  it('returns what the action returned, unwrapping `data`, with its logs', async () => {
    const action = async (values: unknown) => {
      const ctx = contexts.at(-1) as { logger: { info: (s: string) => void } };
      ctx.logger.info('called');
      return { data: { got: (values as { q: string }).q } };
    };
    const result = await call(
      { actions: { search: action } },
      { v: 2, op: 'call', key: 'search', inputs: { q: 'hi' } },
      env,
    );
    expect(result).toEqual({ ok: true, op: 'call', data: { got: 'hi' }, logs: ['info: called'] });
    const bare = await call(
      { actions: { search: async () => 'plain' } },
      { v: 2, op: 'call', key: 'search' },
      env,
    );
    expect(bare).toMatchObject({ data: 'plain' });
  });

  it('refuses an action it does not have, and a result too large to hold', async () => {
    await expect(call({ actions: {} }, { v: 2, op: 'call', key: 'x' }, env)).rejects.toThrow(
      /no action named x/,
    );
    const huge = async () => ({ data: 'x'.repeat(4 * 1024 * 1024 + 1) });
    await expect(
      call({ actions: { huge } }, { v: 2, op: 'call', key: 'huge' }, env),
    ).rejects.toThrow(/more than a call may hold/);
  });
});

group('describe', () => {
  const CALLABLE_TARGET = Symbol.for('@prismatic-io/spectral/callable-mock/v1');

  it('reads the authoring definition behind the callable functions', () => {
    const owner = {
      key: 'demo',
      display: { label: 'Demo', description: 'A demo component.' },
      actions: {
        search: {
          display: { label: 'Search', description: 'Find things.' },
          inputs: {
            q: { type: 'string', label: 'Query', required: true, comments: 'What to find.' },
            limit: { type: 'string', default: 10, shown: false },
            tags: { type: 'string', collection: 'valuelist', default: () => [] },
            weird: { type: 'string', default: 10n },
            broken: null,
          },
        },
      },
      connections: [
        {
          key: 'oauth',
          display: { label: 'Sign in' },
          oauth2Type: 'authorization_code',
          inputs: { scopes: { type: 'string' } },
        },
        { display: { label: 'no key' } },
      ],
    };
    const search = Object.assign(async () => undefined, { [CALLABLE_TARGET]: { owner } });
    const plain = async () => undefined;
    const perform = Object.assign(async () => undefined, { [CALLABLE_TARGET]: {} });
    const changes = Object.assign(async () => undefined, {
      perform,
      triggerType: 'polling',
      batchConfig: { batchSize: 5 },
      display: { label: 'Changes' },
      inputs: { since: { type: 'string', required: false } },
    });
    const hook = Object.assign(async () => undefined, { perform: async () => ({}) });

    const described = describe({
      triggers: { changes, hook } as unknown as CallableComponentLike['triggers'],
      actions: { search, plain },
      dataSources: { pickList: {} },
    });
    expect(described).toEqual({
      key: 'demo',
      label: 'Demo',
      description: 'A demo component.',
      actions: {
        search: {
          label: 'Search',
          description: 'Find things.',
          inputs: {
            q: { type: 'string', label: 'Query', required: true, comments: 'What to find.' },
            limit: { type: 'string', default: 10, shown: false },
            tags: { type: 'string', collection: 'valuelist' },
            weird: { type: 'string' },
          },
        },
        plain: { inputs: {} },
      },
      triggers: {
        changes: {
          label: 'Changes',
          inputs: { since: { type: 'string', required: false } },
          polling: true,
          batchSize: 5,
        },
        hook: { inputs: {}, polling: false },
      },
      connections: [
        {
          key: 'oauth',
          label: 'Sign in',
          oauth2Type: 'authorization_code',
          inputs: { scopes: { type: 'string' } },
        },
      ],
      dataSources: ['pickList'],
    });
  });

  it('describes a component with no authoring definition by its keys alone', () => {
    expect(describe({ actions: { a: async () => undefined } })).toEqual({
      actions: { a: { inputs: {} } },
      triggers: {},
      connections: [],
      dataSources: [],
    });
  });
});
