import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type PageLibraryLine, PageLibraryLineSchema } from '@bendyline/gezel/pages';
import * as tar from 'tar';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PageLibraryStore } from './store.js';

let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'gezel-page-libraries-'));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

/** A package tarball as the registry serves one, and its hash. */
async function tarball(
  name: string,
  version: string,
  files: Record<string, string>,
): Promise<{ path: string; sha256: string }> {
  const fixture = join(scratch, `fixture-${name}-${version}`);
  for (const [path, text] of Object.entries({
    'package.json': JSON.stringify({ name, version }),
    ...files,
  })) {
    await mkdir(join(fixture, 'package', path, '..'), { recursive: true });
    await writeFile(join(fixture, 'package', path), text);
  }
  const path = join(scratch, `${name}-${version}.tgz`);
  await tar.create({ cwd: fixture, file: path, gzip: true }, ['package']);
  return {
    path,
    sha256: createHash('sha256')
      .update(await readFile(path))
      .digest('hex'),
  };
}

function line(sha256: string, extra: Record<string, unknown> = {}): PageLibraryLine {
  return PageLibraryLineSchema.parse({
    library: 'widget',
    name: 'Widget',
    version: '2.1.0',
    answers: { from: '2.0.0', before: '3.0.0' },
    source: { kind: 'npm', package: 'widget', version: '2.1.0', sha256 },
    packages: ['widget'],
    include: ['build/widget.module.js', 'addons/'],
    module: { default: true, entries: { '.': 'build/widget.module.js', './addons/': 'addons/' } },
    license: 'MIT',
    notice: 'LICENSE',
    ...extra,
  });
}

const FILES = {
  'build/widget.module.js': 'export const widget = 1;\n',
  'build/widget.cjs': 'module.exports = 1;\n',
  'addons/extra.js': "import { widget } from 'widget';\nexport const extra = widget;\n",
  LICENSE: 'MIT License\n',
  'src/secret.js': 'never served\n',
};

describe('PageLibraryStore', () => {
  it('installs only the listed files, byte for byte, and serves them by address', async () => {
    const pkg = await tarball('widget', '2.1.0', FILES);
    const home = join(scratch, 'home');
    const store = new PageLibraryStore({ home, seedRoots: [] });

    const installed = await store.install({ line: line(pkg.sha256), tarballPath: pkg.path });

    expect(Object.keys(installed.files).sort()).toEqual([
      'LICENSE',
      'addons/extra.js',
      'build/widget.module.js',
    ]);
    expect(installed.dir).toBe(
      join(home, 'page-libraries', 'widget', `2.1.0-${pkg.sha256.slice(0, 12)}`),
    );
    expect(await readdir(join(home, 'page-libraries'))).toEqual(['widget']);
    expect((await store.lines()).map((entry) => `${entry.library}@${entry.version}`)).toEqual([
      'widget@2.1.0',
    ]);

    const served = await store.file('widget', '2.1.0', 'addons/extra.js');
    // Its own bare import is left as written: the page's import map answers it.
    expect(await readFile(served!, 'utf8')).toBe(FILES['addons/extra.js']);
    expect(await store.file('widget', '2.1.0', 'src/secret.js')).toBeNull();
    expect(await store.file('widget', '2.1.0', 'build/widget.cjs')).toBeNull();
    expect(await store.file('widget', '2.1.0', '../../../config.json')).toBeNull();
    expect(await store.file('widget', '9.9.9', 'build/widget.module.js')).toBeNull();
  });

  it('refuses a tarball that is not the one pinned, and leaves nothing behind', async () => {
    const pkg = await tarball('widget', '2.1.0', FILES);
    const home = join(scratch, 'home');
    const store = new PageLibraryStore({ home, seedRoots: [] });

    await expect(
      store.install({ line: line('b'.repeat(64)), tarballPath: pkg.path }),
    ).rejects.toThrow(/does not match its pinned hash/);
    expect(existsSync(join(home, 'page-libraries'))).toBe(false);
  });

  it('refuses a line that maps a request to a file the package lacks', async () => {
    const pkg = await tarball('widget', '2.1.0', FILES);
    const home = join(scratch, 'home');
    const store = new PageLibraryStore({ home, seedRoots: [] });
    const broken = line(pkg.sha256, {
      include: ['build/widget.module.js', 'build/widget.min.js'],
      module: { entries: { '.': 'build/widget.module.js' } },
      classic: { entries: { '.': 'build/widget.min.js' } },
    });

    await expect(store.install({ line: broken, tarballPath: pkg.path })).rejects.toThrow(
      /has no build\/widget\.min\.js/,
    );
    expect(await readdir(join(home, 'page-libraries'))).toEqual([]);
    expect(await store.lines()).toEqual([]);
  });

  it('does not serve a file that was changed after it was installed', async () => {
    const pkg = await tarball('widget', '2.1.0', FILES);
    const home = join(scratch, 'home');
    const installed = await new PageLibraryStore({ home, seedRoots: [] }).install({
      line: line(pkg.sha256),
      tarballPath: pkg.path,
    });
    await writeFile(join(installed.dir, 'build', 'widget.module.js'), 'export const widget = 2;\n');

    // A new process: nothing has been checked yet.
    const store = new PageLibraryStore({ home, seedRoots: [] });
    expect(await store.file('widget', '2.1.0', 'build/widget.module.js')).toBeNull();
    expect(await store.file('widget', '2.1.0', 'addons/extra.js')).not.toBeNull();
  });

  it('writes a module around a CommonJS file, and not around a changed one', async () => {
    const pkg = await tarball('widget', '2.1.0', FILES);
    const home = join(scratch, 'home');
    const cjs = line(pkg.sha256, {
      include: ['build/widget.cjs'],
      module: { default: true, entries: {} },
      commonjs: { '.': { file: 'build/widget.cjs', exports: [] } },
    });
    const installed = await new PageLibraryStore({ home, seedRoots: [] }).install({
      line: cjs,
      tarballPath: pkg.path,
    });

    const store = new PageLibraryStore({ home, seedRoots: [] });
    const written = await store.globalModule('widget', '2.1.0', '_gezel/index.js');
    expect(written).toContain(FILES['build/widget.cjs']);
    expect(written).toContain('export default __gezelExports;');
    expect(await store.globalModule('widget', '2.1.0', '_gezel/other.js')).toBeNull();

    await writeFile(join(installed.dir, 'build', 'widget.cjs'), 'module.exports = 2;\n');
    const fresh = new PageLibraryStore({ home, seedRoots: [] });
    expect(await fresh.globalModule('widget', '2.1.0', '_gezel/index.js')).toBeNull();
  });

  it('refuses a CommonJS spec whose file the package lacks', async () => {
    const pkg = await tarball('widget', '2.1.0', FILES);
    const store = new PageLibraryStore({ home: join(scratch, 'home'), seedRoots: [] });
    const broken = line(pkg.sha256, {
      include: ['build/widget.module.js'],
      module: { entries: { '.': 'build/widget.module.js' } },
      commonjs: { './x': { file: 'build/missing.cjs', exports: [] } },
    });
    await expect(store.install({ line: broken, tarballPath: pkg.path })).rejects.toThrow(
      /has no build\/missing\.cjs/,
    );
  });

  it('reads lines that shipped with the app, after the ones downloaded', async () => {
    const pkg = await tarball('widget', '2.1.0', FILES);
    const bundled = join(scratch, 'bundled-home');
    await new PageLibraryStore({ home: bundled, seedRoots: [] }).install({
      line: line(pkg.sha256),
      tarballPath: pkg.path,
    });
    const seed = join(bundled, 'page-libraries');

    const fromSeed = new PageLibraryStore({ home: join(scratch, 'empty-home'), seedRoots: [seed] });
    expect(await fromSeed.lines()).toHaveLength(1);
    expect(await fromSeed.file('widget', '2.1.0', 'build/widget.module.js')).toContain(seed);

    const fromEnv = new PageLibraryStore({
      home: join(scratch, 'empty-home'),
      env: { GEZEL_PAGE_LIBRARIES_DIR: seed },
    });
    expect(await fromEnv.lines()).toHaveLength(1);
  });
});
