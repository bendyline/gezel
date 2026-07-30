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
  const [builder, workflow, macPkg] = await Promise.all([
    readFile(join(appDir, 'electron-builder.yml'), 'utf8'),
    readFile(join(root, '.github', 'workflows', 'release-electron.yml'), 'utf8'),
    readFile(join(appDir, 'src', 'updater', 'mac-pkg.ts'), 'utf8'),
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
});
