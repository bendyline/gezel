import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { errorToResponse } from '@bendyline/gezel/runtime';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ServiceContext } from '../http/context.js';
import { craftbookRoutes } from '../http/routes/craftbooks.js';
import { Store } from './store.js';

/**
 * A craftbook id and its version each become ONE folder name under the
 * templates root, and every route that takes them reached the disk unchecked.
 *
 * The client sends an id through `encodeURIComponent`, so `../..` arrives as
 * `..%2F..`: a single URL segment that survives normalization, which Hono then
 * decodes back to `../..` for the handler. `craftbook_write` passes a
 * model-chosen id straight through, so a write could land outside the root,
 * and `DELETE /api/craftbooks/:id` ends in a recursive `rm` of the book's
 * folder. A body id (create) and a document `version` reached the same paths.
 *
 * The home sits three levels inside the test folder, so an escape lands in
 * this test's own temp tree and nothing outside it.
 */

const DOC = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    name: 'Escape Book',
    steps: [{ id: 'one', name: 'One', prompt: 'Do the thing.', terminal: true }],
    ...extra,
  });

describe('craftbook ids and versions stay inside the templates root', () => {
  let root: string;
  let home: string;
  let app: Hono;
  let canary: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'gezel-craftbook-contain-'));
    home = join(root, 'outer', 'inner', 'home');
    await mkdir(home, { recursive: true });
    const store = new Store({ home });
    await store.ensureLayout();
    // A file the escapes below would reach. An id is joined under its shard
    // folder (its first two characters), so `../..` sits under `..` and
    // resolves to `<home>/../..`, which is `<root>/outer`.
    canary = join(root, 'outer', 'keep.txt');
    await writeFile(canary, 'keep me');
    const ctx = {
      home,
      store,
      catalog: { get: async () => null, list: async () => [] },
      tasks: { list: async () => [] },
      history: { log: async () => undefined },
    } as unknown as ServiceContext;
    app = new Hono();
    app.route('/api/craftbooks', craftbookRoutes(ctx));
    app.onError((err, c) => {
      const reply = errorToResponse(err, { exposeUnknown: false });
      return c.json(reply.body, reply.status as 400);
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** Every file under `<root>` that is not inside the daemon's home. */
  async function filesOutsideHome(): Promise<string[]> {
    const out: string[] = [];
    async function walk(dir: string): Promise<void> {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (path === home) continue;
        if (entry.isDirectory()) await walk(path);
        else out.push(path.slice(root.length + 1).replaceAll('\\', '/'));
      }
    }
    await walk(root);
    return out.sort();
  }

  const call = (method: string, id: string, suffix = '', body?: unknown) =>
    app.request(`/api/craftbooks/${encodeURIComponent(id)}${suffix}`, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });

  it.each(['../..', '..\\..', '..', '.', 'C:', 'a/b'])(
    'refuses %j as a craftbook id on the document write',
    async (id) => {
      const res = await call('PUT', id, '/document', { content: DOC() });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
      expect(await filesOutsideHome()).toEqual(['outer/keep.txt']);
    },
  );

  it('refuses a traversal id in the body of a create', async () => {
    const res = await app.request('/api/craftbooks/document', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: DOC({ id: '../../..' }) }),
    });
    expect(res.status).toBe(422);
    const res2 = await app.request('/api/craftbooks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: '../../..',
        name: 'Escape Book',
        steps: [{ name: 'One', prompt: 'Do the thing.' }],
      }),
    });
    expect(res2.status).toBe(422);
    expect(await filesOutsideHome()).toEqual(['outer/keep.txt']);
  });

  it('refuses a document whose version would climb out of the version folder', async () => {
    const res = await call('PUT', 'escape-book', '/document', {
      content: DOC({ version: '../../../../..' }),
    });
    expect(res.status).toBe(422);
    expect(await filesOutsideHome()).toEqual(['outer/keep.txt']);
  });

  it('never deletes outside the templates root', async () => {
    // Plant a book-shaped folder above the root, as an earlier unchecked write
    // could have, then ask the delete route for it by a traversal id. The id
    // `../..` resolves from the templates root's shard folder `..` to
    // `<home>/../..`, which is `<root>/outer`: the folder holding the home.
    const planted = join(root, 'outer');
    await mkdir(join(planted, 'versions', '1.0.0'), { recursive: true });
    await writeFile(join(planted, 'manifest.json'), JSON.stringify({ id: '../..' }));
    await writeFile(
      join(planted, 'versions', '1.0.0', 'manifest.json'),
      JSON.stringify({
        version: '1.0.0',
        entryStepId: 'one',
        steps: [{ id: 'one', name: 'One', prompt: 'x', terminal: true }],
      }),
    );
    const res = await call('DELETE', '../..');
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    await expect(stat(canary)).resolves.toBeTruthy();
    await expect(stat(home)).resolves.toBeTruthy();
  });

  it('keeps bundled-script source reads, writes and deletes inside the root', async () => {
    const save = await call('PUT', '../..', '/scripts/source', {
      name: 'probe',
      source: 'export {};\n',
    });
    expect(save.status).toBeGreaterThanOrEqual(400);
    expect(save.status).toBeLessThan(500);
    const create = await call('POST', '../..', '/scripts', { name: 'probe2' });
    expect(create.status).toBeGreaterThanOrEqual(400);
    expect(create.status).toBeLessThan(500);
    const del = await call('DELETE', '../..', '/scripts/source?name=probe');
    expect(del.status).toBeGreaterThanOrEqual(400);
    expect(del.status).toBeLessThan(500);
    expect(await filesOutsideHome()).toEqual(['outer/keep.txt']);
  });

  it('still saves, reads and deletes an ordinary local craftbook', async () => {
    const put = await call('PUT', 'my-book', '/document', { content: DOC({ version: '1.2.0' }) });
    expect(put.status).toBe(200);
    const get = await call('GET', 'my-book', '?source=local');
    expect(get.status).toBe(200);
    expect(((await get.json()) as { craftbook: { version: string } }).craftbook.version).toBe(
      '1.2.0',
    );
    const script = await call('PUT', 'my-book', '/scripts/source', {
      name: 'probe',
      source: 'export {};\n',
    });
    expect(script.status).toBe(200);
    const del = await call('DELETE', 'my-book');
    expect(del.status).toBe(200);
    expect(await filesOutsideHome()).toEqual(['outer/keep.txt']);
  });
});
