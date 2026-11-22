import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTrustingFetch } from '@bendyline/gezel-client/node';
import { PageLibraryStore } from '@bendyline/gezel-inference/internal/page-libraries/store';
import { PageLibraryLineSchema } from '@bendyline/gezel/pages';
import * as tar from 'tar';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningService, startService } from '../service.js';

let svc: RunningService;
let home: string;
let httpFetch: typeof fetch;
let baseUrl: string;

const MODULE = "export const name = 'widget';\n";
const ADDON = "import { name } from 'widget';\nexport const extra = name;\n";
const CLASSIC = 'window.Widget = { name: "widget" };\n';

const pages: Record<string, string> = {
  'site/index.html': [
    '<!doctype html><html><head>',
    '<script src="https://unpkg.com/widget@2.1.0/dist/widget.min.js" integrity="sha384-x"></script>',
    '<script src="https://example.com/elsewhere.js"></script>',
    '</head><body>',
    '<script type="module">',
    'import { name } from "widget";',
    'import { extra } from "https://esm.sh/widget@2/addons/extra.js";',
    '</script>',
    '<script type="module" src="./src/main.ts"></script>',
    '</body></html>',
  ].join('\n'),
  'site/mapped.html': [
    '<!doctype html><html><head>',
    '<script type="importmap">{"imports":{"widget":"https://cdn.jsdelivr.net/npm/widget@2.1.0/build/widget.module.js","mine":"./mine.js"}}</script>',
    '</head><body></body></html>',
  ].join('\n'),
  'site/src/main.ts': [
    "import { name } from 'widget';",
    "import { extra } from 'widget/addons/extra.js';",
    "import * as byUrl from 'https://cdn.jsdelivr.net/npm/widget@2/+esm';",
    "import other from 'https://example.com/other.js';",
    'export const all: string[] = [name, extra, byUrl.name, other];',
  ].join('\n'),
  'site/plain.js':
    'import { name } from "https://unpkg.com/widget@2.1.0/build/widget.module.js";\nexport default name;\n',
  'site/vanilla.js': 'export const answer = 42; // see https://example.com/unpkg.com\n',
};

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-preview-libraries-'));
  process.env.GEZEL_MOCK_PROVIDER = '1';

  // A package as the registry serves it, installed the way a download is.
  const fixture = join(home, 'fixture');
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'widget', version: '2.1.0' }),
    'build/widget.module.js': MODULE,
    'addons/extra.js': ADDON,
    'dist/widget.min.js': CLASSIC,
    'src/internal.js': 'never served\n',
  };
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(fixture, 'package', path, '..'), { recursive: true });
    await writeFile(join(fixture, 'package', path), text);
  }
  const tarballPath = join(home, 'widget-2.1.0.tgz');
  await tar.create({ cwd: fixture, file: tarballPath, gzip: true }, ['package']);
  const sha256 = createHash('sha256')
    .update(await readFile(tarballPath))
    .digest('hex');
  await new PageLibraryStore({ home, seedRoots: [] }).install({
    tarballPath,
    line: PageLibraryLineSchema.parse({
      library: 'widget',
      name: 'Widget',
      version: '2.1.0',
      answers: { from: '2.0.0', before: '3.0.0' },
      source: { kind: 'npm', package: 'widget', version: '2.1.0', sha256 },
      packages: ['widget'],
      include: ['build/widget.module.js', 'addons/', 'dist/widget.min.js'],
      module: { default: true, entries: { '.': 'build/widget.module.js', './addons/': 'addons/' } },
      classic: { default: true, global: 'Widget', entries: { '.': 'dist/widget.min.js' } },
      license: 'MIT',
    }),
  });

  svc = await startService({ home });
  baseUrl = `${svc.cert ? 'https' : 'http'}://127.0.0.1:${svc.port}`;
  httpFetch = svc.cert ? createTrustingFetch({ cert: svc.cert.certPem }) : fetch;
  for (const [path, content] of Object.entries(pages))
    await svc.context.store.writeProjectWorkspaceFile('default', path, content);
}, 30_000);

afterAll(async () => {
  await svc.stop();
  await rm(home, { recursive: true, force: true });
  delete process.env.GEZEL_MOCK_PROVIDER;
}, 30_000);

interface Lease {
  /** `…/preview/<capability>/workspace/default/site/` */
  page: string;
  /** `/preview/<capability>/lib/` */
  lib: string;
  browserUrl?: string;
}

async function lease(): Promise<Lease> {
  const minted = await httpFetch(`${baseUrl}/api/projects/default/preview-capability`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${svc.clientToken}` },
    body: JSON.stringify({ source: 'workspace', path: 'site/index.html' }),
  });
  const { url, browserUrl } = (await minted.json()) as { url: string; browserUrl?: string };
  return {
    page: `${baseUrl}${url.slice(0, url.lastIndexOf('/') + 1)}`,
    lib: `/preview/${url.split('/')[2]}/lib/`,
    ...(browserUrl ? { browserUrl } : {}),
  };
}

describe('page libraries in a workspace preview', () => {
  it('serves a shelf file, as published, to any page that holds a lease', async () => {
    const { lib } = await lease();
    const module = await httpFetch(`${baseUrl}${lib}widget/2.1.0/build/widget.module.js`);
    expect(module.status).toBe(200);
    expect(module.headers.get('content-type')).toContain('javascript');
    // A module loaded from the sandboxed page's opaque origin needs this.
    expect(module.headers.get('access-control-allow-origin')).toBe('null');
    expect(module.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(await module.text()).toBe(MODULE);

    // Its own bare import is served as written; the page's import map answers it.
    expect(await (await httpFetch(`${baseUrl}${lib}widget/2.1.0/addons/extra.js`)).text()).toBe(
      ADDON,
    );
  });

  it('serves nothing the line does not list, and nothing without a live lease', async () => {
    const { lib } = await lease();
    const status = async (path: string) => (await httpFetch(`${baseUrl}${path}`)).status;
    expect(await status(`${lib}widget/2.1.0/src/internal.js`)).toBe(404);
    expect(await status(`${lib}widget/9.9.9/build/widget.module.js`)).toBe(404);
    expect(await status(`${lib}nothing/1.0.0/index.js`)).toBe(404);
    expect(await status(`${lib}widget/2.1.0/..%2f..%2f..%2fconfig.json`)).toBe(404);
    expect(await status(`${lib}widget/2.1.0/.gezel-page-library.json`)).toBe(404);
    expect(await status(`/preview/${'A'.repeat(43)}/lib/widget/2.1.0/build/widget.module.js`)).toBe(
      401,
    );
    expect(await status('/preview/short/lib/widget/2.1.0/build/widget.module.js')).toBe(401);
  });

  it('points every spelling in a page at one shelf address', async () => {
    const { page, lib } = await lease();
    const html = await (await httpFetch(`${page}index.html`)).text();
    const module = `${lib}widget/2.1.0/build/widget.module.js`;

    // Plain-script tag: the classic build, and no hash of the CDN's bytes.
    expect(html).toContain(
      `<script src="${lib}widget/2.1.0/dist/widget.min.js" crossorigin="anonymous"></script>`,
    );
    expect(html).not.toContain('integrity=');
    // Not a library the shelf carries: left for the page's network policy.
    expect(html).toContain('<script src="https://example.com/elsewhere.js"></script>');
    // One import map, ahead of the page's own scripts, answers the bare import.
    expect(html.match(/type="importmap"/g)).toHaveLength(1);
    expect(html.indexOf('type="importmap"')).toBeLessThan(html.indexOf('type="module"'));
    expect(html).toContain(`"widget":"${module}"`);
    expect(html).toContain(`"widget/addons/":"${lib}widget/2.1.0/addons/"`);
    expect(html).toContain('import { name } from "widget";');
    // A CDN import inside the inline module.
    expect(html).toContain(`import { extra } from "${lib}widget/2.1.0/addons/extra.js";`);

    // TypeScript: names are left to the import map, CDN addresses rewritten.
    const main = await (await httpFetch(`${page}src/main.ts`)).text();
    expect(main).toMatch(/from ['"]widget['"]/);
    expect(main).toMatch(/from ['"]widget\/addons\/extra\.js['"]/);
    expect(main).toContain(`from '${module}'`);
    expect(main).toContain("from 'https://example.com/other.js'");

    // A plain script is served as written except for the address.
    expect(await (await httpFetch(`${page}plain.js`)).text()).toBe(
      `import { name } from "${module}";\nexport default name;\n`,
    );
    expect(await (await httpFetch(`${page}vanilla.js`)).text()).toBe(pages['site/vanilla.js']);
  });

  it("merges into the page's own import map", async () => {
    const { page, lib } = await lease();
    const html = await (await httpFetch(`${page}mapped.html`)).text();
    expect(html.match(/type="importmap"/g)).toHaveLength(1);
    expect(html).toContain(`"widget":"${lib}widget/2.1.0/build/widget.module.js"`);
    expect(html).toContain('"mine":"./mine.js"');
    expect(html).not.toContain('cdn.jsdelivr.net');
  });

  it('serves the shelf on the plain-HTTP listener that "Open in browser" uses', async () => {
    const { lib, browserUrl } = await lease();
    if (!browserUrl) return;
    const origin = new URL(browserUrl).origin;
    const module = await fetch(`${origin}${lib}widget/2.1.0/build/widget.module.js`);
    expect(module.status).toBe(200);
    expect(await module.text()).toBe(MODULE);
  });
});
