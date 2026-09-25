import { createHash } from 'node:crypto';
import {
  access,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function verifyRuntime(root, target) {
  const realRoot = await realpath(root);
  const manifest = JSON.parse(await readFile(path.join(root, 'sdk-manifest.json'), 'utf8'));
  if (
    manifest.scope !== 'provider-model-runtime' ||
    manifest.target !== target ||
    manifest.gezelABIVersion !== 1 ||
    !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(manifest.packageVersion) ||
    !Object.keys(manifest.files ?? {}).length
  ) {
    throw new Error(`Expected a staged ${target} provider/model runtime`);
  }
  for (const [name, sha] of Object.entries(manifest.files)) {
    const file = path.resolve(root, name);
    if (
      !file.startsWith(`${path.resolve(root)}${path.sep}`) ||
      (await lstat(file)).isSymbolicLink() ||
      !(await realpath(file)).startsWith(`${realRoot}${path.sep}`) ||
      createHash('sha256')
        .update(await readFile(file))
        .digest('hex') !== sha
    ) {
      throw new Error(`Native package integrity mismatch: ${name}`);
    }
  }
  return manifest;
}

export async function verifyProducerSources(manifest, repo) {
  for (const [name, sha] of Object.entries(manifest.sources ?? {})) {
    const file = path.resolve(repo, name);
    if (
      !file.startsWith(`${path.resolve(repo)}${path.sep}`) ||
      createHash('sha256')
        .update(await readFile(file))
        .digest('hex') !== sha
    ) {
      throw new Error(`Restage the native runtime after changing ${name}`);
    }
  }
}

export async function stageNative(
  target,
  source,
  destination = path.join(packageRoot, 'native', target),
) {
  const manifest = await verifyRuntime(source, target);
  await mkdir(path.dirname(destination), { recursive: true });
  const work = await mkdtemp(`${destination}.stage-`);
  const previous = `${work}/previous`;
  let moved = false;
  try {
    // Only declared, verified bytes enter the distribution (no build caches or
    // undeclared artifacts accidentally left beside a producer's package).
    for (const name of ['sdk-manifest.json', ...Object.keys(manifest.files)]) {
      const destination = path.join(work, 'next', name);
      await mkdir(path.dirname(destination), { recursive: true });
      await cp(path.join(source, name), destination);
    }
    await verifyRuntime(`${work}/next`, target);
    try {
      await access(destination);
      moved = true;
    } catch {}
    if (moved) await rename(destination, previous);
    try {
      await rename(`${work}/next`, destination);
    } catch (error) {
      if (moved) await rename(previous, destination);
      throw error;
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [target, source] = process.argv.slice(2);
  if (!['ios', 'android'].includes(target) || !source)
    throw new Error('Usage: node scripts/stage-native.mjs ios|android <staged-runtime>');
  await stageNative(target, path.resolve(source));
  console.log(`Prepared Gezel Capacitor ${target} package.`);
}
