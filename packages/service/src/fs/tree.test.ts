import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findHtmlPages, walkDir, walkDirDetailed } from './tree.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'gezel-html-pages-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function seed(path: string): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), '<!doctype html>');
}

describe('walkDirDetailed', () => {
  it('lists a directory fully before descending, so root files survive the entry cap', async () => {
    // A large subdirectory must not starve its root-level siblings out of
    // the listing — the wild-caught gezel-site bug: a 1000-entry docs/
    // dir consumed the whole budget depth-first and the workspace's own
    // index.html vanished from every listing.
    await Promise.all([
      seed('LICENSE'),
      seed('README.md'),
      ...Array.from({ length: 20 }, (_, i) => seed(`docs/page-${String(i).padStart(2, '0')}.md`)),
      seed('index.html'),
      seed('package.json'),
    ]);

    const { entries, truncated } = await walkDirDetailed(root, { maxEntries: 10 });
    const paths = entries.map((e) => e.path);

    expect(truncated).toBe(true);
    for (const rootFile of ['LICENSE', 'README.md', 'docs', 'index.html', 'package.json']) {
      expect(paths).toContain(rootFile);
    }
  });

  it('emits parent directories before their children', async () => {
    await Promise.all([seed('a/b/c.txt'), seed('top.txt')]);

    const { entries } = await walkDirDetailed(root);
    const paths = entries.map((e) => e.path);

    expect(paths.indexOf('a')).toBeGreaterThanOrEqual(0);
    expect(paths.indexOf('a')).toBeLessThan(paths.indexOf('a/b'));
    expect(paths.indexOf('a/b')).toBeLessThan(paths.indexOf('a/b/c.txt'));
  });

  it('reports truncated: false when the tree fits the bounds', async () => {
    await Promise.all([seed('one.txt'), seed('sub/two.txt')]);

    const { entries, truncated } = await walkDirDetailed(root);

    expect(truncated).toBe(false);
    expect(entries.map((e) => e.path).sort()).toEqual(['one.txt', 'sub', 'sub/two.txt']);
  });

  it('reports truncated: true when maxDepth prunes a subtree', async () => {
    await seed('a/b/c/deep.txt');

    const { entries, truncated } = await walkDirDetailed(root, { maxDepth: 2 });

    expect(truncated).toBe(true);
    expect(entries.map((e) => e.path)).not.toContain('a/b/c/deep.txt');
  });

  it('walkDir returns the same entries without the flag', async () => {
    await Promise.all([seed('one.txt'), seed('sub/two.txt')]);

    const entries = await walkDir(root);

    expect(entries.map((e) => e.path).sort()).toEqual(['one.txt', 'sub', 'sub/two.txt']);
  });
});

describe('findHtmlPages', () => {
  it('finds pages through four containing folders only', async () => {
    await Promise.all([
      seed('index.html'),
      seed('one/page.htm'),
      seed('one/two/three/four/deep.html'),
      seed('one/two/three/four/five/too-deep.html'),
      seed('one/two/not-a-page.txt'),
    ]);

    const paths = (await findHtmlPages(root)).map((entry) => entry.path);

    expect(paths).toEqual(['index.html', 'one/page.htm', 'one/two/three/four/deep.html']);
  });

  it('finds a root index.html even when a deep directory holds more pages than the cap', async () => {
    await Promise.all([
      ...Array.from({ length: 8 }, (_, i) => seed(`docs/deep-${i}.html`)),
      seed('index.html'),
    ]);

    const paths = (await findHtmlPages(root, { maxEntries: 4 })).map((entry) => entry.path);

    expect(paths).toContain('index.html');
  });

  it('does not enter node_modules or dot-prefixed folders', async () => {
    await Promise.all([
      seed('app/index.html'),
      seed('node_modules/package/index.html'),
      seed('app/node_modules/package/nested.html'),
      seed('.generated/index.html'),
      seed('app/.cache/preview.html'),
    ]);

    const paths = (await findHtmlPages(root)).map((entry) => entry.path);

    expect(paths).toEqual(['app/index.html']);
  });
});
