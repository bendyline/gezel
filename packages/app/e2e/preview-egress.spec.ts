import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type ElectronApplication, type Page, expect, test } from '@playwright/test';
import { _electron as electron } from 'playwright';
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
    for (const mode of ['strict', 'free'] as const) {
      await writeFile(
        join(workspace, `${mode}.html`),
        `<!doctype html><body><script>
fetch(${JSON.stringify(`${sinkOrigin}/${mode}-fetch`)}, { mode: 'no-cors' }).catch(() => {});
var image = new Image(); image.src = ${JSON.stringify(`${sinkOrigin}/${mode}-image`)}; document.body.append(image);
setTimeout(function(){ location.href = ${JSON.stringify(`${sinkOrigin}/${mode}-navigate`)}; }, 250);
</script></body>`,
        'utf8',
      );
    }
  });

  test.afterAll(async () => {
    await app?.close();
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

  test('blocks strict egress and permits resources—not navigation—when enabled', async () => {
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
    await page.waitForTimeout(400);
    expect(requests).not.toContain('/free-navigate');
    await expect(page.locator('#egress-preview')).toHaveAttribute('src', freeUrl);
  });
});
