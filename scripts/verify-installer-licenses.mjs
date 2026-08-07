#!/usr/bin/env node
/**
 * Extract a finished desktop installer and verify the resources/licenses
 * payload. This is intentionally separate from electron-builder's afterPack
 * check: release CI proves the final EXE/PKG/DEB/RPM container retained it.
 */
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { platformKeysFromRoot, verifyNativeFileTree } from './native-file-manifest-lib.mjs';
import { verifyLicenseBundle } from './verify-packaged-licenses.mjs';

const execFileP = promisify(execFile);
const LINUX_METAINFO_PATH = join('usr', 'share', 'metainfo', 'com.bendyline.gezel.metainfo.xml');
const LINUX_DESKTOP_PATH = join('usr', 'share', 'applications', 'com.bendyline.gezel.desktop');

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

async function findNativeRoots(root) {
  const matches = [];
  async function visit(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(dir, entry.name);
      const normalized = path.replaceAll('\\', '/');
      if (normalized.endsWith('/app.asar.unpacked/native-bin')) {
        matches.push(path);
      } else {
        await visit(path);
      }
    }
  }
  await visit(root);
  return matches;
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

async function verifyLinuxAppStreamMetadata(artifact, root) {
  const extension = extname(artifact).toLowerCase();
  if (extension !== '.deb' && extension !== '.rpm') return;

  const relativePath = LINUX_METAINFO_PATH.replaceAll('\\', '/');
  let metadata;
  try {
    metadata = await readFile(join(root, LINUX_METAINFO_PATH), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`${basename(artifact)} contains no ${relativePath}`);
    }
    throw error;
  }

  const requiredMetadata = [
    ['component id', /<id>\s*com\.bendyline\.gezel\s*<\/id>/],
    ['metadata license', /<metadata_license>\s*MIT\s*<\/metadata_license>/],
    ['project license', /<project_license>\s*MIT\s*<\/project_license>/],
    [
      'desktop launchable',
      /<launchable\s+type="desktop-id">\s*com\.bendyline\.gezel\.desktop\s*<\/launchable>/,
    ],
  ];
  for (const [label, pattern] of requiredMetadata) {
    if (!pattern.test(metadata)) {
      throw new Error(`${relativePath} has no valid ${label}`);
    }
  }

  try {
    await readFile(join(root, LINUX_DESKTOP_PATH), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(
        `${relativePath} refers to missing ${LINUX_DESKTOP_PATH.replaceAll('\\', '/')}`,
      );
    }
    throw error;
  }

  console.log(
    `\u2713 ${basename(artifact)} declares the MIT project license in AppStream metadata.`,
  );
}

async function main() {
  const artifactArg = process.argv[2];
  if (!artifactArg) {
    throw new Error(
      'usage: node scripts/verify-installer-licenses.mjs <installer> [--native-source <native-bin> --native-manifest <json> --native-release <version>]',
    );
  }
  const args = process.argv.slice(3);
  const value = (name) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const nativeSourceArg = value('--native-source');
  const nativeManifestArg = value('--native-manifest');
  const nativeRelease = value('--native-release');
  if (!!nativeSourceArg !== !!nativeManifestArg) {
    throw new Error('--native-source and --native-manifest must be provided together');
  }

  const artifact = resolve(artifactArg);
  const scratch = await mkdtemp(join(tmpdir(), 'gezel-installer-licenses-'));
  try {
    await extract(artifact, scratch);
    await verifyLinuxAppStreamMetadata(artifact, scratch);
    const manifests = await findManifests(scratch);
    if (manifests.length === 0) {
      throw new Error(`${basename(artifact)} contains no resources/licenses/manifest.json`);
    }
    const roots = [...new Set(manifests.map((path) => dirname(path)))];
    for (const root of roots) await verifyLicenseBundle(root);
    console.log(
      `\u2713 ${basename(artifact)} contains ${roots.length} verified legal bundle${roots.length === 1 ? '' : 's'}.`,
    );

    if (nativeSourceArg && nativeManifestArg) {
      const nativeSource = resolve(nativeSourceArg);
      const nativeManifest = JSON.parse(await readFile(resolve(nativeManifestArg), 'utf8'));
      const platformKeys = await platformKeysFromRoot(nativeSource);
      await verifyNativeFileTree({
        root: nativeSource,
        manifest: nativeManifest,
        expectedRelease: nativeRelease,
        platformKeys,
      });

      const packagedNativeRoots = await findNativeRoots(scratch);
      if (packagedNativeRoots.length === 0) {
        throw new Error(`${basename(artifact)} contains no app.asar.unpacked/native-bin directory`);
      }
      for (const packagedRoot of packagedNativeRoots) {
        await verifyNativeFileTree({
          root: packagedRoot,
          manifest: nativeManifest,
          expectedRelease: nativeRelease,
          platformKeys,
        });
      }
      console.log(
        `\u2713 ${basename(artifact)} retained the pinned native files and symlinks in ${packagedNativeRoots.length} packaged tree${packagedNativeRoots.length === 1 ? '' : 's'}.`,
      );
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`\u2717 installer payload verification failed: ${error.message}`);
  process.exitCode = 1;
});
