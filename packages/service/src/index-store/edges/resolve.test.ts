import { describe, expect, it } from 'vitest';
import { IMPORT_FLAG } from '../index-store-types.js';
import { resolveFileEdges } from './resolve.js';
import type { EdgeFile, ProjectConfigFiles, RawImport } from './types.js';

const LANG: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  py: 'python',
  go: 'go',
  rs: 'rust',
  c: 'c',
  h: 'c',
  md: 'markdown',
};

function file(path: string): EdgeFile {
  const ext = path.slice(path.lastIndexOf('.') + 1);
  return { path, lang: LANG[ext] ?? null, kind: ext === 'md' ? 'markdown' : 'code' };
}

function configs(partial: Partial<ProjectConfigFiles> = {}): ProjectConfigFiles {
  return {
    tsconfigs: new Map(),
    packageJsons: new Map(),
    goMods: new Map(),
    cargoTomls: new Map(),
    ...partial,
  };
}

function row(srcPath: string, raw: string, extra: Partial<RawImport> = {}): RawImport {
  return { srcPath, raw, bindings: null, flags: 0, ...extra };
}

function resolve(paths: string[], imports: RawImport[], cfg = configs()) {
  return resolveFileEdges({ files: paths.map(file), imports, configs: cfg });
}

function pairs(paths: string[], imports: RawImport[], cfg = configs()) {
  return resolve(paths, imports, cfg).edges.map((e) => `${e.src} -> ${e.dst} (${e.resolver})`);
}

describe('resolveFileEdges', () => {
  it('resolves relative JS/TS imports exactly as the Village does', () => {
    expect(
      pairs(
        ['src/a.ts', 'src/b.ts', 'src/util/index.ts'],
        [row('src/a.ts', './b.js'), row('src/a.ts', './util'), row('src/a.ts', 'react')],
      ),
    ).toEqual(['src/a.ts -> src/b.ts (relative)', 'src/a.ts -> src/util/index.ts (relative)']);
  });

  it('follows tsconfig paths and baseUrl, through a relative extends', () => {
    const cfg = configs({
      tsconfigs: new Map<string, unknown>([
        ['tsconfig.base.json', { compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } }],
        ['app/tsconfig.json', { extends: '../tsconfig.base.json' }],
      ]),
    });
    expect(
      pairs(
        ['app/main.ts', 'src/ui/button.tsx', 'lib/format.ts'],
        [row('app/main.ts', '@/ui/button'), row('app/main.ts', 'lib/format')],
        cfg,
      ),
    ).toEqual([
      'app/main.ts -> lib/format.ts (ts-paths)',
      'app/main.ts -> src/ui/button.tsx (ts-paths)',
    ]);
  });

  it('maps a workspace package back to its source, subpaths included', () => {
    const cfg = configs({
      packageJsons: new Map<string, unknown>([
        [
          'packages/core/package.json',
          {
            name: '@acme/core',
            exports: {
              '.': { types: './dist/index.d.ts', import: './dist/index.js' },
              './paths': { import: './dist/paths.js' },
            },
          },
        ],
        ['packages/ui/package.json', { name: '@acme/ui', main: 'dist/index.js' }],
      ]),
    });
    expect(
      pairs(
        [
          'packages/core/src/index.ts',
          'packages/core/src/paths.ts',
          'packages/ui/src/index.tsx',
          'packages/app/src/main.ts',
        ],
        [
          row('packages/app/src/main.ts', '@acme/core'),
          row('packages/app/src/main.ts', '@acme/core/paths'),
          row('packages/app/src/main.ts', '@acme/ui'),
          row('packages/app/src/main.ts', '@acme/core-extras'),
        ],
        cfg,
      ),
    ).toEqual([
      'packages/app/src/main.ts -> packages/core/src/index.ts (workspace)',
      'packages/app/src/main.ts -> packages/core/src/paths.ts (workspace)',
      'packages/app/src/main.ts -> packages/ui/src/index.tsx (workspace)',
    ]);
  });

  it('resolves AMD module ids against the RequireJS base of the page that governs the importer', () => {
    const cfg = configs({
      requireJs: [
        {
          pageDir: 'src',
          baseDir: 'src',
          paths: { fileSystemImpl: 'filesystem/impls/appshell/AppshellFileSystem' },
        },
        { pageDir: 'test', baseDir: 'src', paths: { spec: '../test/spec' } },
      ],
    });
    const paths = [
      'src/editor/CodeHintManager.js',
      'src/command/Commands.js',
      'src/strings.js',
      'src/nls/strings.js',
      'src/htmlContent/main-view.html',
      'src/filesystem/impls/appshell/AppshellFileSystem.js',
      'src/utils/StringUtils.js',
      'test/spec/Editor-test.js',
      'test/spec/SpecRunnerUtils.js',
      'tools/build.js',
    ];
    expect(
      pairs(
        paths,
        [
          row('src/editor/CodeHintManager.js', 'command/Commands'),
          row('src/editor/CodeHintManager.js', 'strings'),
          row('src/editor/CodeHintManager.js', 'fileSystemImpl'),
          row('src/editor/CodeHintManager.js', 'text!htmlContent/main-view.html'),
          row('src/editor/CodeHintManager.js', 'i18n!nls/strings'),
          row('src/editor/CodeHintManager.js', 'lodash'),
          row('test/spec/Editor-test.js', 'spec/SpecRunnerUtils'),
          row('test/spec/Editor-test.js', 'utils/StringUtils'),
          // Outside every RequireJS page: a bare id stays an npm package.
          row('tools/build.js', 'utils/StringUtils'),
        ],
        cfg,
      ),
    ).toEqual([
      'src/editor/CodeHintManager.js -> src/command/Commands.js (requirejs)',
      'src/editor/CodeHintManager.js -> src/filesystem/impls/appshell/AppshellFileSystem.js (requirejs)',
      'src/editor/CodeHintManager.js -> src/htmlContent/main-view.html (requirejs)',
      'src/editor/CodeHintManager.js -> src/nls/strings.js (requirejs)',
      'src/editor/CodeHintManager.js -> src/strings.js (requirejs)',
      'test/spec/Editor-test.js -> src/utils/StringUtils.js (requirejs)',
      'test/spec/Editor-test.js -> test/spec/SpecRunnerUtils.js (requirejs)',
    ]);
  });

  it('falls back to a nested loader context only when the page base finds nothing', () => {
    const cfg = configs({ requireJs: [{ pageDir: 'src', baseDir: 'src', paths: {} }] });
    expect(
      pairs(
        [
          'src/extensions/default/Debug/main.js',
          'src/extensions/default/Debug/keyboard.json',
          'src/extensions/default/Debug/strings.js',
          'src/strings.js',
        ],
        [
          row('src/extensions/default/Debug/main.js', 'text!keyboard.json'),
          // Both exist: the page's base is what RequireJS loads.
          row('src/extensions/default/Debug/main.js', 'strings'),
        ],
        cfg,
      ),
    ).toEqual([
      'src/extensions/default/Debug/main.js -> src/extensions/default/Debug/keyboard.json (requirejs-local)',
      'src/extensions/default/Debug/main.js -> src/strings.js (requirejs)',
    ]);
  });

  it('resolves Python relative imports by dots and submodule names', () => {
    expect(
      pairs(
        ['pkg/__init__.py', 'pkg/a.py', 'pkg/b.py', 'pkg/sub/__init__.py', 'pkg/sub/c.py'],
        [
          row('pkg/sub/c.py', '..', {
            bindings: [
              { name: 'a', local: 'a', kind: 'named' },
              { name: 'b', local: 'b', kind: 'named' },
            ],
          }),
          row('pkg/a.py', '.sub', { bindings: [{ name: 'c', local: 'c', kind: 'named' }] }),
          row('pkg/b.py', '.', { bindings: [{ name: 'helper', local: 'helper', kind: 'named' }] }),
        ],
      ),
    ).toEqual([
      'pkg/a.py -> pkg/sub/__init__.py (py-rel)',
      'pkg/a.py -> pkg/sub/c.py (py-rel)',
      'pkg/b.py -> pkg/__init__.py (py-rel)',
      'pkg/sub/c.py -> pkg/a.py (py-rel)',
      'pkg/sub/c.py -> pkg/b.py (py-rel)',
    ]);
  });

  it('resolves Python absolute imports from the root, src/ and project folders', () => {
    expect(
      pairs(
        [
          'src/shop/cart.py',
          'src/shop/__init__.py',
          'tools/pyproject.toml',
          'tools/fmt.py',
          'app.py',
        ],
        [row('app.py', 'shop.cart'), row('app.py', 'fmt'), row('app.py', 'os.path')],
      ),
    ).toEqual(['app.py -> src/shop/cart.py (py-abs)', 'app.py -> tools/fmt.py (py-abs)']);
  });

  it('turns a Go package import into edges to its non-test files', () => {
    const cfg = configs({ goMods: new Map([['go.mod', 'module example.com/shop\n\ngo 1.22\n']]) });
    expect(
      pairs(
        ['cmd/main.go', 'cart/cart.go', 'cart/total.go', 'cart/cart_test.go'],
        [row('cmd/main.go', 'example.com/shop/cart'), row('cmd/main.go', 'fmt')],
        cfg,
      ),
    ).toEqual(['cmd/main.go -> cart/cart.go (go-mod)', 'cmd/main.go -> cart/total.go (go-mod)']);
  });

  it('resolves Rust mod declarations and crate/self/super paths', () => {
    const cfg = configs({
      cargoTomls: new Map([['Cargo.toml', '[package]\nname = "shop-core"\n']]),
    });
    expect(
      pairs(
        ['src/lib.rs', 'src/cart.rs', 'src/cart/item.rs', 'src/money.rs'],
        [
          row('src/lib.rs', 'mod cart'),
          row('src/cart.rs', 'mod item'),
          row('src/cart/item.rs', 'super::super::money::Money'),
          row('src/cart.rs', 'crate::money::{Money,Currency}'),
          row('src/money.rs', 'std::fmt'),
        ],
        cfg,
      ),
    ).toEqual([
      'src/cart.rs -> src/cart/item.rs (rust)',
      'src/cart.rs -> src/money.rs (rust)',
      'src/cart/item.rs -> src/money.rs (rust)',
      'src/lib.rs -> src/cart.rs (rust)',
    ]);
  });

  it('finds quoted C headers beside, under include/, or by a unique suffix', () => {
    expect(
      pairs(
        ['src/main.c', 'src/util.h', 'include/shop/cart.h', 'third_party/zlib/zlib.h'],
        [
          row('src/main.c', 'util.h'),
          row('src/main.c', 'shop/cart.h'),
          row('src/main.c', 'zlib.h'),
          row('src/main.c', '<stdio.h>'),
        ],
      ),
    ).toEqual([
      'src/main.c -> include/shop/cart.h (c-include)',
      'src/main.c -> src/util.h (c-include)',
      'src/main.c -> third_party/zlib/zlib.h (c-include)',
    ]);
  });

  it('links documents to files, folders and root-absolute paths', () => {
    const graph = resolve(
      ['docs/guide.md', 'docs/setup/README.md', 'README.md', 'src/app.ts', 'docs/faq.md'],
      [
        row('README.md', './docs/guide.md'),
        row('docs/guide.md', './setup'),
        row('docs/guide.md', '/src/app.ts'),
        row('docs/guide.md', './faq'),
        row('docs/guide.md', './missing.md'),
      ],
    );
    expect(graph.edges.map((e) => `${e.src} -> ${e.dst} [${e.kind}]`)).toEqual([
      'README.md -> docs/guide.md [link]',
      'docs/guide.md -> docs/faq.md [link]',
      'docs/guide.md -> docs/setup/README.md [link]',
      'docs/guide.md -> src/app.ts [link]',
    ]);
  });

  it('carries bindings and flags, and counts coverage per language', () => {
    const graph = resolve(
      ['src/a.ts', 'src/b.ts', 'src/c.ts', 'lib/x.py'],
      [
        row('src/a.ts', './b', {
          bindings: [{ name: 'B', local: 'B', kind: 'named' }],
          flags: IMPORT_FLAG.typeOnly,
        }),
        row('src/c.ts', 'lodash'),
        row('lib/x.py', 'requests'),
      ],
    );
    expect(graph.edges).toEqual([
      {
        src: 'src/a.ts',
        dst: 'src/b.ts',
        raw: './b',
        kind: 'import',
        resolver: 'relative',
        bindings: [{ name: 'B', local: 'B', kind: 'named' }],
        flags: IMPORT_FLAG.typeOnly,
      },
    ]);
    expect(graph.coverage.typescript).toEqual({
      files: 3,
      filesWithImports: 2,
      filesWithEdges: 1,
      edges: 1,
    });
    expect(graph.coverage.python).toEqual({
      files: 1,
      filesWithImports: 1,
      filesWithEdges: 0,
      edges: 0,
    });
  });

  it('never makes an edge from a file to itself or from a file that is gone', () => {
    expect(pairs(['src/a.ts'], [row('src/a.ts', './a'), row('src/gone.ts', './a')])).toEqual([]);
  });
});
