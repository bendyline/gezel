#!/usr/bin/env node
/** Verify that npm's authoritative service payload includes its UI legal bundle. */
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  SERVICE_FONT_LEGAL_ROOT,
  SERVICE_NOTICE_PATH,
  verifyServiceFontLegalBundle,
} from './service-font-legal.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const serviceRoot = join(repoRoot, 'packages', 'service');

function npmPackDryRun(cache) {
  const packArgs = [
    'pack',
    '.',
    '--dry-run',
    '--json',
    '--ignore-scripts',
    '--workspaces=false',
    '--cache',
    cache,
  ];
  const command = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : 'npm';
  const args = process.platform === 'win32' ? ['/d', '/s', '/c', 'npm.cmd', ...packArgs] : packArgs;
  const result = spawnSync(command, args, {
    cwd: serviceRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const detail = [result.error?.stack, result.stderr, result.stdout].filter(Boolean).join('\n');
    throw new Error(
      `npm pack failed (status=${result.status}, signal=${result.signal}):\n${detail}`,
    );
  }
  const parsed = JSON.parse(result.stdout);
  const packed = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!packed?.files) throw new Error('npm pack returned no service payload');
  return packed.files.map((file) => file.path.replaceAll('\\', '/'));
}

export async function verifyServicePackageLicenses() {
  const staged = await verifyServiceFontLegalBundle();
  const cache = await mkdtemp(join(tmpdir(), 'gezel-service-pack-licenses-'));
  try {
    const packed = new Set(npmPackDryRun(cache));
    if (!packed.has('dist/NOTICE.md')) {
      throw new Error('service npm tarball is missing dist/NOTICE.md');
    }

    const legalNames = await readdir(SERVICE_FONT_LEGAL_ROOT);
    for (const name of legalNames) {
      const path = `dist/licenses/fonts/${name}`;
      if (!packed.has(path)) throw new Error(`service npm tarball is missing ${path}`);
    }

    const fontAssets = [...packed].filter(
      (path) => path.startsWith('dist/ui/assets/') && /\.(?:woff2?|ttf|otf)$/i.test(path),
    );
    if (fontAssets.length === 0) {
      throw new Error('service npm tarball contains no built UI font assets');
    }

    const notice = await readFile(SERVICE_NOTICE_PATH, 'utf8');
    for (const attribution of [
      'OpenMoji attribution note',
      `Font Awesome Free ${staged.fontAwesomeVersion}`,
      'Visual Studio Code icons',
      'Microsoft Corporation',
    ]) {
      if (!notice.includes(attribution)) {
        throw new Error(`service npm notice is missing attribution: ${attribution}`);
      }
    }
    return { fontAssets: fontAssets.length, legalFiles: legalNames.length };
  } finally {
    await rm(cache, { recursive: true, force: true });
  }
}

async function main() {
  const result = await verifyServicePackageLicenses();
  console.log(
    `\u2713 verified service npm payload carries ${result.fontAssets} built font assets, ` +
      `NOTICE.md, and ${result.legalFiles} font-license files.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`\u2717 service npm license verification failed: ${error.message}`);
    process.exitCode = 1;
  });
}
