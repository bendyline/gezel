#!/usr/bin/env node
/**
 * Stage the build context for one Gezel container image (ADR 0029,
 * docs/container.md): the relocatable Node distribution, the pinned Node,
 * pnpm and DuckDB runtimes, and the native engines for one flavor, each
 * verified against the pins this checkout ships. The Dockerfile then only
 * copies files; apt is the build's one network dependency.
 *
 * Usage (on Linux, the architecture being built):
 *   pnpm build
 *   node scripts/stage-docker-context.mjs --flavor cpu|vulkan|cuda [--skip-bundle]
 *
 * Output: release/docker-context/linux-<arch>-<flavor>/
 *   app/          the node-only bundle (CLI, gezeld, web UI, ML runtime)
 *   node/         the pinned Node binary and its license
 *   pnpm/         the pinned pnpm package (bin/pnpm.mjs)
 *   duckdb/       the pinned DuckDB CLI and its license
 *   native-bin/   linux-<arch>, linux-<arch>-cpu and, for a GPU flavor, its key
 *   licenses/     third-party terms the image redistributes
 *   Dockerfile, entrypoint.sh, image.json
 *
 * Environment:
 *   GEZEL_NATIVE_CACHE_DIR   where verified engine archives are kept between
 *                            runs (default: release/native-cache)
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { chmod, cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FLAVORS = ['cpu', 'vulkan', 'cuda'];
/** Which flavors each architecture has engines for. */
const FLAVORS_BY_ARCH = { x64: ['cpu', 'vulkan', 'cuda'], arm64: ['cpu', 'cuda'] };

function parseArgs(argv) {
  const out = { flavor: 'cpu', skipBundle: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--flavor') out.flavor = argv[++i];
    else if (arg === '--skip-bundle') out.skipBundle = true;
    else if (arg === '-h' || arg === '--help') out.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

function run(command, args, opts = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', cwd: repoRoot, ...opts });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with ${result.status ?? result.signal}`);
  }
}

async function sha256(path) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

/** The pinned release and every archive's sha256, read from the TypeScript source of truth. */
async function nativePins() {
  const src = await readFile(
    join(repoRoot, 'packages', 'inference', 'src', 'engines', 'native-manifest.ts'),
    'utf8',
  );
  const release = /NATIVE_ENGINE_RELEASE = '([^']+)'/.exec(src)?.[1];
  if (!release) throw new Error('cannot read NATIVE_ENGINE_RELEASE');
  const hashes = new Map();
  for (const match of src.matchAll(/'(gezel-native-[^']+)':\s*'([0-9a-f]{64})'/g)) {
    hashes.set(match[1], match[2]);
  }
  return { release, hashes };
}

/** Download one engine archive (or reuse a verified cached copy) and check it against its pin. */
async function fetchArchive(name, release, expected, cacheDir) {
  const cached = join(cacheDir, name);
  if (existsSync(cached) && (await sha256(cached)) === expected) return cached;
  await mkdir(cacheDir, { recursive: true });
  const url = `https://github.com/bendyline/gezel/releases/download/native-v${release}/${name}`;
  console.log(`[docker-context] downloading ${name}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`download failed (${res.status}): ${url}`);
  const partial = `${cached}.partial`;
  await pipeline(Readable.fromWeb(res.body), createWriteStream(partial));
  const actual = await sha256(partial);
  if (actual !== expected) {
    await rm(partial, { force: true });
    throw new Error(`${name}: sha256 ${actual} does not match the pinned ${expected}`);
  }
  await rename(partial, cached);
  return cached;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      'Usage: node scripts/stage-docker-context.mjs --flavor cpu|vulkan|cuda [--skip-bundle]',
    );
    return;
  }
  if (process.platform !== 'linux') {
    throw new Error(
      'Stage the image on Linux (or WSL): the node bundle carries native modules for the platform that builds it.',
    );
  }
  const arch = process.arch;
  if (!FLAVORS_BY_ARCH[arch]) throw new Error(`no Gezel image for ${arch}`);
  if (!FLAVORS.includes(args.flavor) || !FLAVORS_BY_ARCH[arch].includes(args.flavor)) {
    throw new Error(`flavor ${args.flavor} is not built for linux-${arch}`);
  }

  const platform = `linux-${arch}`;
  const target = join(repoRoot, 'release', 'docker-context', `${platform}-${args.flavor}`);
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });

  // The app: the relocatable node-only distribution.
  const bundle = join(repoRoot, 'release', 'gezel-node');
  if (!args.skipBundle) {
    run(process.execPath, ['scripts/build-node-bundle.mjs'], {
      env: { ...process.env, GEZEL_SKIP_BUNDLE_ARCHIVE: '1' },
    });
  }
  if (!existsSync(join(bundle, 'dist', 'bin', 'gezel.js'))) {
    throw new Error('release/gezel-node is missing; run without --skip-bundle (after pnpm build)');
  }
  await cp(bundle, join(target, 'app'), { recursive: true, verbatimSymlinks: true });

  // Node, pnpm and DuckDB: the same verified fetches the desktop build uses.
  for (const script of ['fetch-node.mjs', 'fetch-pnpm.mjs', 'fetch-duckdb.mjs']) {
    run(process.execPath, [join('packages', 'app', 'scripts', script)]);
  }
  const appDist = join(repoRoot, 'packages', 'app', 'dist');
  await cp(join(appDist, 'node-bundle'), join(target, 'node'), { recursive: true });
  await cp(join(appDist, 'pnpm-bundle'), join(target, 'pnpm'), { recursive: true });
  await cp(join(appDist, 'duckdb-bundle'), join(target, 'duckdb'), { recursive: true });
  for (const required of ['node/node', 'pnpm/bin/pnpm.mjs', 'duckdb/duckdb']) {
    if (!existsSync(join(target, required)))
      throw new Error(`staged runtime is missing ${required}`);
  }

  // Native engines: the platform's own archive (image, speech, uv, device
  // health), the CPU llama build every flavor falls back to, and the GPU build.
  const { release, hashes } = await nativePins();
  const cacheDir = process.env.GEZEL_NATIVE_CACHE_DIR ?? join(repoRoot, 'release', 'native-cache');
  const keys = [platform, `${platform}-cpu`];
  if (args.flavor !== 'cpu') keys.push(`${platform}-${args.flavor}`);
  for (const key of keys) {
    const name = `gezel-native-${release}-${key}.tar.gz`;
    const expected = hashes.get(name);
    if (!expected) throw new Error(`native-v${release} pins no archive named ${name}`);
    const archive = await fetchArchive(name, release, expected, cacheDir);
    const dest = join(target, 'native-bin', key);
    await mkdir(dest, { recursive: true });
    run('tar', ['-xzf', archive, '-C', dest]);
  }

  // Third-party terms the image redistributes beyond the bundle's own.
  const licenses = join(target, 'licenses');
  await mkdir(licenses, { recursive: true });
  await cp(join(target, 'node', 'LICENSE.txt'), join(licenses, 'node-LICENSE.txt'));
  await cp(join(target, 'duckdb', 'LICENSE.txt'), join(licenses, 'duckdb-LICENSE.txt'));
  if (args.flavor === 'cuda') {
    await cp(join(repoRoot, 'native', 'cuda-eulas'), join(licenses, 'cuda'), { recursive: true });
  }

  await cp(join(repoRoot, 'docker', 'Dockerfile'), join(target, 'Dockerfile'));
  await cp(join(repoRoot, 'docker', 'entrypoint.sh'), join(target, 'entrypoint.sh'));
  await chmod(join(target, 'entrypoint.sh'), 0o755);

  const cliPackage = JSON.parse(
    await readFile(join(repoRoot, 'packages', 'cli', 'package.json'), 'utf8'),
  );
  const meta = {
    version: cliPackage.version,
    flavor: args.flavor,
    platform,
    nativeRelease: release,
    nativeKeys: keys,
  };
  await writeFile(join(target, 'image.json'), `${JSON.stringify(meta, null, 2)}\n`);
  console.log(`[docker-context] staged ${target}`);
  console.log(
    `[docker-context] build it: docker build --build-arg FLAVOR=${args.flavor} --build-arg GEZEL_VERSION=${meta.version} --build-arg NATIVE_RELEASE=${release} -t gezel:${args.flavor} ${target}`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
