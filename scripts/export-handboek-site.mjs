#!/usr/bin/env node
// Build the CLI (and everything it depends on) then render the Handboek as a
// static site into a sibling checkout — by default `../gezel-site/docs`, which
// GitHub Pages serves as-is.
//
// The output directory is wiped between runs so articles deleted from the
// content tree don't linger on the published site. A marker file records that
// a directory is ours to wipe; anything else needs --force, so a mistyped
// --out can't delete a directory we never wrote.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MARKER = '.handboek-export.json';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, '..');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name) => {
  const idx = argv.indexOf(name);
  return idx === -1 ? undefined : argv[idx + 1];
};
const values = (name) => argv.flatMap((a, i) => (a === name && argv[i + 1] ? [argv[i + 1]] : []));

// Relative to the export root, so it points at gezel-site/handboek.css — one
// level above `docs/`, and therefore outside the directory this script wipes.
const DEFAULT_CSS = '../handboek.css';

// The docs sit under the site root, so the wordmark links back to the
// landing page. A project-scoped Pages deploy would need '/<repo>/'.
const DEFAULT_SITE_URL = '/';

if (flag('--help') || flag('-h')) {
  console.log(`Usage: node scripts/export-handboek-site.mjs [options]

  --out <dir>    output directory (default: ../gezel-site/docs)
  --css <href>   extra stylesheet linked on every page, relative to the export
                 root (default: ${DEFAULT_CSS}). Repeatable; --no-css disables.
  --site-url <u> site URL behind the masthead wordmark (default: ${DEFAULT_SITE_URL});
                 --no-site-url omits the wordmark
  --skip-build   reuse the current packages/cli/dist instead of rebuilding
  --force        wipe the output directory even without an export marker
`);
  process.exit(0);
}

const out = resolve(repoRoot, value('--out') ?? join('..', 'gezel-site', 'docs'));
const cssHrefs = flag('--no-css') ? [] : values('--css').length ? values('--css') : [DEFAULT_CSS];
const siteUrl = flag('--no-site-url') ? null : (value('--site-url') ?? DEFAULT_SITE_URL);

const run = (label, cmd, args) => {
  console.log(`[handboek-site] ${label}`);
  const result = spawnSync(cmd, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    console.error(`[handboek-site] ${label} failed`);
    process.exit(result.status ?? 1);
  }
};

if (!flag('--skip-build')) {
  run('bootstrap', 'node', [join('scripts', 'bootstrap.mjs')]);
  // `cli...` selects the CLI plus every workspace package it depends on, built
  // in topological order — core, client, catalog, mcp, service.
  run('building CLI + dependencies', 'pnpm', [
    '--filter',
    '@bendyline/gezel-cli...',
    'run',
    'build',
  ]);
}

const cliEntry = join(repoRoot, 'packages', 'cli', 'dist', 'bin', 'gezel.js');
if (!existsSync(cliEntry)) {
  console.error(`[handboek-site] CLI not built — missing ${cliEntry}`);
  console.error('[handboek-site] drop --skip-build, or run pnpm build first');
  process.exit(1);
}

if (existsSync(out)) {
  const entries = readdirSync(out);
  const ours = entries.includes(MARKER);
  if (entries.length > 0 && !ours && !flag('--force')) {
    console.error(`[handboek-site] ${out} has contents but no ${MARKER} marker.`);
    console.error(
      '[handboek-site] refusing to wipe it — pass --force if it is the right directory.',
    );
    process.exit(1);
  }
  await rm(out, { recursive: true, force: true });
}
await mkdir(out, { recursive: true });

run('rendering handboek', process.execPath, [
  cliEntry,
  'handboek',
  'export',
  '--out',
  out,
  ...cssHrefs.flatMap((href) => ['--css', href]),
  ...(siteUrl ? ['--site-url', siteUrl] : []),
]);

await writeFile(
  join(out, MARKER),
  `${JSON.stringify({ generator: 'scripts/export-handboek-site.mjs', source: repoRoot }, null, 2)}\n`,
  'utf8',
);

console.log(`[handboek-site] done — ${out}`);
console.log(
  `[handboek-site] preview: python3 -m http.server 8000 --directory ${resolve(out, '..')}`,
);
