#!/usr/bin/env node
/**
 * Extract a finished desktop installer and verify the resources/licenses
 * payload. This is intentionally separate from electron-builder's afterPack
 * check: release CI proves the final EXE/PKG/DEB/RPM container retained it.
 */
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { verifyLicenseBundle } from './verify-packaged-licenses.mjs';

const execFileP = promisify(execFile);

async function walk(root, predicate) {
  const matches = [];
  async function visit(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && predicate(path)) matches.push(path);
    }
  }
  await visit(root);
  return matches;
}

async function extractRpm(artifact, output) {
  await new Promise((resolveRun, rejectRun) => {
    const rpm = spawn('rpm2cpio', [artifact], { stdio: ['ignore', 'pipe', 'inherit'] });
    const cpio = spawn('cpio', ['-idmu'], { cwd: output, stdio: ['pipe', 'ignore', 'inherit'] });
    rpm.stdout.pipe(cpio.stdin);
    let rpmCode;
    let cpioCode;
    const finish = () => {
      if (rpmCode === undefined || cpioCode === undefined) return;
      if (rpmCode === 0 && cpioCode === 0) resolveRun();
      else rejectRun(new Error(`rpm extraction failed (rpm2cpio=${rpmCode}, cpio=${cpioCode})`));
    };
    rpm.on('error', rejectRun);
    cpio.on('error', rejectRun);
    rpm.on('close', (code) => {
      rpmCode = code;
      finish();
    });
    cpio.on('close', (code) => {
      cpioCode = code;
      finish();
    });
  });
}

async function extractNsis(artifact, output) {
  await execFileP('7z', ['x', '-y', `-o${output}`, artifact], { maxBuffer: 32 * 1024 * 1024 });
  let manifests = await findManifests(output);
  if (manifests.length > 0) return;

  // NSIS commonly contains a nested app-64.7z payload. Extract every nested
  // archive once; the legal bundle then appears as ordinary resource files.
  const nested = await walk(output, (path) =>
    ['.7z', '.zip'].includes(extname(path).toLowerCase()),
  );
  for (let index = 0; index < nested.length; index += 1) {
    const nestedOutput = join(output, `nested-${index}`);
    await execFileP('7z', ['x', '-y', `-o${nestedOutput}`, nested[index]], {
      maxBuffer: 32 * 1024 * 1024,
    });
  }
  manifests = await findManifests(output);
  if (manifests.length === 0) {
    throw new Error(
      `7-Zip extracted ${basename(artifact)} but no resources/licenses manifest was found`,
    );
  }
}

async function findManifests(root) {
  return walk(root, (path) => {
    const normalized = path.replaceAll('\\', '/');
    return normalized.endsWith('/licenses/manifest.json');
  });
}

async function extract(artifact, output) {
  const extension = extname(artifact).toLowerCase();
  if (extension === '.exe') return extractNsis(artifact, output);
  if (extension === '.pkg') {
    // pkgutil creates the expansion directory itself and refuses to use an
    // existing path. `output` is the mkdtemp-owned cleanup root, so expand
    // into a child that does not exist yet.
    const expanded = join(output, 'expanded');
    await execFileP('pkgutil', ['--expand-full', artifact, expanded], {
      maxBuffer: 32 * 1024 * 1024,
    });
    return;
  }
  if (extension === '.deb') {
    await execFileP('dpkg-deb', ['--extract', artifact, output], { maxBuffer: 32 * 1024 * 1024 });
    return;
  }
  if (extension === '.rpm') return extractRpm(artifact, output);
  throw new Error(`unsupported installer type: ${extension || '(none)'}`);
}

async function main() {
  const artifactArg = process.argv[2];
  if (!artifactArg) {
    throw new Error('usage: node scripts/verify-installer-licenses.mjs <installer>');
  }
  const artifact = resolve(artifactArg);
  const scratch = await mkdtemp(join(tmpdir(), 'gezel-installer-licenses-'));
  try {
    await extract(artifact, scratch);
    const manifests = await findManifests(scratch);
    if (manifests.length === 0) {
      throw new Error(`${basename(artifact)} contains no resources/licenses/manifest.json`);
    }
    const roots = [...new Set(manifests.map((path) => dirname(path)))];
    for (const root of roots) await verifyLicenseBundle(root);
    console.log(
      `\u2713 ${basename(artifact)} contains ${roots.length} verified legal bundle${roots.length === 1 ? '' : 's'}.`,
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`\u2717 installer license verification failed: ${error.message}`);
  process.exitCode = 1;
});
