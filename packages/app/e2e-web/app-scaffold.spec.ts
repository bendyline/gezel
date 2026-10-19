/** Generated HTML runs against the real page shim and typography, not a second SDK mock. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { GezelClient } from '@bendyline/gezel-client';
import { type Page, expect, test } from '@playwright/test';
import { scaffoldGezappSource } from '../../cli/src/app-scaffold.js';
import { buildPageApiShim } from '../../core/src/project-types/page-api-shim.js';
import { projectPageTypographyStyle } from '../../service/src/project-type/page-typography.js';

type Message = {
  kind: string;
  id?: string;
  tool?: string;
  path?: string;
  input?: Record<string, unknown>;
};
type Records = { records: Array<{ title: string; at: string }> };
type Relay = (message: Message) => Promise<Record<string, unknown>>;

declare global {
  interface Window {
    scaffoldRelay: Relay;
  }
}

function generatedPage(name = 'Field Notes') {
  return scaffoldGezappSource('field-notes', { name, withPage: true }).find(([path]) =>
    path.endsWith('/pages/dashboard/index.html'),
  )![1];
}

const bootstrap = {
  api: 1 as const,
  projectId: 'fixture',
  source: 'type' as const,
  entry: 'dashboard/index.html',
  typeName: 'Field Notes',
  params: {},
  tools: ['page_add_record'],
};

async function hosted(page: Page, relay: Relay, html = generatedPage()) {
  const messages: Message[] = [];
  await page.exposeFunction('scaffoldRelay', async (message: Message) => {
    messages.push(message);
    if (message.kind === 'hello') return { kind: 'init', theme: { mode: 'light' } };
    if (!['read', 'invoke'].includes(message.kind)) return {};
    const kind = message.kind === 'read' ? 'read-result' : 'result';
    try {
      return { kind, id: message.id, ok: true, ...(await relay(message)) };
    } catch (error) {
      return { kind, id: message.id, ok: false, error: String(error), errorCode: 'not-allowed' };
    }
  });
  await page.setContent('<main id="host"></main>');
  await page.evaluate(
    (source) => {
      const frame = document.createElement('iframe');
      frame.title = 'App';
      frame.style.cssText = 'width:100%;height:700px;border:0';
      frame.setAttribute('sandbox', 'allow-scripts');
      window.addEventListener('message', async (event) => {
        if (event.source !== frame.contentWindow || event.data?.__gezelPage !== 1) return;
        const reply = await window.scaffoldRelay(event.data);
        if (reply.kind) frame.contentWindow?.postMessage({ __gezelPage: 1, ...reply }, '*');
      });
      frame.srcdoc = source;
      document.querySelector('#host')!.append(frame);
    },
    html.replace('<head>', `<head>${projectPageTypographyStyle()}${buildPageApiShim(bootstrap)}`),
  );
  return { view: page.frameLocator('iframe'), messages };
}

async function broadcast(page: Page, message: Record<string, unknown>) {
  await page.evaluate((value) => {
    document.querySelector('iframe')!.contentWindow!.postMessage({ __gezelPage: 1, ...value }, '*');
  }, message);
}

function readReply(records: Records) {
  return { content: JSON.stringify(records), encoding: 'utf8' };
}

test('raw-file demo adds, resets, escapes names, and needs no network or fonts', async ({
  page,
}) => {
  const requests: string[] = [];
  page.on('request', (request) => requests.push(request.url()));
  await page.route('**/*', (route) => route.abort());
  const name = 'Notes & <script>throw new Error("injected")</script>';
  // A raw file has no injected host; setContent exercises the same no-server path.
  await page.setContent(generatedPage(name));
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(name);
  await expect(page.getByLabel('Demo')).toBeVisible();
  await expect(page.locator('#records li')).toHaveCount(2);
  await page.getByLabel('New record').fill('<img src=x onerror=alert(1)>');
  await page.getByRole('button', { name: 'Add record', exact: true }).click();
  await expect(page.locator('#records li')).toHaveCount(3);
  await expect(page.locator('#records li').last()).toContainText('<img src=x onerror=alert(1)>');
  await expect(page.locator('#records img')).toHaveCount(0);
  await page.getByRole('button', { name: 'Reset demo' }).click();
  await expect(page.locator('#records li')).toHaveCount(2);
  await page.setViewportSize({ width: 320, height: 700 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(requests).toEqual([]);
});

test('inherits real host fonts, follows theme changes, and cleans up subscriptions', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  const { view, messages } = await hosted(page, async () => readReply({ records: [] }));
  await expect(view.locator('#status')).toContainText('No records yet');
  await expect(view.getByLabel('Demo')).toBeHidden();
  await expect(view.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(view.locator('html')).toHaveCSS('color-scheme', 'light');
  await expect(view.locator('body')).toHaveCSS('font-family', /Hanken Grotesk/);
  await expect(view.locator('h1')).toHaveCSS('font-family', /PT Serif/);
  await expect(view.locator('input')).toHaveCSS('font-family', /Hanken Grotesk/);
  await expect(view.locator('#add')).toHaveCSS('font-family', /Hanken Grotesk/);
  await broadcast(page, { kind: 'theme', theme: { mode: 'dark' } });
  await expect(view.locator('html')).toHaveCSS('color-scheme', 'dark');

  const frame = page.frames()[1]!;
  await frame.evaluate(() => dispatchEvent(new PageTransitionEvent('pagehide')));
  await expect.poll(() => messages.filter((message) => message.kind === 'unwatch').length).toBe(1);
  await broadcast(page, { kind: 'theme', theme: { mode: 'light' } });
  // The shim receives the update, but the disposed page has no theme subscriber.
  await expect(view.locator('html')).toHaveAttribute('data-theme', 'dark');
  await frame.evaluate(() =>
    dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })),
  );
  await expect(view.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect.poll(() => messages.filter((message) => message.kind === 'watch').length).toBe(2);
});

test('keeps live errors live, preserves drafts on action failure, and permits retry', async ({
  page,
}) => {
  let denied = true;
  let finish: ((value: Record<string, unknown>) => void) | undefined;
  const { view, messages } = await hosted(page, async (message) => {
    if (denied) throw new Error('Permission denied');
    if (message.kind === 'read') return readReply({ records: [] });
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  await expect(view.locator('#load-error')).toContainText('Permission denied');
  await expect(view.getByLabel('Demo')).toBeHidden();
  await expect(view.locator('#records li')).toHaveCount(0);
  await expect(view.locator('#add')).toBeDisabled();
  denied = false;
  await view.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(view.locator('#load-error')).toBeHidden();
  await view.getByLabel('New record').fill('Keep my draft');
  await view.getByRole('button', { name: 'Add record', exact: true }).click();
  await expect(view.locator('#add')).toBeDisabled();
  await expect.poll(() => Boolean(finish)).toBe(true);
  expect(messages.filter((message) => message.kind === 'invoke')).toMatchObject([
    { tool: 'page_add_record', input: { title: 'Keep my draft' } },
  ]);
  finish!({ ok: false, error: 'File edits are not allowed', errorCode: 'not-allowed' });
  await expect(view.locator('#action-error')).toContainText('File edits are not allowed');
  await expect(view.getByLabel('New record')).toHaveValue('Keep my draft');
  await expect(view.locator('#add')).toBeEnabled();
  finish = undefined;
  await view.getByLabel('New record').press('Enter');
  await expect.poll(() => Boolean(finish)).toBe(true);
  finish!({ output: { records: [] } });
  await expect(view.getByLabel('New record')).toHaveValue('');
  await expect(view.locator('#action-error')).toBeHidden();
});

test('ignores late reads and disables actions in browser preview mode', async ({ page }) => {
  const pending: Array<(value: Record<string, unknown>) => void> = [];
  let reads = 0;
  const { view } = await hosted(page, async () => {
    if (++reads === 1) return readReply({ records: [] });
    return new Promise((resolve) => pending.push(resolve));
  });
  await expect(view.locator('#status')).toContainText('No records yet');
  await view.getByRole('button', { name: 'Refresh', exact: true }).click();
  await view.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect.poll(() => pending.length).toBe(2);
  pending[1]!(readReply({ records: [{ title: 'Newest', at: '2026-01-02' }] }));
  await expect(view.locator('#records')).toContainText('Newest');
  pending[0]!(readReply({ records: [{ title: 'Stale', at: '2026-01-01' }] }));
  await expect(view.locator('#records')).not.toContainText('Stale');
  // Top-level injection selects the real shim's read-only browser mode.
  await page.setContent(generatedPage().replace('<head>', `<head>${buildPageApiShim(bootstrap)}`));
  await expect(page.locator('#readonly')).toBeVisible();
  await expect(page.locator('#add')).toBeDisabled();
  await expect(page.getByLabel('Demo')).toBeHidden();
});

test('installed scaffold supports page and gezel actions through the real service', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const { startService } = await import('@bendyline/gezel-service');
  const { packGezappFromSource, validateGezappSource } = await import(
    '../../service/src/project-type/gezapp-source.js'
  );
  const { importGezapp } = await import('../../service/src/project-type/gezapp.js');
  const { applyProjectType } = await import('../../service/src/project-type/apply.js');
  const { resolveProjectScriptTools } = await import(
    '../../service/src/project-type/script-tools.js'
  );
  const { registerScriptTools } = await import('../../mcp/src/script-tools.js');
  const home = await mkdtemp(join(tmpdir(), 'gezel-scaffold-e2e-'));
  const env = {
    GEZEL_HOME: home,
    GEZEL_MOCK_PROVIDER: '1',
    GEZEL_INSECURE_TRANSPORT: '1',
    GEZEL_SKIP_SYSTEM_BOOTSTRAP: '1',
    GEZEL_SECRETS_BACKEND: 'file',
    GEZEL_DISABLE_EMBEDDINGS: '1',
    GEZEL_DISABLE_MACHINE_ENGINE: '1',
    GEZEL_MACHINE_SHARED_HOME: join(home, 'shared'),
    GEZEL_SYSTEM_SERVICE_HOME: join(home, 'machine'),
    GEZEL_LAN_DISCOVERY: 'off',
  };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  let svc: Awaited<ReturnType<typeof startService>> | undefined;
  try {
    const source = join(home, 'source');
    for (const [path, content] of scaffoldGezappSource('field-notes', { withPage: true })) {
      await mkdir(dirname(join(source, path)), { recursive: true });
      await writeFile(join(source, path), content);
    }
    expect((await validateGezappSource(source)).findings).toEqual([]);
    const packed = await packGezappFromSource(source);
    await writeFile(
      join(home, 'config.json'),
      JSON.stringify({ aiEngagementMode: 'reactive', nightShift: { enabled: false } }),
    );
    svc = await startService({ home });
    const { store, catalog, token } = svc.context;
    await importGezapp({ home, catalog }, packed.buffer, { confirm: true });
    const project = await store.createProject({ name: 'Scaffold test' });
    await applyProjectType(
      { home, store, catalog },
      { projectId: project.id, typeId: 'field-notes' },
    );
    const baseUrl = `http://127.0.0.1:${svc.port}`;
    const api = new GezelClient({ baseUrl, token });
    async function post(route: string, body: unknown) {
      return fetch(`${baseUrl}/api/projects/${project.id}/${route}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    }
    const installedPage = await catalog.readItemFile(
      'project-type',
      'field-notes',
      'pages/dashboard/index.html',
      'installed-ai-apps',
      '1.0.0',
    );
    expect(installedPage).not.toBeNull();
    const { view } = await hosted(
      page,
      async (message) => {
        const response = await post(
          message.kind === 'invoke' ? 'page-invoke' : 'page-read',
          message.kind === 'invoke'
            ? { tool: message.tool, input: message.input }
            : { op: 'read', source: 'workspace', path: message.path },
        );
        const result = await response.json();
        if (!response.ok || result.status === 'error') throw new Error(result.error);
        return result;
      },
      installedPage!.toString('utf8'),
    );
    await expect(view.locator('#status')).toContainText('No records yet');
    await view.getByLabel('New record').fill('Added by the page');
    await view.getByRole('button', { name: 'Add record', exact: true }).click();
    await expect(view.locator('#records')).toContainText('Added by the page');

    // Register exactly the roster a gezel receives, and call its real named MCP handler.
    const tools = await resolveProjectScriptTools(catalog, await store.getProject(project.id));
    const handlers = new Map<
      string,
      (input: Record<string, unknown>) => Promise<{ isError?: boolean }>
    >();
    const server = {
      tool(
        name: string,
        _description: string,
        _shape: unknown,
        handler: typeof handlers extends Map<string, infer H> ? H : never,
      ) {
        handlers.set(name, handler);
      },
    };
    registerScriptTools(server as Parameters<typeof registerScriptTools>[0], tools, {
      api,
      projectId: project.id,
      reservedNames: new Set(),
    });
    expect([...handlers.keys()]).toEqual(['add_record']);
    expect((await handlers.get('add_record')!({ title: 'Added by the keeper' })).isError).not.toBe(
      true,
    );
    await view.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(view.locator('#records li')).toHaveCount(2);
    await expect(view.locator('#records')).toContainText('Added by the keeper');
    expect(
      (await post('page-invoke', { tool: 'add_record', input: { title: 'Wrong audience' } }))
        .status,
    ).toBe(403);
    expect(
      (await post('page-read', { op: 'read', source: 'workspace', path: 'other.json' })).status,
    ).toBe(403);

    const dataPath = join(await store.projectWorkspaceDir(project.id), 'data.json');
    expect(JSON.parse(await readFile(dataPath, 'utf8')).records).toHaveLength(2);
    await writeFile(dataPath, 'broken JSON');
    expect((await handlers.get('add_record')!({ title: 'Must not erase data' })).isError).toBe(
      true,
    );
    expect(await readFile(dataPath, 'utf8')).toBe('broken JSON');
    await rm(dataPath);
    expect(
      (await handlers.get('add_record')!({ title: 'Must not recreate missing data' })).isError,
    ).toBe(true);
    await expect(readFile(dataPath, 'utf8')).rejects.toThrow(/ENOENT/);
  } finally {
    await page.close();
    await svc?.stop();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(home, { recursive: true, force: true });
  }
});
