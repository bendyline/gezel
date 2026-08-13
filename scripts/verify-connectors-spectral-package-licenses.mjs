#!/usr/bin/env node
/** Verify that the published Spectral connector carries its Apache legal payload. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageRoot = join(repoRoot, 'packages', 'connectors-spectral');
const apacheLicensePath = join(packageRoot, 'THIRD_PARTY_LICENSES', 'Apache-2.0.txt');
const noticePath = join(packageRoot, 'NOTICE.md');
const provenancePath = join(packageRoot, 'vendor', 'provenance.json');
const legalBanner = 'Includes modified portions of prismatic-io/components';
const apacheLicenseSha256 = '7782acf4e68f6098643d91417bdb71212d5ef826e1a754bf5329888c97dfcbf0';

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
    cwd: packageRoot,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const detail = [result.error?.stack, result.stderr, result.stdout].filter(Boolean).join('\n');
    throw new Error(
      `npm pack failed (status=${result.status}, signal=${result.signal}):\n${detail}`,
    );
  }
  const parsed = JSON.parse(result.stdout);
  const packed = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!packed?.files) throw new Error('npm pack returned no Spectral connector payload');
  return new Set(packed.files.map((file) => file.path.replaceAll('\\', '/')));
}

export async function verifyConnectorsSpectralPackageLicenses() {
  const cache = await mkdtemp(join(tmpdir(), 'gezel-spectral-pack-licenses-'));
  try {
    const packed = npmPackDryRun(cache);
    for (const path of [
      'NOTICE.md',
      'THIRD_PARTY_LICENSES/Apache-2.0.txt',
      'vendor/provenance.json',
    ]) {
      if (!packed.has(path)) throw new Error(`Spectral connector npm tarball is missing ${path}`);
    }

    const [license, notice, provenanceSource, manifestSource] = await Promise.all([
      readFile(apacheLicensePath, 'utf8'),
      readFile(noticePath, 'utf8'),
      readFile(provenancePath, 'utf8'),
      readFile(join(packageRoot, 'package.json'), 'utf8'),
    ]);
    for (const required of [
      'Apache License',
      'Version 2.0, January 2004',
      'TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION',
      'END OF TERMS AND CONDITIONS',
    ]) {
      if (!license.includes(required)) throw new Error(`Apache license is missing: ${required}`);
    }
    const licenseSha256 = createHash('sha256').update(license).digest('hex');
    if (licenseSha256 !== apacheLicenseSha256) {
      throw new Error(`Apache license text has drifted (sha256 ${licenseSha256})`);
    }
    for (const required of [
      'Prismatic components',
      'dist/index.js',
      'dist/run-action.js',
      'Bendyline changed the upstream source',
      'THIRD_PARTY_LICENSES/Apache-2.0.txt',
    ]) {
      if (!notice.includes(required)) throw new Error(`Spectral NOTICE is missing: ${required}`);
    }

    const provenance = JSON.parse(provenanceSource);
    const manifest = JSON.parse(manifestSource);
    const spectralVersion = manifest.dependencies?.['@prismatic-io/spectral'];
    const entries = Object.entries(provenance).filter(([key]) => !key.startsWith('_'));
    if (entries.length === 0)
      throw new Error('Spectral provenance ledger has no component entries');
    for (const [key, entry] of entries) {
      if (entry.license !== 'Apache-2.0') throw new Error(`${key} is not marked Apache-2.0`);
      if (entry.spectralVersion !== spectralVersion) {
        throw new Error(`${key} provenance does not match Spectral ${spectralVersion}`);
      }
      if (typeof entry.upstream !== 'string' || !entry.upstream.startsWith('https://github.com/')) {
        throw new Error(`${key} has no public upstream URL`);
      }
      if (!Array.isArray(entry.modifications) || entry.modifications.length === 0) {
        throw new Error(`${key} has no modification summary`);
      }
    }

    for (const entry of ['dist/index.js', 'dist/run-action.js']) {
      if (!packed.has(entry)) throw new Error(`Spectral connector npm tarball is missing ${entry}`);
      const source = await readFile(join(packageRoot, entry), 'utf8');
      if (!source.includes(legalBanner)) {
        throw new Error(
          `${entry} does not carry the Apache modification banner; rebuild the package`,
        );
      }
    }
    return { components: entries.length, files: packed.size };
  } finally {
    await rm(cache, { recursive: true, force: true });
  }
}

async function main() {
  const result = await verifyConnectorsSpectralPackageLicenses();
  console.log(
    `\u2713 verified Spectral npm payload carries Apache legal material and provenance for ${result.components} vendored component(s) across ${result.files} packed files.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`\u2717 Spectral npm license verification failed: ${error.message}`);
    process.exitCode = 1;
  });
}
