import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const uiRequire = createRequire(new URL('../../ui/package.json', import.meta.url));
const { chromium } = uiRequire('playwright');
const { createServer } = await import(uiRequire.resolve('vite'));
const root = fileURLToPath(new URL('..', import.meta.url));
const server = await createServer({
  configFile: false,
  root,
  optimizeDeps: { noDiscovery: true, entries: [] },
  server: { host: '127.0.0.1', port: 0 },
  plugins: [
    {
      name: 'product-files-test',
      configureServer(server) {
        server.middlewares.use('/__product_files_test', (_req, response) => {
          response.setHeader('Content-Type', 'text/html');
          response.end('<!doctype html><title>Product files test</title>');
        });
      },
    },
  ],
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__product_files_test`);
  const checks = await page.evaluate(async () => {
    const { browserDatabase, createBrowserProductFiles } = await import('/src/browser-files.ts');
    const database = `gezel-product-test-${crypto.randomUUID()}`;
    const open = browserDatabase(database);
    const files = createBrowserProductFiles(open);
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    function check(value, message) {
      if (!value) throw new Error(message);
    }
    async function rejects(action) {
      try {
        await action();
      } catch {
        return;
      }
      throw new Error('Expected storage operation to reject');
    }
    await files.mkdir('projects/one/workspace');
    await files.write('projects/one/workspace/a.txt', encoder.encode('first'));
    const stale = createBrowserProductFiles(open);
    check(
      decoder.decode(await stale.read('projects/one/workspace/a.txt')) === 'first',
      'Reopen lost file',
    );
    await files.write('projects/one/workspace/a.txt', encoder.encode('latest'));
    await rejects(() => stale.write('projects/one/workspace/a.txt', encoder.encode('lost update')));
    check(
      decoder.decode(await files.read('projects/one/workspace/a.txt')) === 'latest',
      'Stale tab overwrote data',
    );
    await files.write('projects/one/workspace/binary', new Uint8Array([0, 255, 1, 2]));
    await files.rename('projects/one', 'projects/published');
    check(
      (await files.read('projects/published/workspace/binary')).join(',') === '0,255,1,2',
      'Directory rename lost bytes',
    );
    check((await files.read('projects/one/workspace/a.txt')) === null, 'Rename left old path');
    await files.mkdir('projects/other');
    await rejects(() => files.rename('projects/published', 'projects/other'));
    check(
      decoder.decode(await files.read('projects/published/workspace/a.txt')) === 'latest',
      'Failed rename lost data',
    );
    const entries = await files.list('projects/published/workspace');
    check(
      entries.length === 2 && entries.every((entry) => entry.mtime > 0 && !entry.isDirectory),
      'Invalid listing',
    );
    for (const path of ['', '../x', '/x', 'a/../x', 'a//x', 'a\\x', 'a\0x']) {
      await rejects(() => files.write(path, new Uint8Array()));
      await rejects(() => files.remove(path));
    }
    await rejects(() =>
      files.write('projects/published/workspace/a.txt', new Uint8Array(16 * 1024 * 1024 + 1)),
    );
    check(
      decoder.decode(await files.read('projects/published/workspace/a.txt')) === 'latest',
      'Oversized write lost data',
    );
    await rejects(() => files.write('missing/parent/file', encoder.encode('bad')));
    check((await files.read('missing/parent/file')) === null, 'Failed write left file bytes');
    await files.remove('projects/published');
    check(
      (await files.list('projects')).map((entry) => entry.name).join() === 'other',
      'Subtree removal failed',
    );
    await files.remove('missing');
    (await open()).close();
    return {
      reopened: true,
      staleWriteRejected: true,
      directoryRename: true,
      binary: true,
      confinement: true,
      failedMutationsAtomic: true,
      subtreeRemoval: true,
    };
  });
  assert.equal(Object.values(checks).every(Boolean), true);
  console.log('Browser product filesystem passed:', Object.keys(checks).join(', '));
} finally {
  await browser?.close();
  await server.close();
}
