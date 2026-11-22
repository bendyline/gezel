import { describe, expect, it } from 'vitest';
import { type PageLibraryLine, PageLibraryLineSchema } from '../schemas/page-library.js';
import { collectPageLibraries, pinsForUses } from './collect.js';
import {
  commonJsModuleSource,
  commonJsModuleSpec,
  globalModuleCommonJs,
  globalModulePath,
  globalModuleSource,
} from './globals.js';
import {
  type ModuleImport,
  locateScriptsAndLinks,
  rewriteModuleLibraryImports,
  rewritePageLibraries,
} from './html-rewrite.js';
import { buildPageImportMap, mergeAuthoredImportMap } from './import-map.js';
import { compileInlineJsx, isBabelStandaloneUrl } from './jsx.js';
import { listedPageLibraries, pageLibrariesNote } from './note.js';
import { phoneLibraryFiles } from './phone.js';
import {
  isPageLibrarySpecifier,
  pageLibraryFileUrl,
  parseCdnUrl,
  pickPageLibraryLine,
  requestedVersionRange,
  resolvePageLibrarySpecifier,
  resolvePageLibraryUrl,
} from './resolver.js';

const SHA = 'a'.repeat(64);
function line(input: Record<string, unknown>): PageLibraryLine {
  return PageLibraryLineSchema.parse({
    license: 'MIT',
    source: { kind: 'npm', package: input.library, version: input.version, sha256: SHA },
    ...input,
  });
}

const THREE = line({
  library: 'three',
  name: 'three.js',
  version: '0.185.2',
  answers: { from: '0.160.0', before: '1.0.0' },
  packages: ['three'],
  include: ['build/three.module.js', 'build/three.core.js', 'examples/jsm/'],
  module: {
    default: true,
    entries: {
      '.': 'build/three.module.js',
      './addons/': 'examples/jsm/',
      './examples/jsm/': 'examples/jsm/',
    },
  },
});
const THREE_CLASSIC = line({
  library: 'three',
  name: 'three.js',
  version: '0.128.0',
  answers: { from: '0.100.0', before: '0.160.0' },
  packages: ['three'],
  include: ['build/three.min.js', 'build/three.module.js', 'examples/js/', 'examples/jsm/'],
  module: { entries: { '.': 'build/three.module.js', './examples/jsm/': 'examples/jsm/' } },
  classic: { default: true, global: 'THREE', entries: { '.': 'build/three.min.js' } },
  paths: { 'build/three.js': 'build/three.min.js' },
  cdnjs: {
    name: 'three.js',
    files: { 'three.min.js': 'build/three.min.js', 'three.js': 'build/three.min.js' },
  },
});
const REACT = line({
  library: 'react',
  name: 'React',
  version: '18.3.1',
  answers: { from: '18.0.0', before: '19.0.0' },
  packages: ['react'],
  include: ['umd/react.production.min.js'],
  classic: { default: true, global: 'React', entries: { '.': 'umd/react.production.min.js' } },
  paths: { 'umd/react.development.js': 'umd/react.production.min.js' },
});
const CHART = line({
  library: 'chart.js',
  name: 'Chart.js',
  version: '4.6.1',
  answers: { from: '4.0.0', before: '5.0.0' },
  packages: ['chart.js'],
  include: ['dist/'],
  module: { default: true, entries: { '.': 'dist/chart.js', './auto': 'dist/auto.js' } },
  classic: { default: true, global: 'Chart', entries: { '.': 'dist/chart.umd.js' } },
  requires: { '@kurkle/color': '^0.3.0' },
});
const COLOR = line({
  library: 'kurkle-color',
  name: '@kurkle/color',
  version: '0.3.4',
  answers: { from: '0.3.0', before: '0.4.0' },
  packages: ['@kurkle/color'],
  include: ['dist/color.esm.js'],
  module: { default: true, entries: { '.': 'dist/color.esm.js' } },
});
const D3 = line({
  library: 'd3',
  name: 'D3',
  version: '7.9.2',
  answers: { from: '7.0.0', before: '8.0.0' },
  packages: ['d3'],
  include: ['dist/d3.min.js'],
  classic: { default: true, global: 'd3', entries: { '.': 'dist/d3.min.js' } },
  urls: [{ url: 'https://d3js.org/d3.v7.min.js', form: 'classic', path: 'dist/d3.min.js' }],
});
const SHELF = [THREE, THREE_CLASSIC, REACT, CHART, COLOR, D3];
const BASE = '/preview/cap/lib/';

/** Enough of an import scanner for the fixtures here. */
function scanImports(code: string): ModuleImport[] {
  const found: ModuleImport[] = [];
  for (const match of code.matchAll(/(?:from\s+|import\s*\(?\s*)(["'])([^"']+)\1/g)) {
    // The real scanner skips `import type`, which loads nothing.
    if (code.slice(code.lastIndexOf('import', match.index), match.index).startsWith('import type'))
      continue;
    const start = match.index + match[0].lastIndexOf(match[2]!);
    found.push({ specifier: match[2]!, start, end: start + match[2]!.length });
  }
  return found;
}

describe('requestedVersionRange', () => {
  it('reads what a spelling asks for', () => {
    expect(requestedVersionRange('18')).toEqual({ from: [18, 0, 0], before: [19, 0, 0] });
    expect(requestedVersionRange('18.2')).toEqual({ from: [18, 2, 0], before: [18, 3, 0] });
    expect(requestedVersionRange('0.160.0')).toEqual({ from: [0, 160, 0], before: [0, 160, 1] });
    expect(requestedVersionRange('^18.2.0')).toEqual({ from: [18, 2, 0], before: [19, 0, 0] });
    expect(requestedVersionRange('^0.160.0')).toEqual({ from: [0, 160, 0], before: [0, 161, 0] });
    expect(requestedVersionRange('r128')).toEqual({ from: [0, 128, 0], before: [0, 129, 0] });
    expect(requestedVersionRange('latest')).toBeNull();
    expect(requestedVersionRange(undefined)).toBeNull();
  });
});

describe('pickPageLibraryLine', () => {
  const three = [THREE, THREE_CLASSIC];
  it('answers by form first, then version, then the default', () => {
    expect(pickPageLibraryLine(three, 'module')?.line.version).toBe('0.185.2');
    expect(pickPageLibraryLine(three, 'classic')?.line.version).toBe('0.128.0');
    expect(pickPageLibraryLine(three, 'module', '0.128.0')?.line.version).toBe('0.128.0');
    expect(pickPageLibraryLine(three, 'module', '0.170')?.line.version).toBe('0.185.2');
    expect(pickPageLibraryLine(three, 'style')).toBeNull();
  });

  it('falls to the default with a note when no line answers the version', () => {
    // three dropped its plain-script build; a page asking for one at 0.170 gets 0.128.
    const picked = pickPageLibraryLine(three, 'classic', '0.170.0');
    expect(picked?.line.version).toBe('0.128.0');
    expect(picked?.note).toContain('0.170.0 is not available here');
  });
});

describe('parseCdnUrl', () => {
  it('reads each CDN the way that CDN lays out a package', () => {
    expect(parseCdnUrl('https://unpkg.com/three@0.160.0/build/three.module.js')).toEqual({
      package: 'three',
      version: '0.160.0',
      path: 'build/three.module.js',
    });
    expect(parseCdnUrl('https://cdn.jsdelivr.net/npm/chart.js')).toEqual({
      package: 'chart.js',
      path: '',
    });
    expect(parseCdnUrl('https://cdn.jsdelivr.net/npm/d3@7/+esm')).toEqual({
      package: 'd3',
      version: '7',
      path: '',
    });
    expect(parseCdnUrl('https://esm.sh/v135/react-dom@19.0.0/client?dev')).toEqual({
      package: 'react-dom',
      version: '19.0.0',
      path: 'client',
    });
    expect(parseCdnUrl('//cdn.jsdelivr.net/npm/@tailwindcss/browser@4')).toEqual({
      package: '@tailwindcss/browser',
      version: '4',
      path: '',
    });
    expect(
      parseCdnUrl('https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js'),
    ).toEqual({ cdnjs: 'three.js', version: 'r128', path: 'three.min.js' });
    expect(parseCdnUrl('https://ga.jspm.io/npm:three@0.160.0/build/three.module.js')).toEqual({
      package: 'three',
      version: '0.160.0',
      path: 'build/three.module.js',
    });
  });

  it('leaves everything that is not a library CDN alone', () => {
    expect(parseCdnUrl('https://example.com/three.js')).toBeNull();
    expect(parseCdnUrl('https://cdn.jsdelivr.net/gh/user/repo/file.js')).toBeNull();
    expect(parseCdnUrl('./three.js')).toBeNull();
    expect(parseCdnUrl('data:text/javascript,1')).toBeNull();
  });
});

describe('one address per file', () => {
  // The browser keys a module by its URL: two answers would run three.js twice.
  it('resolves every spelling of three to the same file', () => {
    const expected = '/preview/cap/lib/three/0.185.2/build/three.module.js';
    const spellings = [
      resolvePageLibrarySpecifier(SHELF, 'three'),
      resolvePageLibraryUrl(
        SHELF,
        'https://unpkg.com/three@0.170.0/build/three.module.js',
        'module',
      ),
      resolvePageLibraryUrl(SHELF, 'https://cdn.jsdelivr.net/npm/three@0.185/+esm', 'module'),
      resolvePageLibraryUrl(SHELF, 'https://esm.sh/three', 'module'),
      resolvePageLibraryUrl(SHELF, 'https://cdn.skypack.dev/three@0.170.0', 'module'),
    ];
    for (const file of spellings) expect(file && pageLibraryFileUrl(BASE, file)).toBe(expected);
    expect(buildPageImportMap(SHELF, BASE).imports.three).toBe(expected);
  });

  it('maps addons and subpaths', () => {
    const addon = '/preview/cap/lib/three/0.185.2/examples/jsm/controls/OrbitControls.js';
    for (const file of [
      resolvePageLibrarySpecifier(SHELF, 'three/addons/controls/OrbitControls.js'),
      resolvePageLibrarySpecifier(SHELF, 'three/examples/jsm/controls/OrbitControls.js'),
      resolvePageLibraryUrl(
        SHELF,
        'https://unpkg.com/three@0.170.0/examples/jsm/controls/OrbitControls.js',
        'module',
      ),
    ]) {
      expect(file && pageLibraryFileUrl(BASE, file)).toBe(addon);
    }
    expect(resolvePageLibrarySpecifier(SHELF, 'chart.js/auto')?.path).toBe('dist/auto.js');
    expect(resolvePageLibrarySpecifier(SHELF, 'three/not/there.js')).toBeNull();
    expect(resolvePageLibrarySpecifier(SHELF, 'phaser')).toBeNull();
    expect(isPageLibrarySpecifier(SHELF, 'three/anything')).toBe(true);
    expect(isPageLibrarySpecifier(SHELF, 'react')).toBe(false);
    expect(isPageLibrarySpecifier(SHELF, './three')).toBe(false);
  });

  it('answers the plain-script spellings models write', () => {
    const cdnjs = resolvePageLibraryUrl(
      SHELF,
      'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js',
      'classic',
    );
    expect(cdnjs && pageLibraryFileUrl(BASE, cdnjs)).toBe(
      '/preview/cap/lib/three/0.128.0/build/three.min.js',
    );
    expect(
      resolvePageLibraryUrl(SHELF, 'https://unpkg.com/react@18/umd/react.development.js', 'classic')
        ?.path,
    ).toBe('umd/react.production.min.js');
    expect(
      resolvePageLibraryUrl(SHELF, 'https://cdn.jsdelivr.net/npm/chart.js', 'classic')?.path,
    ).toBe('dist/chart.umd.js');
    expect(resolvePageLibraryUrl(SHELF, 'https://d3js.org/d3.v7.min.js', 'classic')?.path).toBe(
      'dist/d3.min.js',
    );
    // A file the line does not carry is not answered with a different one.
    expect(
      resolvePageLibraryUrl(
        SHELF,
        'https://unpkg.com/react@18/cjs/react.development.js',
        'classic',
      ),
    ).toBeNull();
    expect(resolvePageLibraryUrl(SHELF, 'https://unpkg.com/phaser@3', 'classic')).toBeNull();
  });
});

describe('buildPageImportMap', () => {
  const map = buildPageImportMap(SHELF, BASE);

  it('answers bare imports with each default module line', () => {
    expect(map.imports).toMatchObject({
      three: '/preview/cap/lib/three/0.185.2/build/three.module.js',
      'three/addons/': '/preview/cap/lib/three/0.185.2/examples/jsm/',
      'chart.js': '/preview/cap/lib/chart.js/4.6.1/dist/chart.js',
      'chart.js/auto': '/preview/cap/lib/chart.js/4.6.1/dist/auto.js',
      '@kurkle/color': '/preview/cap/lib/kurkle-color/0.3.4/dist/color.esm.js',
    });
    expect(map.imports.react).toBeUndefined();
  });

  it("scopes an older line's files to that line", () => {
    // 0.128's addons import `three`; on a page that loaded 0.128 by address
    // they must not pull in 0.185 as a second copy.
    expect(map.scopes['/preview/cap/lib/three/0.128.0/']).toMatchObject({
      three: '/preview/cap/lib/three/0.128.0/build/three.module.js',
    });
    expect(map.scopes['/preview/cap/lib/three/0.185.2/']).toBeUndefined();
  });
});

describe('mergeAuthoredImportMap', () => {
  const ours = buildPageImportMap(SHELF, BASE);

  it("turns the page's CDN addresses into shelf addresses and lets the page win", () => {
    const authored = JSON.stringify({
      imports: {
        three: 'https://unpkg.com/three@0.128.0/build/three.module.js',
        'three/addons/': 'https://unpkg.com/three@0.128.0/examples/jsm/',
        mine: './vendor/mine.js',
        elsewhere: 'https://example.com/lib.js',
      },
    });
    const { map, notes } = mergeAuthoredImportMap(authored, ours, SHELF, BASE);
    expect(map.imports.three).toBe('/preview/cap/lib/three/0.128.0/build/three.module.js');
    expect(map.imports['three/addons/']).toBe('/preview/cap/lib/three/0.128.0/examples/jsm/');
    expect(map.imports.mine).toBe('./vendor/mine.js');
    expect(map.imports.elsewhere).toBe('https://example.com/lib.js');
    expect(map.imports['chart.js']).toBe(ours.imports['chart.js']);
    expect(notes).toEqual([]);
  });

  it('replaces a map the browser could not read', () => {
    const { map, notes } = mergeAuthoredImportMap('{ imports: ', ours, SHELF, BASE);
    expect(map).toBe(ours);
    expect(notes[0]).toContain('not valid JSON');
  });
});

describe('locateScriptsAndLinks', () => {
  it('finds tags with exact offsets and skips what only looks like one', () => {
    const html = [
      '<!-- <script src="https://unpkg.com/three"></script> -->',
      '<style>a::after{content:"<script src=x>"}</style>',
      '<link rel=stylesheet href="a.css">',
      `<script type="module" src='m.js' async></script>`,
      '<script>var s = "<script src=nested>";</script>',
      '<SCRIPT SRC=upper.js></SCRIPT>',
    ].join('\n');
    const parts = locateScriptsAndLinks(html);
    expect(parts.map((part) => part.tag)).toEqual(['link', 'script', 'script', 'script']);
    const src = parts[1]!.attributes.find((entry) => entry.name === 'src')!;
    expect(html.slice(src.valueStart, src.valueEnd)).toBe('m.js');
    expect(parts[1]!.attributes.map((entry) => entry.name)).toEqual(['type', 'src', 'async']);
    expect(html.slice(parts[2]!.bodyStart, parts[2]!.bodyEnd)).toBe(
      'var s = "<script src=nested>";',
    );
    expect(parts[3]!.attributes[0]).toMatchObject({ name: 'src', value: 'upper.js' });
  });

  it('survives markup that is not well formed', () => {
    expect(locateScriptsAndLinks('<script src="open')).toHaveLength(1);
    expect(locateScriptsAndLinks('< a <<script>x')).toHaveLength(1);
    expect(locateScriptsAndLinks('<a ="x"><link href=y>')).toHaveLength(1);
  });
});

describe('rewritePageLibraries', () => {
  const ctx = { lines: SHELF, base: BASE, scanImports };

  it('leaves a page alone when the shelf is empty', () => {
    const html = '<script src="https://unpkg.com/three"></script>';
    expect(rewritePageLibraries(html, { lines: [], base: BASE })).toEqual({
      html,
      importMap: null,
      notes: [],
    });
  });

  it('points plain-script and stylesheet tags at the shelf and drops their hashes', () => {
    const html = [
      '<script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js" integrity="sha512-x" crossorigin="anonymous"></script>',
      '<script src=https://cdn.jsdelivr.net/npm/chart.js></script>',
      '<script src="https://example.com/other.js"></script>',
      '<script src="./local.js"></script>',
      '<script type="text/babel" src="https://unpkg.com/react@18"></script>',
    ].join('\n');
    const out = rewritePageLibraries(html, ctx).html;
    expect(out).toContain(
      '<script src="/preview/cap/lib/three/0.128.0/build/three.min.js" crossorigin="anonymous"></script>',
    );
    expect(out).toContain(
      '<script src=/preview/cap/lib/chart.js/4.6.1/dist/chart.umd.js></script>',
    );
    expect(out).toContain('<script src="https://example.com/other.js"></script>');
    expect(out).toContain('<script src="./local.js"></script>');
    expect(out).toContain('<script type="text/babel" src="https://unpkg.com/react@18"></script>');
  });

  it('adds one import map when the page has none', () => {
    const html = '<script type="module">import * as THREE from "three";</script>';
    const out = rewritePageLibraries(html, ctx);
    expect(out.html).toBe(html);
    expect(out.importMap).toMatch(/^<script type="importmap">\{"imports":\{/);
    expect(out.importMap).toContain(
      '"three":"/preview/cap/lib/three/0.185.2/build/three.module.js"',
    );
  });

  it("merges into the page's own import map instead of adding a second", () => {
    const html = [
      '<script type="importmap">{"imports":{"three":"https://unpkg.com/three@0.160.0/build/three.module.js"}}</script>',
      '<script type="module">',
      'import { OrbitControls } from "https://unpkg.com/three@0.160.0/examples/jsm/controls/OrbitControls.js";',
      'import("https://esm.sh/chart.js@4/auto");',
      'import local from "./local.js";',
      '</script>',
    ].join('\n');
    const out = rewritePageLibraries(html, ctx);
    expect(out.importMap).toBeNull();
    expect(out.html.match(/type="importmap"/g)).toHaveLength(1);
    expect(out.html).toContain('"three":"/preview/cap/lib/three/0.185.2/build/three.module.js"');
    expect(out.html).toContain('"chart.js":"/preview/cap/lib/chart.js/4.6.1/dist/chart.js"');
    expect(out.html).toContain(
      'from "/preview/cap/lib/three/0.185.2/examples/jsm/controls/OrbitControls.js"',
    );
    expect(out.html).toContain('import("/preview/cap/lib/chart.js/4.6.1/dist/auto.js")');
    expect(out.html).toContain('from "./local.js"');
  });

  it('says when a version was swapped', () => {
    const html = '<script src="https://unpkg.com/react@17/umd/react.production.min.js"></script>';
    const out = rewritePageLibraries(html, ctx);
    expect(out.html).toContain('/preview/cap/lib/react/18.3.1/umd/react.production.min.js');
    expect(out.notes).toEqual(['React 17 is not available here; this page runs on 18.3.1.']);
  });
});

describe('rewriteModuleLibraryImports', () => {
  it('rewrites only CDN imports the shelf answers', () => {
    const code = [
      'import * as THREE from "https://esm.sh/three@0.185";',
      'import x from "https://example.com/x.js";',
      'import { h } from "preact";',
    ].join('\n');
    const out = rewriteModuleLibraryImports(code, scanImports(code), { lines: SHELF, base: BASE });
    expect(out.code).toBe(
      [
        'import * as THREE from "/preview/cap/lib/three/0.185.2/build/three.module.js";',
        'import x from "https://example.com/x.js";',
        'import { h } from "preact";',
      ].join('\n'),
    );
  });
});

describe('project pins', () => {
  const NEWER = line({
    library: 'three',
    name: 'three.js',
    version: '0.190.0',
    answers: { from: '0.160.0', before: '1.0.0' },
    packages: ['three'],
    include: ['build/three.module.js'],
    module: { default: true, entries: { '.': 'build/three.module.js' } },
  });
  const UNDEFAULTED = { ...THREE, module: { ...THREE.module!, default: false } };
  const moved = [NEWER, UNDEFAULTED, THREE_CLASSIC];

  it('keeps the version a project settled on when the default moves', () => {
    expect(pickPageLibraryLine(moved, 'module')?.line.version).toBe('0.190.0');
    const pins = { three: { module: '0.185.2' } };
    expect(pickPageLibraryLine(moved, 'module', undefined, pins)?.line.version).toBe('0.185.2');
    expect(buildPageImportMap(moved, BASE, pins).imports.three).toBe(
      '/preview/cap/lib/three/0.185.2/build/three.module.js',
    );
    // A spelling that names a version still wins over the pin.
    expect(pickPageLibraryLine(moved, 'module', '0.190', pins)?.line.version).toBe('0.190.0');
    // A pin the shelf no longer carries falls to the default.
    expect(
      pickPageLibraryLine(moved, 'module', undefined, { three: { module: '0.170.0' } })?.line
        .version,
    ).toBe('0.190.0');
  });

  it('pins only uses that named no version, and only once', () => {
    const uses = [
      { line: THREE, form: 'module' as const, spelling: 'three', from: 'a.js', versioned: false },
      {
        line: THREE_CLASSIC,
        form: 'classic' as const,
        spelling: 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js',
        from: 'index.html',
        versioned: true,
      },
    ];
    expect(pinsForUses(uses)).toEqual({ three: { module: '0.185.2' } });
    expect(pinsForUses(uses, { three: { module: '0.170.0' } })).toBeNull();
  });
});

describe('collectPageLibraries', () => {
  const files: Record<string, string> = {
    'game/index.html': [
      '<script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>',
      '<script src="https://unpkg.com/phaser@3/dist/phaser.min.js"></script>',
      '<script src="https://example.com/analytics.js"></script>',
      '<script type="importmap">{"imports":{"vendor/":"./vendor/","d3":"https://d3js.org/d3.v7.min.js"}}</script>',
      '<script type="module">import Chart from "chart.js/auto"; import "./boot.js";</script>',
      '<script type="module" src="/src/main.ts"></script>',
    ].join('\n'),
    'game/boot.js': 'export const booted = true;\n',
    'game/src/main.ts': [
      "import * as THREE from 'three';",
      "import type { Scene } from 'three';",
      "import { OrbitControls } from 'three/addons/controls/OrbitControls.js';",
      "import { units } from './units';",
      "import gsap from 'gsap';",
      "import x from 'https://esm.sh/lodash-es@4';",
    ].join('\n'),
    'game/src/units.ts': "import { name } from '@kurkle/color';\nexport const units = [name];\n",
  };
  const read = async (path: string) => files[path] ?? null;

  it("finds every library a page and its modules use, and what the shelf can't answer", async () => {
    const found = await collectPageLibraries({
      entry: 'game/index.html',
      read,
      lines: SHELF,
      scanImports,
    });
    expect(
      found.uses.map((use) => `${use.form} ${use.line.library}@${use.line.version} ${use.from}`),
    ).toEqual([
      'classic three@0.128.0 game/index.html',
      'module chart.js@4.6.1 game/index.html',
      'module three@0.185.2 game/src/main.ts',
      'module three@0.185.2 game/src/main.ts',
      'module kurkle-color@0.3.4 game/src/units.ts',
    ]);
    expect(found.unknown).toEqual([
      {
        spelling: 'https://unpkg.com/phaser@3/dist/phaser.min.js',
        from: 'game/index.html',
        kind: 'url',
      },
      { spelling: 'gsap', from: 'game/src/main.ts', kind: 'package' },
      { spelling: 'https://esm.sh/lodash-es@4', from: 'game/src/main.ts', kind: 'url' },
    ]);
    // Chart.js requires @kurkle/color, so it is needed even unused.
    expect(found.lines.map((entry) => `${entry.library}@${entry.version}`).sort()).toEqual([
      'chart.js@4.6.1',
      'kurkle-color@0.3.4',
      'three@0.128.0',
      'three@0.185.2',
    ]);
    // The authored map's d3 address is a plain-script build; as a module it answers nothing.
    expect(found.uses.some((use) => use.line.library === 'd3')).toBe(false);
  });

  it('stops after the file limit', async () => {
    const found = await collectPageLibraries({
      entry: 'game/index.html',
      read,
      lines: SHELF,
      scanImports,
      maxFiles: 1,
    });
    expect(found.uses.some((use) => use.from === 'game/src/units.ts')).toBe(false);
  });
});

describe('pageLibrariesNote', () => {
  it('names each library a page can load, and leaves out what only another loads', () => {
    expect(
      listedPageLibraries(SHELF).map(
        (entry) => `${entry.name} ${entry.version}${entry.scriptOnly ? ' script' : ''}`,
      ),
    ).toEqual(['Chart.js 4', 'D3 7 script', 'React 18 script', 'three.js 0.185', 'three.js 0.128']);
    const note = pageLibrariesNote(SHELF)!;
    expect(note).toContain(
      'Chart.js 4, D3 7 as a script tag, React 18 as a script tag, three.js 0.185 or 0.128',
    );
    expect(note).not.toContain('kurkle');
    expect(note).toContain("`import * as THREE from 'three'`");
    expect(note).toContain('No other library will load.');
  });

  it('says nothing when the shelf is empty', () => {
    expect(pageLibrariesNote([])).toBeNull();
  });
});

describe('modules written over a plain-script global', () => {
  const REACT = line({
    library: 'react',
    name: 'React',
    version: '18.3.1',
    answers: { from: '16.0.0', before: '19.0.0' },
    packages: ['react'],
    include: ['umd/react.production.min.js'],
    module: { default: true, entries: {} },
    classic: { default: true, global: 'React', entries: { '.': 'umd/react.production.min.js' } },
    globals: {
      '.': {
        global: 'React',
        file: 'umd/react.production.min.js',
        exports: ['useState', 'createElement'],
      },
      './jsx-runtime': { global: 'React', file: 'umd/react.production.min.js', jsxRuntime: true },
    },
  });
  const DOM = line({
    library: 'react-dom',
    name: 'React DOM',
    version: '18.3.1',
    answers: { from: '16.0.0', before: '19.0.0' },
    packages: ['react-dom'],
    include: ['umd/react-dom.production.min.js'],
    module: { default: true, entries: {} },
    globals: {
      './client': {
        global: 'ReactDOM',
        file: 'umd/react-dom.production.min.js',
        exports: ['createRoot'],
        after: ['react'],
      },
    },
    requires: { react: '^18.0.0' },
  });

  it('answers module requests with an address under the line', () => {
    expect(globalModulePath('.')).toBe('_gezel/index.js');
    expect(globalModulePath('./jsx-runtime')).toBe('_gezel/jsx-runtime.js');
    expect(resolvePageLibrarySpecifier([REACT, DOM], 'react')?.path).toBe('_gezel/index.js');
    expect(resolvePageLibrarySpecifier([REACT, DOM], 'react-dom/client')?.path).toBe(
      '_gezel/client.js',
    );
    expect(resolvePageLibrarySpecifier([REACT, DOM], 'react-dom')).toBeNull();
    const map = buildPageImportMap([REACT, DOM], BASE);
    expect(map.imports).toMatchObject({
      react: '/preview/cap/lib/react/18.3.1/_gezel/index.js',
      'react/jsx-runtime': '/preview/cap/lib/react/18.3.1/_gezel/jsx-runtime.js',
      'react-dom/client': '/preview/cap/lib/react-dom/18.3.1/_gezel/client.js',
    });
  });

  it('writes a module that loads the build, after what it needs, and hands the global on', () => {
    expect(globalModuleSource(DOM, '_gezel/client.js')).toBe(
      [
        "// Written by Gezel from React DOM 18.3.1's umd/react-dom.production.min.js (docs/page-libraries.md).",
        'import "react";',
        'import "../umd/react-dom.production.min.js";',
        'const g = globalThis["ReactDOM"];',
        'export default g;',
        'export const { createRoot } = g;',
        '',
      ].join('\n'),
    );
    expect(globalModuleSource(REACT, '_gezel/jsx-runtime.js')).toContain(
      'export function jsxs(type, props, key)',
    );
    expect(globalModuleSource(REACT, '_gezel/other.js')).toBeNull();
    expect(globalModuleSource(REACT, 'umd/react.production.min.js')).toBeNull();
    expect(globalModuleCommonJs(REACT, '_gezel/index.js')).toBe(
      'module.exports = globalThis["React"];\n',
    );
    expect(globalModuleCommonJs(REACT, '_gezel/jsx-runtime.js')).toContain(
      'module.exports = { Fragment, jsx, jsxs, jsxDEV };',
    );
  });
});

describe('compileInlineJsx', () => {
  const compile = (code: string, path: string) => ({
    code: `/* ${path} */ ${code.trim()}`,
    imports: [],
    errors: code.includes('<<') ? ['bad JSX'] : [],
  });

  it('compiles JSX scripts into module scripts and drops the in-browser compiler', () => {
    const html = [
      '<script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>',
      '<script src="https://unpkg.com/react@18/umd/react.development.js"></script>',
      '<script type="text/babel">render(<App />)</script>',
      '<script type="text/babel" data-presets="react,typescript">const n: number = 1</script>',
    ].join('\n');
    expect(compileInlineJsx(html, compile)).toBe(
      [
        '',
        '<script src="https://unpkg.com/react@18/umd/react.development.js"></script>',
        '<script type="module">/* inline-1.jsx */ render(<App />)</script>',
        '<script type="module">/* inline-2.tsx */ const n: number = 1</script>',
      ].join('\n'),
    );
  });

  it('leaves a page without JSX scripts alone, Babel tag and all', () => {
    const html =
      '<script src="https://cdnjs.cloudflare.com/ajax/libs/babel-standalone/6.26.0/babel.min.js"></script>';
    expect(compileInlineJsx(html, compile)).toBe(html);
    expect(
      isBabelStandaloneUrl(
        'https://cdnjs.cloudflare.com/ajax/libs/babel-standalone/6.26.0/babel.min.js',
      ),
    ).toBe(true);
    expect(isBabelStandaloneUrl('https://unpkg.com/react@18')).toBe(false);
  });

  it('leaves a JSX script with a src, and the Babel tag that loads it, alone', () => {
    // Its empty body was once compiled into an empty module and Babel dropped,
    // so the page rendered blank.
    const html = [
      '<script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>',
      '<script type="text/babel" src="app.jsx"></script>',
    ].join('\n');
    expect(compileInlineJsx(html, compile)).toBe(html);
  });

  it('compiles inline JSX but keeps Babel while a JSX script with a src remains', () => {
    const html = [
      '<script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>',
      '<script type="text/babel">render(<App />)</script>',
      '<script type="text/babel" src="widgets.jsx"></script>',
    ].join('\n');
    expect(compileInlineJsx(html, compile)).toBe(
      [
        '<script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>',
        '<script type="module">/* inline-1.jsx */ render(<App />)</script>',
        '<script type="text/babel" src="widgets.jsx"></script>',
      ].join('\n'),
    );
  });

  it('reports JSX that does not compile in the console', () => {
    expect(compileInlineJsx('<script type="text/babel">a << b</script>', compile)).toBe(
      '<script>console.error("This page\'s JSX did not compile: bad JSX");</script>',
    );
  });
});

describe('phoneLibraryFiles', () => {
  const files: Record<string, string> = {
    'build/three.module.js': "export * from './three.core.js';",
    'build/three.core.js': 'export const REVISION = "185";',
    'build/three.webgpu.js': "export * from './three.core.js';",
    'examples/jsm/controls/OrbitControls.js':
      "import { REVISION } from 'three';\nimport { clamp } from '../math/clamp.js';",
    'examples/jsm/math/clamp.js': 'export const clamp = (x) => x;',
    'examples/jsm/loaders/GLTFLoader.js': 'export class GLTFLoader {}',
    LICENSE: 'MIT',
  };
  const read = async (path: string) => files[path] ?? null;
  const scan = (code: string): ModuleImport[] =>
    [...code.matchAll(/from '([^']+)'/g)].map((match) => ({
      specifier: match[1]!,
      start: match.index!,
      end: match.index! + match[0].length,
    }));

  it('carries nothing of a line not marked for phones', async () => {
    expect(await phoneLibraryFiles(THREE, read, scan)).toEqual({ modules: [], texts: [] });
  });

  it('carries the requests a phone build names and what they import, never a folder', async () => {
    const phone = line({
      ...THREE,
      include: ['build/', 'examples/jsm/'],
      module: {
        default: true,
        entries: { ...THREE.module!.entries, './webgpu': 'build/three.webgpu.js' },
      },
      notice: 'LICENSE',
      hosts: ['desktop', 'phone'],
      phoneRequests: ['.', './addons/controls/OrbitControls.js'],
    });
    expect(await phoneLibraryFiles(phone, read, scan)).toEqual({
      modules: [
        'build/three.core.js',
        'build/three.module.js',
        'examples/jsm/controls/OrbitControls.js',
        'examples/jsm/math/clamp.js',
      ],
      texts: ['LICENSE'],
    });
  });

  it('keeps plain-script builds and global builds as written', async () => {
    const react = line({
      library: 'react',
      name: 'React',
      version: '18.3.1',
      answers: { from: '16.0.0', before: '19.0.0' },
      packages: ['react'],
      include: ['umd/react.production.min.js'],
      module: { default: true, entries: {} },
      classic: { default: true, global: 'React', entries: { '.': 'umd/react.production.min.js' } },
      globals: {
        '.': { global: 'React', file: 'umd/react.production.min.js', exports: ['useState'] },
      },
      hosts: ['desktop', 'phone'],
    });
    const umd = async (path: string) => (path === 'umd/react.production.min.js' ? 'x' : null);
    expect(await phoneLibraryFiles(react, umd, scan)).toEqual({
      modules: [],
      texts: ['umd/react.production.min.js'],
    });
  });
});

describe('modules written around a CommonJS file', () => {
  const REACT19 = line({
    library: 'react',
    name: 'React',
    version: '19.3.1',
    answers: { from: '19.0.0', before: '20.0.0' },
    packages: ['react'],
    include: ['cjs/react.production.js', 'cjs/react-jsx-runtime.production.js'],
    module: { default: true, entries: {} },
    commonjs: {
      '.': { file: 'cjs/react.production.js', exports: ['useState', 'version', 'default'] },
      './jsx-runtime': {
        file: 'cjs/react-jsx-runtime.production.js',
        exports: ['Fragment', 'jsx', 'jsxs'],
      },
    },
    hosts: ['desktop', 'phone'],
  });
  const DOM19 = line({
    library: 'react-dom',
    name: 'React DOM',
    version: '19.3.1',
    answers: { from: '19.0.0', before: '20.0.0' },
    packages: ['react-dom'],
    include: ['cjs/react-dom-client.production.js'],
    module: { default: true, entries: {} },
    commonjs: {
      './client': {
        file: 'cjs/react-dom-client.production.js',
        exports: ['createRoot'],
        imports: ['react', 'react-dom'],
      },
    },
    requires: { react: '19.3.1' },
    hosts: ['desktop', 'phone'],
  });

  it('answers bare imports with a module the shelf writes', () => {
    expect(resolvePageLibrarySpecifier([REACT19], 'react')).toEqual({
      line: REACT19,
      path: '_gezel/index.js',
    });
    expect(resolvePageLibrarySpecifier([REACT19], 'react/jsx-runtime')?.path).toBe(
      '_gezel/jsx-runtime.js',
    );
    const map = buildPageImportMap([REACT19, DOM19], '/lib/');
    expect(map.imports['react-dom/client']).toBe('/lib/react-dom/19.3.1/_gezel/client.js');
    expect(commonJsModuleSpec(DOM19, '_gezel/client.js')?.spec.imports).toEqual([
      'react',
      'react-dom',
    ]);
  });

  it('runs the file as published inside a function and exports its names', () => {
    const code = 'exports.useState = function () {};\nexports.version = "19.3.1"; // end';
    const source = commonJsModuleSource(REACT19, '_gezel/index.js', code)!;
    expect(source).toContain(`(function (exports, module, require) {\n${code}\n})`);
    expect(source).toContain('export default __gezelExports;');
    // `default` is the wrapper's own export.
    expect(source).toContain('export const { useState, version } = __gezelExports;');
    const client = commonJsModuleSource(DOM19, '_gezel/client.js', 'exports.createRoot = 1;')!;
    expect(client).toContain('import * as __gezelImport0 from "react";');
    expect(client).toContain('import * as __gezelImport1 from "react-dom";');
    expect(client).toContain(
      'if (id === "react") return __gezelImport0.default ?? __gezelImport0;',
    );
    expect(commonJsModuleSource(REACT19, '_gezel/missing.js', code)).toBeNull();
    // A global module is not mistaken for one.
    expect(globalModuleSource(REACT19, '_gezel/index.js')).toBeNull();
  });

  it('carries the CommonJS file to phones as text', async () => {
    const files: Record<string, string> = {
      'cjs/react.production.js': 'exports.useState = 1;',
      'cjs/react-jsx-runtime.production.js': 'exports.jsx = 1;',
    };
    expect(
      await phoneLibraryFiles(
        REACT19,
        async (path) => files[path] ?? null,
        () => [],
      ),
    ).toEqual({
      modules: [],
      texts: ['cjs/react-jsx-runtime.production.js', 'cjs/react.production.js'],
    });
  });
});
