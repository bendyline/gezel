import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runJob } from './run.js';
import { unloadComponentHooks } from './v2/load-component.js';
import type { RunJob } from './v2/protocol.js';

/**
 * `runJob` in process, for the paths the spawned end-to-end test
 * (run.test.ts) exercises only through the built entry. A run installs the
 * HTTP guard and the loader's hook for the life of its process, so each test
 * here puts back what the run replaced.
 */

const fixtures = resolve(__dirname, '..', 'test-fixtures');
const echoEntry = join(fixtures, 'echo-component', 'npm-dist', 'index.cjs');
const echo = {
  dir: join(fixtures, 'echo-component'),
  entry: 'npm-dist/index.cjs',
  entrySha256: createHash('sha256').update(readFileSync(echoEntry)).digest('hex'),
};
const SECRET = 'echo-key-1234567890';
const connection = {
  input: 'connection',
  value: { key: 'apiKey', configVarKey: '', fields: { apiKey: SECRET } },
};

const axios = createRequire(require.resolve('@prismatic-io/spectral'))('axios') as {
  defaults: { adapter: unknown };
};
type Patchable = Record<'request' | 'get', unknown>;
const httpMod = http as unknown as Patchable;
const httpsMod = https as unknown as Patchable;
const proc = process as unknown as { getBuiltinModule?: unknown };
const original = {
  http: [httpMod.request, httpMod.get] as const,
  https: [httpsMod.request, httpsMod.get] as const,
  fetch: globalThis.fetch,
  adapter: axios.defaults.adapter,
  getBuiltinModule: proc.getBuiltinModule,
};

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'gezel-spectral-run-job-'));
});

afterEach(async () => {
  [httpMod.request, httpMod.get] = original.http;
  [httpsMod.request, httpsMod.get] = original.https;
  globalThis.fetch = original.fetch;
  axios.defaults.adapter = original.adapter;
  unloadComponentHooks();
  await rm(cwd, { recursive: true, force: true });
});

afterAll(() => {
  proc.getBuiltinModule = original.getBuiltinModule;
});

describe('runJob, in process', () => {
  it('pings without loading a component, and prepares the output folder', async () => {
    const result = await runJob({ v: 2, op: 'ping', replay: [] }, cwd);
    expect(result).toEqual({
      ok: true,
      op: 'ping',
      sdk: require('@prismatic-io/spectral/package.json').version,
      node: process.version,
      replayed: [],
    });
    expect(existsSync(join(cwd, 'out'))).toBe(true);
  });

  it('answers a job it cannot run with a named failure, never a throw', async () => {
    expect(await runJob({ v: 1 } as unknown as RunJob, cwd)).toMatchObject({
      ok: false,
      error: { kind: 'component', message: 'unsupported job version 1' },
      logs: [],
    });
    expect(await runJob({ v: 2, op: 'call' }, cwd)).toMatchObject({
      ok: false,
      op: 'call',
      error: { message: 'the job names no component' },
    });
    expect(
      await runJob({ v: 2, op: 'nothing' as RunJob['op'], component: echo }, cwd),
    ).toMatchObject({ ok: false, error: { message: 'unknown operation nothing' } });
  });

  it('describes the echo component', async () => {
    const result = await runJob({ v: 2, op: 'describe', component: echo }, cwd);
    if (!result.ok || result.op !== 'describe') throw new Error(JSON.stringify(result));
    expect(result.component).toMatchObject({ key: 'gezel-echo', label: 'Echo' });
    expect(Object.keys(result.component.actions)).toEqual(['listItems', 'revealKey']);
  });

  it('pages an action from recordings and says which it used', async () => {
    const result = await runJob(
      {
        v: 2,
        op: 'list',
        component: echo,
        key: 'listItems',
        connection,
        inputs: { baseUrl: 'https://api.example.com' },
        items: { paths: ['$.data'] },
        page: { input: 'page', from: '$.next' },
        replay: [
          {
            request: { url: 'https://api.example.com/unused' },
            response: { status: 200, body: {} },
          },
          {
            request: { method: 'GET', url: 'https://api.example.com/items' },
            response: { status: 200, body: { items: [{ id: 'r1' }], next: 'b' } },
          },
          {
            request: { method: 'GET', url: 'https://api.example.com/items?page=b' },
            response: { status: 200, body: { items: [{ id: 'r2' }] } },
          },
        ],
      },
      cwd,
    );
    expect(result).toMatchObject({
      ok: true,
      op: 'list',
      items: 2,
      complete: true,
      replayed: [1, 2],
    });
    const items = readFileSync(join(cwd, 'out', 'items.ndjson'), 'utf8')
      .trim()
      .split('\n');
    expect(items.map((line) => JSON.parse(line))).toEqual([{ id: 'r1' }, { id: 'r2' }]);
  });

  it('calls an action and keeps the credential out of what it returns, logs and throws', async () => {
    const returned = await runJob(
      { v: 2, op: 'call', component: echo, key: 'revealKey', connection },
      cwd,
    );
    // `call` returns the data as the component gave it; run.ts scrubs the
    // serialized result on its way to result.json.
    expect(returned).toMatchObject({ ok: true, logs: ['warn: using [secret]'] });
    const thrown = await runJob(
      { v: 2, op: 'call', component: echo, key: 'revealKey', connection, inputs: { fail: true } },
      cwd,
    );
    expect(thrown).toMatchObject({
      ok: false,
      error: { kind: 'component', message: 'the key [secret] was rejected' },
    });
  });

  it('names the HTTP failure a component rewrote, from the response the guard saw', async () => {
    const result = await runJob(
      {
        v: 2,
        op: 'poll',
        component: echo,
        key: 'changes',
        connection,
        inputs: { baseUrl: 'https://api.example.com' },
        items: { resolver: true },
        replay: [
          {
            request: { url: 'https://api.example.com/changes?since=0' },
            response: { status: 401, body: { error: 'bad key' } },
          },
        ],
      },
      cwd,
    );
    expect(result).toMatchObject({ ok: false, op: 'poll', error: { kind: 'auth', status: 401 } });
  });
});
