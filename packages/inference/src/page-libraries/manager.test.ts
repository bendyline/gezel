import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { type Server, createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type PageLibraryLine, PageLibraryLineSchema } from '@bendyline/gezel/pages';
import * as tar from 'tar';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type PageLibraryDownloadBlock,
  type PageLibraryEvent,
  PageLibraryManager,
} from './manager.js';
import { PageLibraryStore } from './store.js';

let scratch: string;
let server: Server | undefined;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'gezel-page-library-manager-'));
});

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
  await rm(scratch, { recursive: true, force: true });
});

async function tarball(name: string, version: string): Promise<Buffer> {
  const fixture = join(scratch, `fixture-${name}-${version}`);
  await mkdir(join(fixture, 'package', 'dist'), { recursive: true });
  await writeFile(join(fixture, 'package', 'package.json'), JSON.stringify({ name, version }));
  await writeFile(join(fixture, 'package', 'dist', `${name}.js`), `export const ${name} = 1;\n`);
  await writeFile(join(fixture, 'package', 'LICENSE'), 'MIT\n');
  const path = join(scratch, `${name}-${version}.tgz`);
  await tar.create({ cwd: fixture, file: path, gzip: true }, ['package']);
  return readFile(path);
}

/** A registry that serves each tarball, optionally after a delay, and counts downloads. */
async function registry(
  packages: Record<string, Buffer>,
  delayMs = 0,
): Promise<{ url: string; downloads: string[] }> {
  const downloads: string[] = [];
  server = createServer((request, response) => {
    const origin = `http://127.0.0.1:${(server!.address() as { port: number }).port}`;
    const name = (request.url ?? '').slice(1);
    if (packages[name]) {
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({ versions: { '1.0.0': { dist: { tarball: `${origin}/${name}.tgz` } } } }),
      );
      return;
    }
    const file = name.replace(/\.tgz$/, '');
    downloads.push(file);
    setTimeout(() => response.end(packages[file]), delayMs);
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server!.address() as { port: number }).port}`, downloads };
}

function line(name: string, sha256: string): PageLibraryLine {
  return PageLibraryLineSchema.parse({
    library: name,
    name,
    version: '1.0.0',
    answers: { from: '1.0.0', before: '2.0.0' },
    source: { kind: 'npm', package: name, version: '1.0.0', sha256 },
    packages: [name],
    include: [`dist/${name}.js`],
    module: { default: true, entries: { '.': `dist/${name}.js` } },
    license: 'MIT',
    notice: 'LICENSE',
  });
}

function manager(
  lines: PageLibraryLine[],
  registryUrl: string,
  block: PageLibraryDownloadBlock | null = null,
): PageLibraryManager {
  return new PageLibraryManager({
    store: new PageLibraryStore({ home: join(scratch, 'home'), seedRoots: [] }),
    catalogLines: async () => lines,
    blockReason: async (trigger) => (trigger === 'person' && block !== 'build' ? null : block),
    registry: registryUrl,
  });
}

const sha = (buffer: Buffer) => createHash('sha256').update(buffer).digest('hex');

describe('PageLibraryManager', () => {
  it('downloads what a page needs, once, however many ask at the same time', async () => {
    const widget = await tarball('widget', '1.0.0');
    const reg = await registry({ widget }, 50);
    const lines = [line('widget', sha(widget))];
    const shelf = manager(lines, reg.url);
    const events: PageLibraryEvent[] = [];
    shelf.subscribe((event) => events.push(event));

    const [first, second] = await Promise.all([
      shelf.ensure(lines, { waitMs: 10_000 }),
      shelf.ensure(lines, { waitMs: 10_000 }),
    ]);

    expect(first).toEqual({
      ready: ['widget@1.0.0'],
      installed: ['widget@1.0.0'],
      pending: [],
      failed: [],
    });
    expect(second.ready).toEqual(['widget@1.0.0']);
    expect(reg.downloads).toEqual(['widget']);
    expect(events.map((event) => event.type)).toEqual(['started', 'installed']);
    expect(await shelf.ensure(lines, { waitMs: 0 })).toEqual({
      ready: ['widget@1.0.0'],
      installed: [],
      pending: [],
      failed: [],
    });
  });

  it('stops waiting at the budget and lets the download finish', async () => {
    const widget = await tarball('widget', '1.0.0');
    const reg = await registry({ widget }, 400);
    const lines = [line('widget', sha(widget))];
    const shelf = manager(lines, reg.url);

    expect((await shelf.ensure(lines, { waitMs: 20 })).pending).toEqual(['widget@1.0.0']);
    expect(shelf.downloading()).toEqual(['widget@1.0.0']);
    await expect(shelf.install(lines[0]!)).resolves.toMatchObject({ removable: true });
    expect((await shelf.store.lines()).map((entry) => entry.library)).toEqual(['widget']);
  });

  it('reports a tarball that does not match its pin, and installs nothing', async () => {
    const widget = await tarball('widget', '1.0.0');
    const reg = await registry({ widget });
    const lines = [line('widget', 'f'.repeat(64))];
    const shelf = manager(lines, reg.url);

    const result = await shelf.ensure(lines, { waitMs: 10_000 });
    expect(result.failed[0]?.error).toMatch(/does not match its pinned hash/);
    expect(shelf.lastFailure('widget@1.0.0')).toMatch(/pinned hash/);
    expect(await shelf.store.lines()).toEqual([]);
  });

  it('downloads nothing on its own when blocked, and offers only what is installed', async () => {
    const widget = await tarball('widget', '1.0.0');
    const reg = await registry({ widget });
    const lines = [line('widget', sha(widget))];

    for (const block of ['build', 'network', 'setting'] as const) {
      const shelf = manager(lines, reg.url, block);
      expect(await shelf.ensure(lines, { waitMs: 1_000 })).toMatchObject({ blocked: block });
      expect(await shelf.usableLines()).toEqual([]);
    }
    expect(reg.downloads).toEqual([]);

    // The person may still ask for one at a security level that blocks automatic ones.
    const shelf = manager(lines, reg.url, 'network');
    expect((await shelf.ensure(lines, { waitMs: 10_000, trigger: 'person' })).installed).toEqual([
      'widget@1.0.0',
    ]);
    // A store build never downloads.
    await shelf.remove('widget', '1.0.0');
    expect(
      await manager(lines, reg.url, 'build').ensure(lines, { waitMs: 1_000, trigger: 'person' }),
    ).toMatchObject({ blocked: 'build' });
  });

  it('removes a downloaded line', async () => {
    const widget = await tarball('widget', '1.0.0');
    const reg = await registry({ widget });
    const lines = [line('widget', sha(widget))];
    const shelf = manager(lines, reg.url);
    await shelf.ensure(lines, { waitMs: 10_000 });

    expect(await shelf.remove('widget', '1.0.0')).toBe(true);
    expect(await shelf.store.lines()).toEqual([]);
    expect(await shelf.remove('widget', '1.0.0')).toBe(false);
  });

  it('offers catalog lines beside installed ones when downloads are allowed', async () => {
    const widget = await tarball('widget', '1.0.0');
    const gadget = await tarball('gadget', '1.0.0');
    const reg = await registry({ widget, gadget });
    const lines = [line('widget', sha(widget)), line('gadget', sha(gadget))];
    const shelf = manager(lines, reg.url);
    await shelf.ensure([lines[0]!], { waitMs: 10_000 });

    expect((await shelf.usableLines()).map((entry) => entry.library).sort()).toEqual([
      'gadget',
      'widget',
    ]);
  });
});
