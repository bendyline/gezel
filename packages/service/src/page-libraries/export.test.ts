import {
  compilePreviewModule,
  scanPreviewModuleImports,
} from '@bendyline/gezel-script-runtime/preview-module';
import {
  type PageExportSource,
  type PageLibraryLine,
  PageLibraryLineSchema,
  exportPageFolder,
  exportPageSingleFile,
} from '@bendyline/gezel/pages';
import { describe, expect, it } from 'vitest';

const SHA = 'a'.repeat(64);
const WIDGET = PageLibraryLineSchema.parse({
  library: 'widget',
  name: 'Widget',
  version: '2.1.0',
  answers: { from: '2.0.0', before: '3.0.0' },
  source: { kind: 'npm', package: 'widget', version: '2.1.0', sha256: SHA },
  packages: ['widget'],
  include: ['build/', 'addons/', 'dist/'],
  module: { default: true, entries: { '.': 'build/widget.js', './addons/': 'addons/' } },
  classic: { default: true, global: 'Widget', entries: { '.': 'dist/widget.min.js' } },
  license: 'MIT',
  notice: 'LICENSE',
});
const LIBRARY: Record<string, string> = {
  'build/widget.js': "import { core } from './core.js';\nexport const widget = 'w' + core;\n",
  'build/core.js': 'export const core = 1;\n',
  'addons/extra.js': "import { widget } from 'widget';\nexport const extra = widget + '!';\n",
  'dist/widget.min.js': 'window.Widget={};\n',
  'addons/tag.js': 'export const tag = "</script><!-- x";\n',
  LICENSE: 'MIT License — Widget authors\n',
};

function source(files: Record<string, string>, entry = 'site/index.html'): PageExportSource {
  const encoder = new TextEncoder();
  return {
    entry,
    readText: async (path) => files[path] ?? null,
    readBytes: async (path) => (files[path] === undefined ? null : encoder.encode(files[path])),
    listFiles: async (folder) => Object.keys(files).filter((path) => path.startsWith(folder)),
    lines: [WIDGET],
    readLibrary: async (line: PageLibraryLine, path) =>
      line.library === 'widget' && LIBRARY[path] !== undefined
        ? encoder.encode(LIBRARY[path])
        : null,
    readNotice: async () => LIBRARY.LICENSE!,
    compile: (code, path, format) => compilePreviewModule(code, path, format),
    scanImports: (code, path) => scanPreviewModuleImports(code, path),
  };
}

const PAGE = {
  'site/index.html': [
    '<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body>',
    '<img src="logo.svg">',
    '<script src="https://unpkg.com/widget@2/dist/widget.min.js"></script>',
    '<script type="module" src="/src/main.ts"></script>',
    '</body></html>',
  ].join('\n'),
  'site/src/main.ts': [
    "import { widget } from 'widget';",
    "import { extra } from 'widget/addons/extra.js';",
    "import { helper } from './helper';",
    'document.title = widget + extra + helper();',
  ].join('\n'),
  'site/src/helper.ts': 'export const helper = (): string => "h";',
  'site/style.css': 'body { background: url(bg.svg); }',
  'site/bg.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
  'site/logo.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
  'elsewhere/secret.txt': 'not part of the page',
};

describe('exportPageFolder', () => {
  it('serves the folder as a static host would, with its libraries beside it', async () => {
    const result = await exportPageFolder(source(PAGE));
    const byPath = new Map(result.files.map((file) => [file.path, file.data]));
    expect([...byPath.keys()].sort()).toEqual([
      'LICENSES.txt',
      'bg.svg',
      'index.html',
      'lib/widget/2.1.0/addons/extra.js',
      'lib/widget/2.1.0/build/core.js',
      'lib/widget/2.1.0/build/widget.js',
      'lib/widget/2.1.0/dist/widget.min.js',
      'logo.svg',
      'src/helper.js',
      'src/main.js',
      'style.css',
    ]);
    const html = byPath.get('index.html') as string;
    expect(html).toContain('<script src="./lib/widget/2.1.0/dist/widget.min.js"></script>');
    expect(html).toContain('<script type="module" src="src/main.js"></script>');
    expect(html).toContain('"widget":"./lib/widget/2.1.0/build/widget.js"');
    expect(html).toContain('"widget/addons/":"./lib/widget/2.1.0/addons/"');
    const main = byPath.get('src/main.js') as string;
    expect(main).toMatch(/from ['"]widget['"]/);
    expect(main).toMatch(/from ['"]\.\/helper\.js['"]/);
    expect(byPath.get('LICENSES.txt')).toContain('Widget 2.1.0 (widget): MIT');
    expect(byPath.get('LICENSES.txt')).toContain('MIT License — Widget authors');
    expect(result.notes).toEqual([]);
  });

  it('keeps a JSX script that names its file, and points it at the compiled copy', async () => {
    // Its empty body was once compiled into an empty module, and the page
    // came out blank (1.26326.112 release audit).
    const result = await exportPageFolder(
      source({
        'site/index.html':
          '<html><head></head><body><div id="root"></div><script type="text/babel" src="app.jsx"></script></body></html>',
        'site/app.jsx':
          'const App = () => React.createElement("h1", null, "Hi");\nReactDOM.createRoot(document.getElementById("root")).render(<App />);',
      }),
    );
    const byPath = new Map(result.files.map((file) => [file.path, file.data]));
    const html = byPath.get('index.html') as string;
    expect(html).toContain('<script type="module" src="app.js"></script>');
    expect(html).not.toMatch(/<script type="module">\s*"use strict";\s*<\/script>/);
    expect(byPath.get('app.js')).toContain('Hi');
  });
});

describe('exportPageSingleFile', () => {
  it('links every module and inlines scripts, styles and assets into one page', async () => {
    const result = await exportPageSingleFile(source(PAGE));
    expect(result.files.map((file) => file.path)).toEqual(['index.html']);
    const html = result.files[0]!.data as string;
    expect(html).not.toContain('type="module"');
    expect(html).not.toContain('unpkg.com');
    expect(html).not.toContain('importmap');
    expect(html).toContain('window.Widget={};');
    expect(html).toContain('"lib/widget/2.1.0/build/widget.js"');
    expect(html).toContain('"site/src/helper.ts"');
    expect(html).toMatch(/<style>body \{ background: url\("data:image\/svg\+xml;base64,/);
    expect(html).toMatch(/<img src="data:image\/svg\+xml;base64,/);
    expect(html).toContain('Widget 2.1.0 (widget): MIT');
    expect(html).not.toContain('not part of the page');
    expect(result.notes).toEqual([]);
  });

  it('says what the copy leaves out', async () => {
    const result = await exportPageSingleFile(
      source({
        'site/index.html':
          '<script type="module">import gsap from "gsap"; console.log(gsap);</script><script src="https://example.com/x.js"></script>',
      }),
    );
    expect(result.notes).toEqual([
      'site/inline-module-1.js imports gsap, which this copy does not hold.',
      'https://example.com/x.js is not in this copy; it loads from the internet.',
    ]);
  });

  it('keeps a closing script tag inside library code from ending the page script', async () => {
    const result = await exportPageSingleFile(
      source({
        'site/index.html':
          '<script type="module">import { tag } from "widget/addons/tag.js"; document.title = tag;</script>',
      }),
    );
    const html = result.files[0]!.data as string;
    expect(html.match(/<\/script>/g)).toHaveLength(1);
    expect(html).toContain('<\\/script>');
  });
});
