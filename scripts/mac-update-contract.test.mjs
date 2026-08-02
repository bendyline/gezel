/**
 * The macOS update flow derives its download URL by string-building the PKG
 * asset name and the release tag, rather than reading them from
 * `latest-mac.yml` — that feed lists only the ZIP, because electron-updater's
 * MacUpdater explicitly excludes pkg/dmg.
 *
 * That makes three pieces of config load-bearing from a distance:
 *   - electron-builder.yml `mac.artifactName` decides the filename on the
 *     release; `macPkgAssetName` must reproduce it exactly.
 *   - electron-builder.yml `publish:` decides the owner/repo the assets live
 *     under.
 *   - release-electron.yml tags the release `v${version}`, which is what the
 *     download path contains.
 *
 * Nothing links them to src/updater/mac-pkg.ts, so this does. A silent drift
 * here means every macOS update 404s.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const appDir = join(root, 'packages', 'app');

test('the macOS updater derives the real release asset name and URL', async () => {
  const [builder, workflow, macPkg, main] = await Promise.all([
    readFile(join(appDir, 'electron-builder.yml'), 'utf8'),
    readFile(join(root, '.github', 'workflows', 'release-electron.yml'), 'utf8'),
    readFile(join(appDir, 'src', 'updater', 'mac-pkg.ts'), 'utf8'),
    readFile(join(appDir, 'src', 'main.ts'), 'utf8'),
  ]);

  // `mac:` block wins over the top-level fallback artifactName.
  const macArtifactName = builder
    .slice(builder.indexOf('\nmac:'))
    .match(/^\s*artifactName:\s*(\S+)/m)?.[1];
  assert.equal(
    macArtifactName,
    '${productName}-${version}-mac-${arch}.${ext}',
    'mac.artifactName changed — update macPkgAssetName to match',
  );

  const productName = builder.match(/^productName:\s*(\S+)/m)?.[1];
  const assetTemplate = macPkg.match(/return `([^`]+)`;/)?.[1];
  assert.equal(
    assetTemplate,
    `${productName}-\${version}-mac-\${arch}.pkg`,
    'macPkgAssetName no longer reproduces electron-builder mac.artifactName',
  );

  const publish = builder.slice(builder.indexOf('\npublish:'));
  const owner = publish.match(/^\s*owner:\s*(\S+)/m)?.[1];
  const repo = publish.match(/^\s*repo:\s*(\S+)/m)?.[1];
  assert.match(
    macPkg,
    new RegExp(`RELEASE_OWNER = '${owner}'`),
    'RELEASE_OWNER drifted from electron-builder publish.owner',
  );
  assert.match(
    macPkg,
    new RegExp(`RELEASE_REPO = '${repo}'`),
    'RELEASE_REPO drifted from electron-builder publish.repo',
  );

  // The workflow tags `v${version}`; the download path must use the same shape.
  assert.match(
    workflow,
    /tag_name:\s*v\$\{\{\s*needs\.release-preflight\.outputs\.version\s*\}\}/,
    'release tag format changed — releaseAssetUrl builds /download/v${version}/',
  );
  assert.match(
    macPkg,
    /releases\/download\/v\$\{version\}\//,
    'releaseAssetUrl no longer matches the workflow tag format',
  );

  // SHA256SUMS is the digest source; the release job must keep publishing it
  // under exactly that name.
  assert.match(
    workflow,
    /xargs sha256sum > SHA256SUMS/,
    'release job no longer produces SHA256SUMS — the updater verifies against it',
  );

  assert.match(
    main,
    /const \{ stdout, stderr \} = await run/,
    'the production execFile adapter must preserve spctl stderr for diagnostics',
  );
  assert.match(
    main,
    /updateState\?\.kind === 'ready' && updateState\.version === version/,
    'a failed macOS update must remain retryable for the same version',
  );
});

/**
 * The macOS ZIP is the most deletable-looking artifact in the release: ~447 MB
 * that no user ever downloads, because the darwin update path sets
 * `autoDownload = false` and fetches the PKG itself. Removing the target would
 * also remove `latest-mac.yml` — `PkgTarget` emits no update info, and
 * `ArchiveTarget` writes it only for `format === "zip"`. The updater would
 * then 404 on the channel file and macOS would stop seeing updates at all,
 * with no error visible at build time.
 */
test('the macOS zip target is retained because it is what emits latest-mac.yml', async () => {
  const [builder, workflow] = await Promise.all([
    readFile(join(appDir, 'electron-builder.yml'), 'utf8'),
    readFile(join(root, '.github', 'workflows', 'release-electron.yml'), 'utf8'),
  ]);

  const macBlock = builder.slice(builder.indexOf('\nmac:'), builder.indexOf('\npkg:'));
  const targets = [...macBlock.matchAll(/^\s*-\s*target:\s*(\S+)/gm)].map((m) => m[1]);
  assert.deepEqual(
    targets,
    ['pkg', 'zip'],
    'macOS targets changed. The pkg is the first-install artifact; the zip is the only ' +
      'target that emits latest-mac.yml. Dropping the zip silently disables macOS update ' +
      'discovery — see the comment above it in electron-builder.yml.',
  );

  // The reason has to travel with the config, or the next reader deletes it.
  assert.match(
    macBlock,
    /DO NOT REMOVE, even though nothing ever downloads this ZIP/,
    'the zip target lost the comment explaining why it cannot be deleted',
  );

  // Publishing the feed without the artifact it names would leave latest-mac.yml
  // advertising a 404, which is fine only while nothing resolves it. The release
  // job asserts both exist; keep that assertion.
  assert.match(
    workflow,
    /verified PKG first-install artifact and ZIP-based macOS update feed/,
    'release job no longer verifies that both the PKG and the ZIP feed were produced',
  );
});
