import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EmbeddingPackageManifestSchema } from '@bendyline/gezel/app-models';
import { stageNative, verifyRuntime } from './stage-native.mjs';
export { stageNative, verifyRuntime };
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function filesIn(root, relative = '') {
  const files = [];
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    if (['.build', '.swiftpm'].includes(entry.name)) continue;
    const name = path.posix.join(relative, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Unexpected package symlink: ${name}`);
    if (entry.isDirectory()) files.push(...(await filesIn(root, name)));
    else if (entry.isFile()) files.push(name);
    else throw new Error(`Unexpected package file: ${name}`);
  }
  return files;
}
async function payload(root, target) {
  const directory = path.join(root, 'native', target);
  const runtime = await verifyRuntime(directory, target);
  const actual = (await filesIn(directory)).filter((name) => name !== 'sdk-manifest.json').sort();
  if (JSON.stringify(actual) !== JSON.stringify(Object.keys(runtime.files).sort()))
    throw new Error(`Unexpected ${target} native file inventory`);
  const engine = JSON.parse(await readFile(path.join(directory, 'engine-manifest.json'), 'utf8'));
  if (engine.gezelABIVersion !== runtime.gezelABIVersion || engine.target !== target)
    throw new Error(`Incompatible ${target} engine ABI`);
  const licenses = actual.filter((name) => /(^|\/)LICENSE|NOTICE/i.test(name));
  if (!licenses.length) throw new Error(`Missing ${target} native notices`);
  return {
    version: runtime.packageVersion,
    abi: runtime.gezelABIVersion,
    settings: engine.settings,
    toolchains: engine.toolchains,
    deviceInference: runtime.deviceInference,
    licenses,
    privacyManifests: actual.filter((name) => name.endsWith('.xcprivacy')),
  };
}
/** Build-time provenance. The package tarball's registry integrity authenticates this manifest. */
export async function writeEmbeddingManifest(root = packageRoot) {
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const native = { ios: await payload(root, 'ios'), android: await payload(root, 'android') };
  if (native.ios.version !== native.android.version)
    throw new Error('iOS and Android native package versions differ');
  const files = {};
  for (const directory of ['dist', 'ios/Sources', 'android/src', 'native']) {
    for (const name of await filesIn(path.join(root, directory))) {
      if (name.endsWith('.map')) continue;
      const relative = `${directory}/${name}`;
      files[relative] = hash(await readFile(path.join(root, relative)));
    }
  }
  for (const name of [
    'Package.swift',
    'android/build.gradle',
    'scripts/embedding-package.mjs',
    'scripts/embedding-package.d.mts',
    'scripts/stage-native.mjs',
  ])
    files[name] = hash(await readFile(path.join(root, name)));
  const value = {
    schemaVersion: 1,
    package: manifest.name,
    version: manifest.version,
    capacitor: manifest.peerDependencies['@capacitor/core'],
    native,
    files,
  };
  EmbeddingPackageManifestSchema.parse(value);
  await writeFile(
    path.join(root, 'embedding-manifest.json'),
    `${JSON.stringify(value, null, 2)}\n`,
  );
  return value;
}
/** Read-only installed-package doctor. It never downloads or repairs executable bytes. */
export async function verifyCapacitorPackage(root = packageRoot) {
  const value = EmbeddingPackageManifestSchema.parse(
    JSON.parse(await readFile(path.join(root, 'embedding-manifest.json'), 'utf8')),
  );
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  if (
    value.schemaVersion !== 1 ||
    value.package !== pkg.name ||
    value.version !== pkg.version ||
    value.capacitor !== pkg.peerDependencies['@capacitor/core'] ||
    !value.files ||
    typeof value.files !== 'object' ||
    !Object.keys(value.files).length
  )
    throw new Error('Invalid Gezel embedding manifest');
  const physicalRoot = await realpath(root);
  for (const [relative, expected] of Object.entries(value.files)) {
    if (
      relative.split('/').some((part) => !part || part === '.' || part === '..') ||
      /[\\:]/.test(relative) ||
      [...relative].some((character) => character.charCodeAt(0) < 32) ||
      !/^[a-f0-9]{64}$/.test(expected)
    )
      throw new Error('Invalid embedding file pin');
    const file = path.join(root, relative);
    if (
      (await lstat(file)).isSymbolicLink() ||
      !(await realpath(file)).startsWith(`${physicalRoot}${path.sep}`) ||
      hash(await readFile(file)) !== expected
    )
      throw new Error(`Embedding package integrity mismatch: ${relative}`);
  }
  const native = { ios: await payload(root, 'ios'), android: await payload(root, 'android') };
  if (JSON.stringify(native) !== JSON.stringify(value.native))
    throw new Error('Embedding compatibility metadata changed');
  return value;
}

/** Raise generated app deployment floors after cap sync; preserve higher app requirements. */
export async function configureCapacitorProject({ projectRoot, platform, sdkRoot = packageRoot }) {
  if (!['ios', 'android'].includes(platform)) throw new Error('Expected ios or android');
  const metadata = await verifyCapacitorPackage(sdkRoot);
  const changed = [];
  async function update(relative, transform) {
    const file = path.resolve(projectRoot, relative);
    const before = await readFile(file, 'utf8');
    const after = transform(before);
    if (after !== before) {
      await writeFile(file, after);
      changed.push(file);
    }
  }
  if (platform === 'ios') {
    const minimum = metadata.native.ios.settings.minimumOS;
    if (typeof minimum !== 'string' || !/^\d+\.\d+$/.test(minimum))
      throw new Error('Invalid iOS minimum in SDK metadata');
    const below = (version) => {
      const [major, minor = 0] = version.split('.').map(Number);
      const [requiredMajor, requiredMinor] = minimum.split('.').map(Number);
      return major < requiredMajor || (major === requiredMajor && minor < requiredMinor);
    };
    await update('ios/App/App.xcodeproj/project.pbxproj', (source) =>
      source.replace(/IPHONEOS_DEPLOYMENT_TARGET = "?(\d+(?:\.\d+)?)"?;/g, (match, version) =>
        below(version) ? `IPHONEOS_DEPLOYMENT_TARGET = ${minimum};` : match,
      ),
    );
    await update('ios/App/CapApp-SPM/Package.swift', (source) =>
      source.replace(
        /\.iOS\((?:"(\d+(?:\.\d+)?)"|\.v(\d+)(?:_(\d+))?)\)/g,
        (match, quoted, major, minor) =>
          below(quoted ?? `${major}.${minor ?? 0}`) ? `.iOS("${minimum}")` : match,
      ),
    );
  } else {
    const minimum = metadata.native.android.settings.minimumAPI;
    if (!Number.isInteger(minimum) || minimum < 1 || minimum > 1000)
      throw new Error('Invalid Android minimum in SDK metadata');
    await update('android/variables.gradle', (source) =>
      source.replace(/minSdkVersion\s*=\s*(\d+)/g, (match, value) =>
        Number(value) < minimum ? `minSdkVersion = ${minimum}` : match,
      ),
    );
  }
  return { changed, compatibility: metadata };
}
