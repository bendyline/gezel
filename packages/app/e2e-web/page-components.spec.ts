import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { type Page, expect, test } from '@playwright/test';
import { PAGE_DEMO_STUB } from '../../cli/src/app-scaffold-demo.js';
import {
  pageDemoAssets,
  writePageDemo,
  writePageDemoAssets,
} from '../../cli/src/page-demo-export.js';
import { buildPageApiShim } from '../../core/src/project-types/page-api-shim.js';
import { pageComponentsSource } from '../../core/src/project-types/page-components.js';
import { pageDemoBootstrapSource } from '../../core/src/project-types/page-demo.js';

const target = {
  id: 'library',
  source: 'workspace',
  path: '.',
  accept: ['.png', '.csv'],
  maxFileBytes: 1000,
  writable: true,
};
const mounts = '<main><div id="adder"></div><div id="cards"></div></main>';
test('demo bootstrap is idempotent and never replaces a live host', async ({ page }) => {
  await page.setContent('<main></main>');
  await page.evaluate(() => {
    Reflect.set(window, 'gezel', { page: { mode: 'embedded' }, marker: true });
  });
  await page.addScriptTag({ content: pageDemoBootstrapSource() });
  expect(await page.evaluate(() => Reflect.get(window, 'gezel'))).toEqual({
    page: { mode: 'embedded' },
    marker: true,
  });
  expect(await page.evaluate(() => Reflect.has(window, 'makeDemoGezel'))).toBe(false);
  await page.evaluate(() => {
    Reflect.deleteProperty(window, 'gezel');
  });
  await page.addScriptTag({ content: pageDemoBootstrapSource() });
  await page.addScriptTag({ content: pageDemoBootstrapSource() });
  expect(
    await page.evaluate(() => {
      const make = Reflect.get(window, 'makeDemoGezel');
      const api = make({ page: { typeName: 'Demo' } });
      return { same: api === make({}), mode: api.page.mode, components: api.ui.components.version };
    }),
  ).toEqual({ same: true, mode: 'demo', components: 1 });
});
const mountScript = `const api=window.gezel;
api.ui.components.fileAdder('#adder',{target:'library',onAdded:files=>files.forEach(file=>api.ui.components.fileCard('#cards',{file}))});`;
async function hosted(page: Page, writable = true) {
  const shim = buildPageApiShim({
    api: 1,
    projectId: 'fixture',
    source: 'type',
    entry: 'index.html',
    typeName: 'Fixture',
    params: {},
    tools: [],
    imports: true,
  });
  const html = `${mounts + shim}<script>${mountScript}</script>`;
  await page.setContent(
    '<iframe title="App" sandbox="allow-scripts" style="width:100%;height:800px"></iframe>',
  );
  await page.evaluate(
    ({ html, target }) => {
      const frame = document.querySelector('iframe')!;
      const state = {
        names: [] as string[],
        contents: [] as string[],
        cancelled: [] as string[],
        opened: [] as string[],
      };
      Object.assign(window, { componentTest: state });
      window.addEventListener('message', async (e) => {
        if (e.source !== frame.contentWindow || e.data?.__gezelPage !== 1) return;
        const m = e.data;
        const reply = (data: object) =>
          frame.contentWindow!.postMessage({ __gezelPage: 1, id: m.id, ...data }, '*');
        if (m.kind === 'hello') reply({ kind: 'init', theme: { mode: 'light' } });
        if (m.kind === 'import-targets')
          reply({ kind: 'import-result', ok: true, result: [target] });
        if (m.kind === 'import-cancel') state.cancelled.push(m.id);
        if (m.kind === 'read')
          reply({
            kind: 'read-result',
            ok: true,
            encoding: 'base64',
            content:
              'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6a8AAAAASUVORK5CYII=',
          });
        if (m.kind === 'open') {
          state.opened.push(m.path);
          reply({ kind: 'open-result', ok: true });
        }
        if (m.kind === 'import-file') {
          state.names.push(m.name);
          state.contents.push(await m.file.text());
          if (m.name === 'slow.csv') return;
          reply(
            m.name === 'denied.csv'
              ? {
                  kind: 'import-result',
                  ok: false,
                  errorCode: 'not-allowed',
                  error: 'Permission revoked.',
                }
              : {
                  kind: 'import-result',
                  ok: true,
                  result: {
                    source: 'workspace',
                    path: m.name,
                    name: m.name,
                    size: m.file.size,
                    mtime: 1700000000000,
                  },
                },
          );
        }
      });
      frame.srcdoc = html;
    },
    {
      html,
      target: {
        ...target,
        writable,
        reason: writable ? undefined : 'Workspace writes are disabled.',
      },
    },
  );
  return page.frameLocator('iframe');
}
test('opaque hosted page transfers file bytes, reports partial failure, opens cards and cancels pending imports', async ({
  page,
}) => {
  const view = await hosted(page);
  await expect(view.getByRole('button', { name: 'Add files', exact: true })).toBeEnabled();
  await view.locator('input[type=file]').setInputFiles([
    { name: 'notes.csv', mimeType: 'text/csv', buffer: Buffer.from('name,value\nNorth,42') },
    { name: 'denied.csv', mimeType: 'text/csv', buffer: Buffer.from('secret') },
  ]);
  await expect(view.getByRole('status')).toContainText(['1 of 2 files added']);
  await expect(view.getByText('denied.csv: Permission revoked.')).toBeVisible();
  const card = view.getByRole('button', { name: 'Open notes.csv' });
  await card.focus();
  await page.keyboard.press('Enter');
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, 'componentTest').opened))
    .toEqual(['notes.csv']);
  expect(await page.evaluate(() => Reflect.get(window, 'componentTest').contents)).toEqual([
    'name,value\nNorth,42',
    'secret',
  ]);
  await view
    .locator('input[type=file]')
    .setInputFiles({ name: 'slow.csv', mimeType: 'text/csv', buffer: Buffer.from('slow') });
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, 'componentTest').names.length))
    .toBe(3);
  await view.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(view.getByText('slow.csv: Import cancelled.')).toBeVisible();
  expect(await page.evaluate(() => Reflect.get(window, 'componentTest').cancelled.length)).toBe(1);
});
test('read-only destinations disable the adder and do not upload drops', async ({ page }) => {
  const view = await hosted(page, false);
  await expect(view.getByRole('button', { name: 'Add files', exact: true })).toBeDisabled();
  await expect(view.getByText('Workspace writes are disabled.')).toBeVisible();
  await view.locator('.adder').evaluate((el) => {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File(['x'], 'dropped.csv'));
    el.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer }));
  });
  expect(await page.evaluate(() => Reflect.get(window, 'componentTest').names)).toEqual([]);
});
test('snapshot media placeholders resolve inside a file card shadow root', async ({ page }) => {
  const view = await hosted(page);
  await view.locator('#cards').evaluate((el) => {
    Reflect.get(window, 'gezel').ui.components.fileCard(el, { file: { path: 'photo.png' } });
  });
  await expect(view.locator('gezel-file-card img')).toHaveAttribute(
    'src',
    /^data:image\/png;base64,/,
  );
});

test('shared standalone components support drop, duplicate names, safe text, theme, destroy and reset', async ({
  page,
}) => {
  await page.route('http**://**', (route) => route.abort());
  await page.setContent(
    `${mounts}<script>${PAGE_DEMO_STUB}${pageComponentsSource()}
    const api=makeDemoGezel({});installGezelComponents(api,{demoTargets:[${JSON.stringify(target)}]});
    const adder=api.ui.components.fileAdder('#adder',{target:'library',onAdded:files=>files.forEach(file=>api.ui.components.fileCard('#cards',{file}))});
    window.resetDemo=()=>{api.ui.components.demo.reset();document.querySelector('#cards').replaceChildren();};
    </script>`,
  );
  await expect(page.getByRole('button', { name: 'Add files', exact: true })).toBeEnabled();
  for (let n = 0; n < 2; n++) {
    await page.locator('.adder').evaluate((el) => {
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(new File(['a,b'], 'sample.csv'));
      el.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer }));
    });
    await expect(page.locator('gezel-file-card')).toHaveCount(n + 1);
  }
  await expect(
    page.getByRole('button', { name: 'Open sample (1).csv', exact: true }),
  ).toBeVisible();
  await page.evaluate(() =>
    Reflect.get(window, 'gezel').ui.components.fileCard('#cards', {
      file: { path: '<img onerror=alert(1)>.txt' },
    }),
  );
  await expect(
    page.getByRole('button', { name: 'Open <img onerror=alert(1)>.txt', exact: true }),
  ).toBeVisible();
  await expect(page.locator('gezel-file-card img')).toHaveCount(0);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('gezel-file-adder')).toHaveAttribute('data-theme', 'dark');
  await page.setViewportSize({ width: 320, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.evaluate(() => Reflect.get(window, 'resetDemo')());
  expect(
    await page.evaluate(() => Reflect.get(window, 'gezel').ui.components.demo.files()),
  ).toEqual([]);
  await expect(page.locator('gezel-file-card')).toHaveCount(0);
});

// Content lives in Gilde. Opt in against the checkout being changed, then the
// same checks can follow a catalog pin without a mandatory sibling checkout.
const gilde = process.env.GILDE_DIR;
let preview: ChildProcess | undefined;
let previewUrl: string;
test.beforeAll(async () => {
  if (!gilde) return;
  expect(
    (await readFile(resolve(gilde, 'authoring/page-demo-bootstrap.js'), 'utf8')).replace(
      /\r\n/g,
      '\n',
    ),
  ).toBe(pageDemoBootstrapSource());
  expect(
    (await readFile(resolve(gilde, 'authoring/page-demo-typography.css'), 'utf8')).replace(
      /\r\n/g,
      '\n',
    ),
  ).toBe(pageDemoAssets()[1]!.bytes.toString().replace(/\r\n/g, '\n'));
  preview = spawn(process.execPath, [resolve(gilde, 'tools/serve-page-demos.mjs'), '--port', '0'], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise<void>((ready, reject) => {
    const timer = setTimeout(() => reject(new Error('Demo server did not start')), 15000);
    preview!.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    preview!.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Demo server exited: ${code}`));
    });
    preview!.stdout!.on('data', (chunk) => {
      const url = String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
      if (url) {
        previewUrl = url;
        clearTimeout(timer);
        ready();
      }
    });
  });
});
test.afterAll(() => {
  preview?.kill();
});
for (const [id, targetId, count, selector] of [
  ['me/media-library', 'library', 7, '#gallery'],
  ['da/data-analysis', 'data', 5, '#datasets'],
] as const) {
  test(`${id} works inside the website's opaque demo iframe`, async ({ page }) => {
    test.skip(!gilde, 'Set GILDE_DIR to exercise catalog migrations.');
    await page.setContent(
      `<iframe title="Demo" sandbox="allow-forms allow-modals allow-scripts" src="${previewUrl}/demos/${id.split('/')[1]}/index.html"></iframe>`,
    );
    const demo = page.frameLocator('iframe');
    await expect(demo.locator(`${selector} gezel-file-card`)).toHaveCount(count);
    await expect(demo.getByRole('button', { name: 'Add files', exact: true })).toBeEnabled();
    expect(
      await demo.locator('body').evaluate(async () => {
        await document.fonts.ready;
        return document.fonts.check('16px "Hanken Grotesk"');
      }),
    ).toBe(true);
  });
  for (const mode of ['offline', 'preview'] as const) {
    test(`${id} ${mode} uses injected components and resets added demo files`, async ({ page }) => {
      test.skip(!gilde, 'Set GILDE_DIR to exercise catalog migrations.');
      const dir = resolve(gilde!, `data/project-types/${id}/versions/1.0.0/pages`);
      expect(existsSync(resolve(dir, 'page-components.js'))).toBe(false);
      const files: Array<{ path: string; bytes: Buffer }> = [];
      async function collect(folder: string, prefix = '') {
        for (const entry of await readdir(folder, { withFileTypes: true })) {
          const path = prefix + entry.name;
          if (entry.isDirectory()) await collect(join(folder, entry.name), `${path}/`);
          else files.push({ path, bytes: await readFile(join(folder, entry.name)) });
        }
      }
      await collect(dir);
      const manifest = JSON.parse(await readFile(resolve(dir, '../manifest.json'), 'utf8'));
      const output = test.info().outputPath('export');
      const shared = {
        directory: join(output, '_gezel-demo'),
        assets: await writePageDemoAssets(join(output, '_gezel-demo')),
      };
      await writePageDemo(output, files, { imports: manifest.pages.imports }, shared);
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(
        mode === 'offline'
          ? pathToFileURL(resolve(output, 'index.html')).href
          : `${previewUrl}/demos/${id.split('/')[1]}/index.html`,
      );
      expect(await page.evaluate(() => getComputedStyle(document.body).fontFamily)).toContain(
        'Hanken Grotesk',
      );
      await expect(page.locator(`${selector} gezel-file-card`)).toHaveCount(count);
      await page.screenshot({ path: test.info().outputPath('demo.png'), fullPage: true });
      await expect(page.locator('[data-gezel-demo-banner]')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Add files', exact: true })).toBeEnabled();
      await page.locator('input[type=file]').setInputFiles({
        name: targetId === 'data' ? 'added.csv' : 'added.png',
        mimeType: targetId === 'data' ? 'text/csv' : 'image/png',
        buffer: Buffer.from('sample'),
      });
      await expect(page.locator(`${selector} gezel-file-card`)).toHaveCount(count + 1);
      await page.getByRole('button', { name: 'Reset demo', exact: true }).click();
      await expect(page.locator(`${selector} gezel-file-card`)).toHaveCount(count);
      await page.setViewportSize({ width: 320, height: 800 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      expect(errors).toEqual([]);
    });
  }
}
