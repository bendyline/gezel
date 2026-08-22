#!/usr/bin/env node
// Build the CLI (and everything it depends on) then render the Handboek as a
// static site into a sibling checkout — by default `../gezel-site/docs`, which
// GitHub Pages serves as-is.
//
// The output directory is wiped between runs so articles deleted from the
// content tree don't linger on the published site. A marker file records that
// a directory is ours to wipe; anything else needs --force, so a mistyped
// --out can't delete a directory we never wrote.
//
// The same run refreshes `releases.json` beside the site root — the download
// listing index.html reads instead of calling the GitHub releases API from the
// visitor's browser. It sits outside the wiped directory, alongside
// handboek.css, so regenerating docs can never leave the landing page without
// downloads.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_REPO, writeReleaseListing } from './latest-app-release.mjs';

const MARKER = '.handboek-export.json';
const RELEASES_FILE = 'releases.json';

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
  --releases <f> download listing index.html reads (default: the site root beside
                 --out, i.e. ../gezel-site/${RELEASES_FILE}); --no-releases skips it
  --repo <o/n>   repository to read releases from (default: ${DEFAULT_REPO})
  --skip-build   reuse the current packages/cli/dist instead of rebuilding
  --force        wipe the output directory even without an export marker
`);
  process.exit(0);
}

const out = resolve(repoRoot, value('--out') ?? join('..', 'gezel-site', 'docs'));
const cssHrefs = flag('--no-css') ? [] : values('--css').length ? values('--css') : [DEFAULT_CSS];
const siteUrl = flag('--no-site-url') ? null : (value('--site-url') ?? DEFAULT_SITE_URL);
const releasesOut = flag('--no-releases')
  ? null
  : value('--releases')
    ? resolve(repoRoot, value('--releases'))
    : resolve(out, '..', RELEASES_FILE);
const repo = value('--repo') ?? process.env.GH_REPO ?? DEFAULT_REPO;

const run = (label, cmd, args) => {
  console.log(`[handboek-site] ${label}`);
  const result = spawnSync(cmd, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    // Windows needs cmd.exe to resolve pnpm's .cmd shim. Keep direct
    // executables (especially process.execPath under Program Files) out of
    // the shell so paths containing spaces remain intact.
    shell: process.platform === 'win32' && cmd === 'pnpm',
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

let releasesFailure = null;
if (releasesOut) {
  console.log('[handboek-site] refreshing download listing');
  try {
    const listing = await writeReleaseListing(releasesOut, { repo });
    console.log(
      `[handboek-site] ${listing.tag} — ${listing.builds.length} builds → ${releasesOut}`,
    );
  } catch (err) {
    releasesFailure = err.message;
  }
}

console.log(`[handboek-site] done — ${out}`);
console.log(
  `[handboek-site] preview: python3 -m http.server 8000 --directory ${resolve(out, '..')}`,
);

// A listing from the previous run still points at real installers, so a GitHub
// blip must not block a docs publish. Having no listing at all is a different
// thing: the download section degrades to the releases page, and that is worth
// failing over.
if (releasesFailure) {
  const salvaged = existsSync(releasesOut);
  console.error(`[handboek-site] download listing not refreshed — ${releasesFailure}`);
  console.error(
    salvaged
      ? `[handboek-site] keeping the existing ${releasesOut}`
      : `[handboek-site] no ${releasesOut} — the site will link the releases page instead`,
  );
  console.error('[handboek-site] retry on its own with: node scripts/latest-app-release.mjs');
  if (!salvaged) process.exit(1);
}
