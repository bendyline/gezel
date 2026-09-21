import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

async function digest(file) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest('hex');
}

async function containedFile(root, relative) {
  if (
    !relative ||
    relative.includes('\\') ||
    relative.includes('\0') ||
    path.posix.isAbsolute(relative) ||
    relative.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new Error(`Invalid native manifest path: ${relative}`);
  const file = await realpath(path.join(root, relative));
  if (!file.startsWith(`${await realpath(root)}${path.sep}`))
    throw new Error(`Native manifest path leaves its build directory: ${relative}`);
  return file;
}

/** Cached native outputs must match both the current source and their manifest.
 * Otherwise a normal sync can silently ship an old bridge or an extra library. */
export async function verifyNativeBuild(repo, build, target) {
  const manifest = JSON.parse(await readFile(path.join(build, 'manifest.json'), 'utf8'));
  if (manifest.schemaVersion !== 1 || manifest.target !== target || manifest.gezelABIVersion !== 1)
    throw new Error('Unsupported mobile native build manifest; rebuild the native engine.');
  const version = await readFile(path.join(repo, 'native/engines/llama-cpp/VERSION'), 'utf8');
  const pin = Object.fromEntries(
    version
      .split(/\r?\n/)
      .filter((line) => /^(upstream|tag|build|commit)=/.test(line))
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
  );
  for (const name of ['upstream', 'tag', 'build', 'commit']) {
    if (!pin[name] || manifest.upstream?.[name] !== pin[name])
      throw new Error(`Cached mobile engine has an old ${name}; rebuild the native engine.`);
  }
  for (const name of ['gezel_llama.h', 'gezel_llama.cpp', 'utf8_stream.h', 'CMakeLists.txt']) {
    if (manifest.bridgeSources?.[name] !== (await digest(path.join(repo, 'native/mobile', name))))
      throw new Error(`Cached native bridge differs from ${name}; rebuild the native engine.`);
  }
  const files = manifest.files;
  if (
    !files ||
    typeof files !== 'object' ||
    Array.isArray(files) ||
    Object.keys(files).length === 0
  )
    throw new Error('Native build manifest contains no verified files.');
  for (const [relative, expected] of Object.entries(files)) {
    if (
      typeof expected !== 'string' ||
      !/^[a-f0-9]{64}$/.test(expected) ||
      (await digest(await containedFile(build, relative))) !== expected
    )
      throw new Error(`Native build checksum mismatch: ${relative}`);
  }
  const payload = target === 'android' ? 'jniLibs' : 'GezelLlama.xcframework';
  async function checkInventory(relative) {
    for (const entry of await readdir(path.join(build, relative), { withFileTypes: true })) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await checkInventory(child);
      else if (!Object.hasOwn(files, child))
        throw new Error(`Unverified file in the native payload: ${child}`);
    }
  }
  await checkInventory(payload);
  return manifest;
}

// Read-only preflight runs before Capacitor rewrites generated platform assets.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const target = process.argv[2];
  if (!['android', 'ios'].includes(target))
    throw new Error('Usage: node scripts/verify-native-build.mjs android|ios');
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  await verifyNativeBuild(
    repo,
    path.join(repo, 'native/mobile/.build', target === 'ios' ? 'ios-bridge' : 'android'),
    target,
  );
  console.log(`Verified ${target} native sources and payload before sync.`);
}
