import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { stageNative, verifyProducerSources, verifyRuntime } from './stage-native.mjs';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gezel-capacitor-stage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = {
    scope: 'provider-model-runtime',
    target: 'ios',
    packageVersion: '0.1.0-local.1',
    gezelABIVersion: 1,
    files: { 'runtime.bin': sha('verified') },
  };
  await writeFile(path.join(root, 'runtime.bin'), 'verified');
  const save = () => writeFile(path.join(root, 'sdk-manifest.json'), JSON.stringify(manifest));
  await save();
  return { root, manifest, save };
}

test('stages only verified bytes and preserves the last package on a bad update', async (t) => {
  const f = await fixture(t);
  const destination = path.join(f.root, 'installed');
  await writeFile(path.join(f.root, 'undeclared.bin'), 'stale');
  await stageNative('ios', f.root, destination);
  await assert.rejects(readFile(path.join(destination, 'undeclared.bin')), { code: 'ENOENT' });
  await writeFile(path.join(f.root, 'runtime.bin'), 'altered');
  await assert.rejects(stageNative('ios', f.root, destination), /integrity/);
  assert.equal(await readFile(path.join(destination, 'runtime.bin'), 'utf8'), 'verified');
});

test('rejects wrong-platform and escaping manifests', async (t) => {
  const f = await fixture(t);
  await assert.rejects(verifyRuntime(f.root, 'android'), /Expected/);
  f.manifest.files = { '../outside': sha('verified') };
  await f.save();
  await assert.rejects(verifyRuntime(f.root, 'ios'), /integrity/);
});

test('refuses to repack stale native wrapper sources', async (t) => {
  const f = await fixture(t);
  const manifest = { sources: { 'runtime.bin': sha('verified') } };
  await verifyProducerSources(manifest, f.root);
  await writeFile(path.join(f.root, 'runtime.bin'), 'edited');
  await assert.rejects(verifyProducerSources(manifest, f.root), /Restage/);
});
