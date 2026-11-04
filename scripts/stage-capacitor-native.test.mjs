import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import * as tar from 'tar';
import {
  archiveHash,
  needsPinnedPayload,
  parseNativePin,
  stagePinnedMobileSdks,
} from './stage-capacitor-native.mjs';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const SOURCE = 'native/runtime/stage-sdk.py';

/** A repo with a pin, and a fake release whose archives hold the given source hash. */
async function fixture(t, { sourceHash, tamper } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'gezel-stage-native-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packed = join(root, 'packed');
  await mkdir(join(root, 'native/runtime'), { recursive: true });
  await writeFile(join(root, SOURCE), 'wrapper');
  const assets = new Map();
  let sums = '';
  for (const target of ['ios', 'android']) {
    const payload = join(packed, target);
    await mkdir(payload, { recursive: true });
    await writeFile(join(payload, 'engine.bin'), `engine ${target}`);
    await writeFile(
      join(payload, 'sdk-manifest.json'),
      JSON.stringify({
        scope: 'provider-model-runtime',
        target,
        gezelABIVersion: 1,
        packageVersion: '1.2.3',
        files: { 'engine.bin': sha256(`engine ${target}`) },
        sources: { [SOURCE]: sourceHash ?? sha256('wrapper') },
      }),
    );
    const name = `gezel-mobile-1.2.3-${target}.tar.gz`;
    await tar.c({ gzip: true, cwd: payload, file: join(packed, name) }, [
      'sdk-manifest.json',
      'engine.bin',
    ]);
    const archive = await readFile(join(packed, name));
    assets.set(name, archive);
    sums += `${sha256(archive)}  ${name}\n`;
  }
  if (tamper) assets.set('gezel-mobile-1.2.3-ios.tar.gz', Buffer.from('tampered'));
  assets.set('SHA256SUMS', Buffer.from(sums));
  await mkdir(join(root, 'packages/inference/src/engines'), { recursive: true });
  await writeFile(
    join(root, 'packages/inference/src/engines/native-manifest.ts'),
    `export const NATIVE_ENGINE_RELEASE = '1.2.3';\nexport const SHA256SUMS_DIGEST = '${sha256(sums)}';\n`,
  );
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(url);
    const bytes = assets.get(url.split('/').pop());
    return bytes ? new Response(bytes) : new Response('missing', { status: 404 });
  };
  return { root, fetchImpl, requests, assets };
}

const input = (f, extra = {}) => ({
  repoRoot: f.root,
  fetchImpl: f.fetchImpl,
  log: () => {},
  ...extra,
});

test('reads the pin the way pin-native-release.mjs writes it', async () => {
  const source = await readFile(
    join(repo, 'packages/inference/src/engines/native-manifest.ts'),
    'utf8',
  );
  const { release, digest } = parseNativePin(source);
  assert.match(release, /^\d+\.\d+\.\d+$/);
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.throws(() => parseNativePin('export const OTHER = 1;'), /no usable release pin/);
});

test('finds an archive hash in SHA256SUMS, and refuses an unlisted archive', () => {
  const hash = 'a'.repeat(64);
  assert.equal(
    archiveHash(`${hash}  other.tar.gz\n${hash} *wanted.tar.gz\n`, 'wanted.tar.gz'),
    hash,
  );
  assert.throws(() => archiveHash(`${hash}  other.tar.gz\n`, 'wanted.tar.gz'), /does not list/);
});

test('keeps a build staged on purpose, and replaces a stale release', () => {
  assert.equal(needsPinnedPayload(null, '1.2.3'), true);
  assert.equal(needsPinnedPayload('1.2.3', '1.2.3'), false);
  assert.equal(needsPinnedPayload('1.2.2', '1.2.3'), true);
  assert.equal(needsPinnedPayload('0.0.0-ci.9.1', '1.2.3'), false);
  assert.equal(needsPinnedPayload('0.0.0-ci.9.1', '1.2.3', true), true);
});

test('stages both platforms from the pinned release, then does nothing', async (t) => {
  const f = await fixture(t);
  assert.deepEqual((await stagePinnedMobileSdks(input(f))).staged, ['ios', 'android']);
  const manifest = join(f.root, 'packages/capacitor/native/ios/sdk-manifest.json');
  assert.equal(JSON.parse(await readFile(manifest, 'utf8')).packageVersion, '1.2.3');

  f.requests.length = 0;
  assert.deepEqual((await stagePinnedMobileSdks(input(f))).staged, []);
  assert.deepEqual(f.requests, [], 'a current payload costs no download');
});

test('refuses a SHA256SUMS the build did not pin', async (t) => {
  const f = await fixture(t);
  f.assets.set('SHA256SUMS', Buffer.from('substituted'));
  await assert.rejects(stagePinnedMobileSdks(input(f)), /does not match the pinned digest/);
});

test('refuses an archive that does not match SHA256SUMS', async (t) => {
  const f = await fixture(t, { tamper: true });
  await assert.rejects(stagePinnedMobileSdks(input(f)), /does not match SHA256SUMS/);
});

test('an ordinary stage tolerates source drift, and the release gate names the fix', async (t) => {
  const f = await fixture(t, { sourceHash: sha256('an older wrapper') });
  await stagePinnedMobileSdks(input(f));
  await assert.rejects(
    stagePinnedMobileSdks(input(f, { requireCurrent: true })),
    /native-v1\.2\.3 predates that change\. Cut a native release/,
  );
});

test('the release gate accepts a pinned payload matching its sources', async (t) => {
  const f = await fixture(t);
  await stagePinnedMobileSdks(input(f, { requireCurrent: true }));
});

test('the release gate replaces a CI build rather than shipping it', async (t) => {
  const f = await fixture(t);
  await stagePinnedMobileSdks(input(f));
  const staged = join(f.root, 'packages/capacitor/native/ios');
  const manifest = JSON.parse(await readFile(join(staged, 'sdk-manifest.json'), 'utf8'));
  manifest.packageVersion = '0.0.0-ci.9.1';
  await cp(staged, `${staged}.ci`, { recursive: true });
  await writeFile(join(staged, 'sdk-manifest.json'), JSON.stringify(manifest));
  const { staged: replaced } = await stagePinnedMobileSdks(input(f, { requireCurrent: true }));
  assert.deepEqual(replaced, ['ios']);
});
