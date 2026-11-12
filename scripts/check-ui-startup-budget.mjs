import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

export const DEFAULT_UI_STARTUP_BUDGET = Object.freeze({
  // The pre-review graph was 3.41 MB gzip; the first navigation-boundary pass
  // brought it below 0.9 MB. Keep modest headroom for ordinary work while
  // preventing large features from silently re-entering the shell.
  // Raised from 950_000 for Squisq 2.11.8, whose media-edit schema, narrated
  // segment transform, and animated-image inspection reach the startup graph
  // (~959 KB); moving those behind a lazy boundary upstream is the follow-up.
  // Lowered to about 1.5x the 2026-11-11 measurement (~519 KB) once search
  // snippets stopped pulling Squisq's markdown stack and icon catalog into the
  // shell; a cap at twice the real size would let all of it back unnoticed.
  jsGzipBytes: 780_000,
  cssGzipBytes: 80_000,
  resourceCount: 44,
  forbiddenAssetNames: [/(?:^|\/)(?:pdf|docx|pptx|jszip|standalone-source)[-.]/i],
});

/**
 * What a destination may load beyond the shell before it renders, from the
 * route graph the UI build writes (packages/ui/scripts/vite-route-graph.ts).
 * About 1.5x the 2026-11-12 measurement: Home 84 chunks / 1.30 MB gzip,
 * Projects 89 / 1.22 MB, 481 chunks in all. The caps catch a large regression
 * (a heavy library pulled into a view's first load), not drift.
 */
export const DEFAULT_ROUTE_BUDGET = Object.freeze({
  destinations: Object.freeze({
    HomeView: { chunks: 126, gzipBytes: 1_950_000 },
    ProjectsView: { chunks: 134, gzipBytes: 1_850_000 },
  }),
  totalChunks: 720,
});

export function evaluateRouteBudget(graph, totalChunks, budget = DEFAULT_ROUTE_BUDGET) {
  const failures = [];
  for (const [name, cap] of Object.entries(budget.destinations)) {
    const destination = graph.destinations?.[name];
    if (!destination) {
      failures.push(`route graph has no ${name}`);
      continue;
    }
    const chunks = destination.files ?? destination.chunks?.length ?? 0;
    if (chunks > cap.chunks) failures.push(`${name} loads ${chunks} chunks > ${cap.chunks}`);
    if (destination.gzipBytes > cap.gzipBytes) {
      failures.push(`${name} loads ${destination.gzipBytes} gzip bytes > ${cap.gzipBytes}`);
    }
  }
  if (totalChunks > budget.totalChunks) {
    failures.push(`${totalChunks} JS chunks in the build > ${budget.totalChunks}`);
  }
  return failures;
}

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
  const root = path.dirname(path.resolve(indexPath));
  const graph = await readFile(path.join(root, 'route-graph.json'), 'utf8').then(
    (text) => JSON.parse(text),
    () => null,
  );
  if (graph) {
    const assets = await readdir(path.join(root, 'assets'));
    const totalChunks = assets.filter((name) => name.endsWith('.js')).length;
    failures.push(...evaluateRouteBudget(graph, totalChunks));
  }
  if (failures.length > 0) {
    process.stderr.write(`UI startup budget failed:\n- ${failures.join('\n- ')}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
