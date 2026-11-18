import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunJob, RunResult } from './v2/protocol.js';

/**
 * Runner v2 end to end: the built entry, spawned the way the service spawns
 * it (without the sandbox, which the service's own spawn test adds), against
 * a test component built with the SDK's own factories.
 */

const pkgRoot = resolve(__dirname, '..');
const entry = join(pkgRoot, 'dist', 'run.js');
const fixtures = join(pkgRoot, 'test-fixtures');
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const echo = {
  dir: join(fixtures, 'echo-component'),
  entry: 'npm-dist/index.cjs',
  entrySha256: sha(join(fixtures, 'echo-component', 'npm-dist', 'index.cjs')),
};
const forbidden = (file: string) => ({
  dir: join(fixtures, 'forbidden-component'),
  entry: `npm-dist/${file}`,
  entrySha256: sha(join(fixtures, 'forbidden-component', 'npm-dist', file)),
});

const SECRET = 'echo-key-1234567890';
const connection = {
  input: 'connection',
  value: { key: 'apiKey', configVarKey: '', fields: { apiKey: SECRET } },
};

async function run(job: RunJob): Promise<{ result: RunResult; items: unknown[] }> {
  const cwd = await mkdtemp(join(tmpdir(), 'gezel-spectral-run-test-'));
  try {
    const child = spawn(process.execPath, [entry], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    child.stdin.end(JSON.stringify(job));
    const code = await new Promise<number | null>((done) => child.on('close', done));
    if (code !== 0) throw new Error(`runner exited ${code}: ${stderr}`);
    const result = JSON.parse(readFileSync(join(cwd, 'out', 'result.json'), 'utf8')) as RunResult;
    const itemsFile = join(cwd, 'out', 'items.ndjson');
    const items = existsSync(itemsFile)
      ? readFileSync(itemsFile, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : [];
    return { result, items };
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

let server: Server;
let base: string;
let auth: string[] = [];
let throttle = false;
const changes = [
  { id: 'c1', title: 'one' },
  { id: 'c2', title: 'two' },
  { id: 'c3', title: 'three' },
];

beforeAll(async () => {
  server = createServer((req, res) => {
    auth.push(String(req.headers.authorization));
    const url = new URL(req.url ?? '/', 'http://x');
    res.setHeader('content-type', 'application/json');
    if (throttle) {
      res.writeHead(429, { 'retry-after': '7' }).end(JSON.stringify({ error: 'slow down' }));
      return;
    }
    if (url.pathname === '/items') {
      const page = url.searchParams.get('page');
      res.end(
        JSON.stringify(
          page === '2'
            ? { items: [{ id: 'i3' }] }
            : { items: [{ id: 'i1' }, { id: 'i2' }], next: '2' },
        ),
      );
      return;
    }
    if (url.pathname === '/changes') {
      // Two per page, then a cursor, so a drain takes two performs.
      const since = Number(url.searchParams.get('since'));
      const fresh = changes.slice(since);
      const at = Number(url.searchParams.get('cursor') ?? '0');
      const pageItems = fresh.slice(at, at + 2);
      const more = at + 2 < fresh.length;
      res.end(
        JSON.stringify({
          items: pageItems,
          cursor: more ? String(at + 2) : null,
          now: String(changes.length),
        }),
      );
      return;
    }
    res.writeHead(404).end('{}');
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
});

describe.runIf(existsSync(entry))('the Spectral runner v2', () => {
  it('pings with the pinned SDK', async () => {
    const { result } = await run({ v: 2, op: 'ping' });
    expect(result).toMatchObject({ ok: true, op: 'ping' });
    expect((result as { sdk: string }).sdk).toBe(
      require('@prismatic-io/spectral/package.json').version,
    );
  });

  it('describes a component without network', async () => {
    const { result } = await run({ v: 2, op: 'describe', component: echo });
    if (!result.ok || result.op !== 'describe') throw new Error(JSON.stringify(result));
    expect(result.component.key).toBe('gezel-echo');
    expect(result.component.actions.listItems?.label).toBe('List items');
    expect(result.component.actions.listItems?.inputs.baseUrl).toMatchObject({
      type: 'string',
      required: true,
    });
    expect(result.component.triggers.changes).toMatchObject({ polling: true, batchSize: 2 });
    expect(result.component.connections).toEqual([
      expect.objectContaining({
        key: 'apiKey',
        inputs: { apiKey: expect.objectContaining({ type: 'password' }) },
      }),
    ]);
  });

  it('pages an action to the end, feeding each next-page token back', async () => {
    auth = [];
    const { result, items } = await run({
      v: 2,
      op: 'list',
      component: echo,
      key: 'listItems',
      connection,
      inputs: { baseUrl: base },
      items: { paths: ['$.data'] },
      page: { input: 'page', from: '$.next' },
      origins: [base],
    });
    expect(result).toMatchObject({ ok: true, op: 'list', items: 3, pages: 2, complete: true });
    expect(items).toEqual([{ id: 'i1' }, { id: 'i2' }, { id: 'i3' }]);
    expect(auth.every((a) => a === `Bearer ${SECRET}`)).toBe(true);
  });

  it('drains a polling trigger and returns the position it reached', async () => {
    const job: RunJob = {
      v: 2,
      op: 'poll',
      component: echo,
      key: 'changes',
      connection,
      inputs: { baseUrl: base },
      items: { resolver: true },
      origins: [base],
    };
    const { result, items } = await run(job);
    expect(result).toMatchObject({ ok: true, op: 'poll', drained: true, pages: 2, items: 3 });
    expect(items.map((i) => (i as { id: string }).id)).toEqual(['c1', 'c2', 'c3']);
    const state = (result as { state: unknown }).state;
    expect(state).toEqual({ since: '3' });

    // The next poll starts where the last one ended.
    const again = await run({ ...job, state });
    expect(again.result).toMatchObject({ ok: true, drained: true, items: 0 });
  });

  it('stops a drain at its page limit and continues it from where it stopped', async () => {
    const job: RunJob = {
      v: 2,
      op: 'poll',
      component: echo,
      key: 'changes',
      connection,
      inputs: { baseUrl: base },
      items: { resolver: true },
      origins: [base],
      limits: { maxPages: 1 },
    };
    const first = await run(job);
    expect(first.result).toMatchObject({ ok: true, drained: false, stoppedBy: 'pages', items: 2 });
    const { state, resume } = first.result as { state: unknown; resume: unknown };
    expect(resume).toEqual({ cursor: '2' });
    const second = await run({ ...job, state, resume });
    expect(second.result).toMatchObject({ ok: true, drained: true, items: 1 });
    expect(second.items).toEqual([{ id: 'c3', title: 'three' }]);
  });

  it('refuses an origin the connector does not declare, before any request', async () => {
    auth = [];
    const { result } = await run({
      v: 2,
      op: 'list',
      component: echo,
      key: 'listItems',
      connection,
      inputs: { baseUrl: base },
      origins: ['https://api.example.com'],
    });
    expect(result).toMatchObject({ ok: false, error: { kind: 'origin' } });
    expect(auth).toEqual([]);
  });

  it('names a throttle and carries the wait the service asked for', async () => {
    throttle = true;
    try {
      const { result } = await run({
        v: 2,
        op: 'list',
        component: echo,
        key: 'listItems',
        connection,
        inputs: { baseUrl: base },
        origins: [base],
      });
      expect(result).toMatchObject({
        ok: false,
        error: { kind: 'throttled', status: 429, retryAfterMs: 7000 },
      });
    } finally {
      throttle = false;
    }
  });

  it('never writes the credential, whether a component returns it, logs it or throws it', async () => {
    const returned = await run({ v: 2, op: 'call', component: echo, key: 'revealKey', connection });
    expect(returned.result).toMatchObject({ ok: true, data: { key: '[secret]' } });
    expect((returned.result as { logs: string[] }).logs).toEqual(['warn: using [secret]']);
    const thrown = await run({
      v: 2,
      op: 'call',
      component: echo,
      key: 'revealKey',
      connection,
      inputs: { fail: true },
    });
    expect(thrown.result).toMatchObject({
      ok: false,
      error: { kind: 'component', message: 'the key [secret] was rejected' },
    });
  });

  it('answers from recordings in replay mode, opening no socket', async () => {
    auth = [];
    const { result, items } = await run({
      v: 2,
      op: 'list',
      component: echo,
      key: 'listItems',
      connection,
      inputs: { baseUrl: 'https://api.example.com' },
      items: { paths: ['$.data'] },
      page: { input: 'page', from: '$.next' },
      origins: ['https://api.example.com'],
      replay: [
        {
          request: { method: 'GET', url: 'https://api.example.com/items' },
          response: { status: 200, body: { items: [{ id: 'r1' }], next: 'b' } },
        },
        {
          request: { method: 'GET', url: 'https://api.example.com/items?page=b' },
          response: { status: 200, body: { items: [{ id: 'r2' }] } },
        },
      ],
    });
    expect(result).toMatchObject({ ok: true, items: 2, complete: true });
    expect(items).toEqual([{ id: 'r1' }, { id: 'r2' }]);
    expect(auth).toEqual([]);
  });

  it('a request with no recording fails as a replay miss', async () => {
    const { result } = await run({
      v: 2,
      op: 'list',
      component: echo,
      key: 'listItems',
      connection,
      inputs: { baseUrl: 'https://api.example.com' },
      origins: ['https://api.example.com'],
      replay: [],
    });
    expect(result).toMatchObject({ ok: false, error: { kind: 'replay-miss' } });
  });

  it('refuses a component whose entry does not match its pin', async () => {
    const { result } = await run({
      v: 2,
      op: 'describe',
      component: { ...echo, entrySha256: '0'.repeat(64) },
    });
    expect(result).toMatchObject({ ok: false, error: { kind: 'component' } });
    expect((result as { error: { message: string } }).error.message).toMatch(/pinned hash/);
  });

  it('refuses a component that asks for a socket built-in or a package it does not carry', async () => {
    const net = await run({ v: 2, op: 'describe', component: forbidden('index.cjs') });
    expect(net.result).toMatchObject({ ok: false, error: { kind: 'component' } });
    expect((net.result as { error: { message: string } }).error.message).toMatch(/node:net/);
    const foreign = await run({ v: 2, op: 'describe', component: forbidden('foreign.cjs') });
    expect((foreign.result as { error: { message: string } }).error.message).toMatch(
      /lodash, which is not part of its package/,
    );
  });
});
