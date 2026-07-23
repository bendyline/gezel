#!/usr/bin/env node
import { execSync } from 'node:child_process';
/**
 * Cut a new native-bundle release.
 *
 * Usage:
 *   node scripts/cut-native-release.mjs <version> [--dry-run] [--allow-dirty]
 *
 * Example:
 *   node scripts/cut-native-release.mjs 0.1.3
 *
 * What it does:
 *   1. Validates the new version is semver and strictly greater than the
 *      latest existing `native-v*` tag.
 *   2. Confirms HEAD is on `main` (override with --allow-branch=other).
 *   3. Confirms the working tree is clean (--allow-dirty bypasses).
 *   4. Confirms `main` is up to date with origin (no behind/ahead drift).
 *   5. Creates an annotated tag `native-v<version>` pointing at HEAD.
 *   6. Pushes the tag to origin — that triggers `.github/workflows/build-native.yml`
 *      and (if its workflow_run dependency is healthy)
 *      `.github/workflows/release-native.yml`.
 *
 * Why a script and not just `git tag && git push`:
 *   The CI matrix is 8+ jobs each taking 10–30 minutes. Cheap mistakes
 *   (typo'd version, dirty tree, off-branch tag, accidental v-prefix
 *   inside the version arg) cost real wall-clock time and cause noisy
 *   "release didn't fire" investigations later. Validate before pushing.
 *
 * Source of truth:
 *   The git tag IS the version. There's no `native/VERSION` file to
 *   bump because the in-repo `native/engines/<engine>/VERSION` files
 *   pin upstream commits, not the Gezel-bundle release line. Keeping
 *   that distinction clean.
 */
import { setDefaultAutoSelectFamilyAttemptTimeout } from 'node:net';

setDefaultAutoSelectFamilyAttemptTimeout(5000);

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith('--'));
const flags = new Set(args.filter((a) => a.startsWith('--')));
const dryRun = flags.has('--dry-run');
const allowDirty = flags.has('--allow-dirty');
const branchOverride = args
  .find((a) => a.startsWith('--allow-branch='))
  ?.slice('--allow-branch='.length);

if (positional.length !== 1) {
  console.error('usage: node scripts/cut-native-release.mjs <version> [--dry-run] [--allow-dirty]');
  console.error('       <version> is bare semver, e.g. 0.1.3 (no leading v, no native- prefix)');
  process.exit(2);
}

const version = positional[0].replace(/^v/, '').replace(/^native-v?/, '');

if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version)) {
  console.error(
    `error: "${version}" is not valid semver (expected MAJOR.MINOR.PATCH[-prerelease])`,
  );
  process.exit(1);
}

const newTag = `native-v${version}`;

function run(cmd, opts = {}) {
  return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
}

// ── 1. Latest existing tag ─────────────────────────────────────────
let latest;
try {
  latest = run('git describe --tags --match "native-v*" --abbrev=0');
} catch {
  latest = null;
}
console.log(`latest existing tag: ${latest ?? '(none — this is the first)'}`);

if (latest) {
  const latestVer = latest.replace(/^native-v/, '');
  if (semverCompare(version, latestVer) <= 0) {
    console.error(
      `error: ${version} is not strictly greater than ${latestVer}. Bump major/minor/patch.`,
    );
    process.exit(1);
  }
}

// ── 2. Branch check ────────────────────────────────────────────────
const branch = run('git rev-parse --abbrev-ref HEAD');
const expectedBranch = branchOverride ?? 'main';
if (branch !== expectedBranch) {
  console.error(
    `error: HEAD is on '${branch}', not '${expectedBranch}'. ` +
      `Pass --allow-branch=${branch} to override.`,
  );
  process.exit(1);
}

// ── 3. Clean tree check ────────────────────────────────────────────
const dirty = run('git status --porcelain');
if (dirty && !allowDirty) {
  console.error('error: working tree has uncommitted changes:');
  console.error(dirty);
  console.error('commit / stash first, or pass --allow-dirty to override');
  process.exit(1);
}

// ── 4. Up-to-date check ────────────────────────────────────────────
try {
  run(`git fetch origin ${branch} --quiet`, { stdio: ['ignore', 'pipe', 'inherit'] });
  const local = run('git rev-parse HEAD');
  const remote = run(`git rev-parse origin/${branch}`);
  if (local !== remote) {
    console.error(
      `error: local ${branch} is not at the same commit as origin/${branch}. Pull / push first so the tag points at a published commit.`,
    );
    console.error(`  local : ${local}`);
    console.error(`  remote: ${remote}`);
    process.exit(1);
  }
} catch (err) {
  console.warn(`warning: couldn't compare to origin/${branch}: ${err.message}`);
  console.warn('  proceeding anyway — push may still succeed');
}

// ── 5. Tag exists check ────────────────────────────────────────────
try {
  run(`git rev-parse --verify --quiet ${newTag}`);
  console.error(`error: tag ${newTag} already exists locally — pick a higher version`);
  process.exit(1);
} catch {
  // expected — the tag does not exist
}

// ── 6. Confirm + tag + push ────────────────────────────────────────
const head = run('git rev-parse --short HEAD');
console.log('');
console.log(`would create:  tag '${newTag}' at ${head} (${branch})`);
console.log('would push to: origin');
console.log('triggers:      .github/workflows/build-native.yml');
console.log('');

if (dryRun) {
  console.log('--dry-run set — stopping here.');
  process.exit(0);
}

console.log('tagging…');
run(`git tag -a ${newTag} -m "Native binaries v${version}"`);

console.log('pushing tag to origin…');
execSync(`git push origin ${newTag}`, { stdio: 'inherit' });

console.log('');
console.log(`✓ tagged ${newTag} and pushed`);
console.log('watch CI: https://github.com/bendyline/gezel/actions/workflows/build-native.yml');
console.log('release will appear at:');
console.log(`  https://github.com/bendyline/gezel/releases/tag/${newTag}`);

/** Naïve semver compare. Returns -1 / 0 / 1. Treats prereleases as < release. */
function semverCompare(a, b) {
  const parse = (s) => {
    const [main, pre] = s.split('-');
    const [maj, min, pat] = main.split('.').map((n) => Number.parseInt(n, 10));
    return { maj, min, pat, pre: pre ?? '' };
  };
  const A = parse(a);
  const B = parse(b);
  if (A.maj !== B.maj) return A.maj < B.maj ? -1 : 1;
  if (A.min !== B.min) return A.min < B.min ? -1 : 1;
  if (A.pat !== B.pat) return A.pat < B.pat ? -1 : 1;
  // Equal core; prerelease < release
  if (A.pre === B.pre) return 0;
  if (!A.pre) return 1;
  if (!B.pre) return -1;
  return A.pre < B.pre ? -1 : 1;
}
