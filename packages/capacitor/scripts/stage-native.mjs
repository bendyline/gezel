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

const VERSION = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/;
/** GEZEL_SPEECH_ABI in native/mobile/speech/gezel_speech.h, as the plugins' bindings expect it. */
export const SPEECH_ABI = 3;

export async function verifyRuntime(root, target) {
  const manifest = JSON.parse(await readFile(path.join(root, 'sdk-manifest.json'), 'utf8'));
  if (
    manifest.scope !== 'provider-model-runtime' ||
    manifest.target !== target ||
    manifest.gezelABIVersion !== 1 ||
    !VERSION.test(manifest.packageVersion) ||
    !Object.keys(manifest.files ?? {}).length
  ) {
    throw new Error(`Expected a staged ${target} provider/model runtime`);
  }
  return verifyFiles(root, manifest);
}

/** The optional offline speech runtime (native/mobile/speech/build.py --package). */
export async function verifySpeech(root, target) {
  const manifest = JSON.parse(await readFile(path.join(root, 'sdk-manifest.json'), 'utf8'));
  if (
    manifest.scope !== 'speech-runtime' ||
    manifest.target !== target ||
    manifest.speechABIVersion !== SPEECH_ABI ||
    !VERSION.test(manifest.packageVersion) ||
    !Object.keys(manifest.files ?? {}).length
  ) {
    throw new Error(`Expected a staged ${target} speech runtime`);
  }
  return verifyFiles(root, manifest);
}

async function verifyFiles(root, manifest) {
  const realRoot = await realpath(root);
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

// The license inventory is shared with every desktop engine and changes no code
// in the staged runtime; a notice edit there must not block packing. The next
// native build refreshes the runtime's notices.
const LICENSE_INPUTS = 'native/licenses/';

/**
 * `allowStale` is for packs outside a release. A native release is cut from a
 * merged commit, so a pull request that changes the wrapper sources cannot pin
 * its own, and failing its packs would make that change impossible to merge.
 */
export async function verifyProducerSources(
  manifest,
  repo,
  warn = console.warn,
  { allowStale = false } = {},
) {
  const staleNotices = [];
  const staleSources = [];
  for (const [name, sha] of Object.entries(manifest.sources ?? {})) {
    const file = path.resolve(repo, name);
    if (!file.startsWith(`${path.resolve(repo)}${path.sep}`))
      throw new Error(`Restage the native runtime after changing ${name}`);
    const current = await readFile(file).then(
      (bytes) => createHash('sha256').update(bytes).digest('hex'),
      () => null,
    );
    if (current === sha) continue;
    const relative = path.relative(path.resolve(repo), file).split(path.sep).join('/');
    if (relative.startsWith(LICENSE_INPUTS)) staleNotices.push(name);
    else if (allowStale) staleSources.push(name);
    else throw new Error(`Restage the native runtime after changing ${name}`);
  }
  if (staleSources.length)
    warn(
      `Native runtime ${manifest.packageVersion} predates changes to ${staleSources.join(', ')}; a release needs a new native build first.`,
    );
  if (staleNotices.length)
    warn(
      `Native runtime ${manifest.packageVersion} predates changes to ${staleNotices.join(', ')}; its license notices refresh with the next native build.`,
    );
  return staleNotices;
}

export function stageNative(
  target,
  source,
  destination = path.join(packageRoot, 'native', target),
) {
  return stage(source, destination, (root) => verifyRuntime(root, target));
}

export function stageSpeech(
  target,
  source,
  destination = path.join(packageRoot, 'native', `speech-${target}`),
) {
  return stage(source, destination, (root) => verifySpeech(root, target));
}

async function stage(source, destination, verify) {
  const manifest = await verify(source);
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
    await verify(`${work}/next`);
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
  const [, speech, platform] = /^(speech-)?(ios|android)$/.exec(target ?? '') ?? [];
  if (!platform || !source)
    throw new Error(
      'Usage: node scripts/stage-native.mjs ios|android|speech-ios|speech-android <staged-runtime>',
    );
  await (speech ? stageSpeech : stageNative)(platform, path.resolve(source));
  console.log(`Prepared Gezel Capacitor ${target} package.`);
}
