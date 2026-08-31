import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  collectInitialAssetUrls,
  evaluateUiStartupBudget,
  measureUiStartupGraph,
} from './check-ui-startup-budget.mjs';

test('collects and de-duplicates only initial local scripts and styles', () => {
  const html = `
    <script src="/theme-init.js"></script>
    <script type="module" src="/assets/main.js"></script>
    <link rel="modulepreload" href="/assets/shared.js">
    <link rel="modulepreload" href="/assets/shared.js">
    <link rel="stylesheet" href="/assets/main.css">
    <link rel="icon" href="/favicon.svg">
    <script src="https://example.com/remote.js"></script>
  `;
  assert.deepEqual(collectInitialAssetUrls(html), [
    '/theme-init.js',
    '/assets/main.js',
    '/assets/shared.js',
    '/assets/main.css',
  ]);
});

test('measures the emitted HTML graph instead of every dist asset', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gezel-ui-startup-'));
  await mkdir(path.join(root, 'assets'));
  await writeFile(
    path.join(root, 'index.html'),
    `
    <script type="module" src="/assets/main.js"></script>
    <link rel="stylesheet" href="/assets/main.css">
  `,
  );
  await writeFile(path.join(root, 'assets', 'main.js'), 'console.log("startup")');
  await writeFile(path.join(root, 'assets', 'main.css'), 'body { color: black; }');
  await writeFile(path.join(root, 'assets', 'lazy.js'), 'this must not count');

  const metrics = await measureUiStartupGraph(path.join(root, 'index.html'));
  assert.equal(metrics.resourceCount, 2);
  assert.equal(
    metrics.assets.some((asset) => asset.url.endsWith('lazy.js')),
    false,
  );
  assert.ok(metrics.jsGzipBytes > 0);
  assert.ok(metrics.cssGzipBytes > 0);
});

test('fails byte, resource, and export-only regressions', () => {
  const failures = evaluateUiStartupBudget(
    {
      jsGzipBytes: 101,
      cssGzipBytes: 51,
      resourceCount: 4,
      assets: [{ url: '/assets/pdf-heavy.js' }],
    },
    {
      jsGzipBytes: 100,
      cssGzipBytes: 50,
      resourceCount: 3,
      forbiddenAssetNames: [/(?:^|\/)pdf-/],
    },
  );
  assert.equal(failures.length, 4);
});
