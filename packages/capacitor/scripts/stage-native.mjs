import { createHash } from 'node:crypto';
import {
  access,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inflateRawSync } from 'node:zlib';

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

const plistString = (xml, key) =>
  new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(xml)?.[1] ?? '';

/**
 * What an app store or a consuming Gradle build checks beyond the inventory,
 * for a speech runtime about to be published: the iOS framework's bundle
 * versions and privacy manifest, and the gezel-llama dependency that brings
 * libc++_shared.so on Android. native-v0.1.61 shipped without all three, and
 * App Store Connect refuses an app embedding a framework without versions.
 */
export async function verifySpeechDistribution(root, target) {
  const manifest = await verifySpeech(root, target);
  const names = Object.keys(manifest.files);
  if (target === 'ios') {
    const frameworks = names
      .filter((name) =>
        /^GezelSpeech\.xcframework\/[^/]+\/GezelSpeech\.framework\/GezelSpeech$/.test(name),
      )
      .map((name) => path.posix.dirname(name));
    if (frameworks.length === 0)
      throw new Error('The iOS speech runtime has no GezelSpeech.framework');
    for (const framework of frameworks) {
      const info = await readFile(path.join(root, framework, 'Info.plist'), 'utf8');
      for (const key of ['CFBundleShortVersionString', 'CFBundleVersion', 'MinimumOSVersion']) {
        if (!/^\d+\.\d+(\.\d+)?$/.test(plistString(info, key)))
          throw new Error(
            `${framework}/Info.plist has no ${key}, so App Store Connect would refuse it`,
          );
      }
      if (!names.includes(`${framework}/PrivacyInfo.xcprivacy`))
        throw new Error(`${framework} has no PrivacyInfo.xcprivacy`);
    }
  } else {
    const version = manifest.packageVersion;
    const pom = names.find((name) => name.endsWith(`/gezel-speech-${version}.pom`));
    const xml = pom ? await readFile(path.join(root, pom), 'utf8') : '';
    const escaped = version.replace(/[.]/g, '\\.');
    if (
      !new RegExp(`<artifactId>gezel-llama</artifactId>\\s*<version>${escaped}</version>`).test(xml)
    )
      throw new Error(`The gezel-speech ${version} POM does not depend on gezel-llama ${version}`);
  }
  return manifest;
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
 * Report where `native/runtime` has moved past the staged release. Packs and
 * releases pass `allowStale`: the package ships the pinned release as built,
 * and runtime changes reach it when the pin moves. What would actually break is
 * the plugin calling runtime API the pinned release lacks, which
 * `verifyPluginRuntimeApi` refuses. A name that escapes the repository always
 * throws.
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
      `Native runtime ${manifest.packageVersion} predates changes to ${staleSources.join(', ')}; they ship when the pin moves to a newer native release.`,
    );
  if (staleNotices.length)
    warn(
      `Native runtime ${manifest.packageVersion} predates changes to ${staleNotices.join(', ')}; its license notices refresh with the next native build.`,
    );
  return staleNotices;
}

/* ───────────── The plugin's use of the pinned runtime's API ───────────── */

/**
 * The consuming app compiles the plugin (`ios/Sources`, `android/src`)
 * against the staged runtime, never against `native/runtime` in this repo. So
 * the plugin may name only runtime API the staged release already declares.
 * Code that needs something newer reaches it in a way that still works
 * without it: a notification or map key by name, a feature check, a dynamic
 * call. Names are compared, not signatures, so a new member whose name the
 * pinned runtime already declares elsewhere is not caught.
 */
export async function verifyPluginRuntimeApi({
  capacitorRoot = packageRoot,
  repoRoot,
  manifest,
  warn = console.warn,
}) {
  const repoSources = Object.keys(manifest.sources ?? {});
  const platforms = [
    {
      lang: 'swift',
      pinned: () => readTree(path.join(capacitorRoot, 'native/ios/Sources'), '.swift'),
      repo: repoSources.filter((name) => name.endsWith('.swift')),
      plugin: path.join(capacitorRoot, 'ios/Sources'),
      ext: '.swift',
    },
    {
      lang: 'java',
      pinned: () => readPinnedJavaSources(path.join(capacitorRoot, 'native/android/maven')),
      repo: repoSources.filter((name) => name.endsWith('.java') && !name.includes('/src/test/')),
      plugin: path.join(capacitorRoot, 'android/src/main/java'),
      ext: '.java',
    },
  ];
  const problems = [];
  for (const platform of platforms) {
    const pinnedTexts = await platform.pinned();
    if (pinnedTexts.length === 0) {
      warn(
        `The staged ${platform.lang} runtime ships no sources, so the plugin's use of its API was not checked.`,
      );
      continue;
    }
    const pinned = publicNames(pinnedTexts, platform.lang);
    const repoTexts = [];
    for (const name of platform.repo) {
      const text = await readFile(path.resolve(repoRoot, name), 'utf8').catch(() => null);
      if (text !== null) repoTexts.push(text);
    }
    const unpinned = [...publicNames(repoTexts, platform.lang)].filter((name) => !pinned.has(name));
    if (unpinned.length === 0) continue;
    for (const [file, text] of await readTreeWithNames(platform.plugin, platform.ext)) {
      const used = codeIdentifiers(text, platform.lang);
      const names = unpinned.filter((name) => used.has(name));
      if (names.length > 0) {
        problems.push(
          `${path.relative(capacitorRoot, file).split(path.sep).join('/')} uses ${names.join(', ')}`,
        );
      }
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `The plugin uses native runtime API that native-v${manifest.packageVersion} does not have (${problems.join('; ')}). Apps compile the plugin against that release, so reach the newer API in a way that still works without it, or move the pin.`,
    );
  }
}

/** Public declarations in Swift or Java source, comments and strings removed. */
export function publicNames(texts, lang) {
  const patterns =
    lang === 'swift'
      ? [
          /\b(?:public|open)\b(?:\s+(?:static|class|final|override|convenience|required|mutating|nonisolated|dynamic|lazy|weak|unowned|indirect|\w+\(set\)|@[\w.]+(?:\([^)]*\))?))*\s+(?:func|var|let|class|struct|enum|protocol|typealias|actor)\s+([A-Za-z_]\w*)/g,
          /\bcase\s+([A-Za-z_]\w*)/g,
        ]
      : [
          /\bpublic\b(?:\s+(?:static|final|abstract|sealed))*\s+(?:class|interface|enum|record|@interface)\s+([A-Za-z_$][\w$]*)/g,
          /\bpublic\b(?:\s+(?:static|final|synchronized|abstract|native|default|transient|volatile))*\s+(?:<[^>]*>\s+)?[\w.$]+(?:<[^;{}()]*>)?(?:\[\])*\s+([A-Za-z_$][\w$]*)\s*[(;=]/g,
        ];
  const keywords = new Set(['let', 'var', 'is', 'default', 'case', '_']);
  const names = new Set();
  for (const text of texts) {
    const code = stripCommentsAndStrings(text, lang);
    for (const pattern of patterns) {
      for (const match of code.matchAll(pattern)) {
        if (!keywords.has(match[1])) names.add(match[1]);
      }
    }
  }
  return names;
}

function codeIdentifiers(text, lang) {
  return new Set(stripCommentsAndStrings(text, lang).match(/[A-Za-z_$][\w$]*/g) ?? []);
}

/**
 * Blank out comments and string literals, so a name the plugin only mentions,
 * or passes as text (the way it reaches a newer API on purpose), is not a use.
 */
export function stripCommentsAndStrings(text, lang) {
  let out = '';
  let i = 0;
  let depth = 0;
  while (i < text.length) {
    const two = text.slice(i, i + 2);
    if (depth > 0) {
      if (two === '/*') {
        depth += lang === 'swift' ? 1 : 0;
        i += 2;
      } else if (two === '*/') {
        depth -= 1;
        i += 2;
      } else i += 1;
      continue;
    }
    if (two === '/*') {
      depth = 1;
      i += 2;
    } else if (two === '//') {
      while (i < text.length && text[i] !== '\n') i += 1;
    } else if (text.startsWith('"""', i)) {
      const end = text.indexOf('"""', i + 3);
      i = end < 0 ? text.length : end + 3;
      out += ' ';
    } else if (text[i] === '"' || (lang === 'java' && text[i] === "'")) {
      const quote = text[i];
      i += 1;
      while (i < text.length && text[i] !== quote && text[i] !== '\n')
        i += text[i] === '\\' ? 2 : 1;
      i += 1;
      out += ' ';
    } else {
      out += text[i];
      i += 1;
    }
  }
  return out;
}

async function readTreeWithNames(root, ext) {
  const entries = await readdir(root, { recursive: true }).catch(() => []);
  const files = entries.filter((name) => name.endsWith(ext)).sort();
  return Promise.all(
    files.map(async (name) => {
      const file = path.join(root, name);
      return [file, await readFile(file, 'utf8')];
    }),
  );
}

async function readTree(root, ext) {
  return (await readTreeWithNames(root, ext)).map(([, text]) => text);
}

/** The pinned Android runtime's API, from the sources jar beside its AAR. */
async function readPinnedJavaSources(mavenRoot) {
  const runtime = path.join(mavenRoot, 'com/bendyline/gezel/gezel-runtime');
  const entries = await readdir(runtime, { recursive: true }).catch(() => []);
  const jar = entries.find((name) => name.endsWith('-sources.jar'));
  if (!jar) return [];
  const sources = readZipTextEntries(await readFile(path.join(runtime, jar)), (name) =>
    name.endsWith('.java'),
  );
  return [...sources.values()];
}

/** Text entries of a zip archive (a sources jar): stored or deflated, no zip64. */
export function readZipTextEntries(buffer, accept) {
  let end = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65_557); i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error('Not a zip archive');
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  const entries = new Map();
  for (let n = 0; n < count; n += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('Corrupt zip directory');
    const method = buffer.readUInt16LE(offset + 10);
    const size = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const skip = nameLength + buffer.readUInt16LE(offset + 30) + buffer.readUInt16LE(offset + 32);
    const local = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    offset += 46 + skip;
    if (!accept(name)) continue;
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const data = buffer.subarray(start, start + size);
    if (method === 0) entries.set(name, data.toString('utf8'));
    else if (method === 8) entries.set(name, inflateRawSync(data).toString('utf8'));
    else throw new Error(`Unsupported zip compression ${method} for ${name}`);
  }
  return entries;
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
