import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  README,
  ROCM_LGPL_SOURCES,
  THEROCK_ARCHIVE,
  THEROCK_SOURCE,
  thirdPartySourcesAssetName,
  verifyRocmLgplSources,
} from './rocm-lgpl-sources.mjs';
import { ROCM_LICENSES, rocmSourceOffer } from './stage-native-artifact-licenses.mjs';

const read = (path) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

test('the TheRock pin is the release the pinned ROCm SDK came from', () => {
  const sdk = read('../native/scripts/rocm-sdk-requirements.txt').match(
    /^rocm-sdk-core==(\d+)\.(\d+)\.\d+/m,
  );
  assert.ok(sdk, 'rocm-sdk-core is pinned');
  assert.equal(THEROCK_SOURCE.tag, `therock-${sdk[1]}.${sdk[2]}`);
  assert.match(THEROCK_SOURCE.commit, /^[0-9a-f]{40}$/);
  assert.equal(THEROCK_ARCHIVE, `TheRock-${THEROCK_SOURCE.tag}.tar.gz`);
});

test('every LGPL or GPL ROCm library has its source pinned, and every pin a license', () => {
  for (const entry of ROCM_LICENSES.filter((e) => e.files?.some((name) => /GPL/.test(name)))) {
    assert.ok(
      ROCM_LGPL_SOURCES.some((source) => entry.match.test(source.library)),
      `${entry.component} ships under a GPL-family license with no source pinned`,
    );
  }
  for (const source of ROCM_LGPL_SOURCES) {
    const entry = ROCM_LICENSES.find((candidate) => candidate.match.test(source.library));
    assert.equal(entry?.component, source.component, `${source.library} has a license entry`);
    assert.match(source.sha256, /^[0-9a-f]{64}$/);
    assert.equal(basename(new URL(source.url).pathname), source.file);
    assert.equal(basename(new URL(source.upstream).pathname), source.file);
  }
});

test('a fetched source set is checked file by file', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'gezel-rocm-sources-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const [numactl, elfutils] = ROCM_LGPL_SOURCES;
  writeFileSync(join(dir, README), 'x');
  writeFileSync(join(dir, THEROCK_ARCHIVE), 'x');
  writeFileSync(join(dir, numactl.file), 'not the release');
  writeFileSync(join(dir, 'extra.txt'), 'x');
  assert.deepEqual(verifyRocmLgplSources(dir).sort(), [
    `${elfutils.file} is missing`,
    `${numactl.file} does not match its pinned sha256`,
    'unexpected file extra.txt',
  ]);
  assert.deepEqual(verifyRocmLgplSources(join(dir, 'absent')), [
    `${join(dir, 'absent')} does not exist`,
  ]);
});

test('the Linux license README names the release that carries the source', () => {
  const linux = ['libamdhip64.so.7', 'librocm_sysdeps_elf.so.1', 'librocm_sysdeps_numa.so.1'];
  const tagged = rocmSourceOffer(linux, 'native-v0.1.58').join('\n');
  assert.ok(tagged.includes(thirdPartySourcesAssetName('0.1.58')));
  assert.ok(tagged.includes('https://github.com/bendyline/gezel/releases/tag/native-v0.1.58'));
  assert.ok(tagged.includes('librocm_sysdeps_numa.so.1: numactl 2.0.19 (LGPL-2.1)'));
  assert.ok(tagged.includes('librocm_sysdeps_elf.so.1: elfutils 0.195'));
  assert.ok(tagged.includes(`${THEROCK_SOURCE.repository}/tree/${THEROCK_SOURCE.tag}`));

  const untagged = rocmSourceOffer(linux).join('\n');
  assert.ok(untagged.includes(thirdPartySourcesAssetName('<version>')));
  assert.ok(!untagged.includes('/releases/tag/'));

  assert.deepEqual(rocmSourceOffer(['amdhip64_7.dll', 'rocblas.dll'], 'native-v0.1.58'), []);
});

test('the Linux ROCm leg fetches the source and the draft release attaches it', () => {
  const workflow = read('../.github/workflows/build-native.yml');
  assert.ok(
    workflow.includes('node scripts/rocm-lgpl-sources.mjs --out "$RUNNER_TEMP/rocm-lgpl-sources"'),
  );
  assert.ok(workflow.includes('name: third-party-sources-linux-x64-rocm'));
  assert.match(
    workflow,
    /path: source-artifacts\/third-party-sources-linux-x64-rocm\n\s+pattern: third-party-sources-linux-x64-rocm\n\s+merge-multiple: true\n/,
    'a lone pattern match unpacks into `path` itself, so the folder must be named there',
  );
  assert.ok(workflow.includes('source="source-artifacts/third-party-sources-linux-x64-rocm"'));
  assert.ok(workflow.includes('node scripts/rocm-lgpl-sources.mjs --verify "$source"'));
  assert.ok(workflow.includes(`release/${thirdPartySourcesAssetName('${VERSION}')}`));
  assert.ok(workflow.includes('--native-release "$GITHUB_REF_NAME"'));
  const files = workflow.match(/files: \|\n((?: {12}release\/\S+\n)+)/);
  assert.ok(files?.[1].includes('release/*.tar\n'), 'the release uploads the source tar');
});
