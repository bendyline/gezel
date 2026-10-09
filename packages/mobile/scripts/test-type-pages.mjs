// Every project type's Output page, as a phone shows it: opened standalone
// (demo mode, the page's own sample data) at phone width, in Chromium and
// WebKit. Fails on horizontal overflow and on a page that still speaks the v0
// bridge, which cannot run in a phone's snapshot preview. Small touch
// targets are reported; `--strict` fails on them too.
//
//   node packages/mobile/scripts/test-type-pages.mjs [--strict] [--only <id>]
//
// GEZEL_GILDE_DATA_DIR points at a gilde checkout's data/ (for content under
// review); screenshots land in TYPE_PAGES_OUT (default: the OS temp folder).
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(new URL('../../ui/package.json', import.meta.url));
const { chromium, webkit } = require('playwright');
const catalogRequire = createRequire(new URL('../../catalog/package.json', import.meta.url));

const args = process.argv.slice(2);
const strict = args.includes('--strict');
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : undefined;
const dataDir =
  process.env.GEZEL_GILDE_DATA_DIR ??
  join(dirname(catalogRequire.resolve('@bendyline/gilde/package.json')), 'data');
const out = process.env.TYPE_PAGES_OUT ?? join(tmpdir(), 'gezel-type-pages');
const VIEWPORTS = [
  { name: '320', width: 320, height: 720 },
  { name: '390', width: 390, height: 844 },
];
const MIN_TARGET = 44;

function compareSemver(a, b) {
  const pa = a.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  const pb = b.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++)
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

async function latestPages() {
  const root = join(dataDir, 'project-types');
  const pages = [];
  for (const shard of await readdir(root, { withFileTypes: true })) {
    if (!shard.isDirectory()) continue;
    for (const item of await readdir(join(root, shard.name), { withFileTypes: true })) {
      if (!item.isDirectory() || (only && item.name !== only)) continue;
      const versions = (await readdir(join(root, shard.name, item.name, 'versions'))).sort(
        compareSemver,
      );
      const version = versions.at(-1);
      const dir = join(root, shard.name, item.name, 'versions', version);
      const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
      if (!manifest.pages?.entry) continue;
      const file = join(dir, 'pages', manifest.pages.entry);
      const html = await readFile(file, 'utf8');
      pages.push({
        id: item.name,
        version,
        file,
        apiV1: manifest.pages.api === 1 || /\bwindow\.gezel\b|\bmakeDemoGezel\s*\(/.test(html),
      });
    }
  }
  return pages.sort((a, b) => a.id.localeCompare(b.id));
}

const failures = [];
const warnings = [];
const pages = await latestPages();
await mkdir(out, { recursive: true });
for (const page of pages)
  if (!page.apiV1)
    failures.push(
      `${page.id}@${page.version}: speaks the v0 bridge; phones need window.gezel (v1)`,
    );

for (const [engine, type] of [
  ['chromium', chromium],
  ['webkit', webkit],
]) {
  const browser = await type.launch({ headless: true });
  try {
    for (const viewport of VIEWPORTS) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: 2,
        isMobile: engine === 'chromium',
        hasTouch: true,
      });
      for (const page of pages) {
        const tab = await context.newPage();
        const errors = [];
        tab.on('pageerror', (error) => errors.push(error.message));
        await tab.goto(pathToFileURL(page.file).href);
        await tab.waitForTimeout(400);
        const report = await tab.evaluate((minTarget) => {
          const root = document.scrollingElement ?? document.documentElement;
          const small = [];
          for (const element of document.querySelectorAll(
            'button, a[href], input:not([type=hidden]), select, textarea, [role=button], [tabindex]:not([tabindex="-1"])',
          )) {
            // The demo banner only exists for a page opened outside the app.
            if (element.closest('[data-gezel-demo-banner]')) continue;
            const box = element.getBoundingClientRect();
            if (!box.width || !box.height) continue;
            const style = getComputedStyle(element);
            if (style.visibility === 'hidden' || style.display === 'none') continue;
            if (box.height < minTarget || box.width < minTarget)
              small.push(
                `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''} "${(element.textContent ?? '').trim().slice(0, 24)}" ${Math.round(box.width)}x${Math.round(box.height)}`,
              );
          }
          return { scrollWidth: root.scrollWidth, innerWidth, small };
        }, MIN_TARGET);
        const label = `${page.id}@${page.version} ${engine} ${viewport.name}px`;
        await tab.screenshot({
          path: join(out, `${page.id}-${engine}-${viewport.name}.png`),
          fullPage: true,
        });
        if (report.scrollWidth > report.innerWidth + 1)
          failures.push(`${label}: scrolls sideways (${report.scrollWidth}px wide)`);
        for (const error of errors) failures.push(`${label}: script error: ${error}`);
        if (report.small.length)
          (strict ? failures : warnings).push(
            `${label}: ${report.small.length} touch target(s) under ${MIN_TARGET}px: ${report.small.slice(0, 4).join('; ')}${report.small.length > 4 ? '; …' : ''}`,
          );
        await tab.close();
      }
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

for (const warning of warnings) console.warn(`warn  ${warning}`);
for (const failure of failures) console.error(`FAIL  ${failure}`);
console.log(
  `${pages.length} page(s) checked at ${VIEWPORTS.map((v) => `${v.width}px`).join(' and ')}; screenshots in ${out}`,
);
if (failures.length) process.exit(1);
