import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  GITHUB_RELEASE_ASSET_LIMIT,
  WARN_FRACTION,
  assessAssetSizes,
} from './check-release-asset-sizes.mjs';

const MiB = 1024 * 1024;

test('an asset at or over 2 GiB is an error, since GitHub refuses it', () => {
  const [at, over] = assessAssetSizes([
    { name: 'at.deb', bytes: GITHUB_RELEASE_ASSET_LIMIT },
    { name: 'over.deb', bytes: GITHUB_RELEASE_ASSET_LIMIT + 5 * MiB },
  ]);
  assert.equal(at.level, 'error');
  assert.equal(over.level, 'error');
  assert.match(over.message, /over\.deb is 2053 MiB, 5 MiB over/);
});

test('an asset close to the limit warns, and the native 0.1.61 amd64 deb is one', () => {
  // v1.26307.102 shipped a 1611 MiB amd64 .deb; native-v0.1.61 adds ~317 MiB of
  // compressed Linux x64 engines, most of it the ROCm key.
  const [deb, rpm, mac] = assessAssetSizes([
    { name: 'Gezel-linux-amd64.deb', bytes: 1928 * MiB },
    { name: 'Gezel-linux-x86_64.rpm', bytes: 1723 * MiB },
    { name: 'Gezel-mac-arm64.pkg', bytes: 524 * MiB },
  ]);
  assert.equal(deb.level, 'warning');
  assert.match(deb.message, /120 MiB under/);
  assert.equal(rpm.level, 'ok');
  assert.equal(mac.level, 'ok');
  assert.equal(
    assessAssetSizes([
      { name: 'edge', bytes: Math.ceil(GITHUB_RELEASE_ASSET_LIMIT * WARN_FRACTION) },
    ])[0].level,
    'warning',
  );
});

test('the command fails only when an asset is over the limit', () => {
  const script = fileURLToPath(new URL('./check-release-asset-sizes.mjs', import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), 'gezel-asset-sizes-'));
  try {
    const small = join(dir, 'small.zip');
    writeFileSync(small, 'x');
    const ok = spawnSync(process.execPath, [script, small], { encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /small\.zip: 0 MiB/);
    const none = spawnSync(process.execPath, [script], { encoding: 'utf8' });
    assert.equal(none.status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
