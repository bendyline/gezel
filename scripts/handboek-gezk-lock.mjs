/**
 * Build the bundled Handboek catalog (`packages/service/assets/handboek/handboek.gezk`)
 * just in time, from the service build, so a docs edit or a Gilde bump cannot
 * ship the previous articles. v1.26273.82 did exactly that from a committed
 * archive built one commit before the release notes were renamed. The archive
 * is a build product and is not committed: a committed copy and its lock
 * conflicted on nearly every merge that touched the docs.
 *
 * Building it embeds ~1,400 chunks (about 50 s with the model cached, plus a
 * one-time download of the embedding model), so `handboek.gezk.lock.json`
 * beside it, also ignored, records two hashes that let a build skip the work:
 *
 *   inputs   raw bytes of everything the rendering reads: docs/handboek, the
 *            Handboek engine and catalog loader sources, the builder, and the
 *            resolved Gilde package. Cheap — checked on every service build.
 *   content  the rendered articles, topics and assets the archive holds
 *            (`handboekKnowledgeFingerprint`), plus the embedding and
 *            chunking profile ids. About 14 s — computed only when the
 *            inputs moved.
 *
 * `ensureHandboekGezk` runs from the service build: matching inputs is the
 * fast path; otherwise the builder re-renders, and re-embeds only when the
 * content really changed. CI restores both files from the Actions cache
 * (.github/actions/setup-workspace), where an older entry is safe for the same
 * reason. Deliberately not keyed on the service version: release tooling
 * bumps it on its own, and an update is driven by the archive digest, not the
 * version.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

export function handboekGezkPaths(repoRoot = REPO_ROOT) {
  const assets = join(repoRoot, 'packages', 'service', 'assets', 'handboek');
  return {
    archive: join(assets, 'handboek.gezk'),
    lock: join(assets, 'handboek.gezk.lock.json'),
    builder: join(repoRoot, 'packages', 'service', 'scripts', 'build-handboek-gezk.ts'),
    serviceDir: join(repoRoot, 'packages', 'service'),
  };
}

function listFiles(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    // Untracked dotfiles such as Finder's .DS_Store would move the hash
    // whenever Finder touched a folder, re-rendering for nothing.
    if (entry.name.startsWith('.')) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== 'dist') listFiles(path, out);
    } else if (entry.isFile() && !TEST_FILE.test(entry.name)) {
      out.push(path);
    }
  }
  return out;
}

/** Where the rendering's Gilde content comes from, as it resolves for the catalog package. */
export function gildeIdentity(repoRoot = REPO_ROOT, env = process.env) {
  const override = env.GEZEL_GILDE_DATA_DIR?.trim();
  if (override) return `override:${resolve(override)}`;
  try {
    const require = createRequire(join(repoRoot, 'packages', 'catalog', 'package.json'));
    const manifest = require.resolve('@bendyline/gilde/package.json');
    const { version } = JSON.parse(readFileSync(manifest, 'utf8'));
    // The real path distinguishes a `pnpm link:gilde` checkout from the pin. It is
    // relative to the repo, so a lock survives a moved checkout or another
    // runner's workspace path.
    const real = relative(realpathSync(repoRoot), realpathSync(dirname(manifest))).replaceAll(
      '\\',
      '/',
    );
    return `${version}@${real}`;
  } catch {
    return 'unresolved';
  }
}

/** Hash of every input the Handboek rendering reads. Milliseconds, not seconds. */
export function handboekInputsHash(repoRoot = REPO_ROOT, env = process.env) {
  const roots = [
    join(repoRoot, 'docs', 'handboek'),
    join(repoRoot, 'packages', 'service', 'src', 'handboek'),
    join(repoRoot, 'packages', 'catalog', 'src'),
  ];
  const files = [
    ...roots.flatMap((root) => listFiles(root)),
    handboekGezkPaths(repoRoot).builder,
  ].sort();
  const hash = createHash('sha256');
  hash.update(`gilde ${gildeIdentity(repoRoot, env)}\n`);
  for (const file of files) {
    if (!existsSync(file)) continue;
    hash.update(`${relative(repoRoot, file).replaceAll('\\', '/')}\n`);
    // Normalize line endings so a Windows checkout and CI agree.
    hash.update(readFileSync(file).toString('latin1').replaceAll('\r\n', '\n'));
    hash.update('\n');
  }
  return hash.digest('hex');
}

export function readHandboekLock(repoRoot = REPO_ROOT) {
  try {
    const lock = JSON.parse(readFileSync(handboekGezkPaths(repoRoot).lock, 'utf8'));
    return typeof lock?.inputs === 'string' && typeof lock?.content === 'string' ? lock : null;
  } catch {
    return null;
  }
}

export function writeHandboekLock(lock, repoRoot = REPO_ROOT) {
  writeFileSync(
    handboekGezkPaths(repoRoot).lock,
    `${JSON.stringify({ inputs: lock.inputs, content: lock.content }, null, 2)}\n`,
    'utf8',
  );
}

/**
 * Called from the service build. Returns what happened, ending in `missing`
 * whenever no archive exists afterwards; throws only when the archive could
 * not be built under CI, where shipping a stale one or none would be the bug
 * this exists to prevent.
 */
export function ensureHandboekGezk({
  repoRoot = REPO_ROOT,
  env = process.env,
  watch = false,
  log = console.log,
  runBuilder = defaultRunBuilder,
} = {}) {
  const paths = handboekGezkPaths(repoRoot);
  const built = () => existsSync(paths.archive);
  if (env.GEZEL_SKIP_HANDBOEK_GEZK === '1') return built() ? 'skipped' : 'missing';
  const inputs = handboekInputsHash(repoRoot, env);
  const lock = readHandboekLock(repoRoot);
  if (built() && lock?.inputs === inputs) return 'fresh';
  const command = '`pnpm --filter @bendyline/gezel-service build:handboek-gezk`';
  if (watch) {
    if (!built()) {
      log(`[handboek] the Handboek catalog has not been built; run ${command}`);
      return 'missing';
    }
    log(`[handboek] the Handboek catalog may be stale; run ${command}`);
    return 'stale';
  }
  log(
    built()
      ? '[handboek] Handboek sources changed since the catalog was built; checking…'
      : '[handboek] building the Handboek catalog (about a minute the first time)…',
  );
  if (runBuilder(paths, env)) return 'refreshed';
  // The builder prints its own reason above; naming a cause here guessed wrong.
  const message =
    '[handboek] could not build the Handboek catalog (build:handboek-gezk failed; its error is above)';
  if (env.CI) {
    throw new Error(
      `${message}; refusing to ship ${built() ? 'a possibly stale archive' : 'without the Handboek'}`,
    );
  }
  const retry =
    'Every service build retries until this succeeds; set GEZEL_SKIP_HANDBOEK_GEZK=1 to skip the check meanwhile';
  if (!built()) {
    log(`${message}; this build has no in-app Handboek. ${retry}`);
    return 'missing';
  }
  log(`${message}; keeping the previous archive. ${retry}`);
  return 'stale';
}

function defaultRunBuilder(paths, env) {
  const result = spawnSync(process.execPath, ['--import', 'tsx', paths.builder, '--if-stale'], {
    cwd: paths.serviceDir,
    env,
    stdio: 'inherit',
  });
  return result.status === 0;
}
