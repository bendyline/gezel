import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findHtmlPages } from './tree.js';

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
