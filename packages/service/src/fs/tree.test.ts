import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isGitInstalled, runGit } from '../git/git.js';
import { createGitIgnoreResolver } from '../git/ignore.js';
import { findHtmlPages, listDirEntries, walkDir, walkDirDetailed } from './tree.js';

let root: string;
const gitOk = await isGitInstalled();

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

  it('withStats puts mtimeMs on files and never on directories', async () => {
    await Promise.all([seed('one.txt'), seed('sub/two.txt')]);

    const { entries } = await walkDirDetailed(root, { withStats: true });
    const byPath = new Map(entries.map((e) => [e.path, e]));

    expect(byPath.get('one.txt')?.mtimeMs).toBeTypeOf('number');
    expect(byPath.get('sub/two.txt')?.mtimeMs).toBeTypeOf('number');
    expect(byPath.get('sub')?.mtimeMs).toBeUndefined();
  });

  it('omits mtimeMs entirely without withStats', async () => {
    await seed('one.txt');

    const { entries } = await walkDirDetailed(root);

    expect(entries.every((e) => e.mtimeMs === undefined)).toBe(true);
  });

  it('skipRootDirs prunes a root subtree during the walk, only at depth 0', async () => {
    await Promise.all([
      seed('report.md'),
      // Big enough that post-hoc filtering would have burned the entry cap.
      ...Array.from({ length: 30 }, (_, i) => seed(`shadow/docs/d${i}_files/d${i}.md`)),
      seed('nested/shadow/keep.md'),
    ]);

    const { entries, truncated } = await walkDirDetailed(root, {
      maxEntries: 10,
      skipRootDirs: new Set(['shadow']),
    });
    const paths = entries.map((e) => e.path);

    expect(truncated).toBe(false);
    expect(paths).toContain('report.md');
    expect(paths).toContain('nested/shadow/keep.md');
    expect(paths.some((p) => p === 'shadow' || p.startsWith('shadow/'))).toBe(false);
  });

  it('includeHidden surfaces dotfiles, skipRootDirs, and vendor dirs', async () => {
    await Promise.all([
      seed('README.md'),
      seed('.env'),
      seed('.github/workflows/ci.yml'),
      seed('shadow/report_files/report.md'),
    ]);
    await mkdir(join(root, 'node_modules'), { recursive: true });

    const { entries } = await walkDirDetailed(root, {
      includeHidden: true,
      skipRootDirs: new Set(['shadow']),
    });
    const paths = entries.map((e) => e.path);

    expect(paths).toContain('README.md');
    expect(paths).toContain('.env');
    expect(paths).toContain('.github/workflows/ci.yml');
    expect(paths).toContain('node_modules');
    expect(paths).toContain('shadow/report_files/report.md');
  });

  it('hides Office lock files unless includeHidden is set', async () => {
    await Promise.all([seed('deck.pptx'), seed('~$deck.pptx'), seed('sub/~$notes.docx')]);

    const plain = await walkDirDetailed(root);
    expect(plain.entries.map((entry) => entry.path).sort()).toEqual(['deck.pptx', 'sub']);

    const hidden = await walkDirDetailed(root, { includeHidden: true });
    expect(hidden.entries.map((entry) => entry.path).sort()).toEqual([
      'deck.pptx',
      'sub',
      'sub/~$notes.docx',
      '~$deck.pptx',
    ]);

    expect((await listDirEntries(root, '')).map((entry) => entry.name)).not.toContain(
      '~$deck.pptx',
    );
    expect(
      (await listDirEntries(root, '', { includeHidden: true })).map((entry) => entry.name),
    ).toContain('~$deck.pptx');
  });

  it('includeHidden lists vendor dirs without walking into them', async () => {
    // One node_modules would otherwise consume the whole entry budget and
    // truncate the real tree away.
    await Promise.all([
      seed('index.html'),
      ...Array.from({ length: 20 }, (_, i) => seed(`node_modules/pkg-${i}/index.js`)),
      seed('.git/objects/ab/cdef'),
    ]);

    const { entries, truncated } = await walkDirDetailed(root, { includeHidden: true });
    const paths = entries.map((e) => e.path);

    expect(truncated).toBe(false);
    expect(paths).toContain('index.html');
    expect(paths).toContain('node_modules');
    expect(paths).toContain('.git');
    expect(paths.some((p) => p.startsWith('node_modules/'))).toBe(false);
    expect(paths.some((p) => p.startsWith('.git/'))).toBe(false);
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

  it.skipIf(!gitOk)('excludes Git-ignored pages without entering ignored directories', async () => {
    await runGit(['init', '-q'], { cwd: root });
    await Promise.all([
      seed('app/index.html'),
      seed('app/private.html'),
      seed('generated/index.html'),
      seed('generated/deep/never-scanned.html'),
    ]);
    await Promise.all([
      writeFile(join(root, '.gitignore'), 'generated/\n'),
      writeFile(join(root, 'app', '.gitignore'), 'private.html\n'),
    ]);

    const checkedPaths: string[] = [];
    const resolveGitIgnores = createGitIgnoreResolver(root);
    const paths = (
      await findHtmlPages(root, {
        resolveIgnoredPaths: async (candidates) => {
          checkedPaths.push(...candidates);
          return resolveGitIgnores(candidates);
        },
      })
    ).map((entry) => entry.path);

    expect(paths).toEqual(['app/index.html']);
    expect(checkedPaths).not.toContain('generated/index.html');
    expect(checkedPaths).not.toContain('generated/deep');
  });
});
