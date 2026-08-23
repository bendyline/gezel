import { createContext, runInContext } from 'node:vm';
import type { PageApiBootstrap } from '@bendyline/gezel';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildPageApiShim } from './page-api-shim.js';

/**
 * Executes the injected shim inside node:vm with a hand-rolled window,
 * driving the v1 envelope exactly as the parent relay would. This is the
 * contract test for the page side of the Output Pane API.
 */

const BOOTSTRAP: PageApiBootstrap = {
  api: 1,
  projectId: 'proj-1',
  source: 'type',
  entry: 'board/index.html',
  typeName: 'Checkers',
  params: { personality: 'wry' },
  tools: ['user_move', 'new_game'],
};

interface Harness {
  gezel: {
    page: Record<string, unknown>;
    tools: {
      list(): string[];
      invoke(tool: string, input?: object): Promise<{ output: unknown }>;
    };
    data: {
      read(path: string, opts?: object): Promise<unknown>;
      list(path: string, opts?: object): Promise<unknown[]>;
      watch(path: string, cb: (ev: unknown) => void, opts?: object): () => void;
      url(path: string, opts?: object): string;
    };
    ui: { theme: { mode: string }; onTheme(cb: (t: unknown) => void): () => void };
    refresh(): void;
  };
  posted: unknown[];
  deliver(data: unknown, source?: unknown): void;
  parent: object;
  reloads: number;
  runInPage(code: string): unknown;
}

function boot(
  opts: {
    embedded?: boolean;
    pathname?: string;
    serve?: boolean;
    fetchImpl?: (url: string, init?: Record<string, unknown>) => Promise<unknown>;
  } = {},
): Harness {
  const embedded = opts.embedded !== false;
  const posted: unknown[] = [];
  const listeners: Array<(ev: { source: unknown; data: unknown }) => void> = [];
  const parent = {
    postMessage: (msg: unknown) => {
      posted.push(msg);
    },
  };
  const harness = { reloads: 0 };
  const context: Record<string, unknown> = {
    JSON,
    Math,
    Object,
    Array,
    Error,
    Promise,
    String,
    Uint8Array,
    setTimeout,
    clearTimeout,
    atob: (b64: string) => Buffer.from(b64, 'base64').toString('binary'),
    matchMedia: () => ({ matches: false }),
    location: {
      pathname: opts.pathname ?? '/preview/CAPTOKEN0123/type/proj-1/board/index.html',
      reload: () => {
        harness.reloads += 1;
      },
    },
    addEventListener: (type: string, fn: (ev: { source: unknown; data: unknown }) => void) => {
      if (type === 'message') listeners.push(fn);
    },
    fetch: opts.fetchImpl ?? (() => Promise.reject(new Error('no fetch in test'))),
  };
  context.window = context;
  (context as { parent?: unknown }).parent = embedded ? parent : context;
  createContext(context);
  const html = buildPageApiShim(
    opts.serve
      ? { ...BOOTSTRAP, serve: { apiBase: '/app/api', dataBase: '/data', chat: true } }
      : BOOTSTRAP,
  );
  const script = html.replace(/^<script>/, '').replace(/<\/script>$/, '');
  runInContext(script, context);
  return {
    gezel: (context as { gezel: Harness['gezel'] }).gezel,
    posted,
    deliver: (data, source) => {
      for (const fn of listeners) fn({ source: source ?? parent, data });
    },
    parent,
    get reloads() {
      return harness.reloads;
    },
    runInPage: (code: string) => runInContext(code, context),
  } as Harness;
}

function lastPosted<T>(h: Harness, kind: string): T {
  const found = [...h.posted].reverse().find((m) => (m as { kind?: string }).kind === kind);
  expect(found, `expected a posted '${kind}' envelope`).toBeDefined();
  return found as T;
}

describe('buildPageApiShim', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('installs a non-writable window.gezel with the server bootstrap and sends hello', () => {
    const h = boot();
    expect(h.gezel.page).toMatchObject({
      api: 1,
      projectId: 'proj-1',
      source: 'type',
      entry: 'board/index.html',
      typeName: 'Checkers',
      mode: 'embedded',
    });
    expect(h.gezel.tools.list()).toEqual(['user_move', 'new_game']);
    expect(h.posted[0]).toMatchObject({ __gezelPage: 1, kind: 'hello' });
    // Non-replaceable: a page script's assignment must not clobber the API
    // (sloppy-mode silent failure inside the VM window).
    h.runInPage('window.gezel = null');
    expect(h.runInPage('window.gezel && window.gezel.page.projectId')).toBe('proj-1');
  });

  it('relays invoke over the v1 envelope and resolves on result', async () => {
    const h = boot();
    const done = h.gezel.tools.invoke('user_move', { from: 'c3', to: 'd4' });
    const msg = lastPosted<{ id: string; tool: string; input: unknown }>(h, 'invoke');
    expect(msg).toMatchObject({
      __gezelPage: 1,
      kind: 'invoke',
      tool: 'user_move',
      input: { from: 'c3', to: 'd4' },
    });
    h.deliver({ __gezelPage: 1, kind: 'result', id: msg.id, ok: true, output: { board: 'x' } });
    await expect(done).resolves.toMatchObject({ output: { board: 'x' } });
  });

  it('rejects invoke failures with the typed error code', async () => {
    const h = boot();
    const done = h.gezel.tools.invoke('user_move');
    const msg = lastPosted<{ id: string }>(h, 'invoke');
    h.deliver({
      __gezelPage: 1,
      kind: 'result',
      id: msg.id,
      ok: false,
      error: 'input does not match tool schema',
      errorCode: 'invalid-input',
    });
    await expect(done).rejects.toMatchObject({
      code: 'invalid-input',
      message: expect.stringContaining('schema'),
    });
  });

  it('ignores messages from a non-parent source and v0 sentinels', async () => {
    const h = boot();
    const done = h.gezel.tools.invoke('new_game');
    const msg = lastPosted<{ id: string }>(h, 'invoke');
    // Spoofed source: same shape, wrong window identity.
    h.deliver(
      { __gezelPage: 1, kind: 'result', id: msg.id, ok: false, error: 'spoof' },
      { not: 'parent' },
    );
    // v0 reply shape must be invisible to the v1 listener.
    h.deliver({ __gezelPageResult: true, id: msg.id, ok: false, error: 'v0' });
    h.deliver({ __gezelPage: 1, kind: 'result', id: msg.id, ok: true, output: 'real' });
    await expect(done).resolves.toMatchObject({ output: 'real' });
  });

  it('reads decode by extension: json parses, bytes base64-decodes', async () => {
    const h = boot();
    const jsonRead = h.gezel.data.read('game.json');
    const jsonMsg = lastPosted<{ id: string; op: string; as?: string }>(h, 'read');
    expect(jsonMsg).toMatchObject({ op: 'read', source: 'workspace', path: 'game.json' });
    h.deliver({
      __gezelPage: 1,
      kind: 'read-result',
      id: jsonMsg.id,
      ok: true,
      content: '{"turn":"ai"}',
      encoding: 'utf8',
      etag: 'e1',
    });
    await expect(jsonRead).resolves.toEqual({ turn: 'ai' });

    const byteRead = h.gezel.data.read('media/logo.png', { as: 'bytes' });
    const byteMsg = lastPosted<{ id: string; as?: string }>(h, 'read');
    expect(byteMsg.as).toBe('bytes');
    h.deliver({
      __gezelPage: 1,
      kind: 'read-result',
      id: byteMsg.id,
      ok: true,
      content: Buffer.from([1, 2, 3]).toString('base64'),
      encoding: 'base64',
      etag: 'e2',
    });
    await expect(byteRead).resolves.toEqual(new Uint8Array([1, 2, 3]));
  });

  it('watch registers, delivers change events, and unsubscribes with unwatch', () => {
    const h = boot();
    const seen: unknown[] = [];
    const stop = h.gezel.data.watch('posts', (ev) => seen.push(ev), { source: 'workspace' });
    const watchMsg = lastPosted<{ id: string }>(h, 'watch');
    h.deliver({
      __gezelPage: 1,
      kind: 'change',
      watchId: watchMsg.id,
      path: 'posts/index.json',
      etag: 'n1',
    });
    expect(seen).toEqual([{ path: 'posts/index.json', etag: 'n1' }]);
    stop();
    const unwatch = lastPosted<{ id: string }>(h, 'unwatch');
    expect(unwatch.id).toBe(watchMsg.id);
    h.deliver({ __gezelPage: 1, kind: 'change', watchId: watchMsg.id, path: 'x', etag: 'n2' });
    expect(seen).toHaveLength(1);
  });

  it('applies init/theme pushes and notifies subscribers', () => {
    const h = boot();
    const seen: unknown[] = [];
    h.gezel.ui.onTheme((t) => seen.push(t));
    expect(h.gezel.ui.theme.mode).toBe('light');
    h.deliver({
      __gezelPage: 1,
      kind: 'init',
      api: 1,
      theme: { mode: 'dark' },
      limits: { maxInflight: 2, maxReadBytes: 1024 },
    });
    expect(h.gezel.ui.theme.mode).toBe('dark');
    h.deliver({ __gezelPage: 1, kind: 'theme', theme: { mode: 'light' } });
    expect(seen).toEqual([{ mode: 'dark' }, { mode: 'light' }]);
  });

  it('browser mode: invoke rejects unavailable, url derives from the capability, refresh reloads', async () => {
    const h = boot({ embedded: false });
    expect(h.gezel.page.mode).toBe('browser');
    await expect(h.gezel.tools.invoke('user_move')).rejects.toMatchObject({
      code: 'unavailable',
    });
    expect(h.gezel.data.url('game.json')).toBe('/preview/CAPTOKEN0123/workspace/proj-1/game.json');
    expect(h.gezel.data.url('data/bluesky/posts', { source: 'artifacts' })).toBe(
      '/preview/CAPTOKEN0123/artifacts/proj-1/data/bluesky/posts',
    );
    h.gezel.refresh();
    expect(h.reloads).toBe(1);
    expect(h.posted).toHaveLength(0);
  });

  it('embedded refresh posts the v1 refresh envelope', () => {
    const h = boot();
    h.gezel.refresh();
    expect(lastPosted(h, 'refresh')).toMatchObject({ __gezelPage: 1, kind: 'refresh' });
  });
});

describe('serve mode (bootstrap.serve present)', () => {
  function jsonResponse(status: number, body: unknown) {
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  }

  it('selects mode serve, skips hello, and sends invoke over same-origin fetch', async () => {
    const calls: Array<{ url: string; init: Record<string, unknown> }> = [];
    const h = boot({
      embedded: false,
      serve: true,
      fetchImpl: async (url, init) => {
        calls.push({ url, init: init ?? {} });
        return jsonResponse(200, { status: 'ok', output: { board: 'b' }, runId: 'r1' });
      },
    });
    expect(h.gezel.page.mode).toBe('serve');
    expect(h.posted).toEqual([]);
    const result = (await h.gezel.tools.invoke('user_move', { from: 'c3', to: 'd4' })) as {
      output: unknown;
      runId: string;
    };
    expect(result).toMatchObject({ output: { board: 'b' }, runId: 'r1' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('/app/api/invoke');
    expect(calls[0]?.init).toMatchObject({ method: 'POST', credentials: 'same-origin' });
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      tool: 'user_move',
      input: { from: 'c3', to: 'd4' },
    });
  });

  it('maps HTTP failures onto the page error codes', async () => {
    const h = boot({
      embedded: false,
      serve: true,
      fetchImpl: async () => jsonResponse(429, { error: 'slow down' }),
    });
    await expect(h.gezel.tools.invoke('user_move')).rejects.toMatchObject({
      code: 'rate-limited',
      message: 'slow down',
    });
  });

  it('rejects a failed run like the relay does', async () => {
    const h = boot({
      embedded: false,
      serve: true,
      fetchImpl: async () =>
        jsonResponse(200, { status: 'error', error: 'Illegal move', runId: 'r2' }),
    });
    await expect(h.gezel.tools.invoke('user_move')).rejects.toMatchObject({
      code: 'script-error',
      message: 'Illegal move',
      runId: 'r2',
    });
  });

  it('reads over the head API and decodes like the embedded path', async () => {
    const h = boot({
      embedded: false,
      serve: true,
      fetchImpl: async (url) => {
        expect(url).toBe('/app/api/read');
        return jsonResponse(200, {
          op: 'read',
          content: '{"level":3}',
          encoding: 'utf8',
          etag: 'e1',
        });
      },
    });
    const value = (await h.gezel.data.read('progress.json')) as { level: number };
    expect(value).toEqual({ level: 3 });
  });

  it('maps data.url onto the head data base', () => {
    const h = boot({ embedded: false, serve: true, fetchImpl: async () => jsonResponse(200, {}) });
    expect(h.gezel.data.url('media/win.mp3', { source: 'artifacts' })).toBe(
      '/data/artifacts/media/win.mp3',
    );
  });
});
