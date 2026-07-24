#!/usr/bin/env node
/**
 * Keep public legal inventory aligned with the artifacts we redistribute.
 *
 * This intentionally reads the human-facing Markdown manifests instead of
 * introducing a second generated source of truth. It fails on:
 *   - a native VERSION pin that is stale in NOTICE.md;
 *   - a native license manifest that is not bound to the same tag/commit;
 *   - missing or orphaned native license texts;
 *   - a bundled WOFF2 missing from the font manifest (or vice versa);
 *   - a font/license listed in the manifest but absent from NOTICE.md/disk.
 */
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

function wildcardRegex(pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*');
  return new RegExp(`^${escaped}$`);
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
  return { engines: engineIds.length, licenseFiles: referencedLicenseFiles.size };
}

async function checkFontInventory(notice) {
  const fontsRoot = join(repoRoot, 'packages', 'ui', 'src', 'assets', 'fonts');
  const fontManifest = await readFile(join(fontsRoot, 'README.md'), 'utf8');
  const rows = parseMarkdownTable(fontManifest).filter(
    (cells) => cells[0] !== 'File(s)' && cells.length >= 4,
  );
  const actualFonts = (await readdir(fontsRoot)).filter((name) => name.endsWith('.woff2'));
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
    if (declaredNames.has(fontName)) throw new Error(`duplicate bundled font name: ${fontName}`);
    declaredNames.add(fontName);

    const matcher = wildcardRegex(pattern);
    const matches = actualFonts.filter((file) => matcher.test(file));
    if (matches.length === 0) throw new Error(`font manifest pattern matches no files: ${pattern}`);
    for (const file of matches) matchedFiles.get(file).push(fontName);
  }

  for (const [file, names] of matchedFiles) {
    if (names.length !== 1) {
      throw new Error(
        `${relative(repoRoot, join(fontsRoot, file))} must match exactly one font manifest row; ` +
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
  if (!sameMembers(declaredNames, noticeNames)) {
    throw new Error(
      [
        'NOTICE bundled fonts differ from font manifest',
        `  manifest: ${formatSet(declaredNames)}`,
        `  NOTICE: ${formatSet(noticeNames)}`,
      ].join('\n'),
    );
  }
  return { families: declaredNames.size, files: actualFonts.length };
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
  };
  const rows = parseMarkdownTable(markdownSection(notice, 'Bundled application runtimes')).filter(
    (cells) => cells[0] !== 'Component' && cells.length >= 4,
  );
  const noticeNames = new Set();
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
  return { count: Object.keys(versions).length, versions };
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
  return { native, fonts, runtimes };
}

async function main() {
  const result = await verifyNoticeInventory();
  console.log(
    `\u2713 NOTICE inventory matches ${result.native.engines} native pins, ` +
      `${result.native.licenseFiles} native license texts, ` +
      `${result.fonts.families} font families, ${result.fonts.files} WOFF2 files, and ` +
      `${result.runtimes.count} bundled application runtimes.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`\u2717 NOTICE inventory check failed: ${error.message}`);
    process.exitCode = 1;
  });
}
