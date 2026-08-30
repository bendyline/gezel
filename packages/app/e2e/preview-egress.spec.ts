import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type ElectronApplication, type Page, expect, test } from '@playwright/test';
import { _electron as electron } from 'playwright';
import { closeApp } from './helpers/close-app.js';
import { buildLaunchEnv } from './helpers/launch-env.js';

const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const UI_LOAD_TIMEOUT_MS = 60_000;

test.describe('preview network boundary', () => {
  let home: string;
  let app: ElectronApplication;
  let page: Page;
  let sink: Server;
  let sinkOrigin: string;
  const requests: string[] = [];

  test.beforeAll(async () => {
    test.setTimeout(UI_LOAD_TIMEOUT_MS + 30_000);
    home = await mkdtemp(join(tmpdir(), 'gezel-preview-egress-'));
    sink = createServer((req, res) => {
      requests.push(req.url ?? '/');
      if (req.url?.endsWith('-redirect')) {
        res.writeHead(302, { location: `${req.url}-target` });
        res.end();
        return;
      }
      res.writeHead(200, {
        'access-control-allow-origin': '*',
        'content-type': 'text/plain; charset=utf-8',
      });
      res.end('ok');
    });
    await new Promise<void>((resolve) => sink.listen(0, '127.0.0.1', resolve));
    const address = sink.address() as AddressInfo;
    sinkOrigin = `http://127.0.0.1:${address.port}`;

    app = await electron.launch({
      args: [appRoot],
      env: buildLaunchEnv({
        GEZEL_HOME: home,
        GEZEL_MOCK_PROVIDER: '1',
        GEZEL_EMBEDDED: '1',
        GEZEL_SKIP_SYSTEM_BOOTSTRAP: '1',
      }),
    });
    page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('.app-header')).toBeVisible({ timeout: UI_LOAD_TIMEOUT_MS });
    expect(await page.evaluate(() => Boolean(window.__GEZEL__?.token))).toBe(true);

    const workspace = join(home, 'projects', 'default', 'workspace');
    await mkdir(workspace, { recursive: true });
    for (const mode of ['strict', 'free', 'app-off'] as const) {
      await writeFile(
        join(workspace, `${mode}.html`),
        `<!doctype html><body><script>
fetch(${JSON.stringify(`${sinkOrigin}/${mode}-fetch`)}, { mode: 'no-cors' }).catch(() => {});
fetch(${JSON.stringify(`${sinkOrigin}/${mode}-redirect`)}, { mode: 'no-cors' }).catch(() => {});
var image = new Image(); image.src = ${JSON.stringify(`${sinkOrigin}/${mode}-image`)}; document.body.append(image);
var cssImage = document.createElement('div'); cssImage.style.backgroundImage = ${JSON.stringify(`url(${sinkOrigin}/${mode}-css-image)`)}; cssImage.style.width = '10px'; cssImage.style.height = '10px'; document.body.append(cssImage);
var stylesheet = document.createElement('link'); stylesheet.rel = 'stylesheet'; stylesheet.href = ${JSON.stringify(`${sinkOrigin}/${mode}-stylesheet`)}; document.head.append(stylesheet);
var media = document.createElement('video'); media.src = ${JSON.stringify(`${sinkOrigin}/${mode}-media`)}; media.preload = 'auto'; document.body.append(media);
var frame = document.createElement('iframe'); frame.src = ${JSON.stringify(`${sinkOrigin}/${mode}-frame`)}; document.body.append(frame);
try { new Worker(${JSON.stringify(`${sinkOrigin}/${mode}-worker`)}); } catch (_) {}
setTimeout(function(){ location.href = ${JSON.stringify(`${sinkOrigin}/${mode}-navigate`)}; }, 250);
</script></body>`,
        'utf8',
      );
    }
  });

  test.afterAll(async () => {
    await closeApp(app);
    await new Promise<void>((resolve) => sink?.close(() => resolve()));
    await rm(home, { recursive: true, force: true }).catch(() => {});
  });

  async function authenticatedRequest(
    path: string,
    init?: RequestInit,
  ): Promise<{ ok: boolean; status: number; body: string }> {
    return page.evaluate(
      async ({ path, init }) => {
        const gezel = window.__GEZEL__!;
        return fetch(new URL(path, gezel.baseUrl), {
          ...init,
          headers: {
            ...Object.fromEntries(new Headers(init?.headers).entries()),
            authorization: `Bearer ${gezel.token}`,
            'content-type': 'application/json',
          },
        }).then(async (response) => ({
          ok: response.ok,
          status: response.status,
          body: await response.text(),
        }));
      },
      { path, init },
    );
  }

  async function mountPreview(path: string): Promise<string> {
    const minted = await authenticatedRequest('/api/projects/default/preview-capability', {
      method: 'POST',
      body: JSON.stringify({ source: 'workspace', path }),
    });
    expect(minted.ok).toBe(true);
    const lease = JSON.parse(minted.body) as { url: string };
    return page.evaluate((url) => {
      document.querySelector('#egress-preview')?.remove();
      const frame = document.createElement('iframe');
      frame.id = 'egress-preview';
      frame.sandbox.add('allow-scripts');
      frame.src = new URL(url, window.__GEZEL__!.baseUrl).toString();
      document.body.append(frame);
      return frame.src;
    }, lease.url);
  }

  test('enforces both network switches at the renderer request sink', async () => {
    await page.evaluate((origin) => {
      const image = new Image();
      image.id = 'ordinary-egress-probe';
      image.src = `${origin}/ordinary-image`;
      document.body.append(image);
      const stylesheet = document.createElement('link');
      stylesheet.rel = 'stylesheet';
      stylesheet.href = `${origin}/ordinary-stylesheet`;
      document.head.append(stylesheet);
      const frame = document.createElement('iframe');
      frame.src = `${origin}/ordinary-frame`;
      document.body.append(frame);
      void fetch(`${origin}/ordinary-fetch`).catch(() => {});
      const nested = new Image();
      nested.src = `data:image/svg+xml,${encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg"><image href="${origin}/ordinary-svg-nested"/></svg>`,
      )}`;
      document.body.append(nested);
    }, sinkOrigin);
    await page.waitForTimeout(300);
    expect(requests.filter((path) => path.startsWith('/ordinary-'))).toEqual([]);

    const strictUrl = await mountPreview('strict.html');
    await page.waitForTimeout(700);
    expect(requests.filter((path) => path.startsWith('/strict-'))).toEqual([]);
    await expect(page.locator('#egress-preview')).toHaveAttribute('src', strictUrl);

    const freePolicy = {
      level: 'free',
      allowFileEdits: true,
      allowExternalChat: true,
      allowExternalServices: true,
      allowScriptExecution: true,
      allowAppNetwork: true,
    };
    const updated = await authenticatedRequest('/api/config', {
      method: 'PUT',
      body: JSON.stringify({ securityPolicy: freePolicy }),
    });
    expect(updated.ok).toBe(true);

    const freeUrl = await mountPreview('free.html');
    await expect.poll(() => requests.includes('/free-fetch')).toBe(true);
    await expect.poll(() => requests.includes('/free-image')).toBe(true);
    await expect.poll(() => requests.includes('/free-redirect')).toBe(true);
    await expect.poll(() => requests.includes('/free-redirect-target')).toBe(true);
    await page.waitForTimeout(400);
    expect(requests).not.toContain('/free-navigate');
    await expect(page.locator('#egress-preview')).toHaveAttribute('src', freeUrl);

    const appNetworkOff = await authenticatedRequest('/api/config', {
      method: 'PUT',
      body: JSON.stringify({
        securityPolicy: { ...freePolicy, level: 'custom', allowAppNetwork: false },
      }),
    });
    expect(appNetworkOff.ok).toBe(true);

    const blockedUrl = await mountPreview('app-off.html');
    await page.waitForTimeout(700);
    expect(requests.filter((path) => path.startsWith('/app-off-'))).toEqual([]);
    await expect(page.locator('#egress-preview')).toHaveAttribute('src', blockedUrl);
  });
});
