import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

export const DEFAULT_UI_STARTUP_BUDGET = Object.freeze({
  // The pre-review graph was 3.41 MB gzip; the first navigation-boundary pass
  // brought it below 0.9 MB. Keep modest headroom for ordinary work while
  // preventing large features from silently re-entering the shell.
  jsGzipBytes: 950_000,
  cssGzipBytes: 80_000,
  resourceCount: 44,
  forbiddenAssetNames: [/(?:^|\/)(?:pdf|docx|pptx|jszip|standalone-source)[-.]/i],
});

function attribute(tag, name) {
  return tag.match(new RegExp(`\\b${name}=["']([^"']+)["']`, 'i'))?.[1] ?? null;
}

function isLocalAsset(url) {
  return !/^(?:[a-z]+:)?\/\//i.test(url) && !url.startsWith('data:');
}

/** Return the local scripts/styles Chromium is explicitly told to load. */
export function collectInitialAssetUrls(html) {
  const urls = [];
  for (const tag of html.match(/<(?:link|script)\b[^>]*>/gi) ?? []) {
    if (/^<script\b/i.test(tag)) {
      const src = attribute(tag, 'src');
      if (src && isLocalAsset(src)) urls.push(src);
      continue;
    }
    const rel = attribute(tag, 'rel')?.toLowerCase();
    if (rel !== 'modulepreload' && rel !== 'stylesheet') continue;
    const href = attribute(tag, 'href');
    if (href && isLocalAsset(href)) urls.push(href);
  }
  return [...new Set(urls)];
}

function assetKind(url) {
  const clean = url.split(/[?#]/, 1)[0]?.toLowerCase() ?? '';
  if (clean.endsWith('.css')) return 'css';
  if (clean.endsWith('.js') || clean.endsWith('.mjs')) return 'js';
  return 'other';
}

export async function measureUiStartupGraph(indexPath) {
  const absoluteIndex = path.resolve(indexPath);
  const root = path.dirname(absoluteIndex);
  const html = await readFile(absoluteIndex, 'utf8');
  const assets = [];
  for (const url of collectInitialAssetUrls(html)) {
    const clean = url.split(/[?#]/, 1)[0] ?? url;
    const assetPath = path.resolve(root, clean.replace(/^[/\\]+/, ''));
    const bytes = await readFile(assetPath);
    assets.push({
      url,
      kind: assetKind(url),
      rawBytes: bytes.byteLength,
      gzipBytes: gzipSync(bytes).byteLength,
    });
  }

  const total = (kind, field) =>
    assets.filter((asset) => asset.kind === kind).reduce((sum, asset) => sum + asset[field], 0);
  return {
    indexPath: absoluteIndex,
    resourceCount: assets.length,
    jsRawBytes: total('js', 'rawBytes'),
    jsGzipBytes: total('js', 'gzipBytes'),
    cssRawBytes: total('css', 'rawBytes'),
    cssGzipBytes: total('css', 'gzipBytes'),
    assets,
  };
}

export function evaluateUiStartupBudget(metrics, budget = DEFAULT_UI_STARTUP_BUDGET) {
  const failures = [];
  if (metrics.jsGzipBytes > budget.jsGzipBytes) {
    failures.push(`initial JS gzip ${metrics.jsGzipBytes} > ${budget.jsGzipBytes}`);
  }
  if (metrics.cssGzipBytes > budget.cssGzipBytes) {
    failures.push(`initial CSS gzip ${metrics.cssGzipBytes} > ${budget.cssGzipBytes}`);
  }
  if (metrics.resourceCount > budget.resourceCount) {
    failures.push(`initial resource count ${metrics.resourceCount} > ${budget.resourceCount}`);
  }
  for (const asset of metrics.assets) {
    if (budget.forbiddenAssetNames.some((pattern) => pattern.test(asset.url))) {
      failures.push(`export-only asset entered startup graph: ${asset.url}`);
    }
  }
  return failures;
}

function formatBytes(bytes) {
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

function renderReport(metrics) {
  const largest = [...metrics.assets]
    .sort((a, b) => b.gzipBytes - a.gzipBytes)
    .slice(0, 8)
    .map((asset) => `  ${formatBytes(asset.gzipBytes)}  ${asset.url}`)
    .join('\n');
  return [
    `UI startup graph: ${metrics.resourceCount} resources`,
    `  JS:  ${formatBytes(metrics.jsRawBytes)} raw / ${formatBytes(metrics.jsGzipBytes)} gzip`,
    `  CSS: ${formatBytes(metrics.cssRawBytes)} raw / ${formatBytes(metrics.cssGzipBytes)} gzip`,
    'Largest initial resources:',
    largest,
  ].join('\n');
}

async function main() {
  const indexPath = process.argv[2] ?? 'packages/ui/dist/index.html';
  const metrics = await measureUiStartupGraph(indexPath);
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(metrics, null, 2)}\n`);
  } else {
    process.stdout.write(`${renderReport(metrics)}\n`);
  }
  const failures = evaluateUiStartupBudget(metrics);
  if (failures.length > 0) {
    process.stderr.write(`UI startup budget failed:\n- ${failures.join('\n- ')}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
