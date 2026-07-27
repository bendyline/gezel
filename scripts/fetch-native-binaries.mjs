#!/usr/bin/env node
/**
 * Pull prebuilt native engine binaries (llama-server, sd-server, …)
 * for this machine and drop them where every consumer finds them.
 *
 * Usage:
 *   node scripts/fetch-native-binaries.mjs                 # latest release, ALL variants for this platform
 *                                                          #   (so you can flip Settings → Advanced →
 *                                                          #   Engine backend without re-fetching)
 *   node scripts/fetch-native-binaries.mjs --version 0.1.2 # pin to a release
 *   node scripts/fetch-native-binaries.mjs --variant cuda  # narrow to one variant
 *   node scripts/fetch-native-binaries.mjs --run 24887707235  # pull from a specific build-native.yml run's
 *                                                          #   artifacts. Useful for validating a tagged build
 *                                                          #   while its GitHub Release remains a draft, or for
 *                                                          #   testing a workflow_dispatch build before tagging.
 *   node scripts/fetch-native-binaries.mjs --list          # list available variants for current platform
 *
 * Auth:
 *   Tries in order: GEZEL_GITHUB_TOKEN env, GITHUB_TOKEN env, `gh auth token`.
 *   bendyline/gezel is private, so a token with `repo` scope is required
 *   for both the releases and the run-artifact endpoints.
 *
 * Where files land:
 *   packages/app/native-bin/<platform>[-<variant>]/<binary>[.exe]
 *
 *   This is the canonical location for three consumers at once:
 *     1. Dev `pnpm app` — supervisor's `nativeBinDir(mainMetaUrl)` resolves
 *        to `<mainDir>/../native-bin`, which in dev = `packages/app/native-bin/`.
 *     2. Local packaging (`pnpm package:win/mac/linux`) — electron-builder's
 *        `files: native-bin/**\/*` + `asarUnpack: native-bin/**\/*` glob in
 *        electron-builder.yml packs straight from here.
 *     3. CI (release-electron.yml) — its staging step writes to the same
 *        dir before invoking electron-builder, so a fresh fetch and a
 *        fresh CI release land binaries at the same path.
 *
 *   This used to write to `native/build/`, which the supervisor's dev
 *   fallback also checked but electron-builder didn't see — so a local
 *   `pnpm package:win` after a fetch shipped an installer with no
 *   binaries. native-bin.ts still falls back to `native/build/` for
 *   dev workflows that build an engine via `native/engines/*\/build.sh`.
 *
 * Extraction shells out to system `tar` (built-in on Windows 10+,
 * Mac, Linux) and `unzip` (Mac/Linux) / PowerShell `Expand-Archive`
 * (Windows). No new node_modules deps needed for a root-level script.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  constants,
  accessSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
} from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { setDefaultAutoSelectFamilyAttemptTimeout } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectPlatform, platformVariants } from './native-payload.mjs';

setDefaultAutoSelectFamilyAttemptTimeout(5000);

const REPO_OWNER = 'bendyline';
const REPO_NAME = 'gezel';
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
// See the docstring above for why this points at packages/app/native-bin/
// rather than the older native/build/ location: it's the one path that
// dev `pnpm app`, local `pnpm package:*`, and CI release-electron.yml
// all consume from.
const buildRoot = join(repoRoot, 'packages', 'app', 'native-bin');

const args = parseArgs(process.argv.slice(2));

async function main() {
  if (args.help) {
    console.log(HELP);
    return;
  }

  const platform = detectPlatform();
  if (!platform) {
    console.error(`error: unsupported platform/arch: ${process.platform}/${process.arch}`);
    process.exit(1);
  }

  const token = await resolveToken();
  if (!token) {
    console.error('error: no GitHub token available.');
    console.error('  Set GEZEL_GITHUB_TOKEN, set GITHUB_TOKEN, or run `gh auth login`.');
    console.error('  bendyline/gezel is private — fetching releases / artifacts needs auth.');
    process.exit(1);
  }

  if (args.list) {
    await listAvailable(token, platform);
    return;
  }

  if (args.run) {
    await fetchFromRun({ token, platform, runId: args.run, variant: args.variant });
  } else {
    await fetchFromRelease({ token, platform, version: args.version, variant: args.variant });
  }
}

// ── Auth ───────────────────────────────────────────────────────────

async function resolveToken() {
  if (process.env.GEZEL_GITHUB_TOKEN) return process.env.GEZEL_GITHUB_TOKEN;
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  const gh = spawnSync('gh', ['auth', 'token'], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  if (gh.status === 0) return gh.stdout.trim();
  return null;
}

// ── Release path ───────────────────────────────────────────────────

async function fetchFromRelease({ token, platform, version, variant }) {
  let release;
  if (version) {
    const tag = `native-v${version.replace(/^v/, '').replace(/^native-v?/, '')}`;
    console.log(`looking up release ${tag}…`);
    try {
      release = await api(`/repos/${REPO_OWNER}/${REPO_NAME}/releases/tags/${tag}`, token);
    } catch (err) {
      if (err?.status !== 404) throw err;
      // /releases/tags/ never returns draft releases even when the git tag
      // exists. The list endpoint DOES include drafts for a token with push
      // access, so fall back to it before giving up — this is how a draft
      // gets validated by version prior to publishing.
      const all = await api(`/repos/${REPO_OWNER}/${REPO_NAME}/releases?per_page=100`, token);
      release = all.find((r) => r.tag_name === tag);
      if (!release) {
        console.error(`error: no release tagged ${tag} (drafts included).`);
        console.error('       For an unreleased build, use --run <workflow-run-id> instead.');
        process.exit(1);
      }
      if (release.draft) console.log(`  → ${tag} is a draft release`);
    }
  } else {
    console.log('looking up the latest native-v* release…');
    // /releases/latest skips prereleases AND will surface app releases — we
    // want the most recent native-v* specifically, so iterate.
    const all = await api(`/repos/${REPO_OWNER}/${REPO_NAME}/releases?per_page=30`, token);
    release = all.find((r) => r.tag_name?.startsWith('native-v'));
    if (!release) {
      console.error('error: no native-v* release found in the most recent 30 releases.');
      console.error(
        '       Either no native release exists yet, or use --run <id> to pull build-run artifacts directly.',
      );
      process.exit(1);
    }
    console.log(`  → ${release.tag_name}`);
  }

  const ext = platform.startsWith('win32') ? 'zip' : 'tar.gz';
  const ver = release.tag_name.replace(/^native-v/, '');

  // Integrity: every archive must match the SHA256SUMS the build workflow
  // published alongside it. A release without SHA256SUMS, or an archive
  // missing from it, is refused outright — never extract unverified bytes.
  const sums = await fetchSha256Sums({ token, release });

  // Default behavior fetches every variant for this platform so the
  // user can flip the Settings → Advanced → Engine backend dropdown
  // freely without re-running the script. `--variant` narrows to one.
  const platformKeys = variant ? [pickPlatformKey(platform, variant)] : platformVariants(platform);
  requireKeys(platformKeys, platform);

  for (const platformKey of platformKeys) {
    const assetName = `gezel-native-${ver}-${platformKey}.${ext}`;
    const asset = release.assets?.find((a) => a.name === assetName);
    if (!asset) {
      // For default-all-variants, missing assets aren't fatal — a
      // platform might not ship every variant in every release. Just
      // note + skip. Explicit --variant misses are still fatal.
      if (platformKeys.length > 1) {
        console.warn(`  ⚠ ${assetName} not in release ${release.tag_name} — skipping`);
        continue;
      }
      console.error(`error: ${assetName} not found in release ${release.tag_name}.`);
      console.error('       Available assets:');
      for (const a of release.assets ?? []) console.error(`         ${a.name}`);
      process.exit(1);
    }

    const expectedSha256 = sums.get(assetName);
    if (!expectedSha256) {
      console.error(`error: ${assetName} has no entry in SHA256SUMS for ${release.tag_name}.`);
      console.error('       Refusing to extract an unverifiable archive.');
      process.exit(1);
    }

    const targetDir = join(buildRoot, platformKey);
    // Start from an empty key dir: extraction merges into whatever is
    // already there, so leftovers from an older release survive a re-fetch
    // (pre-0.1.19 fetches left OpenSSL DLLs beside the 0.1.19 payload —
    // stale files mask dependency regressions in local testing and a local
    // electron-builder run would sweep-sign them).
    await rm(targetDir, { recursive: true, force: true });
    await downloadAndExtract({
      token,
      url: asset.url, // API URL — needs Accept: application/octet-stream
      accept: 'application/octet-stream',
      name: assetName,
      targetDir,
      isZip: ext === 'zip',
      expectedSha256,
    });
    console.log(`✓ ${platformKey}: extracted into ${targetDir}`);
    await listExtracted(targetDir);
  }
}

// ── Run-artifact path ──────────────────────────────────────────────

async function fetchFromRun({ token, platform, runId, variant }) {
  console.log(`fetching artifacts from build run ${runId}…`);
  const { artifacts } = await api(
    `/repos/${REPO_OWNER}/${REPO_NAME}/actions/runs/${runId}/artifacts?per_page=100`,
    token,
  );

  // Same default-all-variants policy as the release path. build-native.yml
  // uploads as `native-<engine>-<platform>[-<variant>]`, wrapped in a zip
  // on the GitHub side regardless of source OS.
  const platformKeys = variant ? [pickPlatformKey(platform, variant)] : platformVariants(platform);
  requireKeys(platformKeys, platform);

  let totalMatched = 0;
  for (const platformKey of platformKeys) {
    const matched = artifacts.filter((a) => a.name.endsWith(`-${platformKey}`));
    if (matched.length === 0) {
      if (platformKeys.length > 1) {
        console.warn(`  ⚠ no artifacts ending in -${platformKey} on run ${runId} — skipping`);
        continue;
      }
      console.error(`error: no artifacts ending in -${platformKey} on run ${runId}.`);
      console.error('       Available artifacts:');
      for (const a of artifacts) console.error(`         ${a.name} (${a.size_in_bytes} bytes)`);
      process.exit(1);
    }

    const targetDir = join(buildRoot, platformKey);
    // Once per key, before the artifact loop — several engines merge into
    // one bare key here, so cleaning inside the loop would drop them.
    await rm(targetDir, { recursive: true, force: true });
    await mkdir(targetDir, { recursive: true });
    for (const art of matched) {
      console.log(`  ${art.name}`);
      await downloadAndExtract({
        token,
        url: art.archive_download_url,
        accept: 'application/vnd.github+json',
        name: `${art.name}.zip`,
        targetDir,
        isZip: true,
        unwrapPayload: true,
      });
      // GitHub re-zips run artifacts server-side, so the archive itself has
      // no stable hash. Verify the extracted main binary against the
      // `<artifact>-manifest` sibling the build job uploaded instead.
      // (Manifests cover the main engine binary only, not peer libs — the
      // release path's SHA256SUMS check is the full-coverage one.)
      await verifyAgainstManifest({ token, artifacts, artifactName: art.name, targetDir });
    }
    console.log(`✓ ${platformKey}: extracted into ${targetDir}`);
    await listExtracted(targetDir);
    totalMatched += matched.length;
  }
  if (totalMatched === 0) {
    console.error(`error: no matching artifacts on run ${runId} for platform ${platform}.`);
    process.exit(1);
  }
}

// ── List path ──────────────────────────────────────────────────────

async function listAvailable(token, platform) {
  const releases = await api(`/repos/${REPO_OWNER}/${REPO_NAME}/releases?per_page=10`, token);
  const native = releases.filter((r) => r.tag_name?.startsWith('native-v'));
  if (native.length === 0) {
    console.log('no native-v* releases published yet.');
    return;
  }
  console.log(`recent native releases (host platform: ${platform}):`);
  for (const r of native.slice(0, 5)) {
    console.log(`  ${r.tag_name}  (${r.published_at ?? r.created_at})`);
    const ver = r.tag_name.replace(/^native-v/, '');
    const matching = (r.assets ?? []).filter((a) =>
      a.name.startsWith(`gezel-native-${ver}-${platform}`),
    );
    for (const a of matching) {
      console.log(`    ${a.name}  (${(a.size / 1024 / 1024).toFixed(1)} MB)`);
    }
  }
}

// ── Integrity ──────────────────────────────────────────────────────

/** Parse the release's SHA256SUMS asset into a name → hex-digest map. */
async function fetchSha256Sums({ token, release }) {
  const asset = release.assets?.find((a) => a.name === 'SHA256SUMS');
  if (!asset) {
    console.error(`error: release ${release.tag_name} has no SHA256SUMS asset.`);
    console.error('       Refusing to fetch unverifiable archives.');
    process.exit(1);
  }
  const res = await fetch(asset.url, {
    redirect: 'follow',
    headers: {
      Accept: 'application/octet-stream',
      Authorization: `token ${token}`,
      'User-Agent': 'gezel-fetch-native',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} downloading SHA256SUMS`);
  const sums = new Map();
  for (const line of (await res.text()).split('\n')) {
    const m = line.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/i);
    if (m) sums.set(m[2], m[1].toLowerCase());
  }
  if (sums.size === 0) {
    console.error(`error: SHA256SUMS for ${release.tag_name} parsed to zero entries.`);
    process.exit(1);
  }
  return sums;
}

async function sha256File(path) {
  const hash = createHash('sha256');
  await new Promise((res, rej) => {
    createReadStream(path)
      .on('data', (c) => hash.update(c))
      .on('end', res)
      .on('error', rej);
  });
  return hash.digest('hex');
}

/**
 * Verify extracted binaries from a run artifact against its `-manifest`
 * sibling (`<engine>.sha256`, lines of `<hex>  <binary-name>`). The
 * manifest is required — a run without one predates the integrity
 * pipeline and shouldn't be consumed via this script.
 */
async function verifyAgainstManifest({ token, artifacts, artifactName, targetDir }) {
  const manifest = artifacts.find((a) => a.name === `${artifactName}-manifest`);
  if (!manifest) {
    console.error(`error: no ${artifactName}-manifest artifact on this run.`);
    console.error('       Refusing to trust unverifiable extracted binaries.');
    process.exit(1);
  }
  const scratch = await mkdtemp(join(tmpdir(), 'gezel-native-manifest-'));
  try {
    const zip = join(scratch, 'manifest.zip');
    await downloadToFile({
      token,
      url: manifest.archive_download_url,
      accept: 'application/vnd.github+json',
      dest: zip,
    });
    await extractZip(zip, scratch);
    for (const entry of await readdir(scratch)) {
      if (!entry.endsWith('.sha256')) continue;
      const text = await readFile(join(scratch, entry), 'utf8');
      for (const line of text.split('\n')) {
        const m = line.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/i);
        if (!m) continue;
        const [, expected, binName] = m;
        const actual = await sha256File(join(targetDir, binName));
        if (actual !== expected.toLowerCase()) {
          throw new Error(
            `sha256 mismatch for ${binName} (from ${entry}): expected ${expected}, got ${actual}`,
          );
        }
        console.log(`    ✓ verified ${binName}`);
      }
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

// ── Download + extract via system tools ────────────────────────────

async function downloadToFile({ token, url, accept, dest }) {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: {
      Accept: accept,
      Authorization: `token ${token}`,
      'User-Agent': 'gezel-fetch-native',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} from ${url}`);
  mkdirSync(dirname(dest), { recursive: true });
  const file = createWriteStream(dest);
  const reader = res.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!file.write(value)) await new Promise((r) => file.once('drain', r));
  }
  await new Promise((r) => file.end(r));
}

// A run artifact wraps the build tree in this tarball rather than uploading
// it loose: actions/upload-artifact dereferences symlinks, which tripled
// every SONAME chain and pushed linux-x64-cuda past GitHub's 2 GiB
// release-asset cap. See "Pack build output" in build-native.yml. Release
// archives are already the packed tree, so only the run path unwraps.
const RUN_ARTIFACT_PAYLOAD = 'native-payload.tar.gz';

async function downloadAndExtract({
  token,
  url,
  accept,
  name,
  targetDir,
  isZip,
  expectedSha256,
  unwrapPayload,
}) {
  const scratch = await mkdtemp(join(tmpdir(), 'gezel-native-'));
  const archive = join(scratch, name);
  try {
    console.log(`    downloading ${name}…`);
    await downloadToFile({ token, url, accept, dest: archive });

    if (expectedSha256) {
      const actual = await sha256File(archive);
      if (actual !== expectedSha256) {
        throw new Error(
          `sha256 mismatch for ${name}: expected ${expectedSha256}, got ${actual}. The downloaded archive does not match the release SHA256SUMS — refusing to extract.`,
        );
      }
      console.log('    ✓ sha256 verified against SHA256SUMS');
    }

    await mkdir(targetDir, { recursive: true });
    console.log(`    extracting → ${targetDir}`);
    if (isZip) {
      await extractZip(archive, targetDir);
    } else {
      await extractTarGz(archive, targetDir);
    }

    if (unwrapPayload) {
      const payload = join(targetDir, RUN_ARTIFACT_PAYLOAD);
      if (!existsSync(payload)) {
        throw new Error(
          `${name} contains no ${RUN_ARTIFACT_PAYLOAD} — that run predates the packed-artifact change in build-native.yml. Use --version against a release instead.`,
        );
      }
      await extractTarGz(payload, targetDir);
      await rm(payload, { force: true });
    }

    if (process.platform !== 'win32') {
      for (const f of await readdir(targetDir)) {
        if (!f.endsWith('.exe') && !f.endsWith('.txt')) {
          await chmod(join(targetDir, f), 0o755);
        }
      }
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function extractZip(archive, targetDir) {
  // Windows 10+ ships tar.exe (it's bsdtar) which handles zip files just
  // fine via `tar -xf`. That's strictly more reliable than PowerShell's
  // Expand-Archive (which has historically choked on long paths and zip
  // entries with backslashes). On Mac/Linux, system tar also handles zip.
  // Fallback to PowerShell only if tar isn't on PATH.
  //
  // Hold tar's stderr rather than streaming it: under Git Bash, `tar` is
  // MSYS GNU tar, which cannot auto-detect zip ("This does not look like
  // a tar archive") — expected chatter when a fallback is about to
  // succeed, alarming mid-fetch noise otherwise. Surface it only when
  // every extractor fails.
  const tar = spawnSync('tar', tarExtractArgs(['-xf'], archive, targetDir), {
    stdio: ['ignore', 'inherit', 'pipe'],
    cwd: dirname(archive),
  });
  if (tar.status === 0) return;
  const tarStderr = String(tar.stderr ?? '').trim();
  if (process.platform === 'win32') {
    const ps = spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${targetDir}' -Force`,
      ],
      { stdio: 'inherit' },
    );
    if (ps.status !== 0) {
      throw new Error(`extractZip: both tar and Expand-Archive failed. tar stderr: ${tarStderr}`);
    }
    return;
  }
  const unzip = spawnSync('unzip', ['-o', archive, '-d', targetDir], { stdio: 'inherit' });
  if (unzip.status !== 0) {
    throw new Error(`extractZip: tar and unzip both failed. tar stderr: ${tarStderr}`);
  }
}

async function extractTarGz(archive, targetDir) {
  const tar = spawnSync('tar', tarExtractArgs(['-xzf'], archive, targetDir), {
    stdio: 'inherit',
    cwd: dirname(archive),
  });
  if (tar.status !== 0) throw new Error(`extractTarGz: tar exited ${tar.status}`);
}

/**
 * Build tar args that survive every tar on PATH. Under Git Bash, `tar` is
 * MSYS GNU tar, which parses the colon in `C:\…` as a remote-host prefix
 * ("Cannot connect to C: resolve failed") — that only applies to the
 * archive (-f) argument, so pass it RELATIVE and let the caller set
 * cwd = dirname(archive). Forward slashes on -C keep both GNU tar and
 * bsdtar (cmd/PowerShell, macOS, Linux) happy.
 */
function tarExtractArgs(flags, archive, targetDir) {
  return [...flags, basename(archive), '-C', targetDir.replaceAll('\\', '/')];
}

async function listExtracted(targetDir) {
  try {
    const entries = await readdir(targetDir);
    if (entries.length === 0) return;
    console.log('  contents:');
    for (const e of entries) console.log(`    ${e}`);
  } catch {
    /* nothing to list */
  }
}

// ── Helpers ────────────────────────────────────────────────────────

async function api(path, token) {
  const url = `https://api.github.com${path}`;
  const res = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `token ${token}`,
      'User-Agent': 'gezel-fetch-native',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`GitHub API ${res.status} on ${path}: ${body.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/**
 * `platformVariants` returns an empty list for a platform the native
 * pipeline doesn't publish (darwin-x64, win32-arm64). An empty fetch loop
 * would exit 0 having downloaded nothing — say so instead.
 */
function requireKeys(platformKeys, platform) {
  if (platformKeys.length > 0) return;
  console.error(`error: no native binaries are published for ${platform}.`);
  console.error('       See the matrix in .github/workflows/build-native.yml.');
  process.exit(1);
}

function pickPlatformKey(platform, variant) {
  // Mac is single-variant (Metal). Linux/Windows have cpu / vulkan / cuda
  // variants for llama-cpp. With an explicit variant, just stamp it.
  // Without — fall through to the host probe (matches the supervisor's
  // own auto-detect in packages/app/src/supervisor/llama-backend.ts) so
  // the lone-variant fetch lands in the directory the supervisor will
  // look in. The default-all path doesn't go through here.
  if (platform.startsWith('darwin')) return platform;
  return `${platform}-${variant ?? autoDetectBackend(platform)}`;
}

/**
 * Mirror of `detectLinuxOrWin` from the supervisor's llama-backend.ts.
 * CUDA driver → 'cuda'; Vulkan loader → 'vulkan'; else 'cpu'. Pure
 * filesystem check; no GPU workload. Duplicated rather than imported
 * because the supervisor module sits inside packages/app and a
 * root-level script shouldn't depend on a built workspace package.
 */
function autoDetectBackend(platform) {
  const fileExists = (p) => {
    try {
      accessSync(p, constants.F_OK);
      return true;
    } catch {
      return false;
    }
  };
  if (platform === 'win32-x64') {
    const sys32 = process.env.SYSTEMROOT
      ? join(process.env.SYSTEMROOT, 'System32')
      : 'C:\\Windows\\System32';
    if (fileExists(join(sys32, 'nvcuda.dll')) || fileExists(join(sys32, 'nvml.dll'))) {
      console.log('  auto-detected backend: cuda (found nvcuda.dll / nvml.dll)');
      return 'cuda';
    }
    if (fileExists(join(sys32, 'vulkan-1.dll'))) {
      console.log('  auto-detected backend: vulkan (found vulkan-1.dll)');
      return 'vulkan';
    }
  } else if (platform.startsWith('linux-')) {
    const cudaPaths = [
      '/usr/lib/x86_64-linux-gnu/libcuda.so.1',
      '/usr/lib/aarch64-linux-gnu/libcuda.so.1',
      '/usr/lib64/libcuda.so.1',
      '/usr/lib/libcuda.so.1',
      '/lib/x86_64-linux-gnu/libcuda.so.1',
      '/lib/aarch64-linux-gnu/libcuda.so.1',
    ];
    if (cudaPaths.some(fileExists)) {
      console.log('  auto-detected backend: cuda (found libcuda.so.1)');
      return 'cuda';
    }
    const vkPaths = [
      '/usr/lib/x86_64-linux-gnu/libvulkan.so.1',
      '/usr/lib/aarch64-linux-gnu/libvulkan.so.1',
      '/usr/lib64/libvulkan.so.1',
      '/usr/lib/libvulkan.so.1',
    ];
    if (vkPaths.some(fileExists)) {
      console.log('  auto-detected backend: vulkan (found libvulkan.so.1)');
      return 'vulkan';
    }
  }
  console.log('  auto-detected backend: cpu (no CUDA driver, no Vulkan loader)');
  return 'cpu';
}

function parseArgs(argv) {
  const out = { variant: null, version: null, run: null, list: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--list') out.list = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--version') out.version = argv[++i];
    else if (a === '--variant') out.variant = argv[++i];
    else if (a === '--run') out.run = argv[++i];
    else if (a.startsWith('--version=')) out.version = a.slice('--version='.length);
    else if (a.startsWith('--variant=')) out.variant = a.slice('--variant='.length);
    else if (a.startsWith('--run=')) out.run = a.slice('--run='.length);
  }
  return out;
}

const HELP = `Usage: node scripts/fetch-native-binaries.mjs [options]

  --version <X.Y.Z>    Pull a specific release (default: latest native-v*).
                       Draft releases resolve too when the token has push access.
  --variant <name>     Narrow to a single llama-cpp variant: cpu | vulkan | cuda
                       Default: fetch ALL variants for this platform so the
                       Settings → Advanced → Engine backend dropdown can flip
                       between them without re-running this script.
                       Mac always gets the single Metal variant.
  --run <id>           Pull from a build-native.yml workflow run instead of
                       a published release. Use this to validate a draft-bound
                       tagged build or a workflow_dispatch test build.
  --list               Show recent releases + assets for this platform.
  -h, --help           Show this help.

Auth: GEZEL_GITHUB_TOKEN, GITHUB_TOKEN env, or \`gh auth token\`.`;

main().catch((err) => {
  console.error(err.stack ?? err.message ?? String(err));
  process.exit(1);
});
