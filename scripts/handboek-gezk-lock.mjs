/**
 * Keep the bundled Handboek catalog (`packages/service/assets/handboek/handboek.gezk`)
 * in step with its sources, so a docs edit or a Gilde bump cannot ship the
 * previous articles. v1.26273.82 did exactly that: the archive was built one
 * commit before the release notes were renamed, and the in-app What's New
 * opened on the old release.
 *
 * The archive stays committed (building it embeds ~1,400 chunks, about 50 s
 * with the model cached), and `handboek.gezk.lock.json` beside it records
 * two hashes:
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
 * fast path; otherwise the builder re-renders, and rebuilds the archive only
 * when the content really changed. Deliberately not keyed on the service
 * version: release tooling bumps it on its own, and an update is driven by
 * the archive digest, not the version.
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
    // The real path distinguishes a `pnpm link:gilde` checkout from the pin.
    return `${version}@${realpathSync(dirname(manifest))}`;
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
 * Called from the service build. Returns what happened; throws only when a
 * stale archive could not be rebuilt under CI, where shipping it would be
 * the bug this exists to prevent.
 */
export function ensureHandboekGezk({
  repoRoot = REPO_ROOT,
  env = process.env,
  watch = false,
  log = console.log,
  runBuilder = defaultRunBuilder,
} = {}) {
  const paths = handboekGezkPaths(repoRoot);
  if (env.GEZEL_SKIP_HANDBOEK_GEZK === '1') return 'skipped';
  const inputs = handboekInputsHash(repoRoot, env);
  const lock = readHandboekLock(repoRoot);
  if (existsSync(paths.archive) && lock?.inputs === inputs) return 'fresh';
  if (watch) {
    log(
      '[handboek] the bundled Handboek catalog may be stale; run `pnpm --filter @bendyline/gezel-service build:handboek-gezk`',
    );
    return 'stale';
  }
  log('[handboek] Handboek sources changed since the bundled catalog was built; checking…');
  const ok = runBuilder(paths, env);
  if (ok && env.GITHUB_ACTIONS) {
    // CI shipped fresh bytes, but the checkout's copy is stale: say so where
    // the pusher will see it, so the next build takes the fast path.
    log(
      '::warning file=packages/service/assets/handboek/handboek.gezk::The committed Handboek catalog was stale and was rebuilt for this build. Run `pnpm --filter @bendyline/gezel-service build:handboek-gezk` and commit handboek.gezk and handboek.gezk.lock.json.',
    );
  }
  if (ok) return 'refreshed';
  const message =
    '[handboek] could not refresh the bundled Handboek catalog (build:handboek-gezk failed — it needs the BGE embedding model, downloaded on first use)';
  if (env.CI) throw new Error(`${message}; refusing to ship a possibly stale archive`);
  log(`${message}; keeping the committed archive`);
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
