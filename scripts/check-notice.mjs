#!/usr/bin/env node
/**
 * Keep public legal inventory aligned with the artifacts we redistribute.
 *
 * This intentionally reads the human-facing Markdown manifests instead of
 * introducing a second generated source of truth. It fails on:
 *   - a native VERSION pin that is stale in NOTICE.md;
 *   - a native license manifest that is not bound to the same tag/commit;
 *   - missing or orphaned native license texts;
 *   - a built UI font missing from the font manifest/NOTICE (or vice versa);
 *   - a font license absent from the service npm payload or stale on disk.
 */
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  loadPnpmRuntimeInventory,
  pnpmReleaseTargets,
  shippedPnpmRuntimePackages,
} from './pnpm-runtime-inventory.mjs';
import { verifyServiceFontLegalBundle } from './service-font-legal.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(scriptDir, '..');

const ENGINE_NOTICE_NAMES = {
  ds4: 'ds4 / DwarfStar',
  'llama-cpp': 'llama.cpp',
  'sd-cpp': 'stable-diffusion.cpp',
  uv: 'uv',
  'whisper-cpp': 'whisper.cpp',
};

function parseMarkdownTable(section) {
  const rows = [];
  for (const line of section.split('\n')) {
    if (!line.trimStart().startsWith('|')) continue;
    const cells = line
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((cell) => cell.trim());
    if (cells.every((cell) => /^:?-{3,}:?$/.test(cell))) continue;
    rows.push(cells);
  }
  return rows;
}

function markdownSection(markdown, heading) {
  const marker = `## ${heading}`;
  const start = markdown.indexOf(marker);
  if (start < 0) throw new Error(`missing Markdown section: ${marker}`);
  const rest = markdown.slice(start + marker.length);
  const next = rest.search(/\n## /);
  return next < 0 ? rest : rest.slice(0, next);
}

function markdownSubsection(markdown, heading) {
  const marker = `### ${heading}`;
  const start = markdown.indexOf(marker);
  if (start < 0) throw new Error(`missing Markdown subsection: ${marker}`);
  const rest = markdown.slice(start + marker.length);
  const next = rest.search(/\n#{2,3} /);
  return next < 0 ? rest : rest.slice(0, next);
}

function plainMarkdown(value) {
  return value
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/\[([^\]]+)]\([^)]+\)/g, '$1')
    .trim();
}

function parseVersionFile(source, path) {
  const values = {};
  for (const line of source.split('\n')) {
    const match = line.match(/^([a-zA-Z0-9_]+)=(.+)$/);
    if (match) values[match[1]] = match[2].trim();
  }
  if (!values.tag || !values.commit) {
    throw new Error(`${path} must contain tag= and commit=`);
  }
  if (!/^[0-9a-f]{40}$/.test(values.commit)) {
    throw new Error(`${path} commit must be a full 40-character lowercase SHA`);
  }
  return values;
}

async function parsePinnedConstant(path, name) {
  const source = await readFile(path, 'utf8');
  const match = source.match(new RegExp(`\\b${name}\\s*=\\s*['\"]([^'\"]+)['\"]`));
  if (!match) throw new Error(`cannot parse ${name} from ${relative(repoRoot, path)}`);
  return match[1];
}

function builtFontRegex(pattern) {
  const match = pattern.match(/^(.+)\.(woff2?|ttf|otf)$/i);
  if (!match) throw new Error(`invalid bundled-font pattern: ${pattern}`);
  const stem = match[1];
  const escaped = stem.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*');
  // Vite preserves the original stem and inserts a content hash before the
  // extension. A wildcard source pattern already consumes that hash; exact
  // names (OpenMoji) need the optional suffix explicitly.
  const hash = stem.includes('*') ? '' : '(?:-[a-zA-Z0-9_-]+)?';
  return new RegExp(`^${escaped}${hash}\\.${match[2]}$`, 'i');
}

function sorted(values) {
  return [...values].sort((a, b) => a.localeCompare(b));
}

function sameMembers(left, right) {
  const a = sorted(left);
  const b = sorted(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function formatSet(values) {
  return sorted(values).join(', ') || '(none)';
}

async function checkNativeInventory(notice) {
  const enginesRoot = join(repoRoot, 'native', 'engines');
  const licensesRoot = join(repoRoot, 'native', 'licenses');
  const licenseManifestPath = join(licensesRoot, 'manifest.json');
  const manifest = JSON.parse(await readFile(licenseManifestPath, 'utf8'));
  if (manifest.schemaVersion !== 1 || !manifest.engines || typeof manifest.engines !== 'object') {
    throw new Error('native/licenses/manifest.json must have schemaVersion 1 and an engines map');
  }

  const engineIds = [];
  for (const entry of await readdir(enginesRoot, { withFileTypes: true })) {
    if (entry.isDirectory() && existsSync(join(enginesRoot, entry.name, 'VERSION'))) {
      engineIds.push(entry.name);
    }
  }
  if (!sameMembers(engineIds, Object.keys(manifest.engines))) {
    throw new Error(
      [
        'native license engines differ from VERSION inventory',
        `  VERSION: ${formatSet(engineIds)}`,
        `  licenses: ${formatSet(Object.keys(manifest.engines))}`,
      ].join('\n'),
    );
  }

  const nativeRows = parseMarkdownTable(
    markdownSection(notice, 'Native engines and bundled binaries'),
  );
  const referencedLicenseFiles = new Set();
  // Collected for generate-sbom.mjs. This loop already reconciles the VERSION
  // pin, the license manifest, and the NOTICE row, so it is the one place that
  // has all three agreeing — re-parsing NOTICE.md in the SBOM generator would
  // be a second parser to keep in step.
  const components = [];
  for (const engineId of engineIds) {
    const versionPath = join(enginesRoot, engineId, 'VERSION');
    const pin = parseVersionFile(
      await readFile(versionPath, 'utf8'),
      relative(repoRoot, versionPath),
    );
    const legal = manifest.engines[engineId];
    if (legal.tag !== pin.tag || legal.commit !== pin.commit) {
      throw new Error(
        `native license manifest is stale for ${engineId}: VERSION is ${pin.tag}/${pin.commit}, ` +
          `manifest is ${legal.tag}/${legal.commit}`,
      );
    }
    if (!Array.isArray(legal.files) || legal.files.length === 0) {
      throw new Error(`native license manifest has no files for ${engineId}`);
    }
    for (const file of legal.files) {
      if (typeof file !== 'string' || file.includes('/') || file.includes('\\')) {
        throw new Error(`invalid native license filename for ${engineId}: ${String(file)}`);
      }
      if (!existsSync(join(licensesRoot, file))) {
        throw new Error(`missing native license text: native/licenses/${file}`);
      }
      referencedLicenseFiles.add(file);
    }

    const noticeName = ENGINE_NOTICE_NAMES[engineId];
    if (!noticeName) throw new Error(`add NOTICE mapping for native engine ${engineId}`);
    const row = nativeRows.find((cells) => plainMarkdown(cells[0] ?? '').includes(noticeName));
    if (!row) throw new Error(`NOTICE.md has no native row for ${noticeName}`);
    const versionCell = row[1] ?? '';
    const expected =
      engineId === 'ds4'
        ? `commit \`${pin.commit.slice(0, 8)}\` (\`${pin.tag}\`)`
        : `tag \`${pin.tag}\``;
    if (versionCell !== expected) {
      throw new Error(
        `NOTICE.md native pin is stale for ${noticeName}: expected "${expected}", found "${versionCell}"`,
      );
    }

    components.push({
      id: engineId,
      name: noticeName,
      // ds4 is pinned by commit; everything else by upstream tag.
      version: engineId === 'ds4' ? pin.commit : pin.tag,
      tag: pin.tag,
      commit: pin.commit,
      license: plainMarkdown(row[2] ?? ''),
      source: (row[3] ?? '').match(/\]\((https?:[^)]+)\)/)?.[1] ?? null,
    });
  }

  const presentLicenseFiles = (await readdir(licensesRoot)).filter((name) =>
    name.startsWith('LICENSE-'),
  );
  if (!sameMembers(presentLicenseFiles, referencedLicenseFiles)) {
    throw new Error(
      [
        'native license files differ from manifest',
        `  files: ${formatSet(presentLicenseFiles)}`,
        `  manifest: ${formatSet(referencedLicenseFiles)}`,
      ].join('\n'),
    );
  }
  return {
    engines: engineIds.length,
    licenseFiles: referencedLicenseFiles.size,
    components,
  };
}

async function checkFontInventory(notice) {
  const fontsRoot = join(repoRoot, 'packages', 'ui', 'src', 'assets', 'fonts');
  const builtAssetsRoot = join(repoRoot, 'packages', 'service', 'dist', 'ui', 'assets');
  if (!existsSync(builtAssetsRoot)) {
    throw new Error(
      'missing packages/service/dist/ui/assets; build the UI and service before checking notices',
    );
  }
  const stagedLegal = await verifyServiceFontLegalBundle();
  const fontManifest = await readFile(join(fontsRoot, 'README.md'), 'utf8');
  const rows = parseMarkdownTable(fontManifest).filter(
    (cells) => cells[0] !== 'File(s)' && cells.length >= 4,
  );
  const actualFonts = (await readdir(builtAssetsRoot)).filter((name) =>
    /\.(?:woff2?|ttf|otf)$/i.test(name),
  );
  if (actualFonts.length === 0) {
    throw new Error('packages/service/dist/ui/assets contains no built font files');
  }
  const declaredNames = new Set();
  const matchedFiles = new Map(actualFonts.map((name) => [name, []]));

  for (const cells of rows) {
    const patternMatch = (cells[0] ?? '').match(/`([^`]+\.woff2)`/);
    const nameMatch = (cells[1] ?? '').match(/\*\*([^*]+)\*\*/);
    const licenseMatch = (cells[3] ?? '').match(/\]\(([^)]+)\)/);
    if (!patternMatch || !nameMatch || !licenseMatch) {
      throw new Error(`invalid bundled-font manifest row: | ${cells.join(' | ')} |`);
    }
    const pattern = patternMatch[1];
    const fontName = nameMatch[1].trim();
    const licensePath = resolve(fontsRoot, licenseMatch[1]);
    if (!existsSync(licensePath)) {
      throw new Error(
        `font ${fontName} references missing license ${relative(repoRoot, licensePath)}`,
      );
    }
    const matcher = builtFontRegex(pattern);
    const matches = actualFonts.filter((file) => matcher.test(file));
    // The source manifest also records weights/themes that Vite may tree-shake.
    // Only families represented in the distribution belong in its inventory.
    if (matches.length === 0) continue;
    if (declaredNames.has(fontName)) throw new Error(`duplicate bundled font name: ${fontName}`);
    declaredNames.add(fontName);
    for (const file of matches) matchedFiles.get(file).push(fontName);
  }

  const dependencyFonts = [
    {
      name: `Font Awesome Free ${stagedLegal.fontAwesomeVersion}`,
      pattern: 'fa-*.woff2',
    },
    { name: 'Visual Studio Code icons', pattern: 'codicon-*.ttf' },
  ];
  for (const font of dependencyFonts) {
    const matcher = builtFontRegex(font.pattern);
    const matches = actualFonts.filter((file) => matcher.test(file));
    if (matches.length === 0) {
      throw new Error(`dependency font pattern matches no built files: ${font.pattern}`);
    }
    declaredNames.add(font.name);
    for (const file of matches) matchedFiles.get(file).push(font.name);
  }

  for (const [file, names] of matchedFiles) {
    if (names.length !== 1) {
      throw new Error(
        `${relative(repoRoot, join(builtAssetsRoot, file))} must match exactly one font manifest row; ` +
          `matched ${names.length}: ${names.join(', ') || '(none)'}`,
      );
    }
  }

  const noticeRows = parseMarkdownTable(markdownSection(notice, 'Bundled fonts and emoji')).filter(
    (cells) => cells[0] !== 'Asset' && cells.length >= 3,
  );
  const noticeNames = new Set();
  for (const cells of noticeRows) {
    const match = (cells[0] ?? '').match(/\*\*([^*]+)\*\*/);
    if (!match) throw new Error(`invalid NOTICE bundled-font row: | ${cells.join(' | ')} |`);
    noticeNames.add(match[1].trim());
    const licenseMatch = (cells[1] ?? '').match(/\]\(([^)]+)\)/);
    if (!licenseMatch || !existsSync(resolve(repoRoot, licenseMatch[1]))) {
      throw new Error(`NOTICE font ${match[1].trim()} does not link to a local license text`);
    }
  }
  const dependencySection = markdownSection(notice, 'Icon fonts carried inside dependencies');
  const dependencyRows = parseMarkdownTable(dependencySection).filter(
    (cells) => cells[0] !== 'Asset' && cells.length >= 4,
  );
  for (const cells of dependencyRows) {
    const match = (cells[0] ?? '').match(/\*\*([^*]+)\*\*/);
    if (!match) throw new Error(`invalid NOTICE dependency-font row: | ${cells.join(' | ')} |`);
    noticeNames.add(match[1].trim());
  }
  for (const required of ['Fonticons, Inc.', 'Microsoft Corporation', 'used unmodified']) {
    if (!dependencySection.includes(required)) {
      throw new Error(`NOTICE dependency-font attribution is missing: ${required}`);
    }
  }
  if (!sameMembers(declaredNames, noticeNames)) {
    throw new Error(
      [
        'NOTICE bundled fonts differ from built service UI assets',
        `  built: ${formatSet(declaredNames)}`,
        `  NOTICE: ${formatSet(noticeNames)}`,
      ].join('\n'),
    );
  }
  return {
    families: declaredNames.size,
    files: actualFonts.length,
    licenseFiles: stagedLegal.files,
  };
}

async function checkBundledRuntimes(notice) {
  const appRoot = join(repoRoot, 'packages', 'app');
  const requireFromApp = createRequire(join(appRoot, 'package.json'));
  const electronPackage = JSON.parse(
    await readFile(requireFromApp.resolve('electron/package.json'), 'utf8'),
  );
  const versions = {
    Electron: electronPackage.version,
    'Node.js': await parsePinnedConstant(join(appRoot, 'src', 'node-version.ts'), 'NODE_VERSION'),
    pnpm: await parsePinnedConstant(join(appRoot, 'src', 'pnpm-version.ts'), 'PNPM_VERSION'),
    // DuckDB's pin lives in core, not packages/app, because the service's
    // engine resolver reads the same constant when an npm / CLI install
    // downloads it. It is a bundled runtime rather than a native engine: we
    // redistribute the DuckDB Foundation's own signed, notarized binary and
    // never build or re-sign it.
    DuckDB: await parsePinnedConstant(
      join(repoRoot, 'packages', 'core', 'src', 'native', 'duckdb-pin.ts'),
      'DUCKDB_VERSION',
    ),
  };
  const runtimeSection = markdownSection(notice, 'Bundled application runtimes').split('\n### ')[0];
  const rows = parseMarkdownTable(runtimeSection).filter(
    (cells) => cells[0] !== 'Component' && cells.length >= 4,
  );
  const noticeNames = new Set();
  const components = [];
  for (const cells of rows) {
    const name = plainMarkdown(cells[0] ?? '');
    noticeNames.add(name);
    if (!(name in versions)) throw new Error(`NOTICE has an unknown bundled runtime: ${name}`);
    const foundVersion = plainMarkdown(cells[1] ?? '');
    if (foundVersion !== versions[name]) {
      throw new Error(
        `NOTICE.md bundled runtime is stale for ${name}: expected ${versions[name]}, found ${foundVersion}`,
      );
    }
    components.push({
      name,
      version: versions[name],
      license: plainMarkdown(cells[2] ?? ''),
      source: (cells[3] ?? '').match(/\]\((https?:[^)]+)\)/)?.[1] ?? null,
    });
  }
  if (!sameMembers(Object.keys(versions), noticeNames)) {
    throw new Error(
      [
        'NOTICE bundled runtimes differ from packaged runtime inventory',
        `  packaged: ${formatSet(Object.keys(versions))}`,
        `  NOTICE: ${formatSet(noticeNames)}`,
      ].join('\n'),
    );
  }
  return { count: Object.keys(versions).length, versions, components };
}

function pnpmTargetDisplay(targets) {
  return targets.length === pnpmReleaseTargets().length
    ? 'all released targets'
    : targets.join(', ');
}

async function checkPnpmRuntimeInventory(notice) {
  const inventory = await loadPnpmRuntimeInventory();
  const expected = shippedPnpmRuntimePackages(inventory);
  const rows = parseMarkdownTable(
    markdownSubsection(notice, 'pnpm embedded dependency graph'),
  ).filter((cells) => cells[0] !== 'Package' && cells.length >= 4);
  const byIdentity = new Map();
  for (const cells of rows) {
    const name = plainMarkdown(cells[0] ?? '');
    const version = plainMarkdown(cells[1] ?? '');
    const identity = `${name}@${version}`;
    if (byIdentity.has(identity)) throw new Error(`duplicate NOTICE pnpm runtime row: ${identity}`);
    byIdentity.set(identity, {
      name,
      version,
      license: plainMarkdown(cells[2] ?? ''),
      targets: plainMarkdown(cells[3] ?? ''),
    });
  }
  const expectedIds = expected.map((pkg) => `${pkg.name}@${pkg.version}`);
  if (!sameMembers(expectedIds, byIdentity.keys())) {
    throw new Error(
      [
        'NOTICE pnpm embedded dependency graph differs from the pin-bound inventory',
        `  inventory: ${formatSet(expectedIds)}`,
        `  NOTICE: ${formatSet(byIdentity.keys())}`,
      ].join('\n'),
    );
  }
  for (const pkg of expected) {
    const row = byIdentity.get(`${pkg.name}@${pkg.version}`);
    if (row.license !== pkg.license) {
      throw new Error(
        `NOTICE pnpm runtime license is stale for ${pkg.name}@${pkg.version}: ` +
          `expected ${pkg.license}, found ${row.license}`,
      );
    }
    const expectedTargets = pnpmTargetDisplay(pkg.targets);
    if (row.targets !== expectedTargets) {
      throw new Error(
        `NOTICE pnpm runtime targets are stale for ${pkg.name}@${pkg.version}: ` +
          `expected ${expectedTargets}, found ${row.targets}`,
      );
    }
  }
  return {
    pnpmVersion: inventory.pnpmVersion,
    packageSha256: inventory.packageSha256,
    count: expected.length,
    components: expected,
  };
}

export async function verifyNativeNoticeInventory() {
  const notice = await readFile(join(repoRoot, 'NOTICE.md'), 'utf8');
  return checkNativeInventory(notice);
}

export async function verifyNoticeInventory() {
  const notice = await readFile(join(repoRoot, 'NOTICE.md'), 'utf8');
  const native = await checkNativeInventory(notice);
  const fonts = await checkFontInventory(notice);
  const runtimes = await checkBundledRuntimes(notice);
  const pnpmRuntime = await checkPnpmRuntimeInventory(notice);
  return { native, fonts, runtimes, pnpmRuntime };
}

async function main() {
  const result = await verifyNoticeInventory();
  console.log(
    `\u2713 NOTICE inventory matches ${result.native.engines} native pins, ` +
      `${result.native.licenseFiles} native license texts, ` +
      `${result.fonts.families} font families, ${result.fonts.files} built font files, ` +
      `${result.fonts.licenseFiles} service font-license files, and ` +
      `${result.runtimes.count} bundled application runtimes with ` +
      `${result.pnpmRuntime.count} embedded pnpm dependency identities.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`\u2717 NOTICE inventory check failed: ${error.message}`);
    process.exitCode = 1;
  });
}
