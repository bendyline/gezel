#!/usr/bin/env node
// Install page libraries (docs/page-libraries.md) from the catalog's pins,
// without a running daemon. Each line's package is fetched from the npm
// registry, checked against its pinned hash, and installed by the same store
// the daemon serves from.
//
//   node scripts/seed-page-libraries.mjs --home <dir>     a Gezel home
//   node scripts/seed-page-libraries.mjs --out <dir>      a folder that ships
//                                                         with the app
//   node scripts/seed-page-libraries.mjs --home <dir> --only three,chart.js
//   node scripts/seed-page-libraries.mjs --out packages/mobile/page-libraries --phone
//
// One of --home or --out is required, so a run never writes into a home by
// accident. Lines come from the catalog: `--gilde <data dir>`, else
// GEZEL_GILDE_DATA_DIR, else the pinned @bendyline/gilde. Store builds stage
// their fixed set with `--out packages/app/dist/page-libraries`, which
// electron-builder ships as Resources/page-libraries; they pass `--allow-empty`,
// so a catalog without the kind stages an empty folder instead of failing
// the release. `--phone` takes only the
// lines marked for phones, which the phone app's build bundles from
// packages/mobile/page-libraries.
//
// Needs built packages: run `pnpm build` (or `pnpm dev`) first.
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const built = (path) => import(pathToFileURL(join(root, 'packages', path)).href);

function option(name) {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
}

const out = option('--out');
const home = option('--home');
if (!out === !home) {
  console.error('Pass exactly one of --home <Gezel home> or --out <folder>.');
  process.exit(2);
}
const only = option('--only')
  ?.split(',')
  .map((entry) => entry.trim());
const phoneOnly = process.argv.includes('--phone');

const { BundledSource, fetchPinnedNpmTarball, gildeDataDir } = await built('catalog/dist/index.js');
const { PageLibraryStore } = await built('inference/dist/page-libraries/store.js');
const { scanPreviewModuleImports } = await built('script-runtime/dist/preview-module.js');
const { splitPackageSpecifier } = await built('core/dist/pages/index.js');

const dataDir = resolve(option('--gilde') ?? process.env.GEZEL_GILDE_DATA_DIR ?? gildeDataDir());
const items = await new BundledSource({ dataDir }).list('page-library');
const lines = items
  .flatMap((item) => (item.manifest.kind === 'page-library' ? item.manifest.lines : []))
  .filter((line) => !only || only.includes(line.library))
  .filter((line) => !phoneOnly || line.hosts.includes('phone'));
if (!lines.length) {
  // A store build staged from a catalog that carries none yet still needs
  // the folder electron-builder ships; the app reads an empty one as none.
  if (process.argv.includes('--allow-empty') && out) {
    await mkdir(resolve(out), { recursive: true });
    console.log(`No page libraries in the catalog at ${dataDir}; staged an empty ${resolve(out)}.`);
    process.exit(0);
  }
  console.error(`No page libraries in the catalog at ${dataDir}.`);
  process.exit(1);
}

/**
 * What would leave a page without an answer. A module entry may import only
 * the line's own packages and what it declares in `requires`: d3's published
 * `.mjs` re-exports thirty `d3-*` packages and loads nothing. A CommonJS file
 * (`commonjs`) must require only what its spec imports, and assign every
 * name its spec exports. Read from the text; nothing downloaded is run.
 */
async function lineProblems(line, dir) {
  const answered = new Set([...line.packages, ...Object.keys(line.requires ?? {})]);
  const missing = new Set();
  for (const path of Object.values(line.module?.entries ?? {})) {
    if (path.endsWith('/')) continue;
    const source = await readFile(join(dir, path), 'utf8');
    for (const { specifier } of scanPreviewModuleImports(source, path)) {
      const named = splitPackageSpecifier(specifier);
      if (named && !answered.has(named.name)) missing.add(named.name);
    }
  }
  const problems = missing.size
    ? [`its module files import ${[...missing].join(', ')}, which the line does not declare`]
    : [];
  for (const [request, spec] of Object.entries(line.commonjs ?? {})) {
    const source = await readFile(join(dir, spec.file), 'utf8');
    const required = new Set(
      [...source.matchAll(/(?<![\w$.])require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]),
    );
    const imports = new Set(spec.imports);
    for (const name of required)
      if (!imports.has(name))
        problems.push(`${request} requires ${name}, which its spec does not import`);
    for (const name of imports) {
      const named = splitPackageSpecifier(name);
      if (!named || !answered.has(named.name))
        problems.push(`${request} imports ${name}, which the line neither is nor requires`);
    }
    const assigned = new Set(
      [...source.matchAll(/(?<![\w$.])exports\.([A-Za-z_$][\w$]*)\s*=(?!=)/g)].map((m) => m[1]),
    );
    const absent = spec.exports.filter((name) => !assigned.has(name));
    if (absent.length)
      problems.push(`${request} exports ${absent.join(', ')}, which ${spec.file} never assigns`);
  }
  return problems;
}

const store = new PageLibraryStore({
  home: resolve(home ?? tmpdir()),
  seedRoots: [],
  ...(out ? { writableRoot: resolve(out) } : {}),
});
const installed = new Set((await store.lines()).map((line) => `${line.library}@${line.version}`));
const scratch = await mkdtemp(join(tmpdir(), 'gezel-seed-page-libraries-'));
let failed = 0;
let total = 0;
try {
  for (const line of lines) {
    const label = `${line.library}@${line.version}`;
    if (installed.has(label)) {
      console.log(`  have      ${label}`);
      continue;
    }
    try {
      const tarballPath = join(scratch, `${line.library}-${line.version}.tgz`);
      await fetchPinnedNpmTarball({
        packageName: line.source.package,
        version: line.source.version,
        dest: tarballPath,
      });
      const result = await store.install({ line, tarballPath });
      const problems = await lineProblems(line, result.dir);
      if (problems.length) {
        await rm(result.dir, { recursive: true, force: true });
        throw new Error(problems.join('; '));
      }
      const bytes = Object.values(result.files).reduce((sum, file) => sum + file.bytes, 0);
      total += bytes;
      console.log(
        `  installed ${label}  ${Object.keys(result.files).length} files, ${(bytes / 1024 / 1024).toFixed(1)} MB`,
      );
    } catch (err) {
      failed += 1;
      console.error(`  FAILED    ${label}: ${err instanceof Error ? err.message : err}`);
    }
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}
console.log(
  `shelf: ${out ? resolve(out) : join(resolve(home), 'page-libraries')} (${(total / 1024 / 1024).toFixed(1)} MB added)`,
);
process.exit(failed ? 1 : 0);
